//! Social Security benefit resolution: claiming-age adjustment, COLA, and
//! the unknown-owner warning path — exercised end-to-end through
//! `run_deterministic`, not just the pure `adjustment_factor` formula.

use engine::model::{
    PeriodLength, Person, Plan, SimConfig, SocialSecurityBenefit, YearMonth, SCHEMA_VERSION,
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
        schema_version: SCHEMA_VERSION,
        name: "ss-test".to_string(),
        people: vec![Person {
            id: owner.clone(),
            name: "Solo".to_string(),
            birth,
            retirement: birth.add_years(1),
        }],
        accounts: vec![],
        streams: vec![],
        social_security: vec![SocialSecurityBenefit {
            id: "ss1".to_string(),
            owner,
            benefit_at_fra: BENEFIT_AT_FRA,
            full_retirement_age,
            claiming_age,
            cola_override,
        }],
        assumptions: engine::model::Assumptions {
            inflation: 0.0,
            asset_returns: Default::default(),
            flat_tax_rate: 0.0,
            plan_end_age: claiming_age + 3,
            sweep_surplus_to_taxable: false,
            social_security_cola: plan_cola,
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
    let projection = run_deterministic(&plan);
    assert_close(projection.snapshots[0].income, BENEFIT_AT_FRA, "p0 income");
}

#[test]
fn claiming_early_applies_reduction() {
    let plan = plan_with(67, 62, 0.0, Some(0.0));
    let projection = run_deterministic(&plan);
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 0.70,
        "p0 income",
    );
}

#[test]
fn claiming_delayed_applies_credit() {
    let plan = plan_with(66, 70, 0.0, Some(0.0));
    let projection = run_deterministic(&plan);
    assert_close(
        projection.snapshots[0].income,
        BENEFIT_AT_FRA * 1.32,
        "p0 income",
    );
}

#[test]
fn unknown_owner_produces_warning() {
    let mut plan = plan_with(67, 67, 0.0, Some(0.0));
    plan.social_security[0].owner = "nobody".to_string();
    let projection = run_deterministic(&plan);
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
    let projection = run_deterministic(&plan);
    assert_close(
        projection.snapshots[1].income,
        BENEFIT_AT_FRA * 1.05,
        "p1 income",
    );
}
