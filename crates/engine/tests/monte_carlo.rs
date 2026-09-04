//! Monte Carlo behavior: reproducibility, aggregate sanity, and that
//! volatility actually widens the outcome fan.

use std::collections::BTreeMap;

use engine::model::AssetClass;
use engine::presets::seed_plan;
use engine::strategies::{BracketTax, ProportionalDrawdown, StochasticReturns};
use engine::{
    run_monte_carlo, run_monte_carlo_sim, run_monte_carlo_sim_with, run_monte_carlo_with,
    Cancelled, MonteCarloConfig, RunControl,
};

#[test]
fn same_seed_reproduces_identical_results() {
    let plan = seed_plan();
    let config = MonteCarloConfig {
        n_paths: 50,
        seed: 42,
    };
    let a = run_monte_carlo(&plan, &config);
    let b = run_monte_carlo(&plan, &config);

    assert_eq!(a.success_rate, b.success_rate);
    assert_eq!(a.percentiles.len(), b.percentiles.len());
    for (pa, pb) in a.percentiles.iter().zip(&b.percentiles) {
        assert_eq!(pa.p10, pb.p10);
        assert_eq!(pa.p50, pb.p50);
        assert_eq!(pa.p90, pb.p90);
    }
}

#[test]
fn different_seeds_produce_different_paths() {
    let plan = seed_plan();
    let a = run_monte_carlo(
        &plan,
        &MonteCarloConfig {
            n_paths: 50,
            seed: 1,
        },
    );
    let b = run_monte_carlo(
        &plan,
        &MonteCarloConfig {
            n_paths: 50,
            seed: 2,
        },
    );
    let median_a: Vec<f64> = a.percentiles.iter().map(|p| p.p50).collect();
    let median_b: Vec<f64> = b.percentiles.iter().map(|p| p.p50).collect();
    assert_ne!(median_a, median_b);
}

#[test]
fn aggregate_shape_is_sane() {
    let plan = seed_plan();
    let result = run_monte_carlo(
        &plan,
        &MonteCarloConfig {
            n_paths: 200,
            seed: 7,
        },
    );

    assert_eq!(result.n_paths, 200);
    assert!(
        (0.0..=1.0).contains(&result.success_rate),
        "success rate out of range: {}",
        result.success_rate
    );

    let deterministic = engine::run_deterministic(&plan);
    assert_eq!(result.percentiles.len(), deterministic.snapshots.len());

    for p in &result.percentiles {
        assert!(
            p.p10 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p90,
            "percentiles out of order at period {}: {p:?}",
            p.period
        );
    }
}

#[test]
fn single_path_collapses_percentiles() {
    let result = run_monte_carlo(
        &seed_plan(),
        &MonteCarloConfig {
            n_paths: 1,
            seed: 3,
        },
    );
    assert_eq!(result.n_paths, 1);
    // One sample: every percentile is that same sample.
    for p in &result.percentiles {
        assert_eq!(p.p10, p.p90);
        assert_eq!(p.p10, p.p50);
    }
    // A single path either fully succeeded or fully failed.
    assert!(result.success_rate == 0.0 || result.success_rate == 1.0);
}

#[test]
fn zero_volatility_matches_deterministic() {
    let plan = seed_plan();
    let no_vol: BTreeMap<AssetClass, f64> = plan
        .assumptions
        .asset_returns
        .keys()
        .map(|c| (*c, 0.0))
        .collect();
    let returns = StochasticReturns::new(
        &plan.assumptions.asset_returns,
        &no_vol,
        plan.sim_config.period.months(),
        99,
    );
    let tax = BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    };
    let result = run_monte_carlo_sim(
        &plan,
        &returns,
        &tax,
        &ProportionalDrawdown,
        &MonteCarloConfig {
            n_paths: 10,
            seed: 99,
        },
    );

    let deterministic = engine::run_deterministic(&plan);
    for (p, snapshot) in result.percentiles.iter().zip(&deterministic.snapshots) {
        assert!(
            (p.p50 - snapshot.net_worth).abs() < 1e-6,
            "period {}: stochastic median {} != deterministic {}",
            p.period,
            p.p50,
            snapshot.net_worth
        );
    }
}

#[test]
fn higher_volatility_widens_the_fan() {
    let plan = seed_plan();
    let tax = BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    };
    let months = plan.sim_config.period.months();
    let config = MonteCarloConfig {
        n_paths: 200,
        seed: 11,
    };

    let spread_at = |stddev: f64| {
        let vol: BTreeMap<AssetClass, f64> = plan
            .assumptions
            .asset_returns
            .keys()
            .map(|c| (*c, stddev))
            .collect();
        let returns = StochasticReturns::new(
            &plan.assumptions.asset_returns,
            &vol,
            months,
            config.seed as u64,
        );
        let result = run_monte_carlo_sim(&plan, &returns, &tax, &ProportionalDrawdown, &config);
        let last = result.percentiles.last().expect("plan has periods");
        last.p90 - last.p10
    };

    assert!(
        spread_at(0.20) > spread_at(0.05),
        "higher volatility should widen the p10-p90 spread"
    );
}

#[test]
fn net_worth_never_goes_negative() {
    let plan = seed_plan();
    let vol = engine::presets::asset_volatility();
    let returns = StochasticReturns::new(
        &plan.assumptions.asset_returns,
        &vol,
        plan.sim_config.period.months(),
        5,
    );
    let tax = BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    };
    let result = run_monte_carlo_sim(
        &plan,
        &returns,
        &tax,
        &ProportionalDrawdown,
        &MonteCarloConfig {
            n_paths: 500,
            seed: 5,
        },
    );
    for p in &result.percentiles {
        assert!(
            p.p10 >= 0.0 && !p.p10.is_sign_negative(),
            "period {} p10 is negative (or -0.0): {:e}",
            p.period,
            p.p10
        );
    }
}

/// Pins the exact aggregate output against values captured before
/// `run_monte_carlo` was changed from collecting whole `Projection`s to
/// folding each path down to a net-worth vector and a success flag. The
/// percentile pass is nearest-rank over a sorted slice and the success count
/// is an integer, so the refactor is required to be *bit*-identical, not
/// approximately equal — hence `assert_eq!` on `f64` rather than an epsilon.
///
/// Spot indices rather than all 58 periods: enough to catch an off-by-one or
/// a reordering, few enough to read when it fails.
#[test]
fn fold_reproduces_pre_refactor_output() {
    let plan = seed_plan();
    let result = run_monte_carlo(
        &plan,
        &MonteCarloConfig {
            n_paths: 200,
            seed: 7,
        },
    );

    assert_eq!(result.success_rate, 0.745);
    assert_eq!(result.percentiles.len(), 58);

    let at = |i: usize| &result.percentiles[i];

    assert_eq!(at(0).p10, 626751.4776252601);
    assert_eq!(at(12).p10, 2031389.8270239325);
    assert_eq!(at(38).p10, 16595.174591872736);
    assert_eq!(at(57).p10, 0.0);

    assert_eq!(at(0).p50, 762556.4549689445);
    assert_eq!(at(12).p50, 3213900.8128613797);
    assert_eq!(at(38).p50, 6639330.651474725);
    assert_eq!(at(57).p50, 10304220.924875783);

    assert_eq!(at(0).p90, 868644.9166317225);
    assert_eq!(at(12).p90, 4965592.984084475);
    assert_eq!(at(38).p90, 25760238.28534736);
    assert_eq!(at(57).p90, 78211766.53865191);
}

/// The observed form must not change the answer: progress counting and the
/// cancel check sit beside the path, not in it, and the collect still runs in
/// index order.
#[test]
fn controlled_run_matches_uncontrolled_and_counts_every_path() {
    let plan = seed_plan();
    let config = MonteCarloConfig {
        n_paths: 200,
        seed: 7,
    };
    let control = RunControl::new();

    let observed = run_monte_carlo_with(&plan, &config, &control).expect("not cancelled");
    let plain = run_monte_carlo(&plan, &config);

    assert_eq!(control.completed(), 200);
    assert_eq!(observed.success_rate, plain.success_rate);
    for (a, b) in observed.percentiles.iter().zip(&plain.percentiles) {
        assert_eq!(a.p10, b.p10);
        assert_eq!(a.p50, b.p50);
        assert_eq!(a.p90, b.p90);
    }
}

/// A cancel that is already set produces no result at all — not a partial
/// one — and does no path work.
#[test]
fn cancelled_before_start_returns_cancelled_without_running() {
    let plan = seed_plan();
    let control = RunControl::new();
    control.cancel();

    let result = run_monte_carlo_with(
        &plan,
        &MonteCarloConfig {
            n_paths: 5_000,
            seed: 1,
        },
        &control,
    );

    assert_eq!(result.unwrap_err(), Cancelled);
    assert_eq!(control.completed(), 0);
}

/// A cancel that lands mid-sweep stops the sweep short: the run reports
/// `Cancelled` and far fewer paths have completed than were asked for. The
/// flag is set from the return model — the one hook every path passes
/// through — since there is no other way to get code to run "during" a run
/// from a test.
#[test]
fn cancel_mid_run_short_circuits_the_sweep() {
    use engine::strategies::{AssetReturns, PeriodIndex, ReturnModel};
    use std::sync::atomic::{AtomicU32, Ordering};

    struct CancelAfter<'a> {
        inner: StochasticReturns,
        control: &'a RunControl,
        calls: AtomicU32,
        after: u32,
    }
    impl ReturnModel for CancelAfter<'_> {
        fn returns_for(&self, period: PeriodIndex, path_id: u64) -> AssetReturns {
            if self.calls.fetch_add(1, Ordering::Relaxed) == self.after {
                self.control.cancel();
            }
            self.inner.returns_for(period, path_id)
        }
    }

    let plan = seed_plan();
    let config = MonteCarloConfig {
        n_paths: 20_000,
        seed: 1,
    };
    let control = RunControl::new();
    let returns = CancelAfter {
        inner: StochasticReturns::new(
            &plan.assumptions.asset_returns,
            &plan.assumptions.asset_volatility,
            12,
            1,
        ),
        control: &control,
        calls: AtomicU32::new(0),
        // Roughly 50 paths in (58 periods each), well before the end.
        after: 3_000,
    };
    let tax = BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    };

    let result = run_monte_carlo_sim_with(
        &plan,
        &returns,
        &tax,
        &ProportionalDrawdown,
        &config,
        &control,
    );

    assert_eq!(result.unwrap_err(), Cancelled);
    // Threads already inside a path finish it, so this is "far short of the
    // whole", not an exact count.
    assert!(
        control.completed() < 5_000,
        "cancel should stop scheduling promptly; {} paths completed",
        control.completed()
    );
}
