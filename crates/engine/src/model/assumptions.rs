use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{FilingStatus, StateTaxProfile, StreamBoundary};

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
#[derive(Serialize, TS, Clone, Debug)]
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
    /// When leftover household cash each period (income and required
    /// distributions, minus contributions, taxes, and expenses) starts being
    /// swept into the first account of kind `Taxable`. `None` — the default
    /// — never sweeps; `Some(PlanStart)` always does.
    ///
    /// A boundary rather than a flag because surplus is two different
    /// quantities either side of retirement (#50), and one answer cannot be
    /// right for both:
    ///
    /// - **While working** it is *current spending*. This app takes savings
    ///   as the input and lets spending fall out as the residual — accounts
    ///   are contributed to from `allowed_contributions`, and nothing here
    ///   throttles a contribution for affordability — so a plan with no
    ///   expense streams still simulates correctly, and its surplus is the
    ///   grocery bill rather than money looking for a home. Sweeping it
    ///   would invent wealth out of money already spent.
    /// - **In retirement** it is real. Income is largely fixed, spending is
    ///   the thing being modelled, and cash left over genuinely does get
    ///   reinvested. Not sweeping it understates the portfolio for every
    ///   retirement year.
    ///
    /// `Some(AtRetirement(p))` states exactly that split, and says *whose*
    /// retirement — which a household with staggered retirement dates has to
    /// answer. `sim::resolve_boundary` turns any of these into a month, and
    /// the sweep begins with the first period starting on or after it.
    ///
    /// The alternative — asking for a full household budget so the residual
    /// disappears — is deliberately rejected. It demands budgeting work this
    /// tool does not otherwise ask for, in order to recover a number the
    /// engine already derives.
    ///
    /// `#[serde(default)]` so plans saved before this field existed load as
    /// `None`; the boolean `sweep_surplus_to_taxable` it replaces is
    /// migrated in `AssumptionsWire` below.
    #[serde(default)]
    pub sweep_surplus_from: Option<StreamBoundary>,
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

/// Deserialization shape for `Assumptions`, carrying the pre-#50 boolean
/// `sweep_surplus_to_taxable` alongside the boundary that replaced it. A
/// wire struct rather than `#[serde(from = "AssumptionsWire")]` only because
/// ts-rs cannot parse that container attribute and warns on every build —
/// same rationale as `Plan`'s and `Account`'s hand-written `Deserialize`.
#[derive(Deserialize)]
struct AssumptionsWire {
    inflation: f64,
    asset_returns: BTreeMap<AssetClass, f64>,
    #[serde(default)]
    filing_status: FilingStatus,
    #[serde(default)]
    state_tax: StateTaxProfile,
    #[serde(default = "default_plan_end_age")]
    plan_end_age: u8,
    #[serde(default)]
    sweep_surplus_from: Option<StreamBoundary>,
    /// Pre-#50 plans carry this instead: `true` swept from the first period,
    /// `false` never swept. Read only when `sweep_surplus_from` is absent,
    /// so a plan written by a current build is never reinterpreted by a
    /// stale copy of the old key.
    #[serde(default)]
    sweep_surplus_to_taxable: bool,
    #[serde(default = "no_survivor_step_down")]
    survivor_expense_factor: f64,
    #[serde(default)]
    social_security_cola: f64,
}

impl<'de> Deserialize<'de> for Assumptions {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let w = AssumptionsWire::deserialize(deserializer)?;
        Ok(Assumptions {
            inflation: w.inflation,
            asset_returns: w.asset_returns,
            filing_status: w.filing_status,
            state_tax: w.state_tax,
            plan_end_age: w.plan_end_age,
            sweep_surplus_from: w.sweep_surplus_from.or_else(|| {
                w.sweep_surplus_to_taxable
                    .then_some(StreamBoundary::PlanStart)
            }),
            survivor_expense_factor: w.survivor_expense_factor,
            social_security_cola: w.social_security_cola,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::StreamBoundary;

    /// A plan file written before #50 carries the boolean, not the boundary:
    /// `true` must load as a sweep from plan start, `false` as no sweep at
    /// all, so neither changes behaviour on upgrade.
    #[test]
    fn legacy_sweep_boolean_migrates_to_a_boundary() {
        let legacy = |flag: bool| {
            serde_json::json!({
                "inflation": 0.025,
                "asset_returns": {},
                "plan_end_age": 95,
                "sweep_surplus_to_taxable": flag,
            })
        };

        let swept: Assumptions = serde_json::from_value(legacy(true)).expect("parses");
        assert!(matches!(
            swept.sweep_surplus_from,
            Some(StreamBoundary::PlanStart)
        ));

        let unswept: Assumptions = serde_json::from_value(legacy(false)).expect("parses");
        assert!(unswept.sweep_surplus_from.is_none());
    }

    /// The boundary wins where both keys are present — a current build's
    /// output is never reinterpreted through the field it replaced.
    #[test]
    fn explicit_boundary_beats_the_legacy_boolean() {
        let value = serde_json::json!({
            "inflation": 0.025,
            "asset_returns": {},
            "sweep_surplus_from": { "AtRetirement": "p1" },
            "sweep_surplus_to_taxable": true,
        });

        let parsed: Assumptions = serde_json::from_value(value).expect("parses");

        match parsed.sweep_surplus_from {
            Some(StreamBoundary::AtRetirement(id)) => assert_eq!(id, "p1"),
            other => panic!("expected AtRetirement, got {other:?}"),
        }
    }
}
