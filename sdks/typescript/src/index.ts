export type { Tier, Network, YieldLadderOptions, Position, Signer } from './types';
import type { Tier, YieldLadderOptions, Position, Network } from './types';
import { BelowMinDepositError } from './errors';
import {
  addressToScVal,
  amountToScVal,
  tierToScVal,
  TransactionPipeline,
} from './transactions';

const USDC_DECIMALS = 7;
const STROOPS_PER_UNIT = 10 ** USDC_DECIMALS;

const TIER_MIN_DEPOSIT: Record<Tier, bigint> = {
  Flex: BigInt(10 * STROOPS_PER_UNIT),
  L3: BigInt(50 * STROOPS_PER_UNIT),
  L6: BigInt(100 * STROOPS_PER_UNIT),
  L12: BigInt(250 * STROOPS_PER_UNIT),
};

const TIERS: readonly Tier[] = ['Flex', 'L3', 'L6', 'L12'];

const RPC_URLS: Record<Network, string> = {
  mainnet: 'https://rpc-mainnet.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
};

interface RawPosition {
  principal: bigint;
  shares: bigint;
  lock_until: number;
}

export class YieldLadder {
  private readonly options: YieldLadderOptions;
  private readonly pipeline: TransactionPipeline;

  constructor(options: YieldLadderOptions) {
    this.options = options;
    this.pipeline = new TransactionPipeline({
      rpcUrl: options.rpcUrl ?? RPC_URLS[options.network],
      network: options.network,
      publicKey: options.publicKey,
      signer: options.signer,
      transactionTimeoutSeconds: options.transactionTimeoutSeconds,
    });
  }

  /**
   * Deposits `amount` (decimal USDC string) into `tier`. Returns the
   * submitted transaction hash.
   *
   * `idempotencyKey` guards against a double-click/retry submitting twice
   * (issue #140) — defaults to a key derived from the account/tier/asset/
   * amount, so two calls with identical params dedup automatically. Pass
   * your own key (e.g. a per-intent nonce) if you need two calls with
   * otherwise-identical params to NOT be conflated.
   */
  async deposit(params: {
    tier: Tier;
    amount: string;
    idempotencyKey?: string;
  }): Promise<string> {
    const stroops = this.toStroops(params.amount);
    if (stroops < TIER_MIN_DEPOSIT[params.tier]) {
      throw new BelowMinDepositError();
    }

    return this.pipeline.invoke({
      contractId: this.options.vaultRouterContractId,
      method: 'deposit',
      args: [
        addressToScVal(this.options.publicKey),
        tierToScVal(params.tier),
        addressToScVal(this.options.assetContractId),
        amountToScVal(stroops),
      ],
      idempotencyKey:
        params.idempotencyKey ??
        this.defaultIdempotencyKey('deposit', params.tier, params.amount),
    });
  }

  /**
   * Withdraws the caller's full matured position from `tier`. Returns the
   * submitted transaction hash. See `deposit`'s doc for `idempotencyKey`.
   */
  async withdraw(params: { tier: Tier; idempotencyKey?: string }): Promise<string> {
    const position = await this.queryTierPosition(
      this.options.publicKey,
      params.tier,
    );

    return this.pipeline.invoke({
      contractId: this.options.vaultRouterContractId,
      method: 'withdraw',
      args: [
        addressToScVal(this.options.publicKey),
        tierToScVal(params.tier),
        addressToScVal(this.options.assetContractId),
        amountToScVal(BigInt(position.principal)),
      ],
      idempotencyKey:
        params.idempotencyKey ??
        this.defaultIdempotencyKey('withdraw', params.tier, position.principal),
    });
  }

  /**
   * Exits the caller's full position from `tier` before maturity (exit fee
   * applies). See `deposit`'s doc for `idempotencyKey`.
   */
  async earlyExit(params: { tier: Tier; idempotencyKey?: string }): Promise<string> {
    const position = await this.queryTierPosition(
      this.options.publicKey,
      params.tier,
    );

    return this.pipeline.invoke({
      contractId: this.options.vaultRouterContractId,
      method: 'early_exit',
      args: [
        addressToScVal(this.options.publicKey),
        tierToScVal(params.tier),
        addressToScVal(this.options.assetContractId),
        amountToScVal(BigInt(position.principal)),
      ],
      idempotencyKey:
        params.idempotencyKey ??
        this.defaultIdempotencyKey('early_exit', params.tier, position.principal),
    });
  }

  private defaultIdempotencyKey(
    method: string,
    tier: Tier,
    amount: string,
  ): string {
    return [
      method,
      this.options.publicKey,
      tier,
      this.options.assetContractId,
      amount,
    ].join(':');
  }

  async position(address: string): Promise<Position> {
    const positions = await Promise.all(
      TIERS.map(tier => this.queryTierPosition(address, tier)),
    );
    return positions.find(p => p.principal !== '0') ?? positions[0];
  }

  private toStroops(amount: string): bigint {
    const [whole = '0', frac = ''] = amount.split('.');
    const fracPadded = frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
    return (
      BigInt(whole) * BigInt(STROOPS_PER_UNIT) +
      BigInt(fracPadded.length > 0 ? fracPadded : '0')
    );
  }

  private async queryTierPosition(
    address: string,
    tier: Tier,
  ): Promise<Position> {
    const raw = (await this.pipeline.simulateRead({
      contractId: this.options.vaultRouterContractId,
      method: 'position',
      args: [
        addressToScVal(address),
        tierToScVal(tier),
        addressToScVal(this.options.assetContractId),
      ],
    })) as RawPosition;

    return {
      tier,
      principal: raw.principal.toString(),
      shares: raw.shares.toString(),
      // VaultRouter's position() doesn't expose accrued yield yet — that
      // lands with yield distribution in a later issue. 0 here is honest,
      // not a stub pretending to compute something it can't.
      accruedYield: '0',
      lockUntil: raw.lock_until === 0 ? null : raw.lock_until,
    };
  }
}
