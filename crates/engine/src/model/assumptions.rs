use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Broad asset classes the engine models. Portfolio presets map fund tickers
/// (VT, VTI, VXUS, BND) onto these.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum AssetClass {
    UsEquity,
    IntlEquity,
    GlobalEquity,
    UsBonds,
}

/// Market and tax assumptions. All rates are annual decimals (0.07 = 7%).
///
/// Returns are **nominal** — the engine simulates in nominal dollars and the
/// UI deflates for real-dollar display.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Assumptions {
    pub inflation: f64,
    /// Nominal expected annual return per asset class (used by the V1
    /// deterministic `FixedReturns` model; stochastic models bring their own
    /// distribution parameters in V2).
    pub asset_returns: BTreeMap<AssetClass, f64>,
    /// V1 flat tax rate applied to ordinary income and realized gains alike.
    pub flat_tax_rate: f64,
    /// The simulation runs until every person reaches this age.
    pub plan_end_age: u8,
}
