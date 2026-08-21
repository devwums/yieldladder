# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `VaultRouter` <-> tier-vault ABI mismatch: `VaultFlex`, `VaultL3`, `VaultL6`,
  and `VaultL12` now all expose the same `deposit(user, asset, amount)` /
  `withdraw(user, asset, amount) -> i128` / `early_exit(user, asset, amount)
  -> i128` / `balance(user, asset)` / `shares(user, asset)` /
  `lock_until(user, asset)` signatures that `VaultRouter` already called
  with, and `relock(user, asset)` (both on the router and on the locked
  tier vaults) so it isn't ambiguous once locks are asset-scoped.
- Every tier vault's storage (`Balance`, `Shares`, `LockUntil`, `Checkpoint`,
  and VaultL3's `EmergencyUnlock`) is now keyed by `(user, asset)` instead
  of `user` alone, so two different assets held by the same user in the
  same tier no longer share balance, lock, or checkpoint state.
  `shared::checkpoint` is asset-scoped for the same reason.
- Removed a duplicate token transfer inside each tier vault's `deposit()`:
  `VaultRouter` already moves the tokens from the user to the vault before
  invoking it, so the vault's own additional `user -> strategy` transfer
  (which also hardcoded the tier's original single USDC address regardless
  of which `asset` was actually deposited) double-charged the user and used
  the wrong token for any non-USDC asset. Tier vaults are now bookkeeping-
  only; VaultRouter owns all token movement.
- `VaultFlex` now supports partial withdrawal with the same semantics as
  the locked tiers, and gained `early_exit`/`lock_until` for ABI parity.
  Its previous pro-rata yield payout depended on an externally supplied
  `strategy_balance` argument that the router can no longer provide per
  the unified signature; `VaultFlex` now tracks its own principal balance
  like the locked tiers (see the doc comment on `VaultFlex::withdraw`).

### Added

- Integration tests in `vault_router/tests/` that exercise `VaultRouter`
  against the real `VaultFlex`/`VaultL3`/`VaultL6`/`VaultL12` contracts
  (not the unit-test `MockVault`) across two allowlisted assets.
- Cargo workspace with contract stubs for all eight vault roles.
- Next.js dashboard scaffold.
- TypeScript SDK skeleton.
- GitHub Actions CI for Rust and Next.js.

## [0.3.0] — 2026-03-14

### Added

- Share-checkpoint mechanism for mid-period deposits.
- Early-exit fee redistribution to remaining tier depositors.
- Governance contract with 72-hour timelock.

## [0.2.0] — 2026-01-22

### Added

- Strategy Vault allocation engine.
- Harvester contract with caller bounty (10 bps).
- Lock multiplier table for all four vault tiers.

## [0.1.0] — 2025-11-10

### Added

- Initial vault router prototype.
- Vault Flex (no lock) and VaultL12 (12-month lock) contracts.
