//! Monte Carlo behavior: reproducibility, aggregate sanity, and that
//! volatility actually widens the outcome fan.

use std::collections::BTreeMap;

use engine::model::{AssetClass, StreamDirection};
use engine::presets::seed_plan;
use engine::strategies::{BracketTax, ProportionalDrawdown, StochasticReturns};
use engine::{
    run_monte_carlo, run_monte_carlo_sim, run_monte_carlo_sim_with, run_monte_carlo_with,
    Cancelled, MonteCarloConfig, MonteCarloDiagnostics, MonteCarloResult, Plan, Projection,
    RunControl, SimWarning, EARLY_RETIREMENT_WINDOW_YEARS,
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

    // The seed household never runs dry at fixed average returns, so the
    // diagnostics have nothing to report on the failed side and every
    // successful path is the same path.
    let d = &result.diagnostics;
    assert!(deterministic_depletion(&deterministic).is_none());
    assert!(d.failed.is_none());
    assert_eq!(d.depletion_histogram.iter().sum::<u32>(), 0);
    assert_eq!((d.early_failures, d.late_failures), (0, 0));
    let ok = d.succeeded.as_ref().expect("every path succeeded");
    assert_eq!(ok.n, 10);
    assert_collapsed(ok.end_net_worth);
    assert_collapsed(ok.min_net_worth);
    assert_collapsed(
        ok.early_retirement_return
            .expect("plan retires inside its horizon"),
    );
    assert_collapsed(
        ok.withdrawal_rate_at_retirement
            .expect("net worth is positive"),
    );
    assert_withdrawal_rate_matches_snapshots(&plan, &deterministic, d);
}

/// The other σ = 0 shape: a plan that runs dry at fixed average returns
/// puts every path in the same histogram bucket — the deterministic run's
/// own depletion period.
#[test]
fn zero_volatility_depletion_lands_in_one_bucket() {
    let plan = with_expenses_scaled(2.0);
    let result = run_zero_volatility(&plan, 10);
    let deterministic = engine::run_deterministic(&plan);
    let depleted = deterministic_depletion(&deterministic).expect("doubled spending runs dry");

    let d = &result.diagnostics;
    let buckets: Vec<(usize, u32)> = d
        .depletion_histogram
        .iter()
        .enumerate()
        .filter(|(_, &count)| count > 0)
        .map(|(period, &count)| (period, count))
        .collect();
    assert_eq!(buckets, vec![(depleted, 10)]);
    assert!(d.succeeded.is_none());
    let failed = d.failed.as_ref().expect("every path failed");
    assert_eq!(failed.n, 10);
    assert_collapsed(failed.min_net_worth);
    assert_collapsed(
        failed
            .early_retirement_return
            .expect("plan retires inside its horizon"),
    );

    // Doubled spending runs dry after the early window, not inside it, so
    // this pins the split in the direction the arithmetic says.
    let retirement = d
        .retirement_period
        .expect("plan retires inside its horizon");
    let window = EARLY_RETIREMENT_WINDOW_YEARS as usize;
    assert!(depleted >= retirement + window, "expected a late failure");
    assert_eq!((d.early_failures, d.late_failures), (0, 10));
    assert_withdrawal_rate_matches_snapshots(&plan, &deterministic, d);
}

/// Spending is the lever the diagnostics exist to expose: raising it should
/// move the depletion histogram earlier and lift the withdrawal rate at
/// retirement, on the same seed.
#[test]
fn heavier_spending_fails_earlier_and_withdraws_more() {
    let config = MonteCarloConfig {
        n_paths: 500,
        seed: 7,
    };
    let base = run_monte_carlo(&seed_plan(), &config).diagnostics;
    let heavy = run_monte_carlo(&with_expenses_scaled(1.6), &config).diagnostics;

    let failures = |d: &MonteCarloDiagnostics| d.depletion_histogram.iter().sum::<u32>();
    assert!(failures(&heavy) > failures(&base));
    assert!(
        mean_depletion_period(&heavy) < mean_depletion_period(&base),
        "heavier spending should run dry earlier: {} vs {}",
        mean_depletion_period(&heavy),
        mean_depletion_period(&base)
    );
    let rate = |d: &MonteCarloDiagnostics| d.median_withdrawal_rate_at_retirement.unwrap();
    assert!(rate(&heavy) > rate(&base));
}

/// Volatility is what puts failures *inside* the early window. On a plan
/// that already runs dry late at average returns, raising the spread should
/// move failures out of the late bucket and into the early one — the shape
/// the diagnostics call sequence-shaped.
#[test]
fn volatility_shifts_failures_into_the_early_window() {
    let plan = with_expenses_scaled(2.0);
    let config = MonteCarloConfig {
        n_paths: 1_000,
        seed: 11,
    };
    let at = |stddev: f64| run_with_volatility(&plan, stddev, &config).diagnostics;
    let calm = at(0.10);
    let wild = at(0.30);

    assert!(
        wild.early_failures > calm.early_failures,
        "early failures should rise with volatility: {} vs {}",
        wild.early_failures,
        calm.early_failures
    );
    assert!(
        wild.late_failures < calm.late_failures,
        "late failures should fall with volatility: {} vs {}",
        wild.late_failures,
        calm.late_failures
    );
}

/// The histogram is the failed count, not an estimate of it: it sums to
/// exactly the paths that ran dry, which is exactly what `success_rate` was
/// computed from, and the early/late split partitions the same total.
#[test]
fn histogram_accounts_for_every_failed_path() {
    let result = run_monte_carlo(
        &seed_plan(),
        &MonteCarloConfig {
            n_paths: 200,
            seed: 7,
        },
    );
    let d = &result.diagnostics;
    let failed = d
        .failed
        .as_ref()
        .expect("the seed plan has failures at 200 paths");
    let succeeded = d.succeeded.as_ref().expect("and successes");

    assert_eq!(d.depletion_histogram.len(), result.percentiles.len());
    let total = d.depletion_histogram.iter().sum::<u32>();
    assert_eq!(total, failed.n);
    assert_eq!(failed.n + succeeded.n, result.n_paths);
    assert_eq!(d.early_failures + d.late_failures, total);
    assert_eq!(
        (result.n_paths - total) as f64 / result.n_paths as f64,
        result.success_rate
    );

    for group in [failed, succeeded] {
        assert_ordered(group.end_net_worth);
        assert_ordered(group.min_net_worth);
        assert_ordered(group.early_retirement_return.unwrap());
        assert_ordered(group.withdrawal_rate_at_retirement.unwrap());
    }
    // A path that ran dry bottomed out below any path that did not.
    assert!(failed.min_net_worth.p90 < succeeded.min_net_worth.p10);
    // And, on this household, the failed paths had the worse early
    // retirement — the comparison the card is built around.
    assert!(
        failed.early_retirement_return.unwrap().p50
            < succeeded.early_retirement_return.unwrap().p50
    );
}

/// Nobody retires inside the horizon: there is no period to anchor on, so
/// every retirement-anchored figure is absent rather than measured against
/// some made-up year, and no failure is early or late.
#[test]
fn no_retirement_inside_horizon_leaves_anchored_figures_empty() {
    // Quadrupled, not doubled: with retirement pushed out, salaries run to
    // plan end too, and doubled spending no longer outruns them.
    let mut plan = with_expenses_scaled(4.0);
    // The month after the last period — the first month no period covers.
    // A person's own death would not do: the earlier decedent's last month
    // still lies inside the survivor's horizon.
    let end = plan.end_month();
    for person in &mut plan.people {
        person.retirement = end;
    }
    let result = run_monte_carlo(
        &plan,
        &MonteCarloConfig {
            n_paths: 50,
            seed: 3,
        },
    );
    let d = &result.diagnostics;
    assert_eq!(d.retirement_period, None);
    assert_eq!((d.early_failures, d.late_failures), (0, 0));
    assert_eq!(d.median_withdrawal_rate_at_retirement, None);
    for group in [&d.failed, &d.succeeded].into_iter().flatten() {
        assert_eq!(group.early_retirement_return, None);
        assert_eq!(group.withdrawal_rate_at_retirement, None);
    }
    // Failures still count; they just have no early/late shape.
    assert!(d.depletion_histogram.iter().sum::<u32>() > 0);
}

/// Everyone already retired before the plan starts: the anchor is period 0,
/// whose "net worth at period start" has no prior snapshot and comes from
/// the plan's opening balances instead.
#[test]
fn retirement_before_plan_start_anchors_on_opening_balances() {
    let mut plan = seed_plan();
    for person in &mut plan.people {
        person.retirement = engine::YearMonth::new(2020, 1);
    }
    let result = run_zero_volatility(&plan, 3);
    let deterministic = engine::run_deterministic(&plan);

    let d = &result.diagnostics;
    assert_eq!(d.retirement_period, Some(0));
    let opening: f64 = plan.accounts.iter().map(|a| a.balance).sum();
    let gross: f64 = deterministic.snapshots[0].withdrawals.values().sum();
    assert!(gross > 0.0, "a retired household draws on its portfolio");
    let rate = d
        .median_withdrawal_rate_at_retirement
        .expect("opening balances are positive");
    assert!((rate - gross / opening).abs() < 1e-12);
}

fn with_expenses_scaled(factor: f64) -> Plan {
    let mut plan = seed_plan();
    for stream in &mut plan.streams {
        if stream.direction == StreamDirection::Expense {
            stream.annual_amount *= factor;
        }
    }
    plan
}

fn tax_for(plan: &Plan) -> BracketTax {
    BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    }
}

fn run_with_volatility(plan: &Plan, stddev: f64, config: &MonteCarloConfig) -> MonteCarloResult {
    let vol: BTreeMap<AssetClass, f64> = plan
        .assumptions
        .asset_returns
        .keys()
        .map(|c| (*c, stddev))
        .collect();
    let returns = StochasticReturns::new(
        &plan.assumptions.asset_returns,
        &vol,
        plan.sim_config.period.months(),
        config.seed as u64,
    );
    run_monte_carlo_sim(
        plan,
        &returns,
        &tax_for(plan),
        &ProportionalDrawdown,
        config,
    )
}

fn run_zero_volatility(plan: &Plan, n_paths: u32) -> MonteCarloResult {
    run_with_volatility(plan, 0.0, &MonteCarloConfig { n_paths, seed: 99 })
}

fn deterministic_depletion(projection: &Projection) -> Option<usize> {
    projection.warnings.iter().find_map(|w| match w {
        SimWarning::DepletedFunds { period } => Some(*period),
        _ => None,
    })
}

fn mean_depletion_period(d: &MonteCarloDiagnostics) -> f64 {
    let total: u32 = d.depletion_histogram.iter().sum();
    let weighted: f64 = d
        .depletion_histogram
        .iter()
        .enumerate()
        .map(|(period, &count)| period as f64 * count as f64)
        .sum();
    weighted / total as f64
}

/// Under σ = 0 every path is the deterministic path, so the median
/// withdrawal rate must be the snapshot arithmetic itself: gross
/// withdrawals in the first full retirement period over the prior period's
/// closing net worth. Also pins the anchor to the inclusive
/// first-full-period rule the frontend uses.
fn assert_withdrawal_rate_matches_snapshots(
    plan: &Plan,
    deterministic: &Projection,
    d: &MonteCarloDiagnostics,
) {
    let first_retirement = plan.people.iter().map(|p| p.retirement).min().unwrap();
    let r = d
        .retirement_period
        .expect("plan retires inside its horizon");
    assert_eq!(
        r,
        plan.sim_config
            .first_full_period_at_or_after(first_retirement)
    );
    assert!(deterministic.snapshots[r].period_start >= first_retirement);
    assert!(deterministic.snapshots[r - 1].period_start < first_retirement);

    let gross: f64 = deterministic.snapshots[r].withdrawals.values().sum();
    let expected = gross / deterministic.snapshots[r - 1].net_worth;
    let actual = d
        .median_withdrawal_rate_at_retirement
        .expect("net worth is positive");
    assert!(
        (actual - expected).abs() < 1e-12,
        "withdrawal rate {actual} != snapshot arithmetic {expected}"
    );
}

fn assert_collapsed(s: engine::Spread) {
    assert_eq!(s.p10, s.p50, "{s:?}");
    assert_eq!(s.p50, s.p90, "{s:?}");
}

fn assert_ordered(s: engine::Spread) {
    assert!(s.p10 <= s.p50 && s.p50 <= s.p90, "{s:?}");
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
