//! Historical backtesting: the plan replayed against every start year in
//! the record (#178).
//!
//! Monte Carlo draws each year independently, so it under-produces the
//! clustered bad decade that sequence-of-returns risk is. A replay uses the
//! decades that happened: cohort *Y* runs the plan with period *n* earning
//! year *Y + n*'s returns under year *Y + n*'s inflation. It is the same
//! `simulate`, run once per start year the way Monte Carlo runs it once per
//! path — only the return model and the price level differ.
//!
//! The data is Shiller's annual U.S. series, January to January, bundled in
//! the binary (`data/historical_us.csv`, built by
//! `scripts/build-historical-data.mjs`).
//!
//! A start year too recent for the plan's whole horizon runs out of history
//! before it runs out of plan. If it has already depleted by then, it has
//! failed — no later year brings a spent portfolio back. If it has not, its
//! outcome is unknown, and it is `InProgress`: counted, shown, and left out
//! of the success rate.

use std::sync::OnceLock;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Plan, PriceLevel, PricePath, StrategyRates};
use crate::strategies::{HistoricalReturns, ReturnModel};

use super::Projection;

/// One calendar year of U.S. market and price history, January to January.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HistoricalYear {
    pub year: i32,
    /// S&P Composite nominal total return, dividends reinvested.
    pub stocks: f64,
    /// 10-year Treasury nominal total return.
    pub bonds: f64,
    /// CPI-U change.
    pub inflation: f64,
}

const DATA: &str = include_str!("../../data/historical_us.csv");

/// Every year of the bundled history, oldest first and contiguous.
pub fn history() -> &'static [HistoricalYear] {
    static HISTORY: OnceLock<Vec<HistoricalYear>> = OnceLock::new();
    HISTORY.get_or_init(|| parse(DATA))
}

/// The bundled file is build input, not user input, so a malformed line is
/// a bug and panics — `tests/historical.rs` loads it on every run.
fn parse(text: &str) -> Vec<HistoricalYear> {
    let mut years: Vec<HistoricalYear> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("year") {
            continue;
        }
        let fields: Vec<f64> = line
            .split(',')
            .map(|f| {
                f.parse()
                    .unwrap_or_else(|_| panic!("bad history line: {line}"))
            })
            .collect();
        let [year, stocks, bonds, inflation] = fields[..] else {
            panic!("bad history line: {line}");
        };
        let year = year as i32;
        if let Some(last) = years.last() {
            assert_eq!(year, last.year + 1, "history must be contiguous");
        }
        years.push(HistoricalYear {
            year,
            stocks,
            bonds,
            inflation,
        });
    }
    years
}

/// How one start year turned out.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum CohortStatus {
    /// Lasted the plan's whole horizon.
    Succeeded,
    /// Ran out of money within the years history covers — whether or not
    /// history covers the whole horizon.
    Depleted,
    /// Still solvent when history ran out, short of the horizon.
    InProgress,
}

/// One start year, as the overview shows it.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct CohortSummary {
    pub start_year: i32,
    pub status: CohortStatus,
    /// Periods history covers: the plan's horizon, or fewer for a recent
    /// start year.
    pub periods_covered: u32,
    pub depleted_period: Option<u32>,
    /// Net worth at the end of each covered period in plan-start dollars —
    /// deflated by this cohort's own history, so two cohorts' figures are
    /// both in today's dollars but by different roads.
    pub net_worth_real: Vec<f64>,
    pub end_net_worth_real: f64,
    pub min_net_worth_real: f64,
}

/// Every start year in the record.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct BacktestResult {
    pub data_first_year: i32,
    pub data_last_year: i32,
    /// The plan's horizon in periods.
    pub n_periods: u32,
    /// Oldest start year first.
    pub cohorts: Vec<CohortSummary>,
    pub succeeded: u32,
    pub depleted: u32,
    pub in_progress: u32,
    /// `succeeded / (succeeded + depleted)`: a recent start year that has
    /// already run out counts against it, and one still going is left out.
    /// `None` only when no cohort has an outcome.
    pub success_rate: Option<f64>,
}

/// One period of a cohort's market history.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct MarketYear {
    pub historical_year: i32,
    pub stocks: f64,
    pub bonds: f64,
    pub inflation: f64,
    /// Each strategy's nominal return that year, before a stub period's
    /// proration.
    pub strategy_returns: StrategyRates,
}

/// One start year in full, for the ledger.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct CohortDetail {
    pub start_year: i32,
    pub status: CohortStatus,
    pub periods_covered: u32,
    pub depleted_period: Option<u32>,
    /// The run, cut to the covered periods.
    pub projection: Projection,
    /// Parallel to `projection.snapshots`.
    pub market: Vec<MarketYear>,
}

/// Runs one cohort: the plan, its tax model and drawdown built on the
/// given price level, over the given returns. `lib::run_with` in the app.
pub type CohortRunner<'a> = dyn Fn(&PriceLevel, &dyn ReturnModel) -> Projection + Sync + 'a;

/// The replay of the start year at `history[index]`, uncut, and how many of
/// its periods history covers.
fn replay(
    plan: &Plan,
    history: &[HistoricalYear],
    index: usize,
    stock_share: StrategyRates,
    run: &CohortRunner,
) -> (Projection, usize) {
    let years = &history[index..];
    let prices = PriceLevel::Path(PricePath::new(
        plan.sim_config.start,
        years.iter().map(|y| y.inflation).collect(),
        plan.assumptions.inflation,
    ));
    let returns = HistoricalReturns::new(years, stock_share, plan.assumptions.strategy_returns);
    let projection = run(&prices, &returns);
    let covered = projection.snapshots.len().min(years.len());
    (projection, covered)
}

fn status(projection: &Projection, covered: usize) -> (CohortStatus, Option<usize>) {
    let depleted = projection.depleted_period().filter(|&p| p < covered);
    let status = match depleted {
        Some(_) => CohortStatus::Depleted,
        None if covered < projection.snapshots.len() => CohortStatus::InProgress,
        None => CohortStatus::Succeeded,
    };
    (status, depleted)
}

/// Every start year in `history`, in parallel. Each runs the whole plan;
/// a cohort history runs out on is judged on the periods it covers.
pub fn backtest(
    plan: &Plan,
    history: &[HistoricalYear],
    stock_share: StrategyRates,
    run: &CohortRunner,
) -> BacktestResult {
    let runs: Vec<(CohortSummary, usize)> = (0..history.len())
        .into_par_iter()
        .map(|index| {
            let (projection, covered) = replay(plan, history, index, stock_share, run);
            let (status, depleted) = status(&projection, covered);
            let net_worth_real: Vec<f64> = projection.snapshots[..covered]
                .iter()
                .map(|s| s.net_worth / s.deflator_end)
                .collect();
            let summary = CohortSummary {
                start_year: history[index].year,
                status,
                periods_covered: covered as u32,
                depleted_period: depleted.map(|p| p as u32),
                end_net_worth_real: net_worth_real.last().copied().unwrap_or(0.0),
                min_net_worth_real: net_worth_real
                    .iter()
                    .copied()
                    .reduce(f64::min)
                    .unwrap_or(0.0),
                net_worth_real,
            };
            (summary, projection.snapshots.len())
        })
        .collect();
    // Every cohort runs the same plan, so the same horizon.
    let n_periods = runs.first().map_or(0, |(_, len)| *len as u32);
    let cohorts: Vec<CohortSummary> = runs.into_iter().map(|(summary, _)| summary).collect();

    let count = |status| cohorts.iter().filter(|c| c.status == status).count() as u32;
    let succeeded = count(CohortStatus::Succeeded);
    let depleted = count(CohortStatus::Depleted);
    let in_progress = count(CohortStatus::InProgress);
    let decided = succeeded + depleted;
    BacktestResult {
        data_first_year: history.first().map_or(0, |y| y.year),
        data_last_year: history.last().map_or(0, |y| y.year),
        n_periods,
        succeeded,
        depleted,
        in_progress,
        success_rate: (decided > 0).then(|| succeeded as f64 / decided as f64),
        cohorts,
    }
}

/// The start year `start_year` in full, or `None` outside `history`.
pub fn backtest_cohort(
    plan: &Plan,
    history: &[HistoricalYear],
    stock_share: StrategyRates,
    start_year: i32,
    run: &CohortRunner,
) -> Option<CohortDetail> {
    let index = history.iter().position(|y| y.year == start_year)?;
    let (projection, covered) = replay(plan, history, index, stock_share, run);
    let (status, depleted) = status(&projection, covered);
    let market = history[index..index + covered]
        .iter()
        .map(|y| MarketYear {
            historical_year: y.year,
            stocks: y.stocks,
            bonds: y.bonds,
            inflation: y.inflation,
            strategy_returns: HistoricalReturns::blend(y, stock_share),
        })
        .collect();
    Some(CohortDetail {
        start_year,
        status,
        periods_covered: covered as u32,
        depleted_period: depleted.map(|p| p as u32),
        projection: projection.truncated(covered),
        market,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_history_parses() {
        let years = history();
        assert_eq!(years.first().map(|y| y.year), Some(1871));
        assert!(years.len() >= 155);
    }

    #[test]
    fn a_line_out_of_order_is_refused() {
        let result = std::panic::catch_unwind(|| parse("1871,0,0,0\n1873,0,0,0\n"));
        assert!(result.is_err());
    }
}
