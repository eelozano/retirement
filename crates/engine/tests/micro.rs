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
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, GrowthRule,
    PeriodLength, Person, Plan, SimConfig, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::run_deterministic;

fn micro_plan() -> Plan {
    let person = "p1".to_string();
    let bonds_only = AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)]));
    Plan {
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
            annual_contribution: 10_000.0,
            contribution_limit: Some(10_000.0),
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
            flat_tax_rate: 0.20,
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
    let projection = run_deterministic(&micro_plan());
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
        annual_contribution: 0.0,
        contribution_limit: None,
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

    let projection = run_deterministic(&plan);
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

    let projection = run_deterministic(&plan);
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
    let projection = run_deterministic(&plan);
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

#[test]
fn contribution_above_limit_is_clamped_with_warning() {
    let mut plan = micro_plan();
    plan.accounts[0].annual_contribution = 60_000.0; // limit stays 10k
    let projection = run_deterministic(&plan);
    assert!(projection
        .warnings
        .iter()
        .any(|w| matches!(w, engine::SimWarning::ContributionClamped { .. })));
    // Clamped to the 10k limit, so period 0 matches the base case exactly.
    assert_close(
        projection.snapshots[0].contributions,
        10_000.0,
        "clamped contributions",
    );
    assert_close(projection.snapshots[0].net_worth, 121_000.0, "p0 net worth");
}
