#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    BelowMinDeposit      = 2,
    LockNotExpired       = 3,
    NotYetMatured        = 4,
    DepositCapExceeded   = 5,
    Unauthorized         = 6,
    AmountExceedsBalance = 7,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    TotalShares,
    TotalBalance,
    Admin,
    Governance,
    Guardian,
    Strategy,
    Usdc,
    MaxTvl,
    Balance(Address, Address),     // (user, asset)
    Shares(Address, Address),      // (user, asset)
    LockUntil(Address, Address),   // (user, asset)
    Checkpoint(Address, Address),  // (user, asset)
    /// Emergency unlock flag, scoped per asset — when true for a given
    /// asset, early_exit and withdraw for THAT asset skip lock and fee
    /// enforcement so depositors can exit safely, without freezing/
    /// unfreezing every other asset in the tier (issue #138).
    EmergencyUnlock(Address),
}

const FP_MULTIPLIER: i128 = 1_000_000_0;

pub fn mul_fp(a: i128, b_fp: i128) -> i128 {
    (a * b_fp) / FP_MULTIPLIER
}

// 3-month lock duration in ledgers (~5 s/ledger)
const LOCK_DURATION: u32 = 777_600;

// Conservative default cap: 1,000,000 USDC (7 decimals)
const DEFAULT_MAX_TVL: i128 = 1_000_000_0_000_000;

#[contract]
pub struct VaultL3;

#[contractimpl]
impl VaultL3 {
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        guardian: Address,
        strategy: Address,
        usdc: Address,
        max_tvl: i128,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::Strategy, &strategy);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalBalance, &0i128);
        let cap = if max_tvl > 0 { max_tvl } else { DEFAULT_MAX_TVL };
        env.storage().instance().set(&DataKey::MaxTvl, &cap);
    }

    // ── Emergency Unlock ─────────────────────────────────────────────────────

    pub fn set_emergency_unlock(env: Env, asset: Address, active: bool) {
        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .expect("not initialized");
        guardian.require_auth();
        env.storage().persistent().set(&DataKey::EmergencyUnlock(asset), &active);
    }

    pub fn emergency_unlock(env: Env, asset: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::EmergencyUnlock(asset))
            .unwrap_or(false)
    }

    // ── Core vault operations ─────────────────────────────────────────────────

    /// Records a deposit of `asset` for `user`. VaultRouter has already
    /// moved the tokens from `user` to this contract before calling, so no
    /// token transfer happens here — this is bookkeeping only.
    pub fn deposit(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();

        if amount < 500_000_000 {
            panic_with_error!(&env, VaultError::BelowMinDeposit);
        }

        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        let max_tvl: i128 = env.storage().instance().get(&DataKey::MaxTvl).unwrap_or(DEFAULT_MAX_TVL);
        if total_balance + amount > max_tvl {
            panic_with_error!(&env, VaultError::DepositCapExceeded);
        }

        let multiplier_fp = 10_500_000;
        let new_shares = mul_fp(amount, multiplier_fp);

        let current_balance: i128 = env.storage().persistent().get(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let current_shares: i128 = env.storage().persistent().get(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);

        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(current_balance + amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(current_shares + new_shares));

        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares + new_shares));
        env.storage().instance().set(&DataKey::TotalBalance, &(total_balance + amount));

        let lock_until = env.ledger().sequence() + LOCK_DURATION;
        env.storage().persistent().set(&DataKey::LockUntil(user.clone(), asset.clone()), &lock_until);

        let checkpoint = env.ledger().sequence() + 1;
        env.storage().persistent().set(&DataKey::Checkpoint(user.clone(), asset.clone()), &checkpoint);
    }

    /// Withdraw `amount` from a matured position for `asset`.
    ///
    /// - If `amount >= balance`: full withdrawal — storage entries removed.
    /// - If `amount < balance`: partial withdrawal — burns proportional shares,
    ///   reduces Balance/Shares, leaves LockUntil/Checkpoint untouched.
    /// - If `amount > balance`: rejected with `AmountExceedsBalance`.
    pub fn withdraw(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        user.require_auth();

        let emergency: bool = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyUnlock(asset.clone()))
            .unwrap_or(false);

        if !emergency {
            let lock_until: u32 = env.storage().persistent().get(&DataKey::LockUntil(user.clone(), asset.clone())).unwrap_or(0);
            if env.ledger().sequence() < lock_until {
                panic_with_error!(&env, VaultError::LockNotExpired);
            }
        }

        let balance: i128 = env.storage().persistent().get(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let user_shares: i128 = env.storage().persistent().get(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);

        if amount > balance {
            panic_with_error!(&env, VaultError::AmountExceedsBalance);
        }

        if amount >= balance {
            // Full withdrawal — remove storage entries
            let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
            env.storage().instance().set(&DataKey::TotalShares, &(total_shares - user_shares));
            env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - balance).max(0));
            env.storage().persistent().remove(&DataKey::Balance(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Shares(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::LockUntil(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Checkpoint(user.clone(), asset.clone()));
            return balance;
        }

        // Partial withdrawal — burn proportional shares
        let shares_to_burn = (user_shares * amount) / balance;
        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(balance - amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(user_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - amount));

        amount
    }

    /// Early exit `amount` before maturity for `asset`, applying the exit
    /// fee only to the withdrawn amount.
    ///
    /// - If `amount >= balance`: full early exit.
    /// - If `amount < balance`: partial early exit, remainder stays.
    /// - If `amount > balance`: rejected with `AmountExceedsBalance`.
    pub fn early_exit(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        user.require_auth();

        let balance: i128 = env.storage().persistent().get(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let user_shares: i128 = env.storage().persistent().get(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);

        if amount > balance {
            panic_with_error!(&env, VaultError::AmountExceedsBalance);
        }

        let emergency: bool = env
            .storage()
            .persistent()
            .get(&DataKey::EmergencyUnlock(asset.clone()))
            .unwrap_or(false);

        // Exit fee: 0.50% on the withdrawn amount only
        let exit_fee_fp = 50_000;
        let net_amount = if emergency {
            amount
        } else {
            let fee = mul_fp(amount, exit_fee_fp);
            amount - fee
        };

        if amount >= balance {
            // Full early exit
            let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
            env.storage().instance().set(&DataKey::TotalShares, &(total_shares - user_shares));
            env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - balance).max(0));
            env.storage().persistent().remove(&DataKey::Balance(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Shares(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::LockUntil(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Checkpoint(user.clone(), asset.clone()));
            return net_amount;
        }

        // Partial early exit
        let shares_to_burn = (user_shares * amount) / balance;
        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(balance - amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(user_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - amount));

        net_amount
    }

    /// Update the max TVL cap. Only callable by the registered Governance address.
    pub fn set_max_tvl(env: Env, new_cap: i128) {
        let governance: Address = env.storage().instance().get(&DataKey::Governance).unwrap();
        governance.require_auth();
        env.storage().instance().set(&DataKey::MaxTvl, &new_cap);
    }

    pub fn max_tvl(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::MaxTvl).unwrap_or(DEFAULT_MAX_TVL)
    }

    pub fn remaining_capacity(env: Env) -> i128 {
        let max_tvl: i128 = env.storage().instance().get(&DataKey::MaxTvl).unwrap_or(DEFAULT_MAX_TVL);
        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        (max_tvl - total_balance).max(0)
    }

    pub fn relock(env: Env, user: Address, asset: Address) -> u32 {
        user.require_auth();

        let lock_until: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LockUntil(user.clone(), asset.clone()))
            .unwrap_or(0);

        if env.ledger().sequence() < lock_until {
            panic_with_error!(&env, VaultError::NotYetMatured);
        }

        let new_lock_until = env.ledger().sequence() + LOCK_DURATION;
        env.storage()
            .persistent()
            .set(&DataKey::LockUntil(user.clone(), asset.clone()), &new_lock_until);

        new_lock_until
    }

    pub fn lock_until(env: Env, user: Address, asset: Address) -> u32 {
        env.storage().persistent().get(&DataKey::LockUntil(user, asset)).unwrap_or(0)
    }

    pub fn balance(env: Env, user: Address, asset: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(user, asset)).unwrap_or(0)
    }

    pub fn shares(env: Env, user: Address, asset: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Shares(user, asset)).unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
    }

    pub fn total_balance(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::VaultL3;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, super::VaultL3Client<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register_contract(None, VaultL3);
        let client = super::VaultL3Client::new(&env, &vault_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let guardian = Address::generate(&env);
        let strategy = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.initialize(&admin, &governance, &guardian, &strategy, &usdc, &0i128);
        (env, client, governance, guardian, usdc)
    }

    #[test]
    fn test_deposit_records_balance_and_lock() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 500_000_000i128);
        assert!(client.lock_until(&user, &usdc) > 0);
    }

    #[test]
    #[should_panic]
    fn test_deposit_below_minimum_rejected() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &499_999_999i128);
    }

    #[test]
    #[should_panic]
    fn test_deposit_cap_exceeded_rejected() {
        let (env, client, governance, _, usdc) = setup();
        client.set_max_tvl(&governance, &600_000_000i128);
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &700_000_000i128);
    }

    #[test]
    fn test_positions_are_scoped_per_asset() {
        let (env, client, _, _, usdc) = setup();
        let eurc = Address::generate(&env);
        let user = Address::generate(&env);

        client.deposit(&user, &usdc, &500_000_000i128);
        client.deposit(&user, &eurc, &600_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 500_000_000i128);
        assert_eq!(client.balance(&user, &eurc), 600_000_000i128);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_before_maturity_rejected() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);
        client.withdraw(&user, &usdc, &500_000_000i128);
    }

    #[test]
    fn test_withdraw_after_maturity_succeeds() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);

        env.ledger().set_sequence(env.ledger().sequence() + super::LOCK_DURATION + 1);
        let payout = client.withdraw(&user, &usdc, &500_000_000i128);

        assert_eq!(payout, 500_000_000i128);
        assert_eq!(client.balance(&user, &usdc), 0i128);
    }

    #[test]
    fn test_partial_withdraw_leaves_remainder_and_lock() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);
        env.ledger().set_sequence(env.ledger().sequence() + super::LOCK_DURATION + 1);

        let payout = client.withdraw(&user, &usdc, &200_000_000i128);

        assert_eq!(payout, 200_000_000i128);
        assert_eq!(client.balance(&user, &usdc), 300_000_000i128);
        assert!(client.lock_until(&user, &usdc) > 0);
    }

    #[test]
    fn test_early_exit_applies_fee_before_maturity() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);

        let net = client.early_exit(&user, &usdc, &500_000_000i128);

        // 0.50% fee on 500_000_000 = 2_500_000
        assert_eq!(net, 497_500_000i128);
    }

    #[test]
    fn test_emergency_unlock_skips_lock_for_scoped_asset() {
        let (env, client, _, _guardian, usdc) = setup();
        let user = Address::generate(&env);

        client.deposit(&user, &usdc, &500_000_000i128);
        client.set_emergency_unlock(&usdc, &true);

        // usdc: emergency unlock active, no maturity enforcement.
        let payout = client.withdraw(&user, &usdc, &500_000_000i128);
        assert_eq!(payout, 500_000_000i128);
    }

    #[test]
    #[should_panic]
    fn test_emergency_unlock_does_not_leak_across_assets() {
        let (env, client, _, _guardian, usdc) = setup();
        let eurc = Address::generate(&env);
        let user = Address::generate(&env);

        client.deposit(&user, &usdc, &500_000_000i128);
        client.deposit(&user, &eurc, &500_000_000i128);
        client.set_emergency_unlock(&usdc, &true);

        // eurc: emergency unlock was only set for usdc, so eurc's lock must
        // still apply — must not have been globally lifted.
        client.withdraw(&user, &eurc, &500_000_000i128);
    }

    #[test]
    fn test_relock_extends_lock_after_maturity() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);
        env.ledger().set_sequence(env.ledger().sequence() + super::LOCK_DURATION + 1);

        let new_lock = client.relock(&user, &usdc);
        assert!(new_lock > env.ledger().sequence());
    }

    #[test]
    #[should_panic]
    fn test_relock_before_maturity_rejected() {
        let (env, client, _, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &500_000_000i128);
        client.relock(&user, &usdc);
    }
}
