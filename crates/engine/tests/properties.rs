//! Invariant checks over a grid of plan variations. Not exhaustive fuzzing —
//! a deliberate sweep of the knobs users will actually turn.

use engine::model::{Plan, YearMonth};
use engine::presets::seed_plan;
use engine::{run_deterministic, SimWarning};

/// Variations of the seed plan: spending level × retirement shift × returns.
fn plan_grid() -> Vec<Plan> {
    let mut plans = Vec::new();
    for spending_scale in [0.5, 1.0, 1.6, 2.5] {
        for retirement_shift_years in [-5, 0, 5] {
            for return_scale in [0.5, 1.0] {
                let mut plan = seed_plan();
                for stream in &mut plan.streams {
                    if stream.id == "household-spending" {
                        stream.annual_amount *= spending_scale;
                    }
                }
                for person in &mut plan.people {
                    person.retirement = person.retirement.add_years(retirement_shift_years);
                }
                for rate in plan.assumptions.asset_returns.values_mut() {
                    *rate *= return_scale;
                }
                plans.push(plan);
            }
        }
    }
    plans
}

#[test]
fn invariants_hold_across_plan_grid() {
    for (i, plan) in plan_grid().iter().enumerate() {
        let projection = run_deterministic(plan);
        assert!(
            !projection.snapshots.is_empty(),
            "plan {i}: empty projection"
        );

        let depletion_period = projection.warnings.iter().find_map(|w| match w {
            SimWarning::DepletedFunds { period } => Some(*period),
            _ => None,
        });

        let mut prev_deflator = 0.0;
        let mut prev_start: Option<YearMonth> = None;
        for snapshot in &projection.snapshots {
            // Balances never go negative and always sum to net worth.
            let mut sum = 0.0;
            for (id, balance) in &snapshot.balances {
                assert!(
                    *balance >= -1e-6,
                    "plan {i} period {}: negative balance in {id}: {balance}",
                    snapshot.period
                );
                sum += balance;
            }
            assert!(
                (sum - snapshot.net_worth).abs() < 1e-6,
                "plan {i} period {}: net worth {} != balance sum {sum}",
                snapshot.period,
                snapshot.net_worth
            );

            // Cash conservation: money in = money out, except an uncovered
            // shortfall, which is only permitted once depletion was warned.
            let gross_withdrawals: f64 = snapshot.withdrawals.values().sum();
            let inflow = snapshot.income + gross_withdrawals;
            let outflow =
                snapshot.contributions + snapshot.expenses + snapshot.taxes + snapshot.surplus;
            let uncovered = outflow - inflow;
            let tolerance = 1e-6 * outflow.abs().max(1.0);
            assert!(
                uncovered > -tolerance,
                "plan {i} period {}: inflow {inflow} exceeds outflow {outflow}",
                snapshot.period
            );
            if uncovered > tolerance {
                let depleted_by_now = depletion_period.is_some_and(|p| p <= snapshot.period);
                assert!(
                    depleted_by_now,
                    "plan {i} period {}: uncovered shortfall {uncovered} without depletion warning",
                    snapshot.period
                );
            }

            // Deflator grows monotonically; periods advance uniformly.
            assert!(
                snapshot.deflator > prev_deflator,
                "plan {i} period {}: deflator not increasing",
                snapshot.period
            );
            prev_deflator = snapshot.deflator;
            if let Some(prev) = prev_start {
                assert_eq!(
                    prev.months_until(snapshot.period_start),
                    12,
                    "plan {i} period {}: non-annual step",
                    snapshot.period
                );
            }
            prev_start = Some(snapshot.period_start);
        }
    }
}

#[test]
fn extreme_spending_depletes_and_warns() {
    let mut plan = seed_plan();
    for stream in &mut plan.streams {
        if stream.id == "household-spending" {
            stream.annual_amount = 1_000_000.0;
        }
    }
    let projection = run_deterministic(&plan);
    assert!(projection
        .warnings
        .iter()
        .any(|w| matches!(w, SimWarning::DepletedFunds { .. })));
    let last = projection.snapshots.last().unwrap();
    assert!(
        last.net_worth < 1.0,
        "expected depleted portfolio, net worth {}",
        last.net_worth
    );
}

#[test]
fn seed_plan_is_solvent_through_plan_end() {
    let projection = run_deterministic(&seed_plan());
    assert!(
        !projection
            .warnings
            .iter()
            .any(|w| matches!(w, SimWarning::DepletedFunds { .. })),
        "seed plan should not deplete: {:?}",
        projection.warnings
    );
    // Claire (born 1987-06) reaches 95 in 2082-06; annual periods from
    // 2026-01 → ceil(677 / 12) = 57 snapshots.
    assert_eq!(projection.snapshots.len(), 57);
}
