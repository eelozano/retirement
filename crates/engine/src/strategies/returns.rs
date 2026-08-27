use std::collections::BTreeMap;

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
