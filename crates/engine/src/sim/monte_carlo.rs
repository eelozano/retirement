use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Plan, YearMonth};
use crate::sim::{simulate, SimWarning};
use crate::strategies::{DrawdownStrategy, ReturnModel, TaxModel};

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug)]
#[ts(export)]
pub struct MonteCarloConfig {
    pub n_paths: u32,
    /// `u32`, not `u64`, so ts-rs emits a plain `number` — a `bigint` would
    /// not survive `JSON.stringify` over the Tauri IPC boundary. Widened
    /// internally before it reaches the RNG.
    pub seed: u32,
}

/// Net-worth percentiles across all paths at one period, in nominal dollars
/// (same convention as `PeriodSnapshot`) — the data for a percentile-fan
/// chart.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct PeriodPercentiles {
    pub period: usize,
    pub period_start: YearMonth,
    /// Cumulative inflation factor at period start, carried here for the
    /// same reason `PeriodSnapshot` carries it: the real-dollar toggle is a
    /// frontend-only division, with no engine round-trip.
    pub deflator: f64,
    pub p10: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    pub p90: f64,
}

/// Aggregate result of running a plan across many stochastic paths.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct MonteCarloResult {
    pub n_paths: u32,
    /// Fraction of paths that never depleted funds before plan end.
    pub success_rate: f64,
    pub percentiles: Vec<PeriodPercentiles>,
}

/// The two things a caller can do to a run while it is in flight: watch it
/// and stop it. Plain std atomics, so the engine stays free of any IPC or UI
/// dependency — whoever owns the run samples `progress` and flips `cancel`
/// on whatever schedule suits them.
///
/// `progress` counts completed paths, from 0 to `n_paths`. It is not reset
/// between runs; make a fresh `RunControl` per run.
#[derive(Debug, Default)]
pub struct RunControl {
    pub progress: AtomicU32,
    pub cancel: AtomicBool,
}

impl RunControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// Asks the run to stop. Paths already in flight finish (each is a few
    /// hundred microseconds); nothing further is scheduled.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// Paths completed so far.
    pub fn completed(&self) -> u32 {
        self.progress.load(Ordering::Relaxed)
    }
}

/// The run was stopped through `RunControl::cancel` before it finished. Not
/// an error in the run itself — the caller asked for this — so it is a
/// distinct type rather than a message, and the caller can keep whatever
/// result it already had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Monte Carlo run cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Runs `config.n_paths` independent simulation paths in parallel (rayon,
/// over `path_id`) and aggregates a success rate and per-period net-worth
/// percentiles. Each path's randomness comes entirely from `returns`
/// (typically `StochasticReturns` seeded with `config.seed`) keyed off its
/// `path_id` — this function itself holds no RNG state, so paths are
/// embarrassingly parallel by construction.
///
/// Success = the path never emits `SimWarning::DepletedFunds` before plan
/// end (no target "goal" balance in V1 — see the roadmap).
///
/// This is the unobserved, uninterruptible form; `run_monte_carlo_with` is
/// the same run with a `RunControl` attached. Both produce bit-identical
/// output for the same inputs.
pub fn run_monte_carlo(
    plan: &Plan,
    returns: &(dyn ReturnModel + Sync),
    tax: &(dyn TaxModel + Sync),
    drawdown: &(dyn DrawdownStrategy + Sync),
    config: &MonteCarloConfig,
) -> MonteCarloResult {
    run_monte_carlo_with(plan, returns, tax, drawdown, config, &RunControl::new())
        .expect("a run that is never cancelled cannot be cancelled")
}

/// `run_monte_carlo`, observable and interruptible through `control`.
///
/// Returns `Err(Cancelled)` if `control.cancel` is set before the sweep
/// finishes. The check is per path and rayon stops scheduling once one path
/// has returned `Err`, so a cancel lands within a few paths' worth of work
/// rather than after the remainder has been walked through as no-ops.
pub fn run_monte_carlo_with(
    plan: &Plan,
    returns: &(dyn ReturnModel + Sync),
    tax: &(dyn TaxModel + Sync),
    drawdown: &(dyn DrawdownStrategy + Sync),
    config: &MonteCarloConfig,
    control: &RunControl,
) -> Result<MonteCarloResult, Cancelled> {
    let n_paths = config.n_paths.max(1);
    if control.is_cancelled() {
        return Err(Cancelled);
    }

    // Timeline metadata (period start, deflator) is identical across paths —
    // only returns vary, and the deflator comes from a fixed inflation
    // assumption. Take it from one path up front so the parallel sweep below
    // can discard everything but the two numbers the aggregate needs. The
    // duplicated path costs 1/n of the run.
    let timeline: Vec<(YearMonth, f64)> = simulate(plan, returns, tax, drawdown, 0)
        .snapshots
        .iter()
        .map(|s| (s.period_start, s.deflator))
        .collect();
    let n_periods = timeline.len();

    // `map` + `collect`, not `fold`/`reduce`: rayon preserves index order here,
    // so path `i` is always `summaries[i]` — which keeps results bit-identical
    // run to run and gives per-path diagnostics a stable id to hang off. A
    // `reduce` accumulating `f64` would be neither.
    //
    // Collecting into a `Result` is what makes cancel prompt: rayon's
    // `Result` collector short-circuits on the first `Err`, so the remaining
    // paths are never scheduled. Index order is still preserved on the `Ok`
    // side.
    let summaries: Vec<PathSummary> = (0..n_paths as u64)
        .into_par_iter()
        .map(|path_id| {
            if control.is_cancelled() {
                return Err(Cancelled);
            }
            let projection = simulate(plan, returns, tax, drawdown, path_id);
            let summary = PathSummary {
                net_worth: projection.snapshots.iter().map(|s| s.net_worth).collect(),
                succeeded: !projection
                    .warnings
                    .iter()
                    .any(|w| matches!(w, SimWarning::DepletedFunds { .. })),
            };
            // `projection` is dropped here: at 25,000 paths, holding every
            // path's snapshots (and their per-account maps) would be gigabytes.
            control.progress.fetch_add(1, Ordering::Relaxed);
            Ok(summary)
        })
        .collect::<Result<_, _>>()?;

    // An integer count, deliberately — a floating accumulation would make the
    // success rate depend on reduction order.
    let succeeded = summaries.iter().filter(|s| s.succeeded).count();
    let success_rate = succeeded as f64 / n_paths as f64;

    let percentiles = (0..n_periods)
        .map(|period| {
            let mut net_worths: Vec<f64> = summaries.iter().map(|s| s.net_worth[period]).collect();
            net_worths.sort_by(|a, b| a.total_cmp(b));
            let (period_start, deflator) = timeline[period];
            PeriodPercentiles {
                period,
                period_start,
                deflator,
                p10: percentile(&net_worths, 0.10),
                p25: percentile(&net_worths, 0.25),
                p50: percentile(&net_worths, 0.50),
                p75: percentile(&net_worths, 0.75),
                p90: percentile(&net_worths, 0.90),
            }
        })
        .collect();

    Ok(MonteCarloResult {
        n_paths,
        success_rate,
        percentiles,
    })
}

/// What one path contributes to the aggregate: its net worth at each period,
/// and whether it stayed solvent. Everything else the path produced is
/// dropped as soon as this is built — see the comment in the sweep above.
struct PathSummary {
    net_worth: Vec<f64>,
    succeeded: bool,
}

/// Nearest-rank percentile over an already-sorted, non-empty-checked slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}
