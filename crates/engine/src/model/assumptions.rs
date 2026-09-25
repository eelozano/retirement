use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    legacy, AccountId, DrawdownPolicy, FilingStatus, StateTaxProfile, StrategyRates,
    StreamBoundary, YearMonth,
};

/// Market and tax assumptions. All rates are annual decimals (0.07 = 7%).
///
/// Returns are **nominal** — the engine simulates in nominal dollars and the
/// UI deflates for real-dollar display.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Assumptions {
    pub inflation: f64,
    /// Nominal expected annual return for each investment strategy — what an
    /// account allocated `Aggressive` is assumed to earn.
    ///
    /// The expected return of a **single year**, not the rate a balance
    /// compounds at over a projection: `StochasticReturns` adds `σ · shock`
    /// to it, so it is an arithmetic mean and a volatile sequence of such
    /// years compounds about `σ²/2` lower. That is why the deterministic
    /// line sits above the Monte Carlo median. See "The return is an
    /// arithmetic mean, not a compound rate" in `docs/ARCHITECTURE.md` for
    /// why the convention stays and the UI explains it instead.
    ///
    /// This replaced a per-asset-class table (#129). Growth was modelled in
    /// two layers: four asset-class returns here, and per-account weights
    /// over those classes in `presets::allocation_weights`. The engine only
    /// ever used the weighted average, so the four numbers were a second set
    /// of figures to keep true in order to derive three the user could have
    /// typed — and nothing outside the growth path read an asset class at
    /// all.
    ///
    /// `#[serde(default)]`, with the old `asset_returns` key read and blended
    /// in `AssumptionsWire` below, so a plan written before this field loads
    /// with its deterministic projection unchanged.
    #[serde(default = "crate::presets::default_strategy_returns")]
    pub strategy_returns: StrategyRates,
    /// Annualized standard deviation for each strategy, read by
    /// `StochasticReturns` (Monte Carlo): `strategy_returns` sets where the
    /// fan is centered, this sets how wide it is. Surfaced as an editable
    /// number rather than hidden in the engine for the reason #52 gave — the
    /// fan's width must not come from figures the user cannot see.
    ///
    /// These are whole-portfolio figures, not the narrower ones the four
    /// independent per-class draws they replaced implied. Those draws let a
    /// 90/10 portfolio diversify against asset classes that in reality move
    /// together, and the fan was too narrow for it. Upgrading a plan
    /// therefore widens its fan and lowers its reported probability of
    /// success; that is the model getting more honest, not a regression
    /// (#129).
    #[serde(default = "crate::presets::default_strategy_volatility")]
    pub strategy_volatility: StrategyRates,
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
    /// An assumed cut to Social Security from a given month: the trust-fund
    /// depletion scenario, where only part of scheduled benefits stays
    /// payable. `None` — the default — pays every benefit in full, so a plan
    /// saved before this field existed projects identically.
    ///
    /// Scenario policy rather than a household fact: it is a what-if about
    /// the law, not about the household, and comparing "cut" against "no
    /// cut" is exactly what scenarios are for.
    #[serde(default)]
    pub social_security_reduction: Option<SocialSecurityReduction>,
    /// Which account receives reinvested cash: swept surplus (above), and
    /// the after-tax remainder of a required minimum distribution,
    /// unconditionally (#49). `None` — the default — is today's behaviour:
    /// the first account of kind `Taxable` in plan order. Existing plans
    /// must be unaffected, which rules out any other default for a plan
    /// with more than one taxable account (#58).
    ///
    /// `Plan::validate` rejects a destination that does not exist or is not
    /// `AccountKind::Taxable` — `cost_basis` only means anything on a
    /// taxable account, so a wrong-kind destination must never reach
    /// `simulate`. The engine still falls back to the first `Taxable`
    /// account for a plan that skips validation (e.g. a test fixture),
    /// rather than panicking or silently dropping the money.
    ///
    /// `#[serde(default)]` so plans saved before this field existed load as
    /// `None`, projecting identically to today.
    #[serde(default)]
    pub reinvest_into: Option<AccountId>,
    /// Which accounts pay for a shortfall, and in what order. `#[serde(default)]`
    /// (→ `Proportional`) so plans saved before drawdown order existed keep
    /// the order they had.
    #[serde(default)]
    pub drawdown: DrawdownPolicy,
}

/// Every Social Security benefit — own and survivor alike — pays
/// `payable_fraction` of what it otherwise would from `from` onward, for
/// life. The COLA keeps compounding on the reduced amount, which is how a
/// payable-benefit cut works: the schedule is unchanged, only the share of
/// it paid falls.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct SocialSecurityReduction {
    pub from: YearMonth,
    /// Share of scheduled benefits still paid, 0.0..=1.0 (0.77 = a 23% cut).
    pub payable_fraction: f64,
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
/// `sweep_surplus_to_taxable` alongside the boundary that replaced it, and
/// the pre-#129 per-asset-class return table alongside the per-strategy one.
/// A wire struct rather than `#[serde(from = "AssumptionsWire")]` only
/// because ts-rs cannot parse that container attribute and warns on every
/// build — same rationale as `Plan`'s and `Account`'s hand-written
/// `Deserialize`.
///
/// The pre-#129 `asset_volatility` key is deliberately **not** declared
/// here. Nothing reads it any more, unknown keys are ignored, and the
/// resolution below says why a legacy plan is given fresh volatility figures
/// rather than its own blended forward.
#[derive(Deserialize)]
struct AssumptionsWire {
    inflation: f64,
    /// Per-strategy figures, present in anything a current build wrote.
    #[serde(default)]
    strategy_returns: Option<StrategyRates>,
    #[serde(default)]
    strategy_volatility: Option<StrategyRates>,
    /// Pre-#129: nominal expected return per asset class. Read only when
    /// `strategy_returns` is absent, so a current build's output is never
    /// reinterpreted through the field it replaced — the same rule
    /// `sweep_surplus_to_taxable` follows.
    ///
    /// No longer required, unlike the field it replaced: a file written by a
    /// current build has no such key.
    #[serde(default)]
    asset_returns: Option<legacy::ClassRates>,
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
    #[serde(default)]
    social_security_reduction: Option<SocialSecurityReduction>,
    #[serde(default)]
    reinvest_into: Option<AccountId>,
    #[serde(default)]
    drawdown: DrawdownPolicy,
}

impl<'de> Deserialize<'de> for Assumptions {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let w = AssumptionsWire::deserialize(deserializer)?;
        Ok(Assumptions {
            inflation: w.inflation,
            strategy_returns: w
                .strategy_returns
                .unwrap_or_else(|| match &w.asset_returns {
                    // The plan's own table, blended against the weights its
                    // allocation presets carried — the weighted average `grow`
                    // computed every period, so the deterministic projection is
                    // unchanged.
                    Some(classes) => legacy::blend_all(classes),
                    None => crate::presets::default_strategy_returns(),
                }),
            // A legacy plan's own per-class volatility is deliberately not
            // blended forward. Doing so would reproduce the too-narrow fan
            // the independent per-class draws implied, which is the thing
            // #129 exists to correct; the plan gets the realistic
            // whole-portfolio figures instead, visible and editable in one
            // place. Its *returns* are preserved exactly, because those are
            // its own forecast — the volatility was a default it never
            // chose.
            strategy_volatility: w
                .strategy_volatility
                .unwrap_or_else(crate::presets::default_strategy_volatility),
            filing_status: w.filing_status,
            state_tax: w.state_tax,
            plan_end_age: w.plan_end_age,
            sweep_surplus_from: w.sweep_surplus_from.or_else(|| {
                w.sweep_surplus_to_taxable
                    .then_some(StreamBoundary::PlanStart)
            }),
            survivor_expense_factor: w.survivor_expense_factor,
            social_security_cola: w.social_security_cola,
            social_security_reduction: w.social_security_reduction,
            reinvest_into: w.reinvest_into,
            drawdown: w.drawdown,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::StreamBoundary;

    /// Blended figures are exact decimals in principle but float arithmetic
    /// in practice.
    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-12,
            "expected {expected}, got {actual}"
        );
    }

    /// A plan file written before #50 carries the boolean, not the boundary:
    /// `true` must load as a sweep from plan start, `false` as no sweep at
    /// all, so neither changes behaviour on upgrade.
    #[test]
    fn legacy_sweep_boolean_migrates_to_a_boundary() {
        let legacy = |flag: bool| {
            serde_json::json!({
                "inflation": 0.025,
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

    /// A plan file with no per-strategy volatility — anything written before
    /// #129 — loads with the realistic whole-portfolio figures. Deliberately
    /// *not* its own pre-#129 per-class table blended forward: see the
    /// resolution in `Deserialize`.
    #[test]
    fn missing_strategy_volatility_falls_back_to_portfolio_figures() {
        let value = serde_json::json!({
            "inflation": 0.025,
            "plan_end_age": 95,
        });

        let parsed: Assumptions = serde_json::from_value(value).expect("parses");

        assert_eq!(
            parsed.strategy_volatility,
            crate::presets::default_strategy_volatility()
        );
    }

    /// A plan written before #129 carries four per-class returns. Each
    /// strategy must load as the weighted average `grow` computed from them
    /// every period, so the deterministic projection does not move.
    #[test]
    fn legacy_asset_returns_blend_to_per_strategy_rates() {
        let value = serde_json::json!({
            "inflation": 0.025,
            "asset_returns": {
                "UsEquity": 0.08,
                "IntlEquity": 0.075,
                "GlobalEquity": 0.078,
                "UsBonds": 0.04,
            },
        });

        let parsed: Assumptions = serde_json::from_value(value).expect("parses");

        // 90/10: 0.6(8%) + 0.3(7.5%) + 0.1(4%)
        assert_close(parsed.strategy_returns.aggressive, 0.0745);
        // 70/30: 0.45(8%) + 0.25(7.5%) + 0.3(4%)
        assert_close(parsed.strategy_returns.moderate, 0.06675);
        // 50/50 global equity and bonds
        assert_close(parsed.strategy_returns.conservative, 0.059);
    }

    /// The blend reads the plan's *own* table, not the shipped defaults, so a
    /// plan whose returns were edited keeps its own forecast.
    #[test]
    fn legacy_blend_uses_the_plans_own_edited_returns() {
        let value = serde_json::json!({
            "inflation": 0.025,
            "asset_returns": {
                "UsEquity": 0.10,
                "IntlEquity": 0.09,
                "GlobalEquity": 0.085,
                "UsBonds": 0.05,
            },
        });

        let parsed: Assumptions = serde_json::from_value(value).expect("parses");

        assert_close(parsed.strategy_returns.aggressive, 0.092);
        assert_close(parsed.strategy_returns.moderate, 0.0825);
        assert_close(parsed.strategy_returns.conservative, 0.0675);
    }

    /// Per-strategy returns win where both keys are present — a current
    /// build's output is never reinterpreted through the table it replaced.
    #[test]
    fn explicit_strategy_returns_beat_the_legacy_table() {
        let value = serde_json::json!({
            "inflation": 0.025,
            "strategy_returns": { "aggressive": 0.09, "moderate": 0.07, "conservative": 0.05 },
            "asset_returns": { "UsEquity": 0.99 },
        });

        let parsed: Assumptions = serde_json::from_value(value).expect("parses");

        assert_close(parsed.strategy_returns.aggressive, 0.09);
    }

    /// The boundary wins where both keys are present — a current build's
    /// output is never reinterpreted through the field it replaced.
    #[test]
    fn explicit_boundary_beats_the_legacy_boolean() {
        let value = serde_json::json!({
            "inflation": 0.025,
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
