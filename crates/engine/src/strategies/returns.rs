use std::collections::BTreeMap;

use rand::rngs::StdRng;
use rand::SeedableRng;
use rand_distr::{Distribution, Normal};

use crate::model::AssetClass;
use crate::strategies::PeriodIndex;

/// Per-period return (decimal, already scaled to the period length) for each
/// asset class.
pub type AssetReturns = BTreeMap<AssetClass, f64>;

/// Source of market returns for one simulation path.
///
/// `path_id` identifies the Monte Carlo path (run index / RNG seed) in V2;
/// deterministic models ignore it. Implementations must be pure so paths can
/// run in parallel.
pub trait ReturnModel {
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> AssetReturns;
}

/// V1: the same expected nominal return every period, compounded to the
/// period length (annual rate 0.08 → monthly 1.08^(1/12)-1).
pub struct FixedReturns {
    per_period: AssetReturns,
}

impl FixedReturns {
    pub fn new(annual_returns: &AssetReturns, months_per_period: i64) -> Self {
        let per_period = annual_returns
            .iter()
            .map(|(class, annual)| {
                (
                    *class,
                    (1.0 + annual).powf(months_per_period as f64 / 12.0) - 1.0,
                )
            })
            .collect();
        Self { per_period }
    }
}

impl ReturnModel for FixedReturns {
    fn returns_for(&self, _period: PeriodIndex, _path_id: u64) -> AssetReturns {
        self.per_period.clone()
    }
}

/// V2: Monte Carlo returns — each (period, path) draws an independent Normal
/// sample per asset class, scaled to the period length. No correlation
/// across asset classes or periods in V1; that's a known simplification
/// (see the roadmap's historical-sequence-backtesting backlog item).
///
/// The trait takes `&self`, and rayon runs paths in parallel, so this holds
/// no internal RNG state — each call derives a fresh, reproducible seed from
/// `(seed, path_id, period)`.
pub struct StochasticReturns {
    annual_mean: AssetReturns,
    annual_stddev: AssetReturns,
    months_per_period: i64,
    seed: u64,
}

impl StochasticReturns {
    pub fn new(
        annual_mean: &AssetReturns,
        annual_stddev: &AssetReturns,
        months_per_period: i64,
        seed: u64,
    ) -> Self {
        Self {
            annual_mean: annual_mean.clone(),
            annual_stddev: annual_stddev.clone(),
            months_per_period,
            seed,
        }
    }
}

impl ReturnModel for StochasticReturns {
    fn returns_for(&self, period: PeriodIndex, path_id: u64) -> AssetReturns {
        let mut rng = StdRng::seed_from_u64(mix_seed(self.seed, path_id, period as u64));
        let scale = self.months_per_period as f64 / 12.0;
        self.annual_mean
            .iter()
            .map(|(class, mean)| {
                // Mean compounds like `FixedReturns`; variance is additive
                // over time, so stddev scales by sqrt(period length).
                let period_mean = (1.0 + mean).powf(scale) - 1.0;
                let period_stddev =
                    self.annual_stddev.get(class).copied().unwrap_or(0.0) * scale.sqrt();
                let draw = Normal::new(period_mean, period_stddev)
                    .expect("period_stddev is always finite and non-negative")
                    .sample(&mut rng);
                (*class, draw)
            })
            .collect()
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
