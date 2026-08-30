//! Hand-computed 3-period scenario: every number below is derivable on paper.
//!
//! Setup: one person retiring after exactly one working year; zero inflation;
//! a single 100% bonds asset returning 10%; 20% flat tax.
//!
//! Period 0 (working): salary 50k, 10k pre-tax contribution,
//!   tax = (50k - 10k) * 20% = 8k, spending 32k → cash exactly 0.
//!   401(k): (100k + 10k) * 1.1 = 121k.
//! Period 1 (retired): need 32k net, all from pre-tax → gross 40k, tax 8k.
//!   401(k): (121k - 40k) * 1.1 = 89.1k.
//! Period 2: same → (89.1k - 40k) * 1.1 = 54.01k.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile,
    StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::presets::CONTRIBUTION_LIMITS;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection};

/// `run_deterministic` now taxes via real federal/state brackets
/// (`BracketTax`), which would make this file's hand-computed dollar
/// amounts depend on IRS bracket data instead of arithmetic anyone can
/// verify on paper. These tests care about `simulate()`'s own mechanics —
/// contributions, growth, withdrawal gross-up — not tax-law accuracy (that
/// has its own coverage in `strategies::tax`), so they call `simulate()`
/// directly with the trivial flat-rate `FlatTax`, matching the plan's old
/// "20% flat tax" framing exactly.
fn run_with_flat_tax(plan: &Plan, rate: f64) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(plan, &returns, &FlatTax { rate }, &ProportionalDrawdown, 0)
}

fn micro_plan() -> Plan {
    let person = "p1".to_string();
    let bonds_only = AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)]));
    Plan {
        id: "micro".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "micro".to_string(),
        people: vec![Person {
            id: person.clone(),
            name: "Solo".to_string(),
            birth: YearMonth::new(1966, 1),
            retirement: YearMonth::new(2027, 1),
        }],
        accounts: vec![Account {
            id: "401k".to_string(),
            owner: person.clone(),
            kind: AccountKind::TraditionalPreTax,
            name: "401k".to_string(),
            balance: 100_000.0,
            cost_basis: None,
            allocation: bonds_only,
            plan_type: PlanType::EmployerPlan,
            contribution: ContributionRule::FlatAmount(10_000.0),
        }],
        streams: vec![
            CashFlowStream {
                id: "salary".to_string(),
                name: "Salary".to_string(),
                owner: Some(person.clone()),
                direction: StreamDirection::Income,
                annual_amount: 50_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(person),
                growth: GrowthRule::None,
            },
            CashFlowStream {
                id: "spending".to_string(),
                name: "Spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 32_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::None,
            },
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::from([(AssetClass::UsBonds, 0.10)]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            // Person is 60 at plan start (2026); age 63 → end month 2029-01,
            // giving exactly 3 annual periods.
            plan_end_age: 63,
            sweep_surplus_to_taxable: false,
            social_security_cola: 0.0,
        },
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

#[test]
fn three_periods_match_hand_computation() {
    let projection = run_with_flat_tax(&micro_plan(), 0.20);
    assert_eq!(projection.snapshots.len(), 3);
    assert!(
        projection.warnings.is_empty(),
        "unexpected warnings: {:?}",
        projection.warnings
    );

    let p0 = &projection.snapshots[0];
    assert_close(p0.income, 50_000.0, "p0 income");
    assert_close(p0.contributions, 10_000.0, "p0 contributions");
    assert_close(p0.taxes, 8_000.0, "p0 taxes");
    assert_close(p0.expenses, 32_000.0, "p0 expenses");
    assert_close(p0.surplus, 0.0, "p0 surplus");
    assert!(p0.withdrawals.is_empty(), "p0 should have no withdrawals");
    assert_close(p0.net_worth, 121_000.0, "p0 net worth");
    assert_close(p0.deflator, 1.0, "p0 deflator");

    let p1 = &projection.snapshots[1];
    assert_close(p1.income, 0.0, "p1 income");
    assert_close(p1.taxes, 8_000.0, "p1 taxes");
    assert_close(p1.withdrawals["401k"], 40_000.0, "p1 gross withdrawal");
    assert_close(p1.net_worth, 89_100.0, "p1 net worth");

    let p2 = &projection.snapshots[2];
    assert_close(p2.withdrawals["401k"], 40_000.0, "p2 gross withdrawal");
    assert_close(p2.net_worth, 54_010.0, "p2 net worth");
}

/// A zero-balance, zero-contribution taxable account added to the micro plan,
/// with spending lowered so period 0 has positive leftover cash to sweep (or
/// not). Isolates the surplus-sweep toggle from the rest of the hand-checked
/// scenario.
fn micro_plan_with_taxable_account() -> Plan {
    let mut plan = micro_plan();
    plan.accounts.push(Account {
        id: "taxable".to_string(),
        owner: "p1".to_string(),
        kind: AccountKind::Taxable,
        name: "Taxable".to_string(),
        balance: 0.0,
        cost_basis: Some(0.0),
        allocation: AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 0.0)])),
        plan_type: PlanType::None,
        contribution: ContributionRule::FlatAmount(0.0),
    });
    for stream in &mut plan.streams {
        if stream.id == "spending" {
            // salary 50k - pretax contribution 10k - tax 8k - spending 20k = 12k cash.
            stream.annual_amount = 20_000.0;
        }
    }
    plan
}

#[test]
fn sweep_disabled_leaves_surplus_uninvested_but_reported() {
    let plan = micro_plan_with_taxable_account();
    assert!(!plan.assumptions.sweep_surplus_to_taxable);

    let projection = run_with_flat_tax(&plan, 0.20);
    let p0 = &projection.snapshots[0];
    assert_close(p0.surplus, 12_000.0, "p0 surplus");
    assert_close(
        p0.balances["taxable"],
        0.0,
        "taxable account should stay untouched",
    );
}

#[test]
fn sweep_enabled_invests_surplus_into_taxable_account() {
    let mut plan = micro_plan_with_taxable_account();
    plan.assumptions.sweep_surplus_to_taxable = true;

    let projection = run_with_flat_tax(&plan, 0.20);
    let p0 = &projection.snapshots[0];
    assert_close(p0.surplus, 12_000.0, "p0 surplus");
    assert_close(
        p0.balances["taxable"],
        12_000.0,
        "taxable account should absorb the surplus",
    );
}

#[test]
fn depletion_emits_warning_and_balances_stay_nonnegative() {
    let mut plan = micro_plan();
    for stream in &mut plan.streams {
        if stream.id == "spending" {
            stream.annual_amount = 200_000.0;
        }
    }
    let projection = run_with_flat_tax(&plan, 0.20);
    assert!(projection
        .warnings
        .iter()
        .any(|w| matches!(w, engine::SimWarning::DepletedFunds { .. })));
    for snapshot in &projection.snapshots {
        for (id, balance) in &snapshot.balances {
            assert!(*balance >= -1e-6, "negative balance in {id}: {balance}");
        }
    }
}

/// The micro plan's person turns 60 in 2026, so their employer-plan cap
/// includes the SECURE 2.0 age-60..=63 catch-up, and the plan has zero
/// inflation so nothing indexes. Read from the engine's own table rather
/// than restated here: these tests are about bucket sharing, not about
/// whether the seeded figures are current.
fn deferral_cap() -> f64 {
    CONTRIBUTION_LIMITS
        .annual_limit(PlanType::EmployerPlan, 60, 2026, 0.0)
        .expect("employer plans are capped")
}

fn ira_cap() -> f64 {
    CONTRIBUTION_LIMITS
        .annual_limit(PlanType::Ira, 60, 2026, 0.0)
        .expect("IRAs are capped")
}

#[test]
fn contribution_above_limit_is_clamped_with_warning() {
    let mut plan = micro_plan();
    plan.accounts[0].contribution = ContributionRule::FlatAmount(deferral_cap() + 10_000.0);
    let projection = run_with_flat_tax(&plan, 0.20);
    assert_eq!(
        clamp_for(&projection, "401k"),
        Some((deferral_cap() + 10_000.0, deferral_cap())),
        "clamped to the statutory cap, reported with both numbers",
    );
    assert_close(
        projection.snapshots[0].contributions,
        deferral_cap(),
        "clamped contributions",
    );
}

/// The clamp is reported with the numbers behind it, not just the account —
/// the UI has nothing else to render the shortfall from.
fn clamp_for(projection: &Projection, account: &str) -> Option<(f64, f64)> {
    projection.warnings.iter().find_map(|w| match w {
        engine::SimWarning::ContributionClamped {
            account: id,
            requested,
            allowed,
            ..
        } if id == account => Some((*requested, *allowed)),
        _ => None,
    })
}

/// Adds a second capped account to the micro plan's single person.
fn with_second_account(
    id: &str,
    kind: AccountKind,
    plan_type: PlanType,
    contribution: f64,
) -> Plan {
    let mut plan = micro_plan();
    plan.accounts.push(Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind,
        name: id.to_string(),
        balance: 0.0,
        cost_basis: None,
        allocation: AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
        plan_type,
        contribution: ContributionRule::FlatAmount(contribution),
    });
    plan
}

#[test]
fn two_employer_plans_share_one_deferral_limit_filled_in_plan_order() {
    // A 401(k) and a 403(b) do not each get their own elective-deferral
    // limit — the limit belongs to the person.
    let mut plan = with_second_account(
        "403b",
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
        deferral_cap(),
    );
    plan.accounts[0].contribution = ContributionRule::FlatAmount(deferral_cap());

    let projection = run_with_flat_tax(&plan, 0.20);
    assert_close(
        projection.snapshots[0].contributions,
        deferral_cap(),
        "one shared cap across both employer plans",
    );
    // Plan order decides: the first account listed fills, the second gets
    // what is left — here, nothing.
    assert_eq!(clamp_for(&projection, "401k"), None);
    assert_eq!(clamp_for(&projection, "403b"), Some((deferral_cap(), 0.0)));
}

#[test]
fn ira_and_employer_plan_are_capped_independently() {
    // Different buckets: filling the deferral limit leaves the IRA limit
    // entirely intact, and neither is clamped.
    let mut plan = with_second_account("roth-ira", AccountKind::Roth, PlanType::Ira, ira_cap());
    plan.accounts[0].contribution = ContributionRule::FlatAmount(deferral_cap());

    let projection = run_with_flat_tax(&plan, 0.20);
    assert_close(
        projection.snapshots[0].contributions,
        deferral_cap() + ira_cap(),
        "employer and IRA buckets are separate",
    );
    assert!(
        !projection
            .warnings
            .iter()
            .any(|w| matches!(w, engine::SimWarning::ContributionClamped { .. })),
        "nothing exceeded its bucket: {:?}",
        projection.warnings
    );
}

#[test]
fn traditional_and_roth_iras_share_one_ira_limit() {
    // Same bucket even though the kinds differ — the IRA limit is one cap
    // across a person's traditional and Roth IRAs.
    let mut plan = with_second_account("roth-ira", AccountKind::Roth, PlanType::Ira, ira_cap());
    plan.accounts[0].kind = AccountKind::TraditionalPreTax;
    plan.accounts[0].plan_type = PlanType::Ira;
    plan.accounts[0].contribution = ContributionRule::FlatAmount(ira_cap());

    let projection = run_with_flat_tax(&plan, 0.20);
    assert_close(
        projection.snapshots[0].contributions,
        ira_cap(),
        "one shared IRA cap",
    );
}

#[test]
fn plan_type_decides_the_bucket_not_the_tax_treatment() {
    // A traditional IRA and a 401(k) are both `TraditionalPreTax`; only
    // `plan_type` tells them apart. Before #32 the bucket was guessed from
    // whichever statutory figure the account's typed limit sat nearer.
    let mut plan = with_second_account(
        "traditional-ira",
        AccountKind::TraditionalPreTax,
        PlanType::Ira,
        ira_cap(),
    );
    plan.accounts[0].contribution = ContributionRule::FlatAmount(deferral_cap());

    let projection = run_with_flat_tax(&plan, 0.20);
    assert_close(
        projection.snapshots[0].contributions,
        deferral_cap() + ira_cap(),
        "same tax treatment, different buckets",
    );
    assert!(
        !projection
            .warnings
            .iter()
            .any(|w| matches!(w, engine::SimWarning::ContributionClamped { .. })),
        "nothing exceeded its bucket: {:?}",
        projection.warnings
    );
}

#[test]
fn limits_are_per_person_so_two_people_do_not_share_a_bucket() {
    let mut plan = with_second_account(
        "spouse-401k",
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
        deferral_cap(),
    );
    plan.accounts[0].contribution = ContributionRule::FlatAmount(deferral_cap());
    plan.accounts[1].owner = "p2".to_string();
    let mut spouse = plan.people[0].clone();
    spouse.id = "p2".to_string();
    spouse.name = "Spouse".to_string();
    plan.people.push(spouse);

    let projection = run_with_flat_tax(&plan, 0.20);
    assert_close(
        projection.snapshots[0].contributions,
        2.0 * deferral_cap(),
        "each person gets their own deferral limit",
    );
}
