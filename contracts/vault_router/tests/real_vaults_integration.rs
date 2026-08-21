//! Integration tests that exercise VaultRouter against the *real* tier vault
//! contracts (VaultFlex, VaultL3, VaultL6, VaultL12) — not the hand-written
//! MockVault used by vault_router's own unit tests — across two allowlisted
//! assets. This is what would have caught the ABI mismatch fixed in
//! issue #138 before it reached a real deployment.

use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env,
};
use vault_router::{Tier, VaultRouter, VaultRouterClient};

struct Harness<'a> {
    env: Env,
    router: VaultRouterClient<'a>,
    usdc: Address,
    eurc: Address,
}

fn setup() -> Harness<'static> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let governance = Address::generate(&env);
    let guardian = Address::generate(&env);
    let strategy = Address::generate(&env);

    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let eurc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let router_id = env.register_contract(None, VaultRouter);
    let router = VaultRouterClient::new(&env, &router_id);

    let flex_id = env.register_contract(None, vault_flex::VaultFlex);
    let l3_id = env.register_contract(None, vault_l3::VaultL3);
    let l6_id = env.register_contract(None, vault_l6::VaultL6);
    let l12_id = env.register_contract(None, vault_l12::VaultL12);

    // Every tier vault's Admin is the router: deposit/withdraw/early_exit
    // are only callable by whichever address invokes them, which in
    // production is always the router.
    vault_flex::VaultFlexClient::new(&env, &flex_id).initialize(&router_id, &strategy);
    vault_l3::VaultL3Client::new(&env, &l3_id).initialize(
        &router_id, &governance, &guardian, &strategy, &usdc, &0i128,
    );
    vault_l6::VaultL6Client::new(&env, &l6_id).initialize(
        &router_id, &governance, &strategy, &usdc, &0i128,
    );
    vault_l12::VaultL12Client::new(&env, &l12_id).initialize(
        &router_id, &governance, &strategy, &usdc, &0i128,
    );

    router.initialize(
        &admin,
        &governance,
        &guardian,
        &flex_id,
        &l3_id,
        &l6_id,
        &l12_id,
        &vec![&env, usdc.clone(), eurc.clone()],
    );

    Harness { env, router, usdc, eurc }
}

fn fund(env: &Env, asset: &Address, user: &Address, amount: i128) {
    StellarAssetClient::new(env, asset).mint(user, &amount);
}

/// Acceptance criterion: VaultRouter.deposit/withdraw/early_exit succeed
/// end-to-end against real (non-mock) instances of all four tier vaults,
/// for at least two allowlisted assets.
#[test]
fn test_deposit_withdraw_early_exit_across_all_tiers_and_two_assets() {
    let h = setup();
    let env = &h.env;
    let user = Address::generate(env);

    let starting_balance = 20_000_000_000i128;
    fund(env, &h.usdc, &user, starting_balance);
    fund(env, &h.eurc, &user, starting_balance);

    // Deposit into every tier, for both assets.
    h.router.deposit(&user, &Tier::Flex, &h.usdc, &10_000_000i128);
    h.router.deposit(&user, &Tier::Flex, &h.eurc, &10_000_000i128);
    h.router.deposit(&user, &Tier::L3, &h.usdc, &500_000_000i128);
    h.router.deposit(&user, &Tier::L3, &h.eurc, &500_000_000i128);
    h.router.deposit(&user, &Tier::L6, &h.usdc, &1_000_000_000i128);
    h.router.deposit(&user, &Tier::L6, &h.eurc, &1_000_000_000i128);
    h.router.deposit(&user, &Tier::L12, &h.usdc, &2_500_000_000i128);
    h.router.deposit(&user, &Tier::L12, &h.eurc, &2_500_000_000i128);

    // Positions are recorded correctly, independently per asset per tier.
    assert_eq!(h.router.position(&user, &Tier::Flex, &h.usdc).principal, 10_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::Flex, &h.eurc).principal, 10_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::L3, &h.usdc).principal, 500_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::L3, &h.eurc).principal, 500_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::L12, &h.eurc).principal, 2_500_000_000i128);

    // A single deposit must move funds exactly once, not twice.
    let usdc_token = TokenClient::new(env, &h.usdc);
    let eurc_token = TokenClient::new(env, &h.eurc);
    let deposited_per_asset = 10_000_000i128 + 500_000_000i128 + 1_000_000_000i128 + 2_500_000_000i128;
    assert_eq!(usdc_token.balance(&user), starting_balance - deposited_per_asset);
    assert_eq!(eurc_token.balance(&user), starting_balance - deposited_per_asset);

    // Flex has no lock: withdraw succeeds immediately, for both assets, and
    // pays the user back in full.
    h.router.withdraw(&user, &Tier::Flex, &h.usdc, &10_000_000i128);
    h.router.withdraw(&user, &Tier::Flex, &h.eurc, &10_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::Flex, &h.usdc).principal, 0i128);
    assert_eq!(usdc_token.balance(&user), starting_balance - (500_000_000i128 + 1_000_000_000i128 + 2_500_000_000i128));

    // Locked tiers: early_exit succeeds before maturity (fee applied), for
    // both assets, across all three locked tiers.
    h.router.early_exit(&user, &Tier::L3, &h.usdc, &500_000_000i128);
    h.router.early_exit(&user, &Tier::L3, &h.eurc, &500_000_000i128);
    h.router.early_exit(&user, &Tier::L6, &h.usdc, &1_000_000_000i128);
    h.router.early_exit(&user, &Tier::L6, &h.eurc, &1_000_000_000i128);
    h.router.early_exit(&user, &Tier::L12, &h.usdc, &2_500_000_000i128);
    h.router.early_exit(&user, &Tier::L12, &h.eurc, &2_500_000_000i128);

    assert_eq!(h.router.position(&user, &Tier::L3, &h.usdc).principal, 0i128);
    assert_eq!(h.router.position(&user, &Tier::L6, &h.eurc).principal, 0i128);
    assert_eq!(h.router.position(&user, &Tier::L12, &h.usdc).principal, 0i128);
}

/// Regression test for the double-transfer bug: before this fix, each tier
/// vault's deposit() moved funds a second time (user -> strategy) on top of
/// the router's own user -> vault transfer, using a hardcoded token address
/// that ignored the `asset` parameter entirely. A single deposit must debit
/// the user exactly once, in the asset actually deposited.
#[test]
fn test_deposit_moves_funds_exactly_once_per_asset() {
    let h = setup();
    let env = &h.env;
    let user = Address::generate(env);

    fund(env, &h.usdc, &user, 1_000_000_000i128);
    fund(env, &h.eurc, &user, 1_000_000_000i128);

    h.router.deposit(&user, &Tier::L3, &h.eurc, &500_000_000i128);

    let usdc_token = TokenClient::new(env, &h.usdc);
    let eurc_token = TokenClient::new(env, &h.eurc);

    // eurc debited by exactly the deposited amount...
    assert_eq!(eurc_token.balance(&user), 500_000_000i128);
    // ...and usdc untouched, proving the vault no longer moves the wrong
    // (hardcoded) token regardless of which asset was actually deposited.
    assert_eq!(usdc_token.balance(&user), 1_000_000_000i128);
}

/// Two allowlisted assets held simultaneously in the same tier must not
/// cross-contaminate share/lock accounting (issue #138 edge case).
#[test]
fn test_two_assets_in_same_tier_are_independent() {
    let h = setup();
    let env = &h.env;
    let user = Address::generate(env);

    fund(env, &h.usdc, &user, 2_000_000_000i128);
    fund(env, &h.eurc, &user, 2_000_000_000i128);

    h.router.deposit(&user, &Tier::L6, &h.usdc, &1_000_000_000i128);
    h.router.deposit(&user, &Tier::L6, &h.eurc, &1_500_000_000i128);

    let pos_usdc = h.router.position(&user, &Tier::L6, &h.usdc);
    let pos_eurc = h.router.position(&user, &Tier::L6, &h.eurc);

    assert_eq!(pos_usdc.principal, 1_000_000_000i128);
    assert_eq!(pos_eurc.principal, 1_500_000_000i128);
    // VaultL6's multiplier is 1.15x (11_500_000 fp): shares = principal * 1.15
    assert_eq!(pos_usdc.shares, 1_150_000_000i128);
    assert_eq!(pos_eurc.shares, 1_725_000_000i128);

    // Fully exiting the usdc position must not touch the eurc position.
    h.router.early_exit(&user, &Tier::L6, &h.usdc, &1_000_000_000i128);
    assert_eq!(h.router.position(&user, &Tier::L6, &h.usdc).principal, 0i128);
    assert_eq!(h.router.position(&user, &Tier::L6, &h.eurc).principal, 1_500_000_000i128);
}
