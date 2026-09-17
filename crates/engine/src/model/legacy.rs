//! The asset-class vocabulary plans were written in before #129, kept for
//! exactly one job: reading a file that still uses it.
//!
//! Nothing at simulate time touches any of this. The only callers are
//! `AssumptionsWire` and `AllocationRefWire`, both of which translate into
//! the per-strategy model and then forget the classes existed.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::StrategyRates;

/// The four broad asset classes `Assumptions` used to carry a rate for.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AssetClass {
    UsEquity,
    IntlEquity,
    GlobalEquity,
    UsBonds,
}

pub(crate) type ClassRates = BTreeMap<AssetClass, f64>;

/// Boglehead-style three-fund weights each named preset carried in
/// `presets::allocation_weights` before #129 — Aggressive 90/10 stocks/bonds,
/// Moderate 70/30, Conservative 50/50. Frozen here: these are the weights
/// old files were written under, so they must not drift with any later
/// change to what a strategy means.
const AGGRESSIVE: [(AssetClass, f64); 3] = [
    (AssetClass::UsEquity, 0.60),
    (AssetClass::IntlEquity, 0.30),
    (AssetClass::UsBonds, 0.10),
];
const MODERATE: [(AssetClass, f64); 3] = [
    (AssetClass::UsEquity, 0.45),
    (AssetClass::IntlEquity, 0.25),
    (AssetClass::UsBonds, 0.30),
];
const CONSERVATIVE: [(AssetClass, f64); 2] = [
    (AssetClass::GlobalEquity, 0.50),
    (AssetClass::UsBonds, 0.50),
];

/// The per-class returns `presets::default_assumptions` shipped before #129,
/// frozen for the same reason the weights above are.
const DEFAULT_RETURNS: [(AssetClass, f64); 4] = [
    (AssetClass::UsEquity, 0.08),
    (AssetClass::IntlEquity, 0.075),
    (AssetClass::GlobalEquity, 0.078),
    (AssetClass::UsBonds, 0.04),
];

/// A class the plan never priced reads 0.0, exactly as `grow`'s
/// `period_returns.get(class).copied().unwrap_or(0.0)` did.
fn blend(classes: &ClassRates, weights: &[(AssetClass, f64)]) -> f64 {
    weights
        .iter()
        .map(|(class, weight)| weight * classes.get(class).copied().unwrap_or(0.0))
        .sum()
}

/// Each strategy's return under a plan's *own* per-class table — the weighted
/// average `grow` computed every period, so a migrated plan's deterministic
/// projection is identical to the one it had.
pub(crate) fn blend_all(classes: &ClassRates) -> StrategyRates {
    StrategyRates {
        aggressive: blend(classes, &AGGRESSIVE),
        moderate: blend(classes, &MODERATE),
        conservative: blend(classes, &CONSERVATIVE),
    }
}

/// The rate hand-written `Custom` weights blended to, against the *shipped
/// default* per-class returns rather than the plan's own.
///
/// An allocation is a household fact while the return table is per-scenario
/// policy, so there is no single "this plan's returns" for an account shared
/// by five scenarios. The approximation only bites a file that both
/// hand-wrote weights *and* edited per-class returns; no UI path ever wrote
/// `Custom`, and the resulting rate lands on the account card as an editable
/// number either way.
pub(crate) fn blend_custom(weights: &ClassRates) -> f64 {
    let defaults: ClassRates = DEFAULT_RETURNS.iter().copied().collect();
    weights
        .iter()
        .map(|(class, weight)| weight * defaults.get(class).copied().unwrap_or(0.0))
        .sum()
}
