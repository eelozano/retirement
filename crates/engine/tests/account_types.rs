//! The account types added alongside `Savings`/`Hsa` and the `Plan457b`/
//! `Hsa`/`SepIra`/`SimpleIra` statutory buckets: each new bucket has its own
//! cap independent of the others (the motivating 457(b)-vs-401(k) case),
//! HSA contributions reduce taxable income the way a pre-tax account's do,
//! and a `Savings` account grows at its own configured rate rather than a
//! market-return allocation.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    StateTaxProfile, StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::presets::CONTRIBUTION_LIMITS;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection};

const INFLATION: f64 = 0.025;
const START_YEAR: i32 = 2026;
const SALARY: f64 = 300_000.0;

fn base_plan(accounts: Vec<Account>) -> Plan {
    let person = "p1".to_string();
    Plan {
        id: "account-types".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "account-types".to_string(),
        people: vec![Person {
            id: person.clone(),
            name: "Saver".to_string(),
            birth: YearMonth::new(1980, 1),
            retirement: YearMonth::new(2050, 1),
            life_expectancy_age: 71,
        }],
        accounts,
        streams: vec![
            CashFlowStream {
                id: "salary".to_string(),
                name: "Salary".to_string(),
                owner: Some(person.clone()),
                direction: StreamDirection::Income,
                annual_amount: SALARY,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(person),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "spending".to_string(),
                name: "Spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 1.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::None,
                survivor_percentage: None,
            },
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: INFLATION,
            asset_returns: BTreeMap::from([
                (AssetClass::UsBonds, 0.05),
                (AssetClass::UsEquity, 0.08),
            ]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 71,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start: YearMonth::new(START_YEAR, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn account(
    id: &str,
    kind: AccountKind,
    plan_type: PlanType,
    contribution: ContributionRule,
    allocation: AllocationRef,
) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind,
        name: id.to_string(),
        balance: 0.0,
        cost_basis: (kind == AccountKind::Taxable).then_some(0.0),
        allocation,
        plan_type,
        contributions: vec![Contribution::until_retirement(
            "contribution",
            contribution,
            &"p1".to_string(),
        )],
        employer_match: None,
    }
}

fn run(plan: &Plan) -> Projection {
    run_taxed(plan, 0.2)
}

fn run_taxed(plan: &Plan, rate: f64) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(plan, &returns, &FlatTax { rate }, &ProportionalDrawdown, 0)
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

fn contributions_in(projection: &Projection, account_id: &str, year: i32) -> f64 {
    // `contributions` on the snapshot is the household total; per-account
    // amounts aren't broken out there, so these tests use single-account
    // plans and read the aggregate.
    let _ = account_id;
    projection.snapshots[(year - START_YEAR) as usize].contributions
}

/// The motivating example from the `PlanType` doc comment: a 457(b) has a
/// statutorily separate limit from a 401(k), so a person can max out both
/// employer plans in the same year — the sum should be the two limits
/// added, not either one clamped against the other.
#[test]
fn a_457b_and_a_401k_share_no_contribution_cap() {
    let plan = base_plan(vec![
        account(
            "401k",
            AccountKind::TraditionalPreTax,
            PlanType::EmployerPlan,
            ContributionRule::FederalMaximum,
            AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
        ),
        account(
            "457b",
            AccountKind::TraditionalPreTax,
            PlanType::Plan457b,
            ContributionRule::FederalMaximum,
            AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
        ),
    ]);
    let projection = run(&plan);

    let total = contributions_in(&projection, "401k", START_YEAR);
    let expected = CONTRIBUTION_LIMITS
        .annual_limit(PlanType::EmployerPlan, 46, START_YEAR, INFLATION)
        .unwrap()
        + CONTRIBUTION_LIMITS
            .annual_limit(PlanType::Plan457b, 46, START_YEAR, INFLATION)
            .unwrap();
    assert_close(total, expected, "both plans hit their own full limit");
}

#[test]
fn sep_ira_and_simple_ira_resolve_to_their_own_limits() {
    let sep = run(&base_plan(vec![account(
        "sep",
        AccountKind::TraditionalPreTax,
        PlanType::SepIra,
        ContributionRule::FederalMaximum,
        AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
    )]));
    let simple = run(&base_plan(vec![account(
        "simple",
        AccountKind::TraditionalPreTax,
        PlanType::SimpleIra,
        ContributionRule::FederalMaximum,
        AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
    )]));

    assert_close(
        contributions_in(&sep, "sep", START_YEAR),
        CONTRIBUTION_LIMITS.sep_ira,
        "SEP-IRA resolves to its own limit",
    );
    assert_close(
        contributions_in(&simple, "simple", START_YEAR),
        CONTRIBUTION_LIMITS.simple_ira,
        "SIMPLE IRA resolves to its own limit",
    );
}

#[test]
fn hsa_catch_up_starts_at_55_not_50() {
    let at_50 = CONTRIBUTION_LIMITS
        .annual_limit(PlanType::Hsa, 50, START_YEAR, INFLATION)
        .unwrap();
    let at_54 = CONTRIBUTION_LIMITS
        .annual_limit(PlanType::Hsa, 54, START_YEAR, INFLATION)
        .unwrap();
    let at_55 = CONTRIBUTION_LIMITS
        .annual_limit(PlanType::Hsa, 55, START_YEAR, INFLATION)
        .unwrap();
    assert_close(at_50, at_54, "no catch-up yet at 50 or 54");
    assert!(at_55 > at_54, "the $1,000 catch-up starts exactly at 55");
}

/// An HSA contribution reduces taxable income the same way a
/// `TraditionalPreTax` contribution does — the pre-tax half of its
/// pretax-in/untaxed-out combination.
#[test]
fn an_hsa_contribution_reduces_taxable_income() {
    let with_hsa = run(&base_plan(vec![account(
        "hsa",
        AccountKind::Hsa,
        PlanType::Hsa,
        ContributionRule::FlatAmount { amount: 4_000.0 },
        AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
    )]));
    let without = run(&base_plan(vec![account(
        "hsa",
        AccountKind::Hsa,
        PlanType::Hsa,
        ContributionRule::FlatAmount { amount: 0.0 },
        AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
    )]));

    let tax_with = with_hsa.snapshots[0].taxes;
    let tax_without = without.snapshots[0].taxes;
    // FlatTax at 20%: $4,000 sheltered from ordinary income saves $800.
    assert_close(
        tax_without - tax_with,
        800.0,
        "the HSA deduction's tax savings",
    );
}

/// `AllocationRef::Cash` bypasses the asset-class return model entirely —
/// the account grows at exactly its configured rate regardless of what the
/// plan's market assumptions say. Run at 0% tax so the interest's own tax
/// bill — proven separately below — doesn't force a withdrawal that would
/// muddy this test's balance assertion.
#[test]
fn a_savings_account_grows_at_its_own_cash_rate_not_market_returns() {
    let mut plan = base_plan(vec![account(
        "savings",
        AccountKind::Savings,
        PlanType::None,
        ContributionRule::FlatAmount { amount: 0.0 },
        AllocationRef::Cash(0.045),
    )]);
    plan.accounts[0].balance = 10_000.0;
    // No income/expense flows so the balance only moves from growth.
    plan.streams.clear();

    let projection = run_taxed(&plan, 0.0);
    let balances = &projection.snapshots[0].balances;
    assert_close(
        balances["savings"],
        10_000.0 * 1.045,
        "grows at the configured 4.5% rate, not the plan's 5%/8% asset returns",
    );
}

/// A savings account has no cost basis: every dollar in it is already
/// taxed, so unlike a taxable brokerage there's nothing left to protect
/// from double taxation. Its interest is ordinary income in the period it
/// accrues, not deferred to withdrawal.
#[test]
fn a_savings_account_has_no_cost_basis_its_interest_is_taxed_as_it_accrues() {
    let mut plan = base_plan(vec![account(
        "savings",
        AccountKind::Savings,
        PlanType::None,
        ContributionRule::FlatAmount { amount: 0.0 },
        AllocationRef::Cash(0.045),
    )]);
    plan.accounts[0].balance = 10_000.0;
    plan.streams.clear();
    assert_eq!(
        plan.accounts[0].cost_basis, None,
        "a fresh Savings account carries no cost basis"
    );

    // FlatTax at 20%: $450 of interest costs $90, which nothing in this
    // no-income plan can fund except the account itself — proving the
    // interest was taxed as ordinary income the period it accrued, not
    // left untouched until some future withdrawal.
    let projection = run_taxed(&plan, 0.2);
    let first = &projection.snapshots[0];
    assert_close(first.taxes, 90.0, "20% of the $450 interest");
    assert_close(
        first.balances["savings"],
        10_000.0 * 1.045 - 90.0,
        "the tax on interest is funded by drawing on the account that earned it",
    );
}

#[test]
fn kind_and_plan_type_have_to_agree() {
    let mut plan = base_plan(vec![account(
        "hsa",
        AccountKind::Hsa,
        PlanType::Ira,
        ContributionRule::FlatAmount { amount: 0.0 },
        AllocationRef::Moderate,
    )]);
    let errors = plan.validate();
    assert!(
        errors.iter().any(|e| e.field == "accounts[0].plan_type"),
        "an HSA can only carry the Hsa plan type: {errors:?}"
    );

    plan.accounts[0].plan_type = PlanType::Hsa;
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
}

#[test]
fn a_savings_account_is_a_valid_reinvestment_destination() {
    let mut plan = base_plan(vec![account(
        "savings",
        AccountKind::Savings,
        PlanType::None,
        ContributionRule::FlatAmount { amount: 0.0 },
        AllocationRef::Cash(0.02),
    )]);
    plan.assumptions.reinvest_into = Some("savings".to_string());
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
}
