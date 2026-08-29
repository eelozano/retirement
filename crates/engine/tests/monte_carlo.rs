//! Monte Carlo behavior: reproducibility, aggregate sanity, and that
//! volatility actually widens the outcome fan.

use std::collections::BTreeMap;

use engine::model::AssetClass;
use engine::presets::seed_plan;
use engine::strategies::{BracketTax, ProportionalDrawdown, StochasticReturns};
use engine::{run_monte_carlo, run_monte_carlo_sim, MonteCarloConfig};

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
