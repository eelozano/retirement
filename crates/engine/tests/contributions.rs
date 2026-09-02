//! The three contribution modes, against the indexed statutory limit table.
//!
//! The plan below is deliberately long and inflationary — the point of
//! `PercentOfSalary` and `FederalMaximum` is what they do over a career, and
//! neither differs from a flat amount in period 0.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile,
    StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::presets::CONTRIBUTION_LIMITS;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection};

const INFLATION: f64 = 0.025;
const START_YEAR: i32 = 2026;
const SALARY: f64 = 200_000.0;

/// Born January 1980, so the owner turns 46 in the first simulated year and
/// 50 in 2030 — the fifth period, well inside the working window.
fn plan_with(contribution: ContributionRule, kind: AccountKind, plan_type: PlanType) -> Plan {
    let person = "p1".to_string();
    Plan {
        id: "modes".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "modes".to_string(),
        people: vec![Person {
            id: person.clone(),
            name: "Saver".to_string(),
            birth: YearMonth::new(1980, 1),
            retirement: YearMonth::new(2050, 1),
            life_expectancy_age: 71,
        }],
        accounts: vec![Account {
            id: "plan".to_string(),
            owner: person.clone(),
            kind,
            name: "Plan".to_string(),
            balance: 0.0,
            cost_basis: None,
            // Zero return, so a snapshot balance is the running sum of what
            // actually went in — no growth to unwind.
            allocation: AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
            plan_type,
            contribution,
            employer_match: None,
        }],
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
            asset_returns: BTreeMap::from([(AssetClass::UsBonds, 0.0)]),
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

fn run(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &returns,
        &FlatTax { rate: 0.2 },
        &ProportionalDrawdown,
        0,
    )
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// Salary in the period starting `year`, grown from the plan's start.
fn salary_in(year: i32) -> f64 {
    SALARY * (1.0 + INFLATION).powi(year - START_YEAR)
}

fn contributions_in(projection: &Projection, year: i32) -> f64 {
    projection.snapshots[(year - START_YEAR) as usize].contributions
}

#[test]
fn percent_of_salary_rises_with_an_inflating_salary() {
    let plan = plan_with(
        ContributionRule::PercentOfSalary(0.08),
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);

    for year in [START_YEAR, START_YEAR + 1, START_YEAR + 12] {
        assert_close(
            contributions_in(&projection, year),
            0.08 * salary_in(year),
            &format!("8% of the {year} salary"),
        );
    }
    // The whole point: in today's dollars the contribution holds still,
    // where a flat nominal amount would visibly shrink every year.
    let real = |year: i32| {
        let snapshot = &projection.snapshots[(year - START_YEAR) as usize];
        snapshot.contributions / snapshot.deflator
    };
    assert_close(real(START_YEAR + 12), real(START_YEAR), "real terms hold");
}

#[test]
fn a_flat_amount_stays_nominal_and_so_decays_in_real_terms() {
    // Documented behavior, not an oversight: a fixed standing transfer is a
    // fixed number of dollars. The UI says so where it is entered.
    let plan = plan_with(
        ContributionRule::FlatAmount(10_000.0),
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, START_YEAR + 12),
        10_000.0,
        "flat in nominal dollars",
    );
}

#[test]
fn federal_maximum_steps_up_when_the_owner_turns_50() {
    let plan = plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);

    // Born January 1980: turns 49 in 2029 and 50 in 2030. Catch-up
    // eligibility is by the age attained during the year, so 2030 is the
    // first year it applies.
    let before = contributions_in(&projection, 2029);
    let after = contributions_in(&projection, 2030);
    assert_close(
        before,
        CONTRIBUTION_LIMITS
            .annual_limit(PlanType::EmployerPlan, 49, 2029, INFLATION)
            .unwrap(),
        "the plain deferral limit at 49",
    );
    assert!(
        after - before > 8_000.0,
        "turning 50 adds the catch-up tier: {before} -> {after}"
    );

    // And the higher SECURE 2.0 tier replaces it for the years they turn 60
    // through 63, then drops back to the ordinary catch-up at 64.
    assert!(
        contributions_in(&projection, 2040) > contributions_in(&projection, 2039),
        "age 60 steps up again"
    );
    // Comparing adjacent years isolates the tier change: one year of
    // indexing on the base limit cannot outweigh losing the higher tier.
    assert!(
        contributions_in(&projection, 2044) < contributions_in(&projection, 2043),
        "age 64 drops back to the ordinary catch-up"
    );
}

#[test]
fn federal_maximum_on_an_ira_resolves_to_the_ira_limit() {
    let employer = run(&plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    ));
    let ira = run(&plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::Roth,
        PlanType::Ira,
    ));

    assert_close(
        contributions_in(&ira, START_YEAR),
        CONTRIBUTION_LIMITS.ira,
        "the IRA limit, not the deferral limit",
    );
    assert!(
        contributions_in(&ira, START_YEAR) < contributions_in(&employer, START_YEAR),
        "the IRA bucket is the separate, much smaller one",
    );
}

#[test]
fn limits_index_forward_from_the_basis_year() {
    let plan = plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, START_YEAR),
        CONTRIBUTION_LIMITS.employer_plan,
        "the seeded figure applies unindexed in its own basis year",
    );
    assert!(
        contributions_in(&projection, START_YEAR + 12) > 1.3 * CONTRIBUTION_LIMITS.employer_plan,
        "12 years of indexing at 2.5% is a third again, before catch-up",
    );
}

/// Indexed figures step in statutory increments rather than drifting
/// smoothly, which is what the real schedule does.
#[test]
fn indexed_limits_round_down_to_statutory_increments() {
    for year in START_YEAR..START_YEAR + 25 {
        let limit = CONTRIBUTION_LIMITS
            .annual_limit(PlanType::EmployerPlan, 40, year, INFLATION)
            .unwrap();
        assert_close(limit % 500.0, 0.0, &format!("{year} limit lands on $500"));
    }
}

#[test]
fn a_taxable_account_has_no_federal_maximum_to_resolve() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount(0.0),
        AccountKind::Taxable,
        PlanType::None,
    );
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());

    plan.accounts[0].contribution = ContributionRule::FederalMaximum;
    let errors = plan.validate();
    assert!(
        errors.iter().any(|e| e.field == "accounts[0].contribution"),
        "a taxable brokerage has no statutory maximum: {errors:?}"
    );
}

#[test]
fn a_clamp_is_reported_once_for_the_first_year_it_bites() {
    // 20% of a $200k salary is far above the deferral limit, and stays
    // above it for every year of the projection — one finding, not thirty.
    let plan = plan_with(
        ContributionRule::PercentOfSalary(0.20),
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    let clamps: Vec<_> = projection
        .warnings
        .iter()
        .filter_map(|w| match w {
            engine::SimWarning::ContributionClamped {
                period, allowed, ..
            } => Some((*period, *allowed)),
            _ => None,
        })
        .collect();
    assert_eq!(clamps.len(), 1, "reported once: {clamps:?}");
    assert_eq!(clamps[0].0, 0, "reported for the first period it bites");
    assert_close(
        clamps[0].1,
        CONTRIBUTION_LIMITS.employer_plan,
        "held to the statutory cap",
    );
}
