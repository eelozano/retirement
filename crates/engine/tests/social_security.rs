//! Social Security benefit resolution: claiming-age adjustment, COLA, and
//! the unknown-owner warning path — exercised end-to-end through
//! `run_deterministic`, not just the pure `adjustment_factor` formula.

use engine::model::TaxFigures;
use engine::model::{
    FullRetirementAge, PeriodLength, Person, Plan, SimConfig, SocialSecurityBenefit, YearMonth,
    SCHEMA_VERSION,
};
use engine::run_deterministic;

const BENEFIT_AT_FRA: f64 = 20_000.0;

/// A single person with one Social Security benefit and nothing else — no
/// accounts, no other streams — so `PeriodSnapshot::income` is exactly the
/// benefit's resolved annual amount with no other cash flow to net against.
/// `sim_config.start` is set to the exact month the person turns
/// `claiming_age`, so period 0 covers the claiming year with fraction 1.0
/// and zero elapsed years (no COLA compounding yet), keeping assertions
/// exact rather than proration-affected.
fn plan_with(
    full_retirement_age: u8,
    claiming_age: u8,
    plan_cola: f64,
    cola_override: Option<f64>,
) -> Plan {
    let owner = "p1".to_string();
    let birth = YearMonth::new(2000, 1);
    let start = YearMonth::new(2000 + claiming_age as i32, 1);
    Plan {
        id: "ss-test".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "ss-test".to_string(),
        sample: false,
        people: vec![Person {
            id: owner.clone(),
            name: "Solo".to_string(),
            birth,
            retirement: birth.add_years(1),
            life_expectancy_age: claiming_age + 3,
        }],
        accounts: vec![],
        streams: vec![],
        social_security: vec![SocialSecurityBenefit {
            id: "ss1".to_string(),
            owner,
            benefit_at_fra: BENEFIT_AT_FRA,
            full_retirement_age: Some(FullRetirementAge::new(full_retirement_age, 0)),
            claiming_age,
            cola_override,
        }],
        assumptions: engine::model::Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            filing_status: engine::model::FilingStatus::Single,
            state_tax: engine::model::StateTaxProfile::none(),
            plan_end_age: claiming_age + 3,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: plan_cola,
            strategy_volatility: Default::default(),
            reinvest_into: None,
            drawdown: Default::default(),
        },
        sim_config: SimConfig {
            start,
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
fn claiming_at_fra_pays_unadjusted_pia() {
    let plan = plan_with(67, 67, 0.0, Some(0.0));
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(projection.snapshots[0].income, BENEFIT_AT_FRA, "p0 income");
}

#[test]
fn claiming_early_applies_reduction() {
    let plan = plan_with(67, 62, 0.0, Some(0.0));
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 0.70,
        "p0 income",
    );
}

#[test]
fn claiming_delayed_applies_credit() {
    let plan = plan_with(66, 70, 0.0, Some(0.0));
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 1.32,
        "p0 income",
    );
}

/// A mid-year FRA all the way through the simulation, not just the pure
/// formula: born 1957, FRA 66y6m, claimed at 62 is 54 months early and pays
/// 72.5% of the PIA. Neither 66 nor 67 can express it, which is #149.
#[test]
fn a_mid_year_full_retirement_age_is_projected_exactly() {
    let mut plan = plan_with(67, 62, 0.0, Some(0.0));
    plan.social_security[0].full_retirement_age = Some(FullRetirementAge::new(66, 6));
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 0.725,
        "p0 income",
    );
}

/// With no override the engine takes SSA's age for the owner's birth year.
/// `plan_with` births everyone in 2000, which is the 1960-and-later cohort,
/// so the benefit pays exactly what a stated FRA of 67 would.
#[test]
fn an_absent_full_retirement_age_derives_from_the_birth_year() {
    let mut plan = plan_with(67, 62, 0.0, Some(0.0));
    plan.social_security[0].full_retirement_age = None;
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 0.70,
        "p0 income",
    );
}

#[test]
fn unknown_owner_produces_warning() {
    let mut plan = plan_with(67, 67, 0.0, Some(0.0));
    plan.social_security[0].owner = "nobody".to_string();
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert!(projection
        .warnings
        .iter()
        .any(|w| matches!(w, engine::SimWarning::UnknownPersonRef { .. })));
    assert_close(projection.snapshots[0].income, 0.0, "p0 income");
}

#[test]
fn cola_override_beats_plan_default() {
    // Plan default COLA is 2%; this benefit overrides to 5%. One year after
    // claiming (period 1), growth should reflect 5%, not 2%.
    let plan = plan_with(67, 67, 0.02, Some(0.05));
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert_close(
        projection.snapshots[1].income,
        BENEFIT_AT_FRA * 1.05,
        "p1 income",
    );
}
