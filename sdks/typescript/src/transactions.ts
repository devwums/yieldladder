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
import type { Network, PaymentStatus, Signer, Tier } from './types';
import {
  AmbiguousSubmissionError,
  AmountExceedsBalanceError,
  AssetNotAllowedError,
  BelowMinDepositError,
  DepositCapExceededError,
  InvalidTierError,
  LockNotExpiredError,
  NotYetMaturedError,
  ProtocolPausedError,
  RpcTimeoutError,
  RpcUnavailableError,
  SimulationFailedError,
  SubmissionFailedError,
  TransactionExpiredError,
  TransactionFailedError,
  TransactionTimedOutError,
  VaultContractError,
  WalletDisconnectedError,
  WalletRejectedError,
  WalletSigningFailedError,
  YieldLadderError,
} from './errors';
import {
  isTimeoutError,
  isTransientNetworkError,
  retryWithBackoff,
  sleep,
} from './utils';

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

const DEFAULT_TX_TIMEOUT_SECONDS = 30;

/**
 * Confirmation-depth policy (issue #141): Stellar/Soroban's consensus
 * (SCP) gives a ledger deterministic finality the moment it closes — there
 * is no probabilistic reorg window the way Nakamoto-consensus chains have,
 * so there is no separate "included but not yet safe" state to model here.
 * The instant `getTransaction` reports SUCCESS, the result is final; no
 * additional confirmation-depth wait is needed or meaningful.
 */
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_POLL_INTERVAL_MS = 5_000;
/** Generous past Soroban's typical propagation window; a legitimate submission resolves in a few ledgers (~seconds), well under this. */
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/**
 * Soroban surfaces contract-level rejections in the simulation error string
 * as `Error(Contract, #N)`, where N is the error enum's discriminant.
 */
const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/**
 * Retry ceiling for transient network/timeout failures on the read-only,
 * pre-submission RPC calls (`getAccount`, `simulateTransaction`) — issue
 * #142. Deliberately NOT applied to the signing step (a wallet round-trip
 * isn't a network call to retry) nor, at this layer, to `sendTransaction`
 * itself — see `doInvoke`'s own handling of that call's failure modes.
 */
const RPC_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 3_000,
  isRetryable: isTransientNetworkError,
};

/**
 * Only rewraps an error that's actually a transient-network failure (the
 * kind `retryWithBackoff` just gave up retrying) into the typed RPC error —
 * a non-network error (e.g. a malformed request) must pass through
 * unchanged, not get mislabeled as "RPC unreachable".
 */
function toRpcErrorIfTransient(error: unknown): unknown {
  if (!isTransientNetworkError(error)) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  return isTimeoutError(error) ? new RpcTimeoutError(raw) : new RpcUnavailableError(raw);
}

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

export interface WaitForTransactionOptions {
  /** Fired with each observed lifecycle status as polling progresses. */
  onStatus?: (status: PaymentStatus) => void;
  /** Delay before the first poll and the base for exponential backoff between polls. Default 1500ms. */
  pollIntervalMs?: number;
  /** Hard cap on total wait time before giving up with a TransactionTimedOutError. Default 60000ms. */
  timeoutMs?: number;
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
    const sim = await this.simulateWithRetry(tx);
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

  /**
   * Polls `getTransaction` for `hash` until it resolves to a terminal
   * on-chain outcome, driving `onStatus` through the canonical
   * `PaymentStatus` lifecycle. Resolves on SUCCESS; rejects with
   * `TransactionFailedError` on FAILED (this covers a contract-level
   * revert too — see the confirmation-depth policy note above) or with
   * `TransactionTimedOutError` if the deadline passes while the hash is
   * still NOT_FOUND (still propagating, or genuinely dropped — the caller
   * can't distinguish the two and must stop waiting either way).
   */
  async waitForTransaction(
    hash: string,
    opts: WaitForTransactionOptions = {},
  ): Promise<void> {
    const baseIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    opts.onStatus?.('pending');

    for (let attempt = 0; ; attempt++) {
      const result = await this.server.getTransaction(hash);

      if (result.status === 'SUCCESS') {
        opts.onStatus?.('confirmed');
        return;
      }

      if (result.status === 'FAILED') {
        opts.onStatus?.('failed');
        throw new TransactionFailedError(hash);
      }

      // NOT_FOUND: keep polling until the deadline, then stop rather than
      // loop forever — never assume a bare NOT_FOUND is itself a failure.
      if (Date.now() >= deadline) {
        opts.onStatus?.('expired');
        throw new TransactionTimedOutError(hash);
      }

      const backoff = Math.min(
        baseIntervalMs * 2 ** attempt,
        MAX_POLL_INTERVAL_MS,
      );
      await sleep(backoff);
    }
  }

  private async doInvoke(params: InvokeContractParams): Promise<string> {
    const rawTx = await this.buildTransaction(params);

    // Always simulate fresh for this specific call — never reuse a fee or
    // resource footprint estimated for a different transaction.
    const sim = await this.simulateWithRetry(rawTx);
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
    // expire while the user is still looking at the signing prompt. Not
    // retried: asking the wallet to sign again after it just rejected
    // would either re-prompt confusingly or hang, not recover anything.
    let signedXdr: string;
    try {
      signedXdr = await this.config.signer.signTransaction(prepared.toXDR(), {
        network: this.config.network,
        accountToSign: this.config.publicKey,
      });
    } catch (error) {
      throw TransactionPipeline.classifySignerError(error);
    }

    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );

    // Computed locally, before ever calling the network — if `sendTransaction`
    // below throws ambiguously (network/timeout, no response at all), the
    // caller still has a hash to independently poll for instead of no way
    // to look the transaction up at all.
    const localHash = TransactionPipeline.tryComputeHash(signedTx);

    let sendResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      sendResult = await this.server.sendTransaction(signedTx);
    } catch (error) {
      // Soroban RPC's sendTransaction is idempotent by hash (a resubmission
      // of the identical signed envelope comes back DUPLICATE, not a double
      // application) — but this exception means we don't even know whether
      // THIS attempt reached the network, so it's still ambiguous from the
      // caller's point of view: they must check status by hash (or accept
      // the SDK's own retry, which is safe precisely because it resends the
      // same envelope) rather than build and submit a brand new one.
      throw new AmbiguousSubmissionError(
        localHash,
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
    const sourceAccount = await retryWithBackoff(
      () => this.server.getAccount(this.config.publicKey),
      RPC_RETRY_OPTIONS,
    ).catch((error) => {
      throw toRpcErrorIfTransient(error);
    });
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

  /**
   * Retries only the transport failure (unreachable/timed-out RPC) —
   * never retries a normal response that happens to encode a simulation
   * *error* (that's not transient, retrying it changes nothing).
   */
  private async simulateWithRetry(
    tx: Transaction,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return retryWithBackoff(
      () => this.server.simulateTransaction(tx),
      RPC_RETRY_OPTIONS,
    ).catch((error) => {
      throw toRpcErrorIfTransient(error);
    });
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
      throw TransactionPipeline.mapContractError(
        method,
        Number(match[1]),
        sim.error,
      );
    }
    throw new SimulationFailedError(
      `Simulating "${method}" failed: ${sim.error}`,
      sim.error,
    );
  }

  /**
   * Best-effort local hash computation — must never itself throw and mask
   * the real error it's meant to accompany. Accepts either envelope type
   * `TransactionBuilder.fromXDR` can return; both expose `.hash()`.
   */
  private static tryComputeHash(tx: { hash(): Buffer }): string | null {
    try {
      return tx.hash().toString('hex');
    } catch {
      return null;
    }
  }

  /**
   * Distinguishes a wallet declining to sign (a deliberate user action)
   * from the wallet dropping the connection mid-flow — neither is a
   * network or contract failure, so neither should be reported as one.
   * No single error shape is shared across wallets (Freighter/Albedo/
   * LOBSTR/...), so this matches on common phrasing rather than a type.
   */
  private static classifySignerError(error: unknown): YieldLadderError {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).toLowerCase();

    if (/disconnect|not connected|no wallet|no active/.test(message)) {
      return new WalletDisconnectedError();
    }
    if (/reject|declin|deni|cancel|user closed/.test(message)) {
      return new WalletRejectedError();
    }
    return new WalletSigningFailedError(
      error instanceof Error ? error.message : String(error),
    );
  }

  private static mapContractError(
    method: string,
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
        // See the code-4 note atop errors.ts: AssetNotAllowed (router,
        // `deposit`) and NotYetMatured (tier vault, `relock`) collide on
        // this discriminant — only the calling method disambiguates them.
        return method === 'relock'
          ? new NotYetMaturedError()
          : new AssetNotAllowedError();
      case 5:
        return new DepositCapExceededError();
      case 6:
        return new ProtocolPausedError();
      case 7:
        return new AmountExceedsBalanceError();
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
