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

/// Runs `config.n_paths` independent simulation paths in parallel (rayon,
/// over `path_id`) and aggregates a success rate and per-period net-worth
/// percentiles. Each path's randomness comes entirely from `returns`
/// (typically `StochasticReturns` seeded with `config.seed`) keyed off its
/// `path_id` — this function itself holds no RNG state, so paths are
/// embarrassingly parallel by construction.
///
/// Success = the path never emits `SimWarning::DepletedFunds` before plan
/// end (no target "goal" balance in V1 — see the roadmap).
pub fn run_monte_carlo(
    plan: &Plan,
    returns: &(dyn ReturnModel + Sync),
    tax: &(dyn TaxModel + Sync),
    drawdown: &(dyn DrawdownStrategy + Sync),
    config: &MonteCarloConfig,
) -> MonteCarloResult {
    let n_paths = config.n_paths.max(1);

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
    let summaries: Vec<PathSummary> = (0..n_paths as u64)
        .into_par_iter()
        .map(|path_id| {
            let projection = simulate(plan, returns, tax, drawdown, path_id);
            PathSummary {
                net_worth: projection.snapshots.iter().map(|s| s.net_worth).collect(),
                succeeded: !projection
                    .warnings
                    .iter()
                    .any(|w| matches!(w, SimWarning::DepletedFunds { .. })),
            }
            // `projection` is dropped here: at 25,000 paths, holding every
            // path's snapshots (and their per-account maps) would be gigabytes.
        })
        .collect();

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

    MonteCarloResult {
        n_paths,
        success_rate,
        percentiles,
    }
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
