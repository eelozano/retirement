use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{FilingStatus, StateTaxProfile};

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
    /// Federal filing status — drives the federal bracket/standard-deduction
    /// table and Social Security taxability thresholds `BracketTax` uses.
    /// `#[serde(default)]` (→ `Single`) so plans saved before this field
    /// existed load unchanged.
    #[serde(default)]
    pub filing_status: FilingStatus,
    /// State income tax as an editable bracket schedule. A state picker in
    /// the UI prefills this from `Presets::state_tax_profiles`, but the
    /// stored brackets — not the state selection — are what `BracketTax`
    /// evaluates, so user edits always stick. `#[serde(default)]` (→ no
    /// state tax) so plans saved before this field existed load unchanged;
    /// this also supersedes the old flat `flat_tax_rate` field, dropped in
    /// favor of real bracket-table computation (#9).
    #[serde(default)]
    pub state_tax: StateTaxProfile,
    /// Legacy household-wide mortality figure, superseded by
    /// `Person::life_expectancy_age` (#28). No longer read by `end_month` or
    /// `AtDeath` — kept only as the migration fallback for people in plans
    /// saved before that field existed, resolved once in `Plan`'s custom
    /// `Deserialize`. `#[serde(default = "default_plan_end_age")]` so a plan
    /// that stops writing it still loads.
    #[serde(default = "default_plan_end_age")]
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
    /// Fraction of *household* spending — the expense streams no single
    /// person owns — that continues after the first death (#34). One person
    /// does not cost what two did, but the drop is nothing like half:
    /// housing, utilities, and property tax barely move. Planning
    /// conventions cluster around 0.70–0.80, and this is deliberately not
    /// seeded with one of them: the default is 1.0 (no step-down) so the
    /// engine never quietly assumes a number the user did not choose, and
    /// the UI carries the convention as guidance instead.
    ///
    /// Expenses owned by a person are left alone — they are that person's
    /// own cost, and their own end boundary already says when they stop.
    /// `#[serde(default = "no_survivor_step_down")]` so plans saved before
    /// this field existed load with their spending unchanged.
    #[serde(default = "no_survivor_step_down")]
    pub survivor_expense_factor: f64,
    /// Plan-level default annual COLA for Social Security benefits that
    /// don't set their own `cola_override`. `#[serde(default)]` — inert
    /// (0.0) for plans predating this field, which is safe since they also
    /// have no `social_security` entries to apply it to.
    #[serde(default)]
    pub social_security_cola: f64,
}

/// Historical default for `plan_end_age`, matching `presets::default_assumptions`.
fn default_plan_end_age() -> u8 {
    95
}

/// Default for `survivor_expense_factor`: household spending carries on
/// unchanged. See the field docs for why no convention is baked in here.
fn no_survivor_step_down() -> f64 {
    1.0
}
