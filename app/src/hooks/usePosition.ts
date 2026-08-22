import { useState, useEffect } from 'react';

export type Tier = 'Flex' | 'L3' | 'L6' | 'L12';

export interface Position {
  tier: Tier;
  /** Raw share balance returned by the vault contract */
  shares: string;
  /** Principal in USDC stroops (shares / multiplier for locked tiers) */
  principal: string;
  /** Accrued yield estimate in USDC stroops */
  accruedYield: string;
  /** Ledger timestamp when the lock expires, null for Flex */
  lockUntil: number | null;
}

/**
 * A single VaultRouter handles every tier — tier is a call argument to
 * `position(address, tier, asset)`, not a separate deployed contract per
 * tier (see sdks/typescript's YieldLadder, issue #139). This previously
 * read `NEXT_PUBLIC_{TIER}_VAULT` per tier, which doesn't match how the
 * contracts are actually deployed.
 */
const VAULT_ROUTER_CONTRACT_ID = process.env.NEXT_PUBLIC_VAULT_ROUTER_CONTRACT_ID;
const ASSET_CONTRACT_ID = process.env.NEXT_PUBLIC_ASSET_CONTRACT_ID;

export function usePosition(address: string | null, tier: Tier) {
  const [position, setPosition] = useState<Position | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setPosition(null);
      setError(null);
      return;
    }

    if (!VAULT_ROUTER_CONTRACT_ID || !ASSET_CONTRACT_ID) {
      setError('Vault router contract address not configured');
      return;
    }

    // TODO(#141 follow-up): call VaultRouter.position(address, tier, asset)
    // via simulateTransaction — sdks/typescript's YieldLadder.position()
    // already implements exactly this (issue #139), which is the
    // "preferred" approach issue #141 calls for. Wiring it in here is
    // blocked on the app depending on @yieldladder/sdk (or
    // @stellar/stellar-sdk directly) for real XDR encode/decode, which
    // needs a `pnpm install` to regenerate app/pnpm-lock.yaml correctly —
    // this environment can't safely run that (see the identical blocker
    // documented on placeholderSubmissionHash in app/deposit/page.tsx).
    //
    // Previously this returned a hardcoded { shares: '0', principal: '0',
    // ... } dressed up as decoded on-chain data. A silently-wrong zero
    // balance is worse than an explicit "unavailable" state — it can read
    // as "you have nothing here" to a user who actually has a position.
    // Surface that honestly instead of fabricating a result.
    setLoading(false);
    setPosition(null);
    setError(
      'Position data is not yet available in the dashboard — SDK integration pending (see issue #141 follow-up)',
    );
  }, [address, tier]);

  return { position, loading, error };
}
