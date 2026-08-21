export type Tier = 'Flex' | 'L3' | 'L6' | 'L12';
export type Network = 'mainnet' | 'testnet';

/**
 * Signing abstraction shared with the app's WalletAdapter
 * (app/src/lib/wallet/types.ts) — a real WalletAdapter instance (Freighter,
 * Albedo, LOBSTR, ...) can be passed directly as `signer` without an adapter
 * shim. Deliberately just `signTransaction`: the SDK never asks a signer for
 * its own public key — the caller supplies that once via
 * `YieldLadderOptions.publicKey`, matching how a wallet's `connect()` and
 * `signTransaction()` are already two separate steps.
 */
export interface Signer {
  signTransaction(
    xdr: string,
    opts?: { network?: Network; accountToSign?: string },
  ): Promise<string>;
}

export interface YieldLadderOptions {
  network: Network;
  /** The account initiating transactions — used as the transaction source and passed as `user` to VaultRouter. */
  publicKey: string;
  signer: Signer;
  /** Deployed VaultRouter contract address for `network`. */
  vaultRouterContractId: string;
  /** Deposit-asset contract address (e.g. the USDC SAC) used for deposit/withdraw/earlyExit. */
  assetContractId: string;
  /** RPC endpoint override — defaults to the well-known public endpoint for `network`. */
  rpcUrl?: string;
  /**
   * Transaction validity window in seconds before Soroban considers it
   * expired. Soroban ledgers close roughly every 5s; this needs enough
   * headroom for a wallet signing round-trip. Default 30.
   */
  transactionTimeoutSeconds?: number;
}

export interface Position {
  tier: Tier;
  principal: string;
  shares: string;
  accruedYield: string;
  lockUntil: number | null;
}
