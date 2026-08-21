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
    Strategy,
    Usdc,
    MaxTvl,
    Balance(Address, Address),    // (user, asset)
    Shares(Address, Address),     // (user, asset)
    LockUntil(Address, Address),  // (user, asset)
    Checkpoint(Address, Address), // (user, asset)
}

const FP_MULTIPLIER: i128 = 1_000_000_0;

pub fn mul_fp(a: i128, b_fp: i128) -> i128 {
    (a * b_fp) / FP_MULTIPLIER
}

// 12-month lock duration in ledgers (~5 s/ledger)
const LOCK_DURATION: u32 = 3_110_400;
const DEFAULT_MAX_TVL: i128 = 1_000_000_0_000_000;

#[contract]
pub struct VaultL12;

#[contractimpl]
impl VaultL12 {
    pub fn initialize(
        env: Env,
        admin: Address,
        governance: Address,
        strategy: Address,
        usdc: Address,
        max_tvl: i128,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::Strategy, &strategy);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalBalance, &0i128);
        let cap = if max_tvl > 0 { max_tvl } else { DEFAULT_MAX_TVL };
        env.storage().instance().set(&DataKey::MaxTvl, &cap);
    }

    /// Records a deposit of `asset` for `user`. VaultRouter has already
    /// moved the tokens from `user` to this contract before calling, so no
    /// token transfer happens here — this is bookkeeping only.
    pub fn deposit(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();

        if amount < 2_500_000_000 {
            panic_with_error!(&env, VaultError::BelowMinDeposit);
        }

        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        let max_tvl: i128 = env.storage().instance().get(&DataKey::MaxTvl).unwrap_or(DEFAULT_MAX_TVL);
        if total_balance + amount > max_tvl {
            panic_with_error!(&env, VaultError::DepositCapExceeded);
        }

        let multiplier_fp = 13_000_000;
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
    pub fn withdraw(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        user.require_auth();

        let lock_until: u32 = env.storage().persistent().get(&DataKey::LockUntil(user.clone(), asset.clone())).unwrap_or(0);
        if env.ledger().sequence() < lock_until {
            panic_with_error!(&env, VaultError::LockNotExpired);
        }

        let balance: i128 = env.storage().persistent().get(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let user_shares: i128 = env.storage().persistent().get(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);

        if amount > balance {
            panic_with_error!(&env, VaultError::AmountExceedsBalance);
        }

        if amount >= balance {
            let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
            env.storage().instance().set(&DataKey::TotalShares, &(total_shares - user_shares));
            env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - balance).max(0));
            env.storage().persistent().remove(&DataKey::Balance(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Shares(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::LockUntil(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Checkpoint(user.clone(), asset.clone()));
            return balance;
        }

        let shares_to_burn = (user_shares * amount) / balance;
        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(balance - amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(user_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - amount));

        amount
    }

    /// Early exit `amount` before maturity for `asset`.
    pub fn early_exit(env: Env, user: Address, asset: Address, amount: i128) -> i128 {
        user.require_auth();

        let balance: i128 = env.storage().persistent().get(&DataKey::Balance(user.clone(), asset.clone())).unwrap_or(0);
        let user_shares: i128 = env.storage().persistent().get(&DataKey::Shares(user.clone(), asset.clone())).unwrap_or(0);
        let total_shares: i128 = env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);

        if amount > balance {
            panic_with_error!(&env, VaultError::AmountExceedsBalance);
        }

        // Exit fee: 2.50% on withdrawn amount only
        let exit_fee_fp = 250_000;
        let fee = mul_fp(amount, exit_fee_fp);
        let net_amount = amount - fee;

        if amount >= balance {
            let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
            env.storage().instance().set(&DataKey::TotalShares, &(total_shares - user_shares));
            env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - balance).max(0));
            env.storage().persistent().remove(&DataKey::Balance(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Shares(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::LockUntil(user.clone(), asset.clone()));
            env.storage().persistent().remove(&DataKey::Checkpoint(user.clone(), asset.clone()));
            return net_amount;
        }

        let shares_to_burn = (user_shares * amount) / balance;
        let total_balance: i128 = env.storage().instance().get(&DataKey::TotalBalance).unwrap_or(0);
        env.storage().persistent().set(&DataKey::Balance(user.clone(), asset.clone()), &(balance - amount));
        env.storage().persistent().set(&DataKey::Shares(user.clone(), asset.clone()), &(user_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares_to_burn));
        env.storage().instance().set(&DataKey::TotalBalance, &(total_balance - amount));

        net_amount
    }

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

    use super::VaultL12;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, super::VaultL12Client<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let vault_id = env.register_contract(None, VaultL12);
        let client = super::VaultL12Client::new(&env, &vault_id);
        let admin = Address::generate(&env);
        let governance = Address::generate(&env);
        let strategy = Address::generate(&env);
        let usdc = Address::generate(&env);
        client.initialize(&admin, &governance, &strategy, &usdc, &0i128);
        (env, client, governance, usdc)
    }

    #[test]
    fn test_deposit_records_balance_and_lock() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 2_500_000_000i128);
        assert!(client.lock_until(&user, &usdc) > 0);
    }

    #[test]
    fn test_positions_are_scoped_per_asset() {
        let (env, client, _, usdc) = setup();
        let eurc = Address::generate(&env);
        let user = Address::generate(&env);

        client.deposit(&user, &usdc, &2_500_000_000i128);
        client.deposit(&user, &eurc, &3_000_000_000i128);

        assert_eq!(client.balance(&user, &usdc), 2_500_000_000i128);
        assert_eq!(client.balance(&user, &eurc), 3_000_000_000i128);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_before_maturity_rejected() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);
        client.withdraw(&user, &usdc, &2_500_000_000i128);
    }

    #[test]
    fn test_withdraw_after_maturity_succeeds() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);

        env.ledger().set_sequence(env.ledger().sequence() + super::LOCK_DURATION + 1);
        let payout = client.withdraw(&user, &usdc, &2_500_000_000i128);

        assert_eq!(payout, 2_500_000_000i128);
    }

    #[test]
    fn test_early_exit_applies_fee() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);

        let net = client.early_exit(&user, &usdc, &2_500_000_000i128);

        // 2.50% fee on 2_500_000_000 = 62_500_000
        assert_eq!(net, 2_437_500_000i128);
    }

    #[test]
    fn test_relock_extends_lock_after_maturity() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);
        env.ledger().set_sequence(env.ledger().sequence() + super::LOCK_DURATION + 1);

        let new_lock = client.relock(&user, &usdc);
        assert!(new_lock > env.ledger().sequence());
    }

    #[test]
    #[should_panic]
    fn test_relock_before_maturity_rejected() {
        let (env, client, _, usdc) = setup();
        let user = Address::generate(&env);
        client.deposit(&user, &usdc, &2_500_000_000i128);
        client.relock(&user, &usdc);
    }
}
