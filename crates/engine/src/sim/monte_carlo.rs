use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Plan, YearMonth};
use crate::sim::{simulate, Projection, SimWarning};
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
    /// The shape of the failures: when paths ran dry, and how the paths that
    /// did compare with the paths that did not.
    pub diagnostics: MonteCarloDiagnostics,
}

/// Length of the "early retirement" window the diagnostics split on, in
/// years — the conventional first-five-years framing of sequence-of-returns
/// risk. In years rather than periods so a monthly plan (V2) measures the
/// same stretch of retirement instead of the first five months.
pub const EARLY_RETIREMENT_WINDOW_YEARS: u32 = 5;

/// Nearest-rank p10 / p50 / p90 of one per-path statistic over a group of
/// paths.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct Spread {
    pub p10: f64,
    pub p50: f64,
    pub p90: f64,
}

/// Per-path statistics summarised over one group of paths — the failed
/// ones or the successful ones — so a reader can put the two distributions
/// side by side. Every figure is descriptive: it says what the paths in the
/// group looked like, not why they ended up in it.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct PathGroupStats {
    /// Paths in the group. Always at least 1: an empty group is `None` on
    /// `MonteCarloDiagnostics`, never a struct of zeros.
    pub n: u32,
    /// Net worth at the last period, nominal.
    pub end_net_worth: Spread,
    /// The path's lowest net worth at any period end, nominal. Zero for a
    /// path that depleted.
    pub min_net_worth: Spread,
    /// Cumulative portfolio return over the early-retirement window, as a
    /// fraction: +0.31 is 31% growth over the whole window, not per year.
    /// The UI annualises if it wants to.
    ///
    /// Compounded from each period's applied rate, `growth / (net_worth −
    /// growth)`, rather than from dollar growth over the starting balance:
    /// the dollar form falls with the balance, so a path that ran dry inside
    /// the window would look as if it had bad returns whether or not it did.
    /// Savings interest accrues outside `growth`, so the rate is understated
    /// by a hair on plans that hold much in cash. A period with nothing left
    /// to grow contributes a factor of one. The window is cut short by the
    /// plan end when retirement falls within
    /// `EARLY_RETIREMENT_WINDOW_YEARS` of it.
    ///
    /// `None` when the plan has no retirement inside its horizon.
    pub early_retirement_return: Option<Spread>,
    /// Gross withdrawals in the first full retirement period over net worth
    /// at that period's start, as a fraction. Gross is what the portfolio
    /// actually gave up, taxes included; it also includes required
    /// distributions, whose after-tax remainder is reinvested, so on a late
    /// retirement the rate slightly overstates what left the household.
    ///
    /// `None` when the plan has no retirement inside its horizon, or when
    /// net worth was already zero at that point.
    pub withdrawal_rate_at_retirement: Option<Spread>,
}

/// What the failed paths had in common — the descriptive answer to "why did
/// this plan fail?". Nothing here is causal: a path fails because its draws
/// were bad, and these figures only report the shape of that.
///
/// Everything is anchored on the household's **first** retirement, the one
/// that puts the portfolio under load, measured from the first period it
/// covers in full (`SimConfig::first_full_period_at_or_after`), so a
/// mid-year retirement's prorated stub year is not read as a full year of
/// spending.
///
/// The return model draws every period independently (see
/// `StochasticReturns`), which under-produces the clustered bad decade that
/// sequence-of-returns risk actually is. These diagnostics describe what
/// *that* model produced, so sequence-shaped failure is a floor here, not
/// an estimate. Backlog entry F is the honest answer to that question.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct MonteCarloDiagnostics {
    /// `EARLY_RETIREMENT_WINDOW_YEARS`, carried so the UI can name the window
    /// without hard-coding it.
    pub early_window_years: u32,
    /// Index of the first full retirement period — the anchor for the
    /// window, the withdrawal rate, and the early/late split. `None` when
    /// nobody in the plan retires before it ends, in which case the
    /// retirement-anchored figures are `None` too and every failure counts
    /// as neither early nor late.
    pub retirement_period: Option<usize>,
    /// Failed paths by the period they ran dry, one bucket per period,
    /// aligned index-for-index with `percentiles` (which carries the period
    /// start and deflator). Sums to exactly the number of failed paths.
    pub depletion_histogram: Vec<u32>,
    /// Failures inside the early window: before
    /// `retirement_period + early_window_years` (in periods), which includes
    /// a path that ran dry before retirement at all. The shape of sequence
    /// risk.
    pub early_failures: u32,
    /// Failures after the early window. The shape of longevity or spending
    /// drift.
    pub late_failures: u32,
    /// Statistics over the paths that ran dry. `None` when none did.
    pub failed: Option<PathGroupStats>,
    /// Statistics over the paths that did not. `None` when none did.
    pub succeeded: Option<PathGroupStats>,
    /// Median withdrawal rate at retirement across all paths — high here
    /// means the plan is spending-limited regardless of returns. Same
    /// definition and `None` conditions as
    /// `PathGroupStats::withdrawal_rate_at_retirement`.
    pub median_withdrawal_rate_at_retirement: Option<f64>,
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
    let anchor = DiagnosticsAnchor::for_plan(plan, n_periods);

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
            let summary = PathSummary::of(&projection, &anchor);
            // `projection` is dropped here: at 25,000 paths, holding every
            // path's snapshots (and their per-account maps) would be gigabytes.
            control.progress.fetch_add(1, Ordering::Relaxed);
            Ok(summary)
        })
        .collect::<Result<_, _>>()?;

    // An integer count, deliberately — a floating accumulation would make the
    // success rate depend on reduction order.
    let succeeded = summaries.iter().filter(|s| s.succeeded()).count();
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

    let diagnostics = diagnostics(&summaries, &anchor, n_periods);

    Ok(MonteCarloResult {
        n_paths,
        success_rate,
        percentiles,
        diagnostics,
    })
}

/// The plan-level facts every path's summary is measured against. Computed
/// once per run, not per path.
struct DiagnosticsAnchor {
    /// First full retirement period, if inside the horizon.
    retirement_period: Option<usize>,
    /// Early-retirement window, in periods.
    window: usize,
    /// Sum of account balances at plan start: the "net worth at period
    /// start" for period 0, which has no prior snapshot to read it from.
    opening_net_worth: f64,
}

impl DiagnosticsAnchor {
    fn for_plan(plan: &Plan, n_periods: usize) -> Self {
        let retirement_period = plan
            .people
            .iter()
            .map(|p| p.retirement)
            .min()
            .map(|month| plan.sim_config.first_full_period_at_or_after(month))
            .filter(|&period| period < n_periods);
        let window = (i64::from(EARLY_RETIREMENT_WINDOW_YEARS) * 12
            / plan.sim_config.period.months()) as usize;
        Self {
            retirement_period,
            window,
            opening_net_worth: plan.accounts.iter().map(|a| a.balance).sum(),
        }
    }
}

/// What one path contributes to the aggregate: its net worth at each period
/// and a handful of scalars about its shape. Everything else the path
/// produced is dropped as soon as this is built — see the comment in the
/// sweep above.
struct PathSummary {
    net_worth: Vec<f64>,
    /// Period of the `DepletedFunds` warning; the engine emits it at most
    /// once per path. `None` is what "succeeded" means.
    depleted_period: Option<usize>,
    min_net_worth: f64,
    end_net_worth: f64,
    /// See `PathGroupStats::early_retirement_return`.
    early_retirement_return: Option<f64>,
    /// See `PathGroupStats::withdrawal_rate_at_retirement`.
    withdrawal_rate_at_retirement: Option<f64>,
}

impl PathSummary {
    fn succeeded(&self) -> bool {
        self.depleted_period.is_none()
    }

    fn of(projection: &Projection, anchor: &DiagnosticsAnchor) -> Self {
        let snapshots = &projection.snapshots;
        let depleted_period = projection.warnings.iter().find_map(|w| match w {
            SimWarning::DepletedFunds { period } => Some(*period),
            _ => None,
        });
        let min_net_worth = snapshots
            .iter()
            .map(|s| s.net_worth)
            .fold(f64::INFINITY, f64::min);
        let end_net_worth = snapshots.last().map_or(0.0, |s| s.net_worth);

        let early_retirement_return = anchor.retirement_period.map(|r| {
            let end = (r + anchor.window).min(snapshots.len());
            let factor = snapshots[r..end].iter().fold(1.0, |factor, s| {
                let pre_growth = s.net_worth - s.growth;
                if pre_growth > 0.0 {
                    factor * (1.0 + s.growth / pre_growth)
                } else {
                    factor
                }
            });
            factor - 1.0
        });

        let withdrawal_rate_at_retirement = anchor.retirement_period.and_then(|r| {
            let start = match r {
                0 => anchor.opening_net_worth,
                _ => snapshots[r - 1].net_worth,
            };
            let gross: f64 = snapshots[r].withdrawals.values().sum();
            (start > 0.0).then(|| gross / start)
        });

        Self {
            net_worth: snapshots.iter().map(|s| s.net_worth).collect(),
            depleted_period,
            min_net_worth: if min_net_worth.is_finite() {
                min_net_worth
            } else {
                0.0
            },
            end_net_worth,
            early_retirement_return,
            withdrawal_rate_at_retirement,
        }
    }
}

fn diagnostics(
    summaries: &[PathSummary],
    anchor: &DiagnosticsAnchor,
    n_periods: usize,
) -> MonteCarloDiagnostics {
    let mut depletion_histogram = vec![0u32; n_periods];
    let (mut early_failures, mut late_failures) = (0u32, 0u32);
    for period in summaries.iter().filter_map(|s| s.depleted_period) {
        depletion_histogram[period] += 1;
        if let Some(r) = anchor.retirement_period {
            if period < r + anchor.window {
                early_failures += 1;
            } else {
                late_failures += 1;
            }
        }
    }

    let (failed, succeeded): (Vec<&PathSummary>, Vec<&PathSummary>) =
        summaries.iter().partition(|s| !s.succeeded());

    MonteCarloDiagnostics {
        early_window_years: EARLY_RETIREMENT_WINDOW_YEARS,
        retirement_period: anchor.retirement_period,
        depletion_histogram,
        early_failures,
        late_failures,
        failed: group_stats(&failed),
        succeeded: group_stats(&succeeded),
        median_withdrawal_rate_at_retirement: spread(
            summaries
                .iter()
                .filter_map(|s| s.withdrawal_rate_at_retirement),
        )
        .map(|s| s.p50),
    }
}

fn group_stats(paths: &[&PathSummary]) -> Option<PathGroupStats> {
    Some(PathGroupStats {
        n: u32::try_from(paths.len()).expect("path count fits u32 by construction"),
        end_net_worth: spread(paths.iter().map(|s| s.end_net_worth))?,
        min_net_worth: spread(paths.iter().map(|s| s.min_net_worth))?,
        early_retirement_return: spread(paths.iter().filter_map(|s| s.early_retirement_return)),
        withdrawal_rate_at_retirement: spread(
            paths.iter().filter_map(|s| s.withdrawal_rate_at_retirement),
        ),
    })
}

/// `None` for an empty sample — a spread of zeros would read as a finding.
fn spread(values: impl Iterator<Item = f64>) -> Option<Spread> {
    let mut values: Vec<f64> = values.collect();
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    Some(Spread {
        p10: percentile(&values, 0.10),
        p50: percentile(&values, 0.50),
        p90: percentile(&values, 0.90),
    })
}

/// Nearest-rank percentile over an already-sorted, non-empty-checked slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx]
}
