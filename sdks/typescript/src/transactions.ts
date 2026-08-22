import {
  Address,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  scValToNative,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { Network, Signer, Tier } from './types';
import {
  AssetNotAllowedError,
  BelowMinDepositError,
  DepositCapExceededError,
  InvalidTierError,
  LockNotExpiredError,
  ProtocolPausedError,
  SimulationFailedError,
  SubmissionFailedError,
  TransactionExpiredError,
  VaultContractError,
  YieldLadderError,
} from './errors';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

const DEFAULT_TX_TIMEOUT_SECONDS = 30;

/**
 * Soroban surfaces contract-level rejections in the simulation error string
 * as `Error(Contract, #N)`, where N is the error enum's discriminant.
 */
const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

export interface TransactionPipelineConfig {
  rpcUrl: string;
  network: Network;
  publicKey: string;
  signer: Signer;
  transactionTimeoutSeconds?: number;
}

export interface InvokeContractParams {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /**
   * Dedup key (issue #140): concurrent invoke() calls sharing the same
   * idempotencyKey return the SAME in-flight promise instead of each
   * building/simulating/submitting their own transaction — guards a
   * double-click or a retry-after-dropped-response from racing two
   * separate submissions of the same intent. The key is released the
   * moment the call settles (success or failure), so it never blocks a
   * later, genuinely separate call reusing the same key.
   */
  idempotencyKey?: string;
}

/** Encodes a Tier the same way Soroban encodes any #[contracttype] enum variant. */
export function tierToScVal(tier: Tier): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tier)]);
}

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function amountToScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: 'i128' });
}

/**
 * Build -> simulate -> (sign ->) submit, shared by every VaultRouter call
 * the SDK makes. No retry/reconnection logic here — a caller that wants
 * that builds it around these primitives.
 */
export class TransactionPipeline {
  private readonly server: SorobanRpc.Server;
  private readonly networkPassphrase: string;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly config: TransactionPipelineConfig) {
    this.server = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  /** Simulates a read-only call (no signing, no submission) and returns the raw retval, decoded. */
  async simulateRead(params: InvokeContractParams): Promise<unknown> {
    const tx = await this.buildTransaction(params);
    const sim = await this.server.simulateTransaction(tx);
    this.throwIfSimulationFailed(sim, params.method);

    if (!SorobanRpc.Api.isSimulationSuccess(sim) || sim.result === undefined) {
      throw new SimulationFailedError(
        `Simulating "${params.method}" returned no result`,
        'no_result',
      );
    }
    return scValToNative(sim.result.retval);
  }

  /**
   * Builds, simulates, signs (via the configured Signer), and submits a
   * write call. Returns the submitted transaction's hash — callers who need
   * confirmation should watch the vault's state (a later issue's concern),
   * not assume submission alone means success.
   *
   * When `idempotencyKey` is set, a call already in flight for that key is
   * returned as-is instead of starting a second one (issue #140).
   */
  async invoke(params: InvokeContractParams): Promise<string> {
    const { idempotencyKey } = params;
    if (idempotencyKey) {
      const existing = this.inFlight.get(idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const promise = this.doInvoke(params);

    if (idempotencyKey) {
      this.inFlight.set(idempotencyKey, promise);
      // Release once settled — a distinct chained promise, so this never
      // affects the original `promise` returned to the caller above.
      promise
        .finally(() => {
          if (this.inFlight.get(idempotencyKey) === promise) {
            this.inFlight.delete(idempotencyKey);
          }
        })
        .catch(() => undefined);
    }

    return promise;
  }

  private async doInvoke(params: InvokeContractParams): Promise<string> {
    const rawTx = await this.buildTransaction(params);

    // Always simulate fresh for this specific call — never reuse a fee or
    // resource footprint estimated for a different transaction.
    const sim = await this.server.simulateTransaction(rawTx);
    this.throwIfSimulationFailed(sim, params.method);

    let prepared: Transaction;
    try {
      prepared = SorobanRpc.assembleTransaction(rawTx, sim).build();
    } catch (error) {
      throw new SimulationFailedError(
        `Failed to assemble "${params.method}" from its simulation`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // The wallet round-trip happens here — this is where time-bounds can
    // expire while the user is still looking at the signing prompt.
    const signedXdr = await this.config.signer.signTransaction(
      prepared.toXDR(),
      { network: this.config.network, accountToSign: this.config.publicKey },
    );

    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );

    let sendResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      sendResult = await this.server.sendTransaction(signedTx);
    } catch (error) {
      throw new SubmissionFailedError(
        `Submitting "${params.method}" failed`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (sendResult.status === 'ERROR') {
      if (TransactionPipeline.isExpired(sendResult)) {
        throw new TransactionExpiredError();
      }
      throw new SubmissionFailedError(
        `"${params.method}" was rejected on submission`,
        sendResult,
      );
    }

    return sendResult.hash;
  }

  private async buildTransaction(
    params: InvokeContractParams,
  ): Promise<Transaction> {
    const sourceAccount = await this.server.getAccount(this.config.publicKey);
    const contract = new Contract(params.contractId);
    const timeoutSeconds =
      this.config.transactionTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS;

    return new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(params.method, ...params.args))
      .setTimeout(timeoutSeconds)
      .build();
  }

  private throwIfSimulationFailed(
    sim: SorobanRpc.Api.SimulateTransactionResponse,
    method: string,
  ): void {
    if (!SorobanRpc.Api.isSimulationError(sim)) {
      return;
    }

    const match = CONTRACT_ERROR_PATTERN.exec(sim.error);
    if (match) {
      throw TransactionPipeline.mapContractError(Number(match[1]), sim.error);
    }
    throw new SimulationFailedError(
      `Simulating "${method}" failed: ${sim.error}`,
      sim.error,
    );
  }

  private static mapContractError(
    code: number,
    rawError: string,
  ): YieldLadderError {
    switch (code) {
      case 1:
        return new InvalidTierError();
      case 2:
        return new BelowMinDepositError();
      case 3:
        return new LockNotExpiredError();
      case 4:
        return new AssetNotAllowedError();
      case 5:
        return new DepositCapExceededError();
      case 6:
        return new ProtocolPausedError();
      default:
        return new VaultContractError(code, rawError);
    }
  }

  private static isExpired(
    sendResult: SorobanRpc.Api.SendTransactionResponse,
  ): boolean {
    return sendResult.errorResult?.result().switch().name === 'txTooLate';
  }
}
