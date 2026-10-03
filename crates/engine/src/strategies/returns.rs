use rand::rngs::StdRng;
use rand::SeedableRng;
use rand_distr::{Distribution, StandardNormal};

use crate::model::StrategyRates;
use crate::sim::HistoricalYear;
use crate::strategies::PeriodIndex;

/// Per-period return (decimal, already scaled to the period length) for each
/// investment strategy. The same three-number shape as the annual figures on
/// `Assumptions` — scaled, not reshaped.
pub type StrategyReturns = StrategyRates;

/// Source of market returns for one simulation path.
///
/// `path_id` identifies the Monte Carlo path (run index / RNG seed);
/// deterministic models ignore it. Implementations must be pure so paths can
/// run in parallel.
pub trait ReturnModel {
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> StrategyReturns;
}

/// The same expected nominal return every period, compounded to the period
/// length (annual rate 0.08 → monthly 1.08^(1/12)-1).
pub struct FixedReturns {
    per_period: StrategyReturns,
}

impl FixedReturns {
    pub fn new(annual_returns: &StrategyRates, months_per_period: i64) -> Self {
        let scale = months_per_period as f64 / 12.0;
        Self {
            per_period: annual_returns.map(|annual| (1.0 + annual).powf(scale) - 1.0),
        }
    }
}

impl ReturnModel for FixedReturns {
    fn returns_for(&self, _period: PeriodIndex, _path_id: u64) -> StrategyReturns {
        self.per_period
    }
}

/// Monte Carlo returns — each (period, path) draws **one** market-wide shock
/// and scales it by each strategy's own standard deviation.
///
/// One shock, not one per strategy, because the three strategies are the
/// same funds in different proportions: a year that is bad for a 90/10
/// portfolio is bad for a 50/50 one, just less so. Drawing them
/// independently would let a household whose accounts span two strategies
/// diversify against itself and never be hit everywhere at once, which
/// reads as a materially higher probability of success than it has earned —
/// the same error this model used to make across asset classes (#129),
/// measured at +7.5 points on the seed household.
///
/// So strategies are perfectly correlated here. Real portfolios of the same
/// funds run about 0.95–0.99, so 1.0 is the far better of the two
/// approximations available without a correlation matrix, and it errs
/// towards caution rather than away from it.
///
/// Periods are still independent — that is the separate simplification a
/// historical-sequence `ReturnModel` would lift, and it needs real return
/// series rather than a wider draw.
///
/// The trait takes `&self`, and rayon runs paths in parallel, so this holds
/// no internal RNG state — each call derives a fresh, reproducible seed from
/// `(seed, path_id, period)`.
pub struct StochasticReturns {
    annual_mean: StrategyRates,
    annual_stddev: StrategyRates,
    months_per_period: i64,
    seed: u64,
}

impl StochasticReturns {
    pub fn new(
        annual_mean: &StrategyRates,
        annual_stddev: &StrategyRates,
        months_per_period: i64,
        seed: u64,
    ) -> Self {
        Self {
            annual_mean: *annual_mean,
            annual_stddev: *annual_stddev,
            months_per_period,
            seed,
        }
    }
}

impl ReturnModel for StochasticReturns {
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> StrategyReturns {
        let mut rng = StdRng::seed_from_u64(mix_seed(self.seed, path_id, period as u64));
        let scale = self.months_per_period as f64 / 12.0;
        // How this period went for markets, in standard deviations. Drawn
        // once and shared, which is what keeps the strategies correlated.
        let shock: f64 = StandardNormal.sample(&mut rng);
        // Mean compounds like `FixedReturns`; variance is additive over
        // time, so stddev scales by sqrt(period length).
        let draw = |mean: f64, stddev: f64| {
            let period_mean = (1.0 + mean).powf(scale) - 1.0;
            period_mean + stddev * scale.sqrt() * shock
        };
        let mean = &self.annual_mean;
        let stddev = &self.annual_stddev;
        StrategyReturns {
            very_aggressive: draw(mean.very_aggressive, stddev.very_aggressive),
            aggressive: draw(mean.aggressive, stddev.aggressive),
            moderate: draw(mean.moderate, stddev.moderate),
            conservative: draw(mean.conservative, stddev.conservative),
            very_conservative: draw(mean.very_conservative, stddev.very_conservative),
        }
    }
}

/// SplitMix64 finalizer, used to combine three independent identifiers into
/// one well-distributed 64-bit seed for `StdRng`.
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn mix_seed(seed: u64, path_id: u64, period: u64) -> u64 {
    splitmix64(splitmix64(seed ^ path_id) ^ period)
}

/// Real history, one year per period: period *n* earns the returns of
/// `years[n]`, each strategy its stock share of the year's stock return and
/// the rest of its bond return — rebalanced to that mix every year, since
/// the blend is taken afresh each period. A stub period takes its share of
/// the year in the loop, as it does from any return model.
///
/// Past the end of `years` it answers `fallback`, the plan's own typed
/// means: `simulate` runs to the plan's horizon, and a replay of a recent
/// start year discards the periods history has not reached yet.
pub struct HistoricalReturns<'a> {
    years: &'a [HistoricalYear],
    stock_share: StrategyRates,
    fallback: StrategyRates,
}

impl<'a> HistoricalReturns<'a> {
    pub fn new(
        years: &'a [HistoricalYear],
        stock_share: StrategyRates,
        fallback: StrategyRates,
    ) -> Self {
        HistoricalReturns {
            years,
            stock_share,
            fallback,
        }
    }

    /// Every strategy's nominal return in `year`.
    pub fn blend(year: &HistoricalYear, stock_share: StrategyRates) -> StrategyRates {
        stock_share.map(|share| share * year.stocks + (1.0 - share) * year.bonds)
    }
}

impl ReturnModel for HistoricalReturns<'_> {
    fn returns_for(&self, period: PeriodIndex, _path_id: u64) -> StrategyReturns {
        match self.years.get(period) {
            Some(year) => Self::blend(year, self.stock_share),
            None => self.fallback,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every strategy, the two `very_*` tiers included, moves on the same
    /// market shock: with annual periods each draw is `mean + σ · shock`, so
    /// backing the shock out of any tier must give the same number.
    #[test]
    fn every_strategy_shares_one_shock() {
        let mean = crate::presets::default_strategy_returns();
        let stddev = crate::presets::default_strategy_volatility();
        let model = StochasticReturns::new(&mean, &stddev, 12, 11);

        for period in 0..5 {
            let drawn = model.returns_for(period, 3);
            let shock = |r: f64, m: f64, s: f64| (r - m) / s;
            let reference = shock(drawn.moderate, mean.moderate, stddev.moderate);
            for (r, m, s) in [
                (
                    drawn.very_aggressive,
                    mean.very_aggressive,
                    stddev.very_aggressive,
                ),
                (drawn.aggressive, mean.aggressive, stddev.aggressive),
                (drawn.conservative, mean.conservative, stddev.conservative),
                (
                    drawn.very_conservative,
                    mean.very_conservative,
                    stddev.very_conservative,
                ),
            ] {
                assert!((shock(r, m, s) - reference).abs() < 1e-9);
            }
        }
    }
}
