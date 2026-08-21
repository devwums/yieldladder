#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, symbol_short};
use shared::fixed_point::SCALING_FACTOR;
use shared::checkpoint::record_deposit_checkpoint;

// Storage keys setup using Soroban instance and persistent frameworks
const ADMIN_KEY: Symbol = symbol_short!("admin");
const STRATEGY_KEY: Symbol = symbol_short!("strategy");
const TOTAL_SHARES_KEY: Symbol = symbol_short!("t_shares");
const TOTAL_BALANCE_KEY: Symbol = symbol_short!("t_bal");

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Balance(Address, Address), // (user, asset)
    Shares(Address, Address),  // (user, asset)
}

#[contract]
pub struct VaultFlex;

#[contractimpl]
impl VaultFlex {
    /// One-time initialization. Sets admin (VaultRouter) and strategy constraints.
    pub fn initialize(env: Env, admin: Address, strategy: Address) {
        if env.storage().instance().has(&ADMIN_KEY) {
            panic!("VaultFlex: Contract instance already initialized");
        }
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&STRATEGY_KEY, &strategy);
        env.storage().instance().set(&TOTAL_SHARES_KEY, &0i128);
        env.storage().instance().set(&TOTAL_BALANCE_KEY, &0i128);
    }

    /// Records a deposit of `asset` for `user`. Can only be invoked by the
    /// registered Admin (VaultRouter), which has already moved the tokens
    /// from `user` to this contract before calling.
    pub fn deposit(env: Env, user: Address, asset: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&ADMIN_KEY).expect("Uninitialized");
        admin.require_auth(); // Authorization Restriction: Only VaultRouter/Admin can call

        // Acceptance Criteria: Rejects any volume beneath 1.0000000 USDC (1 Stroop Unit Scalar)
        if amount < SCALING_FACTOR {
            panic!("VaultFlex: Deposit amount below minimum requirement of 1 USDC");
        }

        let current_balance = env.storage().persistent().get::<DataKey, i128>(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let current_shares = env.storage().persistent().get::<DataKey, i128>(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);
        let total_shares = env.storage().instance().get::<Symbol, i128>(&TOTAL_SHARES_KEY).unwrap_or(0);
        let total_balance = env.storage().instance().get::<Symbol, i128>(&TOTAL_BALANCE_KEY).unwrap_or(0);

        // Flex tier features a constant 1.00x share multiplier
        let structural_shares = amount;

        // Commit state parameters to persistent ledger
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(current_balance + amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(current_shares + structural_shares));
        env.storage().instance().set(&TOTAL_SHARES_KEY, &(total_shares + structural_shares));
        env.storage().instance().set(&TOTAL_BALANCE_KEY, &(total_balance + amount));

        // Audit M-01 Safeguard: Log checkpoint rule delay sequence via shared infrastructure
        record_deposit_checkpoint(&env, &user, &asset);
    }

    /// Withdraw `amount` from the caller's Flex position for `asset`. Only
    /// callable by Admin (VaultRouter), which pays the user out of its own
    /// balance after this call returns.
    ///
    /// Full-vs-partial semantics match VaultL3/VaultL6/VaultL12:
    /// - `amount >= balance`: full withdrawal, storage entries removed.
    /// - `amount < balance`: partial withdrawal, proportional shares burned.
    /// - `amount > balance`: rejected.
    ///
    /// Note: Flex previously computed a dynamic pro-rata payout from an
    /// externally supplied `strategy_balance` argument. VaultRouter now
    /// calls every tier vault with the same `(user, asset, amount)`
    /// signature and can no longer supply that argument, and StrategyVault
    /// pools capital from all tier vaults without attributing balance back
    /// to a single caller, so there is no accurate callback available
    /// without a StrategyVault redesign (out of scope for issue #138).
    /// Flex now tracks its own principal balance exactly like the locked
    /// tiers instead.
    pub fn withdraw(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        let admin: Address = env.storage().instance().get(&ADMIN_KEY).expect("Uninitialized");
        admin.require_auth();

        let balance: i128 = env.storage().persistent().get::<DataKey, i128>(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let user_shares: i128 = env.storage().persistent().get::<DataKey, i128>(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);

        if user_shares <= 0 || balance <= 0 {
            panic!("VaultFlex: Zero share profile detected or double-withdraw requested");
        }
        if amount > balance {
            panic!("VaultFlex: withdrawal amount exceeds balance");
        }

        let total_shares: i128 = env.storage().instance().get::<Symbol, i128>(&TOTAL_SHARES_KEY).unwrap_or(0);
        let total_balance: i128 = env.storage().instance().get::<Symbol, i128>(&TOTAL_BALANCE_KEY).unwrap_or(0);

        if amount >= balance {
            // Full withdrawal — remove storage entries
            env.storage().instance().set(&TOTAL_SHARES_KEY, &(total_shares - user_shares));
            env.storage().instance().set(&TOTAL_BALANCE_KEY, &(total_balance - balance).max(0));
            env.storage().persistent().remove(&DataKey::Balance(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Shares(user.clone(), asset.clone()));
            return balance;
        }

        // Partial withdrawal — burn proportional shares
        let shares_to_burn = (user_shares * amount) / balance;
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(balance - amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(user_shares - shares_to_burn));
        env.storage().instance().set(&TOTAL_SHARES_KEY, &(total_shares - shares_to_burn));
        env.storage().instance().set(&TOTAL_BALANCE_KEY, &(total_balance - amount));

        amount
    }

    /// Flex has no lock period, so early exit is equivalent to a plain
    /// withdrawal: no fee, no maturity check. Kept as a distinct entry
    /// point so VaultRouter's early_exit forwarding works uniformly across
    /// all four tiers.
    pub fn early_exit(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        Self::withdraw(env, user, asset, amount)
    }

    /// Flex has no lock; always returns 0. Present for ABI parity with the
    /// locked tiers so all four vaults share an identical signature set.
    pub fn lock_until(_env: Env, _user: Address, _asset: Address) -> u32 {
        0
    }

    /* --- Read-Only Query Methods --- */

    pub fn balance(env: Env, user: Address, asset: Address) -> i128 {
        env.storage().persistent().get::<DataKey, i128>(&DataKey::Balance(user, asset)).unwrap_or(0)
    }

    pub fn shares(env: Env, user: Address, asset: Address) -> i128 {
        env.storage().persistent().get::<DataKey, i128>(&DataKey::Shares(user, asset)).unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get::<Symbol, i128>(&TOTAL_SHARES_KEY).unwrap_or(0)
    }

    pub fn total_balance(env: Env) -> i128 {
        env.storage().instance().get::<Symbol, i128>(&TOTAL_BALANCE_KEY).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::VaultFlex;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, super::VaultFlexClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register_contract(None, VaultFlex);
        let client = super::VaultFlexClient::new(&env, &vault_id);
        let admin = Address::generate(&env);
        let strategy = Address::generate(&env);
        client.initialize(&admin, &strategy);
        (env, client, admin, strategy)
    }

    #[test]
    fn test_deposit_records_balance_and_shares() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);

        client.deposit(&user, &usdc, &50_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 50_000_000i128);
        assert_eq!(client.shares(&user, &usdc), 50_000_000i128);
        assert_eq!(client.total_balance(), 50_000_000i128);
        assert_eq!(client.total_shares(), 50_000_000i128);
    }

    #[test]
    #[should_panic]
    fn test_deposit_below_minimum_rejected() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &9_999_999i128);
    }

    #[test]
    fn test_deposits_are_scoped_per_asset() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        let eurc = Address::generate(&env);

        client.deposit(&user, &usdc, &20_000_000i128);
        client.deposit(&user, &eurc, &30_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 20_000_000i128);
        assert_eq!(client.balance(&user, &eurc), 30_000_000i128);
        assert_eq!(client.total_balance(), 50_000_000i128);
    }

    #[test]
    fn test_full_withdrawal_clears_position() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &50_000_000i128);

        let payout = client.withdraw(&user, &usdc, &50_000_000i128);

        assert_eq!(payout, 50_000_000i128);
        assert_eq!(client.balance(&user, &usdc), 0i128);
        assert_eq!(client.shares(&user, &usdc), 0i128);
        assert_eq!(client.total_balance(), 0i128);
    }

    #[test]
    fn test_partial_withdrawal_leaves_remainder() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &50_000_000i128);

        let payout = client.withdraw(&user, &usdc, &20_000_000i128);

        assert_eq!(payout, 20_000_000i128);
        assert_eq!(client.balance(&user, &usdc), 30_000_000i128);
        assert_eq!(client.shares(&user, &usdc), 30_000_000i128);
        assert_eq!(client.total_balance(), 30_000_000i128);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_exceeding_balance_rejected() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &50_000_000i128);
        client.withdraw(&user, &usdc, &50_000_001i128);
    }

    #[test]
    #[should_panic]
    fn test_double_withdraw_rejected() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &50_000_000i128);
        client.withdraw(&user, &usdc, &50_000_000i128);
        client.withdraw(&user, &usdc, &1i128);
    }

    #[test]
    fn test_early_exit_matches_withdraw_no_fee() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.deposit(&user, &usdc, &50_000_000i128);

        let payout = client.early_exit(&user, &usdc, &20_000_000i128);

        // No lock, no fee: early_exit pays out exactly the requested amount.
        assert_eq!(payout, 20_000_000i128);
        assert_eq!(client.balance(&user, &usdc), 30_000_000i128);
    }

    #[test]
    fn test_lock_until_always_zero() {
        let (env, client, _, _) = setup();
        let user = Address::generate(&env);
        let usdc = Address::generate(&env);
        assert_eq!(client.lock_until(&user, &usdc), 0u32);
        client.deposit(&user, &usdc, &50_000_000i128);
        assert_eq!(client.lock_until(&user, &usdc), 0u32);
    }

    #[test]
    #[should_panic]
    fn test_double_initialize_panics() {
        let (env, client, admin, strategy) = setup();
        let _ = env;
        client.initialize(&admin, &strategy);
    }
}
