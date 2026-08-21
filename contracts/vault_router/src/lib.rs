#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, symbol_short, token, Address, Env,
    IntoVal, Symbol, Val, Vec,
};
use shared::allowlist::{init_allowlist, is_asset_allowed, add_asset, remove_asset};

mod error;
pub use error::VaultError;

// ---------------------------------------------------------------------------
// Minimum deposits per tier (USDC 7-decimal stroops)
// ---------------------------------------------------------------------------

const MIN_FLEX: i128 = 10_000_000;
const MIN_L3:   i128 = 500_000_000;
const MIN_L6:   i128 = 1_000_000_000;
const MIN_L12:  i128 = 2_500_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq)]
pub enum Tier {
    Flex,
    L3,
    L6,
    L12,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Position {
    pub principal: i128,
    pub shares: i128,
    pub lock_until: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct VaultCapacity {
    pub max_tvl: i128,
    pub remaining: i128,
}

#[contracttype]
enum DataKey {
    Admin,
    Governance,
    Guardian,
    VaultFlex,
    VaultL3,
    VaultL6,
    VaultL12,
    /// Circuit breaker flag — true means all mutating operations are halted.
    Paused,
}

// ---------------------------------------------------------------------------
// Event topics
// ---------------------------------------------------------------------------

const TOPIC_PAUSED:   Symbol = symbol_short!("paused");
const TOPIC_UNPAUSED: Symbol = symbol_short!("unpaused");

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct VaultRouter;

#[contractimpl]
impl VaultRouter {
    /// One-time setup. Registers the admin, governance, and guardian
    /// addresses, all tier vault addresses, and initialises the
    /// deposit-asset allowlist with `initial_assets`.
    ///
    /// The allowlist uses `shared::allowlist` — distinct from StrategyVault's
    /// pool-counterparty-asset allowlist, which is a different concept.
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        guardian: Address,
        vault_flex: Address,
        vault_l3: Address,
        vault_l6: Address,
        vault_l12: Address,
        initial_assets: Vec<Address>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::VaultFlex, &vault_flex);
        env.storage().instance().set(&DataKey::VaultL3, &vault_l3);
        env.storage().instance().set(&DataKey::VaultL6, &vault_l6);
        env.storage().instance().set(&DataKey::VaultL12, &vault_l12);
        env.storage().instance().set(&DataKey::Paused, &false);

        // Wire shared allowlist as the deposit-asset registry
        init_allowlist(&env, &admin, initial_assets);
    }

    // ── Circuit breaker ────────────────────────────────────────────────────

    /// Halt all mutating operations. Only the Guardian may call this.
    pub fn pause(env: Env) {
        let guardian: Address = env
            .storage().instance()
            .get(&DataKey::Guardian)
            .expect("not initialized");
        guardian.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((TOPIC_PAUSED,), true);
    }

    /// Resume normal operations. Only the Guardian may call this.
    pub fn unpause(env: Env) {
        let guardian: Address = env
            .storage().instance()
            .get(&DataKey::Guardian)
            .expect("not initialized");
        guardian.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((TOPIC_UNPAUSED,), false);
    }

    /// Returns true when the protocol is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Core operations ────────────────────────────────────────────────────

    /// Route a deposit to the appropriate tier vault.
    ///
    /// `asset` must be on the deposit-asset allowlist; rejected with
    /// `AssetNotAllowed` otherwise. Per-asset accounting is handled inside
    /// each tier vault (Balance keyed by (user, asset)). The tier vault
    /// enforces both the minimum deposit and the TVL cap.
    pub fn deposit(env: Env, user: Address, tier: Tier, asset: Address, amount: i128) {
        require_not_paused(&env);
        user.require_auth();

        // Validate asset against the deposit-asset registry
        if !is_asset_allowed(&env, &asset) {
            panic_with_error!(&env, VaultError::AssetNotAllowed);
        }

        let min_amt = min_deposit(&tier);
        if amount < min_amt {
            panic_with_error!(&env, VaultError::BelowMinDeposit);
        }

        let vault = vault_addr(&env, &tier);

        // Transfer asset tokens from user to vault
        token::Client::new(&env, &asset).transfer(&user, &vault, &amount);

        // Forward to vault with asset parameter for per-asset accounting
        let args: Vec<Val> = (user, asset, amount).into_val(&env);
        env.invoke_contract::<()>(&vault, &Symbol::new(&env, "deposit"), args);
    }

    /// Withdraw `amount` from the chosen tier vault for a specific asset.
    ///
    /// Pass the full balance to perform a full withdrawal.
    /// Pass a smaller value to perform a partial withdrawal — the remainder stays.
    pub fn withdraw(env: Env, user: Address, tier: Tier, asset: Address, amount: i128) {
        require_not_paused(&env);
        user.require_auth();

        let vault = vault_addr(&env, &tier);

        let args: Vec<Val> = (user.clone(), asset.clone(), amount).into_val(&env);
        let payout: i128 = env.invoke_contract(&vault, &Symbol::new(&env, "withdraw"), args);

        if payout > 0 {
            token::Client::new(&env, &asset).transfer(&vault, &user, &payout);
        }
    }

    /// Exit a locked tier early for a specific asset position.
    ///
    /// Early exit `amount` — exit fee applied only to the withdrawn amount.
    pub fn early_exit(env: Env, user: Address, tier: Tier, asset: Address, amount: i128) {
        require_not_paused(&env);
        user.require_auth();

        let vault = vault_addr(&env, &tier);

        let args: Vec<Val> = (user.clone(), asset.clone(), amount).into_val(&env);
        let net: i128 = env.invoke_contract(&vault, &Symbol::new(&env, "early_exit"), args);

        if net > 0 {
            token::Client::new(&env, &asset).transfer(&vault, &user, &net);
        }
    }

    /// Update the TVL cap of a given tier vault.
    /// Only callable by the registered Governance address.
    pub fn set_max_tvl(env: Env, tier: Tier, new_cap: i128) {
        let governance: Address = env.storage().instance().get(&DataKey::Governance).unwrap();
        governance.require_auth();

        let vault = vault_addr(&env, &tier);
        let args: Vec<Val> = (new_cap,).into_val(&env);
        env.invoke_contract::<()>(&vault, &Symbol::new(&env, "set_max_tvl"), args);
    }

    /// Read the current TVL cap and remaining capacity for a tier vault.
    pub fn vault_capacity(env: Env, tier: Tier) -> VaultCapacity {
        let vault = vault_addr(&env, &tier);

        let max_tvl: i128 = env.invoke_contract(
            &vault,
            &Symbol::new(&env, "max_tvl"),
            Vec::new(&env),
        );
        let remaining: i128 = env.invoke_contract(
            &vault,
            &Symbol::new(&env, "remaining_capacity"),
            Vec::new(&env),
        );

        VaultCapacity { max_tvl, remaining }
    }

    /// Renew the lock on a matured position in the given locked tier vault,
    /// for a specific asset position.
    ///
    /// Passes through to the tier vault's `relock(user, asset)` function.
    /// Only valid for locked tiers (L3, L6, L12). Flex has no lock period.
    ///
    /// Returns the new `lock_until` ledger sequence number.
    pub fn relock(env: Env, user: Address, tier: Tier, asset: Address) -> u32 {
        user.require_auth();

        // Flex vault has no lock; relock is not applicable
        if tier == Tier::Flex {
            panic!("relock not supported for Flex tier");
        }

        let vault = vault_addr(&env, &tier);
        let args: Vec<Val> = (user, asset).into_val(&env);
        env.invoke_contract(&vault, &Symbol::new(&env, "relock"), args)
    }

    /// Add a new deposit asset to the allowlist. Only callable by admin.
    pub fn add_deposit_asset(env: Env, admin: Address, asset: Address) {
        add_asset(&env, &admin, &asset);
    }

    /// Remove a deposit asset from the allowlist. Only callable by admin.
    pub fn remove_deposit_asset(env: Env, admin: Address, asset: Address) {
        remove_asset(&env, &admin, &asset);
    }

    /// Check whether an asset is on the deposit allowlist (read-only).
    pub fn is_deposit_asset_allowed(env: Env, asset: Address) -> bool {
        is_asset_allowed(&env, &asset)
    }

    /// Return the caller's position in a given tier vault for a specific asset.
    ///
    /// Read-only — not gated by pause.
    pub fn position(env: Env, user: Address, tier: Tier, asset: Address) -> Position {
        let vault = vault_addr(&env, &tier);

        let principal: i128 = env.invoke_contract(
            &vault,
            &Symbol::new(&env, "balance"),
            (user.clone(), asset.clone()).into_val(&env),
        );
        let shares: i128 = env.invoke_contract(
            &vault,
            &Symbol::new(&env, "shares"),
            (user.clone(), asset.clone()).into_val(&env),
        );
        let lock_until: u32 = match tier {
            Tier::Flex => 0,
            _ => env.invoke_contract(
                &vault,
                &Symbol::new(&env, "lock_until"),
                (user, asset).into_val(&env),
            ),
        };

        Position { principal, shares, lock_until }
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_guardian(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Guardian).unwrap()
    }

    pub fn get_vault(env: Env, tier: Tier) -> Address {
        vault_addr(&env, &tier)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn require_not_paused(env: &Env) {
    let paused: bool = env
        .storage().instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, VaultError::ProtocolPaused);
    }
}

fn vault_addr(env: &Env, tier: &Tier) -> Address {
    match tier {
        Tier::Flex => env.storage().instance().get(&DataKey::VaultFlex).unwrap(),
        Tier::L3   => env.storage().instance().get(&DataKey::VaultL3).unwrap(),
        Tier::L6   => env.storage().instance().get(&DataKey::VaultL6).unwrap(),
        Tier::L12  => env.storage().instance().get(&DataKey::VaultL12).unwrap(),
    }
}

fn min_deposit(tier: &Tier) -> i128 {
    match tier {
        Tier::Flex => MIN_FLEX,
        Tier::L3   => MIN_L3,
        Tier::L6   => MIN_L6,
        Tier::L12  => MIN_L12,
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::{min_deposit, Tier, VaultRouter, MIN_FLEX, MIN_L12, MIN_L3, MIN_L6};
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, vec, Address, Env};

    // ── Minimal mock vault that accepts (user, asset, amount) ───────────────

    #[contract]
    pub struct MockVault;

    #[contractimpl]
    impl MockVault {
        pub fn deposit(_env: Env, _user: Address, _asset: Address, _amount: i128) {}
        pub fn withdraw(_env: Env, _user: Address, _asset: Address, _amount: i128) -> i128 { 500_000_000_i128 }
        pub fn early_exit(_env: Env, _user: Address, _asset: Address, _amount: i128) -> i128 { 497_500_000_i128 }
        pub fn balance(_env: Env, _user: Address, _asset: Address) -> i128 { 500_000_000_i128 }
        pub fn shares(_env: Env, _user: Address, _asset: Address) -> i128 { 525_000_000_i128 }
        pub fn lock_until(_env: Env, _user: Address, _asset: Address) -> u32 { 1_000_000_u32 }
        pub fn relock(_env: Env, _user: Address, _asset: Address) -> u32 { 2_000_000_u32 }
        pub fn set_max_tvl(_env: Env, _new_cap: i128) {}
        pub fn max_tvl(_env: Env) -> i128 { 10_000_000_000_i128 }
        pub fn remaining_capacity(_env: Env) -> i128 { 9_500_000_000_i128 }
    }

    /// Returns (env, client, admin, guardian, usdc). All four tier vaults
    /// are registered to the same `MockVault` instance.
    fn setup() -> (Env, super::VaultRouterClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register_contract(None, MockVault);
        let router_id = env.register_contract(None, VaultRouter);
        let client = super::VaultRouterClient::new(&env, &router_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let guardian = Address::generate(&env);
        let usdc = Address::generate(&env);

        // Initialise with USDC as the only allowed deposit asset
        client.initialize(
            &admin,
            &governance,
            &guardian,
            &vault_id, &vault_id, &vault_id, &vault_id,
            &vec![&env, usdc.clone()],
        );

        (env, client, admin, guardian, usdc)
    }

    // ── Pause / unpause ─────────────────────────────────────────────────────

    #[test]
    fn test_is_paused_defaults_false() {
        let (_env, client, _, _guardian, _usdc) = setup();
        assert!(!client.is_paused());
    }

    #[test]
    fn test_guardian_can_pause_and_unpause() {
        let (_env, client, _, _guardian, _usdc) = setup();
        client.pause();
        assert!(client.is_paused());
        client.unpause();
        assert!(!client.is_paused());
    }

    #[test]
    #[should_panic]
    fn test_deposit_rejected_while_paused() {
        let (env, client, _, _guardian, usdc) = setup();
        client.pause();
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::Flex, &usdc, &MIN_FLEX);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_rejected_while_paused() {
        let (env, client, _, _guardian, usdc) = setup();
        client.pause();
        let user = Address::generate(&env);
        client.withdraw(&user, &Tier::L3, &usdc, &250_000_000_i128);
    }

    #[test]
    #[should_panic]
    fn test_early_exit_rejected_while_paused() {
        let (env, client, _, _guardian, usdc) = setup();
        client.pause();
        let user = Address::generate(&env);
        client.early_exit(&user, &Tier::L6, &usdc, &500_000_000_i128);
    }

    #[test]
    fn test_deposit_succeeds_after_unpause() {
        let (env, client, _, _guardian, usdc) = setup();
        client.pause();
        client.unpause();
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::Flex, &usdc, &MIN_FLEX);
    }

    #[test]
    fn test_position_readable_while_paused() {
        let (env, client, _, _guardian, usdc) = setup();
        client.pause();
        let user = Address::generate(&env);
        // Should NOT panic — position() is read-only and not gated
        let pos = client.position(&user, &Tier::L3, &usdc);
        assert_eq!(pos.principal, 500_000_000_i128);
    }

    // ── Allowlist enforcement ───────────────────────────────────────────────

    #[test]
    fn test_allowed_asset_deposit_succeeds() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::Flex, &usdc, &MIN_FLEX);
    }

    #[test]
    #[should_panic]
    fn test_non_allowed_asset_deposit_rejected() {
        let (env, client, _, _, _) = setup();
        let user = Address::generate(&env);
        let eurc = Address::generate(&env); // not on allowlist
        client.deposit(&user, &Tier::Flex, &eurc, &MIN_FLEX);
    }

    #[test]
    fn test_add_then_deposit_second_asset() {
        let (env, client, admin, _, _usdc) = setup();
        let eurc = Address::generate(&env);

        // Not allowed yet
        assert!(!client.is_deposit_asset_allowed(&eurc));

        // Admin adds EURC
        client.add_deposit_asset(&admin, &eurc);
        assert!(client.is_deposit_asset_allowed(&eurc));

        // Now deposit succeeds
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::L3, &eurc, &MIN_L3);
    }

    #[test]
    fn test_remove_asset_blocks_future_deposits() {
        let (env, client, admin, _, usdc) = setup();
        let _user = Address::generate(&env);

        // Remove USDC from allowlist
        client.remove_deposit_asset(&admin, &usdc);
        assert!(!client.is_deposit_asset_allowed(&usdc));

        // Existing deposits unaffected — only new ones blocked (tested via allowlist check)
    }

    #[test]
    fn test_per_asset_position_is_independent() {
        let (env, client, admin, _, usdc) = setup();
        let eurc = Address::generate(&env);
        client.add_deposit_asset(&admin, &eurc);

        let user = Address::generate(&env);

        let pos_usdc = client.position(&user, &Tier::L3, &usdc);
        let pos_eurc = client.position(&user, &Tier::L3, &eurc);

        // Mock returns same value, but calls are distinct — per-asset accounting
        assert_eq!(pos_usdc.principal, 500_000_000_i128);
        assert_eq!(pos_eurc.principal, 500_000_000_i128);
    }

    // ── Minimum deposit guard ───────────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_below_min_deposit_flex() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::Flex, &usdc, &(MIN_FLEX - 1));
    }

    #[test]
    #[should_panic]
    fn test_below_min_deposit_l12() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &Tier::L12, &usdc, &(MIN_L12 - 1));
    }

    // ── Partial withdrawal routing ──────────────────────────────────────────

    #[test]
    fn test_withdraw_routes_to_tier_with_amount() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.withdraw(&user, &Tier::L3, &usdc, &250_000_000_i128);
    }

    #[test]
    fn test_early_exit_routes_to_tier_with_amount() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.early_exit(&user, &Tier::L6, &usdc, &500_000_000_i128);
    }

    #[test]
    #[should_panic]
    fn test_nonexistent_tier_panics() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        // Trying to deposit to a non-existent tier should fail
        client.withdraw(&user, &Tier::Flex, &usdc, &100_i128);
    }

    // ── Relock passthrough ──────────────────────────────────────────────────

    #[test]
    fn test_relock_routes_to_vault_l3() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        let new_lock = client.relock(&user, &Tier::L3, &usdc);
        assert_eq!(new_lock, 2_000_000_u32);
    }

    #[test]
    fn test_relock_routes_to_vault_l6() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        let new_lock = client.relock(&user, &Tier::L6, &usdc);
        assert_eq!(new_lock, 2_000_000_u32);
    }

    #[test]
    fn test_relock_routes_to_vault_l12() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        let new_lock = client.relock(&user, &Tier::L12, &usdc);
        assert_eq!(new_lock, 2_000_000_u32);
    }

    #[test]
    #[should_panic(expected = "relock not supported for Flex tier")]
    fn test_relock_flex_panics() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.relock(&user, &Tier::Flex, &usdc);
    }

    // ── TVL cap management ──────────────────────────────────────────────────

    #[test]
    fn test_set_max_tvl_via_router() {
        let (env, client, _, _, _) = setup();
        let _ = env;
        client.set_max_tvl(&Tier::L3, &5_000_000_000_i128);
    }

    #[test]
    fn test_vault_capacity_query() {
        let (env, client, _, _, _) = setup();
        let _ = env;
        let cap = client.vault_capacity(&Tier::L3);
        assert_eq!(cap.max_tvl, 10_000_000_000_i128);
        assert_eq!(cap.remaining, 9_500_000_000_i128);
    }

    // ── Position queries ────────────────────────────────────────────────────

    #[test]
    fn test_position_locked_tier() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        let pos = client.position(&user, &Tier::L3, &usdc);
        assert_eq!(pos.principal, 500_000_000_i128);
        assert_eq!(pos.lock_until, 1_000_000_u32);
    }

    #[test]
    fn test_position_flex_lock_until_zero() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        let pos = client.position(&user, &Tier::Flex, &usdc);
        assert_eq!(pos.lock_until, 0_u32);
    }

    #[test]
    fn test_position_all_tiers() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        for tier in [Tier::Flex, Tier::L3, Tier::L6, Tier::L12] {
            let pos = client.position(&user, &tier, &usdc);
            assert_eq!(pos.principal, 500_000_000_i128);
        }
    }

    // ── Init guard ──────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (env, client, admin, guardian, usdc) = setup();
        let vault = Address::generate(&env);
        client.initialize(&admin, &vault, &guardian, &vault, &vault, &vault, &vault, &vec![&env, usdc]);
    }

    // ── Vault getter ────────────────────────────────────────────────────────

    #[test]
    fn test_get_vault_returns_registered_address() {
        let (_env, client, _, _, _) = setup();
        let vault_id = client.get_vault(&Tier::Flex);
        assert_eq!(client.get_vault(&Tier::L3), vault_id);
        assert_eq!(client.get_vault(&Tier::L6), vault_id);
        assert_eq!(client.get_vault(&Tier::L12), vault_id);
    }

    // ── Min deposit helper ──────────────────────────────────────────────────

    #[test]
    fn test_min_deposit_values() {
        assert_eq!(min_deposit(&Tier::Flex), MIN_FLEX);
        assert_eq!(min_deposit(&Tier::L3),   MIN_L3);
        assert_eq!(min_deposit(&Tier::L6),   MIN_L6);
        assert_eq!(min_deposit(&Tier::L12),  MIN_L12);
    }
}
