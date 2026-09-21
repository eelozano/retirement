//! Default assumptions, portfolio presets, and the seed plan. Defaults live
//! here (in Rust) so the frontend fetches them instead of duplicating them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    SocialSecurityBenefit, StateCode, StateTaxProfile, StrategyRates, StreamBoundary,
    StreamDirection, StreamKind, TaxFigures, YearMonth, SCHEMA_VERSION,
};
use crate::state_tax_data::state_tax_profiles;

/// Indexed figures round down to a statutory increment: $500 for the
/// deferral, IRA, and employer catch-up limits; $100 for the IRA catch-up.
/// Modelling the rounding matters because it is what makes a limit sit still
/// for a few years and then step — smooth exponential growth would drift
/// away from the real schedule.
pub(crate) fn index_to(base: f64, increment: f64, years: f64, inflation: f64) -> f64 {
    let indexed = base * (1.0 + inflation).powf(years);
    (indexed / increment).floor() * increment
}

/// Age at which required minimum distributions begin, for someone born in
/// `birth_year`. SECURE 2.0 (IRC 401(a)(9)(C)(v)): 73 for people born 1951
/// through 1959, 75 for 1960 and later.
///
/// Anyone born 1950 or earlier reached their required beginning date under
/// the older rules — 70½ or 72 depending on the year — and is already
/// distributing before any projection this app can start. 72 is returned for
/// them because the only question a projection starting today can ask is
/// "are they past it", and for that cohort the answer is yes either way.
///
/// **Not inflation-indexed**, and neither is [`uniform_lifetime_divisor`].
/// Everything else statutory in this module is a dollar amount that runs
/// through `index_to`; these two are an age and a mortality divisor, fixed
/// until Congress or the IRS changes them.
pub fn rmd_age(birth_year: i32) -> i32 {
    match birth_year {
        ..=1950 => 72,
        1951..=1959 => 73,
        _ => 75,
    }
}

/// First age in [`UNIFORM_LIFETIME_DIVISORS`].
pub const UNIFORM_LIFETIME_FIRST_AGE: i32 = 72;

/// IRS Uniform Lifetime Table, Treas. Reg. 1.401(a)(9)-9(c), as reissued
/// effective 2022 — divisors for ages 72 through 120, in order. Age 120 is
/// the table's "120 and older" row.
///
/// The table starts at 72 because that is the earliest required beginning
/// age any living cohort has (see [`rmd_age`]); the published table's
/// younger rows only apply to beneficiaries, which this engine does not
/// model.
pub const UNIFORM_LIFETIME_DIVISORS: [f64; 49] = [
    27.4, 26.5, 25.5, 24.6, 23.7, 22.9, 22.0, 21.1, 20.2, 19.4, // 72-81
    18.5, 17.7, 16.8, 16.0, 15.2, 14.4, 13.7, 12.9, 12.2, 11.5, // 82-91
    10.8, 10.1, 9.5, 8.9, 8.4, 7.8, 7.3, 6.8, 6.4, 6.0, // 92-101
    5.6, 5.2, 4.9, 4.6, 4.3, 4.1, 3.9, 3.7, 3.5, 3.4, // 102-111
    3.3, 3.1, 3.0, 2.9, 2.8, 2.7, 2.5, 2.3, 2.0, // 112-120
];

/// Uniform Lifetime divisor for someone attaining `age` during the
/// distribution year: divide the prior year-end balance by it to get that
/// year's required minimum.
///
/// `None` below the table's first age — the caller has no distribution to
/// compute there. Ages past the last row take the "120 and older" divisor,
/// which is what the table itself says to do.
pub fn uniform_lifetime_divisor(age: i32) -> Option<f64> {
    if age < UNIFORM_LIFETIME_FIRST_AGE {
        return None;
    }
    let idx = (age - UNIFORM_LIFETIME_FIRST_AGE) as usize;
    Some(UNIFORM_LIFETIME_DIVISORS[idx.min(UNIFORM_LIFETIME_DIVISORS.len() - 1)])
}

/// Bundle the frontend fetches once at startup.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Presets {
    pub default_assumptions: Assumptions,
    /// The yearly tax figures and the tax year they are for. The engine's
    /// `presets()` carries the built-in set; the app replaces it with the
    /// user's `tax-figures.yaml`, so the frontend shows the figures actually
    /// in use and never hardcodes a statutory figure of its own.
    pub tax_figures: TaxFigures,
    /// Prefill bracket schedule for each state's income tax, keyed by
    /// `StateCode`. Picking a state in the UI copies its entry into
    /// `Assumptions.state_tax`; the plan then owns an editable copy — this
    /// map is never consulted again at simulate time.
    pub state_tax_profiles: BTreeMap<StateCode, StateTaxProfile>,
}

/// Nominal expected annual return for each strategy, seeding
/// `Assumptions::strategy_returns` for a new plan.
///
/// Round figures a person would actually type. The pre-#129 per-class
/// defaults blended to 7.45 / 6.675 / 5.9 under each preset's weights, and a
/// plan carried across that change keeps its *own* blend to the last decimal
/// — see `AssumptionsWire`. These are only what a new plan starts from, so
/// there is nothing to preserve here and no reason to ship 6.675%.
pub fn default_strategy_returns() -> StrategyRates {
    StrategyRates {
        aggressive: 0.075,
        moderate: 0.067,
        conservative: 0.059,
    }
}

/// Annualized standard deviation for each strategy, seeding
/// `Assumptions::strategy_volatility` — for a new plan, and also for any
/// plan written before #129, which carries no per-strategy figure of its
/// own.
///
/// Whole-portfolio figures for a 90/10, a 70/30 and a 50/50: roughly what
/// those mixes have actually done. The four independent per-class draws this
/// replaced implied 12.4 / 9.7 / 9.0 — `sqrt(Σ wᵢ² σᵢ²)` under each preset's
/// weights — about three points too narrow at the aggressive end, because
/// independent draws let equity diversify against equity.
///
/// So this widens the fan and lowers reported probability of success on a
/// plan nobody edited: across the demo scenarios, by 6.7 to 10.1
/// points (the base scenario goes 0.948 → 0.881 at 2,000 paths). It is the
/// one place this project knowingly breaks "an upgrade never changes a
/// saved plan's output", and it breaks it because the old number was wrong.
pub fn default_strategy_volatility() -> StrategyRates {
    StrategyRates {
        aggressive: 0.155,
        moderate: 0.115,
        conservative: 0.090,
    }
}

pub fn default_assumptions() -> Assumptions {
    Assumptions {
        // Roughly the long-run US average, and deliberately above the 2%
        // target a shorter window would suggest. This is not only a display
        // divisor: it indexes the tax brackets and contribution limits
        // forward and escalates every stream set to grow with inflation, so
        // the cost of seeding it low is spread across the whole projection
        // rather than confined to the today's-dollars toggle. Against the
        // unchanged nominal returns above it implies a 4.4% real return for
        // `Aggressive`.
        inflation: 0.03,
        strategy_returns: default_strategy_returns(),
        strategy_volatility: default_strategy_volatility(),
        filing_status: FilingStatus::Single,
        // No state selected by default — we don't know where the user
        // lives; the state picker prefills a real bracket schedule once
        // they choose one.
        state_tax: StateTaxProfile::none(),
        plan_end_age: 95,
        // Never, until the user says when — see the field docs for why the
        // answer differs either side of retirement.
        sweep_surplus_from: None,
        // No step-down until the user picks one — see the field docs.
        survivor_expense_factor: 1.0,
        // Held equal to `inflation` above, because SSA's COLA tracks CPI-W
        // and the two are the same underlying quantity. A COLA that lags
        // inflation is a real possibility but it is a *choice*, and a
        // default should not make it silently: a new plan would otherwise
        // assume benefits lose purchasing power every year without saying so.
        social_security_cola: 0.03,
        reinvest_into: None,
        drawdown: Default::default(),
    }
}

pub fn presets() -> Presets {
    Presets {
        default_assumptions: default_assumptions(),
        tax_figures: TaxFigures::built_in(),
        state_tax_profiles: state_tax_profiles(),
    }
}

/// The invented example household — Alex and Jordan and their invented
/// balances. It is the fixture every engine test projects against, and the
/// plan the app writes when the user explicitly asks to load an example to
/// look around.
///
/// It is **not** what a fresh install bootstraps: until #103 it was, and a
/// new user's first screen was a complete projection for a household that
/// does not exist, with nothing saying so. A new install now starts empty
/// (see [`new_plan`]).
///
/// Per CLAUDE.md this household stays invented — it is public, committed,
/// and screenshotted, and must never be seeded from anyone's real plan.
pub fn seed_plan() -> Plan {
    let alex = "alex".to_string();
    let jordan = "jordan".to_string();
    Plan {
        id: "base-plan".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "Base plan".to_string(),
        sample: true,
        people: vec![
            Person {
                id: alex.clone(),
                name: "Alex".to_string(),
                birth: YearMonth::new(1983, 8),
                retirement: YearMonth::new(2038, 8),
                life_expectancy_age: 88,
            },
            Person {
                id: jordan.clone(),
                name: "Jordan".to_string(),
                birth: YearMonth::new(1987, 6),
                retirement: YearMonth::new(2042, 8),
                life_expectancy_age: 96,
            },
        ],
        accounts: vec![
            Account {
                id: "taxable-brokerage".to_string(),
                owner: alex.clone(),
                kind: AccountKind::Taxable,
                name: "Taxable Brokerage".to_string(),
                balance: 150_000.0,
                cost_basis: Some(110_000.0),
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::None,
                contributions: vec![Contribution::until_retirement(
                    "taxable-brokerage-contribution",
                    ContributionRule::FlatAmount {
                        amount: 40_000.0,
                        growth: GrowthRule::None,
                    },
                    &alex,
                )],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
            },
            Account {
                id: "alex-401k".to_string(),
                owner: alex.clone(),
                kind: AccountKind::TraditionalPreTax,
                name: "Alex 401(k)".to_string(),
                balance: 400_000.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::EmployerPlan,
                // Intent rather than a frozen figure: a fresh install then
                // indexes the limit forward and picks up catch-up as the
                // owner ages, instead of deferring 2026's number in 2041.
                contributions: vec![Contribution::until_retirement(
                    "alex-401k-contribution",
                    ContributionRule::FederalMaximum,
                    &alex,
                )],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
            },
            Account {
                id: "jordan-roth".to_string(),
                owner: jordan.clone(),
                kind: AccountKind::Roth,
                name: "Jordan Roth IRA".to_string(),
                balance: 80_000.0,
                cost_basis: None,
                allocation: AllocationRef::Moderate,
                plan_type: PlanType::Ira,
                contributions: vec![Contribution::until_retirement(
                    "jordan-roth-contribution",
                    ContributionRule::FederalMaximum,
                    &jordan,
                )],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
            },
        ],
        streams: vec![
            CashFlowStream {
                id: "alex-salary".to_string(),
                name: "Alex salary".to_string(),
                owner: Some(alex.clone()),
                direction: StreamDirection::Income,
                annual_amount: 140_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(alex.clone()),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
                kind: StreamKind::General,
            },
            CashFlowStream {
                id: "jordan-salary".to_string(),
                name: "Jordan salary".to_string(),
                owner: Some(jordan.clone()),
                direction: StreamDirection::Income,
                annual_amount: 110_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(jordan),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
                kind: StreamKind::General,
            },
            CashFlowStream {
                id: "household-spending".to_string(),
                name: "Household spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 96_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
                kind: StreamKind::General,
            },
        ],
        social_security: vec![SocialSecurityBenefit {
            id: "alex-social-security".to_string(),
            owner: alex,
            benefit_at_fra: 32_000.0,
            // Derived from the birth year rather than stated: 1983 is in the
            // 1960-and-later cohort, so this is 67 — the figure the seed
            // always carried.
            full_retirement_age: None,
            claiming_age: 70,
            cola_override: None,
        }],
        assumptions: default_assumptions(),
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

/// An empty plan for a household the user has just described: their people,
/// and nothing else. No accounts, no income, no spending — those are what
/// the user is about to enter, and inventing placeholders for them is what
/// [`seed_plan`] is for and what a *new* plan must never do (#103).
///
/// `start` is passed in rather than read from a clock: the engine is a pure
/// library, so "now" is the adapter's call.
pub fn new_plan(name: &str, start: YearMonth, people: Vec<Person>) -> Plan {
    Plan {
        // Assigned by the storage layer, which owns file-name uniqueness.
        id: String::new(),
        schema_version: SCHEMA_VERSION,
        name: name.to_string(),
        sample: false,
        people,
        accounts: Vec::new(),
        streams: Vec::new(),
        social_security: Vec::new(),
        assumptions: default_assumptions(),
        sim_config: SimConfig {
            start,
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}
