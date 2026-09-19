//! An ordered drawdown end to end: through the plan file, the period loop,
//! and Monte Carlo. The waterfall's own arithmetic is pinned by the unit
//! tests beside `strategies::PhasedDrawdown`.

use engine::model::{
    DrawdownPhase, DrawdownPolicy, PhaseStart, Plan, StackEntry, StackSource, StreamBoundary,
    StreamDirection, TaxFigures,
};
use engine::presets::seed_plan;
use engine::{run_deterministic, run_monte_carlo, MonteCarloConfig, SimWarning};

fn with_stack(mut plan: Plan, stack: Vec<StackEntry>) -> Plan {
    plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
        id: "only".to_string(),
        name: "Only".to_string(),
        start: PhaseStart::Boundary(StreamBoundary::PlanStart),
        stack,
    }]);
    plan
}

fn account(id: &str, floor: f64) -> StackEntry {
    StackEntry {
        source: StackSource::Account(id.to_string()),
        floor,
    }
}

/// A plan written before drawdown order existed has no `drawdown` key, and
/// reads as the proportional drawdown it always had.
#[test]
fn a_plan_without_a_drawdown_key_loads_as_proportional() {
    let mut json = serde_json::to_value(seed_plan()).unwrap();
    json["assumptions"]
        .as_object_mut()
        .unwrap()
        .remove("drawdown")
        .expect("a current plan writes the key");
    let plan: Plan = serde_json::from_value(json).unwrap();
    assert_eq!(plan.assumptions.drawdown, DrawdownPolicy::Proportional);
}

/// A phased policy survives the round trip through the plan file.
#[test]
fn a_phased_policy_round_trips() {
    let plan = with_stack(seed_plan(), vec![account("taxable-brokerage", 25_000.0)]);
    let yaml = serde_yaml_ng::to_string(&plan).unwrap();
    let back: Plan = serde_yaml_ng::from_str(&yaml).unwrap();
    assert_eq!(back.assumptions.drawdown, plan.assumptions.drawdown);
}

/// With the brokerage at the top of the stack, the seed household's first
/// retired years are paid from it alone — where the proportional drawdown
/// took from all three accounts at once.
#[test]
fn the_stack_decides_which_accounts_pay() {
    let figures = TaxFigures::built_in();
    let phased = run_deterministic(
        &with_stack(seed_plan(), vec![account("taxable-brokerage", 0.0)]),
        &figures,
    );
    let first_draw = phased
        .snapshots
        .iter()
        .find(|s| s.withdrawals.values().any(|w| *w > 0.0))
        .expect("the seed plan draws down");
    let drawn: Vec<&String> = first_draw
        .withdrawals
        .iter()
        .filter(|(_, w)| **w > 0.0)
        .map(|(id, _)| id)
        .collect();
    assert_eq!(drawn, vec!["taxable-brokerage"]);
    assert_eq!(first_draw.early_withdrawal_penalty, 0.0);

    let proportional = run_deterministic(&seed_plan(), &figures);
    let same_year = &proportional.snapshots[first_draw.period];
    assert!(same_year.withdrawals.len() > 1);
}

/// A floor the household cannot keep is released and reported, not held
/// while the plan runs dry.
#[test]
fn an_unkeepable_floor_is_released_and_reported() {
    let mut plan = with_stack(
        seed_plan(),
        vec![account("taxable-brokerage", 1_000_000_000.0)],
    );
    // Spend enough that the plan runs out.
    for stream in &mut plan.streams {
        if stream.direction == StreamDirection::Expense {
            stream.annual_amount *= 3.0;
        }
    }
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert!(projection.warnings.iter().any(|w| matches!(
        w,
        SimWarning::FloorReleased { account, .. } if account == "taxable-brokerage"
    )));
    for snapshot in &projection.snapshots {
        for (id, balance) in &snapshot.balances {
            assert!(*balance >= 0.0, "{id} went negative in {}", snapshot.period);
        }
    }
}

/// Monte Carlo runs the plan's policy too.
#[test]
fn monte_carlo_runs_a_phased_plan() {
    let result = run_monte_carlo(
        &with_stack(seed_plan(), vec![account("taxable-brokerage", 0.0)]),
        &TaxFigures::built_in(),
        &MonteCarloConfig {
            n_paths: 50,
            seed: 7,
        },
    );
    assert!((0.0..=1.0).contains(&result.success_rate));
    assert_eq!(result.percentiles.len(), 58);
}
