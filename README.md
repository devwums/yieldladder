![YieldLadder](./yieldladder.PNG)

Time-locked USDC vaults on Soroban with auto-routed AMM yield.

## Abstract

YieldLadder is a savings primitive on the Stellar network. A user deposits USDC into one of four time-locked vaults (Flex, 3-month, 6-month, or 12-month) and receives a non-transferable position representing their share. The protocol routes deposited USDC into a curated set of Stellar AMM liquidity pools, harvests trading fees on a fixed cadence, compounds harvested yield back into the position, and distributes yield proportional to share weight and lock duration.

The protocol is non-custodial and immutable per deployment. Yield is sourced exclusively from on-chain Stellar liquidity pools — no off-chain CeFi venues, no anchor lending, no rehypothecation. The only privileged role is the Strategist, who can propose new pool allocations subject to a 72-hour timelock and a hard-coded per-pool exposure cap.

## Vault tiers

| Tier | Lock duration | Lock multiplier | Early-exit fee | Min deposit |
|---|---|---|---|---|
| Flex | None | 1.00x | 0% | 1 USDC |
| L3 | 3 months | 1.05x | 0.50% | 50 USDC |
| L6 | 6 months | 1.15x | 1.25% | 100 USDC |
| L12 | 12 months | 1.40x | 3.00% | 250 USDC |

Lock multipliers apply at the share-weight level: a 100 USDC deposit into L12 receives 140 share-units, while the same deposit into Flex receives 100. Yield distributes pro-rata against share-units, so longer-lock depositors capture a structurally larger fraction of harvested fees. Early-exit fees are charged against principal and redistributed to remaining depositors in the same tier — they are not retained by the protocol.

## Architecture

```
+------------------+       +-------------------+       +------------------+
|   Vault Router   | ----> |  Vault Contracts  | ----> |  Strategy Vault  |
|   (entrypoint)   |       |  Flex / L3 / L6 / |       |    (allocator)   |
+------------------+       |        L12        |       +------------------+
                           +-------------------+                |
                                                                v
                                                       +------------------+
                                                       |   Stellar AMM    |
                                                       |  liquidity pools |
                                                       |   (curated set)  |
                                                       +------------------+
                                                                |
                                                                v
                                                       +------------------+
                                                       |    Harvester     |
                                                       | (cron-triggered) |
                                                       +------------------+
```

The Vault Router is the user-facing contract; it enforces tier rules and mints position records. Each tier vault holds depositor balances and a reference to the Strategy Vault, which holds the protocol's working capital and executes pool allocations. The Harvester is a permissionless contract — anyone can call `harvest()` after the cooldown elapses and receive a 10 bps bounty on harvested yield.

## Vault mechanics

### Deposit and positions

Users call `deposit(tier, amount)` on the Vault Router. The router transfers USDC into the tier vault, records `shares = amount * lock_multiplier` against the user's address, sets `lock_until = now + tier.duration` for locked tiers, and forwards USDC to the Strategy Vault for allocation. Positions are non-transferable and identified by wallet address — there are no fungible position tokens.

### Yield accrual and withdrawal

Yield accrues continuously at the AMM layer and is realised at each harvest. Harvested USDC is automatically re-deployed into the Strategy Vault, compounding yield without any user action. At maturity, users call `withdraw(tier)` and receive principal plus all accrued yield with no fee. Before maturity, `early_exit(tier)` returns principal minus the exit fee plus accrued yield; the exit fee is socialised across remaining depositors in the same tier.

## Yield sources

YieldLadder allocates exclusively to Stellar AMM pools that meet all of the following criteria:

- USDC is one of the two assets in the pool
- Counterparty asset is on the protocol allowlist (currently: XLM, EURC, AQUA)
- Pool has at least 30 days of trading history
- Pool has at least $250,000 TVL at allocation time
- Per-pool exposure is capped at 35% of Strategy Vault assets

The Strategist can propose adding pools or counterparty assets via the governance contract, subject to a 72-hour timelock. Current allocations are published at `https://yieldladder.dev/allocations` and on-chain via `Strategy.allocations()`.

## Risk model

| Risk | Description | Mitigation |
|---|---|---|
| Smart contract | Contracts are immutable — bugs cannot be patched in place | External audit, formal verification of lock and share accounting |
| Impermanent loss | AMM allocation exposes principal to IL when pool asset prices diverge | Allowlist restricted to low-volatility pairs; per-pool exposure capped; IL tracked and rebalanced above threshold |
| Stablecoin depeg | Material USDC depeg directly affects every position | No hedge; users should size deposits accordingly |
| Strategist | Strategist can propose allocation changes but cannot withdraw user funds | 72-hour timelock, Guardian Multisig veto, hard-coded exposure caps |

## Repository structure

```
yieldladder/
├── app/                        # Next.js 14 frontend (landing page + dashboard)
│   └── src/app/               # App Router pages and layouts
├── contracts/                  # Soroban smart contracts (Rust)
│   ├── governance/            # Strategist proposal and 72-hour timelock
│   ├── harvester/             # Permissionless yield harvester
│   ├── strategy_vault/        # Pool allocation executor
│   ├── vault_flex/            # Flex tier vault (no lock)
│   ├── vault_l3/              # 3-month tier vault
│   ├── vault_l6/              # 6-month tier vault
│   ├── vault_l12/             # 12-month tier vault
│   └── vault_router/          # User-facing entrypoint contract
├── sdks/typescript/           # TypeScript SDK for app integrations
├── deployments/
│   ├── testnet.json           # Testnet contract addresses
│   └── mainnet.json           # Mainnet addresses (pending audit completion)
├── audit/
│   └── internal-2026-01.md   # Internal security review (Jan 2026)
├── security/
│   └── bounty.md             # Bug bounty scope and reward tiers
├── Cargo.toml                 # Rust workspace manifest
├── CHANGELOG.md               # Release history
└── README.md                  # This file
```

## Development setup

### Prerequisites

- [Rust](https://rustup.rs/) stable with the `wasm32-unknown-unknown` target
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+

### Install

```bash
git clone https://github.com/LadderMine/yieldladder.git
cd yieldladder
```

**Frontend:**

```bash
cd app
pnpm install
pnpm dev        # starts on http://localhost:3000
```

**Contracts:**

```bash
# Add the wasm target if you haven't already
rustup target add wasm32-unknown-unknown

# Build all contracts
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test
```

## Contributing

Contributions are welcome. Please follow this workflow:

1. **Open an issue first** for any non-trivial change so the approach can be discussed before you invest time coding.
2. **Fork the repository** and create a branch from `main` with a descriptive name (e.g. `fix/harvester-cooldown`, `feat/l3-vault-tests`).
3. **Make your changes.** Keep commits focused — one logical change per commit.
4. **Ensure CI passes.** The CI pipeline runs `pnpm typecheck` and `pnpm lint` for the frontend, and `cargo build` for contracts. Run these locally before pushing.
5. **Open a pull request** against `main` with a clear title and description. Reference any related issue with `closes #N`.

### Code conventions

- **Rust:** follow standard `rustfmt` formatting (`cargo fmt` before committing). Document public items with `///` doc comments.
- **TypeScript:** the frontend uses the TypeScript strict mode. Run `pnpm typecheck` to verify.
- **Commit messages:** use the `type: description` format — `feat:`, `fix:`, `docs:`, `chore:`, `test:`.

## Audits and security

| Auditor | Scope | Status | Report |
|---|---|---|---|
| Internal review | All contracts | Complete (2026-01) | `audit/internal-2026-01.md` |
| External audit firm | Vault Router, Strategy Vault | Engaged (Q2 2026) | Pending |
| Formal verification | Lock and share accounting | In progress | — |

To report a security vulnerability, see `security/bounty.md` or email `security@yieldladder.dev` (PGP fingerprint `D7F2 7A91 C4AB 8E03 5F12 9B6E 88AD 4F71 33CC 0BAE`). Do not open public issues for security findings.

## Contracts

| Contract | Purpose | Address (mainnet) |
|---|---|---|
| `VaultRouter` | User entrypoint | `CC...PENDING` |
| `VaultFlex` | Flex tier holdings | `CC...PENDING` |
| `VaultL3` | 3-month tier holdings | `CC...PENDING` |
| `VaultL6` | 6-month tier holdings | `CC...PENDING` |
| `VaultL12` | 12-month tier holdings | `CC...PENDING` |
| `StrategyVault` | Allocation execution | `CC...PENDING` |
| `Harvester` | Yield harvest trigger | `CC...PENDING` |
| `Governance` | Strategist proposals and timelock | `CC...PENDING` |

Mainnet addresses are published after audit completion. Testnet addresses are in `deployments/testnet.json`.

## SDK

```typescript
import { YieldLadder } from '@yieldladder/sdk';

const yl = new YieldLadder({
  network: 'mainnet',
  publicKey: userAddress,       // the account initiating transactions
  signer,                        // e.g. a WalletAdapter — see app/src/lib/wallet/types.ts
  vaultRouterContractId: 'CC...',
  assetContractId: 'CC...',      // the deposit asset's SAC address (e.g. USDC)
});

const txHash = await yl.deposit({ tier: 'L6', amount: '500.00' });

const position = await yl.position(userAddress);
// { tier: 'L6', principal: '5000000000', shares: '5750000000',
//   accruedYield: '0', lockUntil: 1781856000 }
// principal/shares are the contract's raw i128 values (7-decimal stroops,
// same base unit `amount` is submitted in) — not yet decimal-formatted.

await yl.withdraw({ tier: 'L6' });    // throws LockNotExpiredError if the lock hasn't expired
await yl.earlyExit({ tier: 'L6' });   // succeeds early, exit fee applied by the contract
```

Every write method returns the submitted transaction's hash. `signer` must implement
`signTransaction(xdr, opts?)` (see `sdks/typescript/src/types.ts`'s `Signer` interface) —
the same shape as the app's `WalletAdapter`, so a real wallet adapter can be passed
directly without an adapter shim.

The SDK source lives in `sdks/typescript/` and targets `@stellar/stellar-sdk` v12+ with Soroban support.

## Glossary

| Term | Definition |
|---|---|
| **Vault** | A Soroban contract that holds depositor balances for a single tier and forwards working capital to the Strategy Vault. |
| **Tier** | A vault parameterisation comprising lock duration, lock multiplier, early-exit fee, and minimum deposit. |
| **Share-unit** | A non-transferable accounting unit representing a depositor's claim. `shares = deposit * lock_multiplier`. |
| **Lock multiplier** | A per-tier constant (1.00x–1.40x) applied at deposit time to weight the depositor's share claim. |
| **Harvest** | A permissionless transaction that claims accumulated AMM trading fees and routes them back as compound yield. |
| **Strategist** | A role that can propose pool allocation changes under timelock. Cannot move user funds. |
| **Guardian Multisig** | A 4-of-7 multisig authorised to veto Strategist proposals during the 72-hour window. Cannot move user funds. |
| **Allocation cap** | Hard-coded maximum fraction of Strategy Vault assets per AMM pool. Currently 35%. |
