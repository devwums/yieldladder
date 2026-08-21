use soroban_sdk::{Env, Address};

/// Record a deposit checkpoint for a specific (user, asset) position.
///
/// Asset-scoped so that a user holding positions in two different assets in
/// the same tier vault doesn't share a single eligibility window between
/// them (issue #138).
pub fn record_deposit_checkpoint(env: &Env, user: &Address, asset: &Address) {
    // Audit M-01 Fix: yield accrual window activates on the NEXT ledger sequence
    let next_eligible_ledger = env.ledger().sequence().checked_add(1).expect("Ledger max seq overflow");
    env.storage().persistent().set(&(user.clone(), asset.clone()), &next_eligible_ledger);
}

pub fn is_eligible_for_yield(env: &Env, user: &Address, asset: &Address) -> bool {
    let key = (user.clone(), asset.clone());
    if !env.storage().persistent().has(&key) {
        return false;
    }
    let activation_ledger: u32 = env.storage().persistent().get(&key).unwrap();
    env.ledger().sequence() >= activation_ledger
}
