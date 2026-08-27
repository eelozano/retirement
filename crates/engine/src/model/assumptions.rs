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
    /// When `true`, leftover household cash each period (income minus
    /// contributions, taxes, and expenses) is swept into the first account
    /// of kind `Taxable`. When `false` (the default), leftover cash is left
    /// unallocated by the simulation — it is still reported via
    /// `PeriodSnapshot::surplus`, just not invested, on the assumption the
    /// user is directing it elsewhere (an explicit contribution, or a goal
    /// outside this plan). `#[serde(default)]` so plans saved before this
    /// field existed load as `false`.
    #[serde(default)]
    pub sweep_surplus_to_taxable: bool,
    /// Plan-level default annual COLA for Social Security benefits that
    /// don't set their own `cola_override`. `#[serde(default)]` — inert
    /// (0.0) for plans predating this field, which is safe since they also
    /// have no `social_security` entries to apply it to.
    #[serde(default)]
    pub social_security_cola: f64,
}
