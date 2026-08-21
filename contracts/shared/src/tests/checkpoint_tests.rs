#![cfg(test)]
use soroban_sdk::{Env, Address, testutils::Address as _};
use crate::checkpoint::{record_deposit_checkpoint, is_eligible_for_yield};

#[test]
fn test_same_ledger_frontrunning_protection() {
    let env = Env::default();
    let user = Address::generate(&env);
    let asset = Address::generate(&env);

    env.ledger().set_sequence(10050);
    record_deposit_checkpoint(&env, &user, &asset);

    // Audit M-01 verification checkpoint: Depositing inside active sequence block MUST yield ineligible for execution rewards
    assert_eq!(is_eligible_for_yield(&env, &user, &asset), false);

    // Advance sequence frame explicitly to activate yield window eligibility
    env.ledger().set_sequence(10051);
    assert_eq!(is_eligible_for_yield(&env, &user, &asset), true);
}

#[test]
fn test_checkpoint_is_scoped_per_asset() {
    let env = Env::default();
    let user = Address::generate(&env);
    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);

    env.ledger().set_sequence(500);
    record_deposit_checkpoint(&env, &user, &asset_a);

    // A checkpoint recorded for asset_a must not make asset_b eligible.
    assert_eq!(is_eligible_for_yield(&env, &user, &asset_a), false);
    assert_eq!(is_eligible_for_yield(&env, &user, &asset_b), false);

    env.ledger().set_sequence(501);
    assert_eq!(is_eligible_for_yield(&env, &user, &asset_a), true);
    assert_eq!(is_eligible_for_yield(&env, &user, &asset_b), false);
}
