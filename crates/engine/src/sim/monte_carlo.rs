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

    let projections: Vec<_> = (0..n_paths as u64)
        .into_par_iter()
        .map(|path_id| simulate(plan, returns, tax, drawdown, path_id))
        .collect();

    let succeeded = projections
        .iter()
        .filter(|p| {
            !p.warnings
                .iter()
                .any(|w| matches!(w, SimWarning::DepletedFunds { .. }))
        })
        .count();
    let success_rate = succeeded as f64 / n_paths as f64;

    let n_periods = projections.first().map_or(0, |p| p.snapshots.len());
    let percentiles = (0..n_periods)
        .map(|period| {
            let mut net_worths: Vec<f64> = projections
                .iter()
                .map(|p| p.snapshots[period].net_worth)
                .collect();
            net_worths.sort_by(|a, b| a.total_cmp(b));
            // Timeline metadata is identical across paths (only returns
            // vary), so read it off the first path rather than recomputing.
            let reference = &projections[0].snapshots[period];
            PeriodPercentiles {
                period,
                period_start: reference.period_start,
                deflator: reference.deflator,
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

/// Nearest-rank percentile over an already-sorted, non-empty-checked slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}
