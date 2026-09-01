//! Default assumptions, portfolio presets, and the seed plan. Defaults live
//! here (in Rust) so the frontend fetches them instead of duplicating them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    SocialSecurityBenefit, StateCode, StateTaxProfile, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use crate::state_tax_data::state_tax_profiles;

/// Tax year the statutory figures in `CONTRIBUTION_LIMITS` are published
/// for. The app is local-first with no network, so these go stale between
/// releases rather than updating themselves — the year is surfaced in the
/// UI so a projection never implies the numbers are live.
pub const LIMITS_BASIS_YEAR: i32 = 2026;

/// Statutory elective-deferral limit for employer plans — 401(k), 403(b),
/// 457(b), Thrift Savings — shared across every such plan a person
/// participates in. IRS Notice 2025-67, tax year 2026.
pub const ELECTIVE_DEFERRAL_LIMIT: f64 = 24_500.0;

/// Statutory IRA contribution limit, shared across a person's traditional
/// and Roth IRAs. IRS Notice 2025-67, tax year 2026.
pub const IRA_CONTRIBUTION_LIMIT: f64 = 7_500.0;

/// Statutory limits for one tax year, indexed forward by the engine.
///
/// Every figure is IRS Notice 2025-67 (tax year 2026), verified against the
/// IRS COLA table. They are carried as data rather than constants so the
/// frontend can show the basis year alongside them, and so a limit lookup is
/// a pure function of (bucket, age, year, inflation).
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug)]
#[ts(export)]
pub struct ContributionLimits {
    /// Tax year these figures are published for.
    pub basis_year: i32,
    /// IRC 402(g)(1) elective deferral limit.
    pub employer_plan: f64,
    /// IRC 414(v) catch-up, added from the year the owner turns 50.
    pub employer_plan_catch_up_50: f64,
    /// SECURE 2.0 higher catch-up, which *replaces* the age-50 figure for
    /// the years the owner turns 60 through 63.
    pub employer_plan_catch_up_60_63: f64,
    /// IRC 219(b)(5)(A) IRA limit.
    pub ira: f64,
    /// IRC 219(b)(5)(B) IRA catch-up, added from the year the owner turns 50.
    pub ira_catch_up_50: f64,
    /// IRC 415(c)(1)(A) annual additions cap: everything that lands in an
    /// employer plan in a year — the employee's own deferrals *and* the
    /// employer match. Far higher than the deferral limit, which is the
    /// whole point: matched dollars are not held to the employee's cap.
    pub annual_additions: f64,
}

pub const CONTRIBUTION_LIMITS: ContributionLimits = ContributionLimits {
    basis_year: LIMITS_BASIS_YEAR,
    employer_plan: ELECTIVE_DEFERRAL_LIMIT,
    employer_plan_catch_up_50: 8_000.0,
    employer_plan_catch_up_60_63: 11_250.0,
    ira: IRA_CONTRIBUTION_LIMIT,
    ira_catch_up_50: 1_100.0,
    annual_additions: 72_000.0,
};

/// Indexed figures round down to a statutory increment: $500 for the
/// deferral, IRA, and employer catch-up limits; $100 for the IRA catch-up.
/// Modelling the rounding matters because it is what makes a limit sit still
/// for a few years and then step — smooth exponential growth would drift
/// away from the real schedule.
fn index_to(base: f64, increment: f64, years: f64, inflation: f64) -> f64 {
    let indexed = base * (1.0 + inflation).powf(years);
    (indexed / increment).floor() * increment
}

impl ContributionLimits {
    /// The annual limit for `plan_type` in calendar year `year`, for an owner
    /// who reaches `age` during that year, with the seeded figures indexed
    /// forward from `basis_year` at `inflation`.
    ///
    /// `None` means "no statutory cap" — a taxable brokerage.
    ///
    /// Catch-up eligibility is by the age *attained during* the calendar
    /// year, which is the statutory rule: someone turning 50 in December is
    /// eligible for that whole year.
    /// The 415(c) annual-additions cap for `year`, indexed from
    /// `basis_year`. Catch-up contributions sit on top of 415(c) rather than
    /// inside it, so the eligible catch-up for `age` is added back.
    ///
    /// 415(c) is statutorily **per employer plan**; this model has no
    /// employer grouping, so it is applied per person. That is the stricter
    /// reading, and only differs for someone in two employers' plans at once.
    pub fn annual_additions_limit(&self, age: i32, year: i32, inflation: f64) -> f64 {
        let years = (year - self.basis_year) as f64;
        let catch_up = match age {
            60..=63 => index_to(self.employer_plan_catch_up_60_63, 500.0, years, inflation),
            a if a >= 50 => index_to(self.employer_plan_catch_up_50, 500.0, years, inflation),
            _ => 0.0,
        };
        index_to(self.annual_additions, 1_000.0, years, inflation) + catch_up
    }

    pub fn annual_limit(
        &self,
        plan_type: PlanType,
        age: i32,
        year: i32,
        inflation: f64,
    ) -> Option<f64> {
        let years = (year - self.basis_year) as f64;
        match plan_type {
            PlanType::None => None,
            PlanType::EmployerPlan => {
                let catch_up = match age {
                    60..=63 => index_to(self.employer_plan_catch_up_60_63, 500.0, years, inflation),
                    a if a >= 50 => {
                        index_to(self.employer_plan_catch_up_50, 500.0, years, inflation)
                    }
                    _ => 0.0,
                };
                Some(index_to(self.employer_plan, 500.0, years, inflation) + catch_up)
            }
            PlanType::Ira => {
                let catch_up = if age >= 50 {
                    index_to(self.ira_catch_up_50, 100.0, years, inflation)
                } else {
                    0.0
                };
                Some(index_to(self.ira, 500.0, years, inflation) + catch_up)
            }
        }
    }
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
    /// Statutory contribution limits and the tax year they are published
    /// for. Lives here so the frontend never hardcodes a statutory figure of
    /// its own, and so it can disclose the basis year next to them.
    pub contribution_limits: ContributionLimits,
    /// Asset-class weights for each named `AllocationRef` preset.
    pub allocations: BTreeMap<String, BTreeMap<AssetClass, f64>>,
    /// Prefill bracket schedule for each state's income tax, keyed by
    /// `StateCode`. Picking a state in the UI copies its entry into
    /// `Assumptions.state_tax`; the plan then owns an editable copy — this
    /// map is never consulted again at simulate time.
    pub state_tax_profiles: BTreeMap<StateCode, StateTaxProfile>,
}

/// Boglehead-style three-fund weights for a named preset.
///
/// - Aggressive: 90/10 stocks/bonds — VTI 60%, VXUS 30%, BND 10%
/// - Moderate:   70/30 — VTI 45%, VXUS 25%, BND 30%
/// - Conservative: 50/50 — VT 50%, BND 50%
pub fn allocation_weights(alloc: &AllocationRef) -> BTreeMap<AssetClass, f64> {
    match alloc {
        AllocationRef::Aggressive => BTreeMap::from([
            (AssetClass::UsEquity, 0.60),
            (AssetClass::IntlEquity, 0.30),
            (AssetClass::UsBonds, 0.10),
        ]),
        AllocationRef::Moderate => BTreeMap::from([
            (AssetClass::UsEquity, 0.45),
            (AssetClass::IntlEquity, 0.25),
            (AssetClass::UsBonds, 0.30),
        ]),
        AllocationRef::Conservative => BTreeMap::from([
            (AssetClass::GlobalEquity, 0.50),
            (AssetClass::UsBonds, 0.50),
        ]),
        AllocationRef::Custom(weights) => weights.clone(),
    }
}

pub fn default_assumptions() -> Assumptions {
    Assumptions {
        inflation: 0.025,
        asset_returns: BTreeMap::from([
            (AssetClass::UsEquity, 0.08),
            (AssetClass::IntlEquity, 0.075),
            (AssetClass::GlobalEquity, 0.078),
            (AssetClass::UsBonds, 0.04),
        ]),
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
        social_security_cola: 0.025,
    }
}

/// Fixed annualized standard deviation per asset class, used by
/// `StochasticReturns` (Monte Carlo). Approximate historical figures, not
/// user-editable in V1 — unlike `asset_returns`, which the plan owns.
pub fn asset_volatility() -> BTreeMap<AssetClass, f64> {
    BTreeMap::from([
        (AssetClass::UsEquity, 0.18),
        (AssetClass::IntlEquity, 0.20),
        (AssetClass::GlobalEquity, 0.17),
        (AssetClass::UsBonds, 0.06),
    ])
}

pub fn presets() -> Presets {
    Presets {
        default_assumptions: default_assumptions(),
        contribution_limits: CONTRIBUTION_LIMITS,
        allocations: BTreeMap::from([
            (
                "Aggressive".to_string(),
                allocation_weights(&AllocationRef::Aggressive),
            ),
            (
                "Moderate".to_string(),
                allocation_weights(&AllocationRef::Moderate),
            ),
            (
                "Conservative".to_string(),
                allocation_weights(&AllocationRef::Conservative),
            ),
        ]),
        state_tax_profiles: state_tax_profiles(),
    }
}

/// Starter plan bootstrapped on first run. Balances, salaries, and spending
/// are editable placeholders — only the people and dates are real inputs.
pub fn seed_plan() -> Plan {
    let enrique = "enrique".to_string();
    let claire = "claire".to_string();
    Plan {
        id: "base-plan".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "Base plan".to_string(),
        people: vec![
            Person {
                id: enrique.clone(),
                name: "Enrique".to_string(),
                birth: YearMonth::new(1983, 8),
                retirement: YearMonth::new(2038, 8),
                life_expectancy_age: 88,
            },
            Person {
                id: claire.clone(),
                name: "Claire".to_string(),
                birth: YearMonth::new(1987, 6),
                retirement: YearMonth::new(2042, 8),
                life_expectancy_age: 96,
            },
        ],
        accounts: vec![
            Account {
                id: "taxable-brokerage".to_string(),
                owner: enrique.clone(),
                kind: AccountKind::Taxable,
                name: "Taxable Brokerage".to_string(),
                balance: 150_000.0,
                cost_basis: Some(110_000.0),
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::None,
                contribution: ContributionRule::FlatAmount(40_000.0),
                employer_match: None,
            },
            Account {
                id: "enrique-401k".to_string(),
                owner: enrique.clone(),
                kind: AccountKind::TraditionalPreTax,
                name: "Enrique 401(k)".to_string(),
                balance: 400_000.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::EmployerPlan,
                contribution: ContributionRule::FlatAmount(ELECTIVE_DEFERRAL_LIMIT),
                employer_match: None,
            },
            Account {
                id: "claire-roth".to_string(),
                owner: claire.clone(),
                kind: AccountKind::Roth,
                name: "Claire Roth IRA".to_string(),
                balance: 80_000.0,
                cost_basis: None,
                allocation: AllocationRef::Moderate,
                plan_type: PlanType::Ira,
                contribution: ContributionRule::FlatAmount(IRA_CONTRIBUTION_LIMIT),
                employer_match: None,
            },
        ],
        streams: vec![
            CashFlowStream {
                id: "enrique-salary".to_string(),
                name: "Enrique salary".to_string(),
                owner: Some(enrique.clone()),
                direction: StreamDirection::Income,
                annual_amount: 140_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(enrique.clone()),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "claire-salary".to_string(),
                name: "Claire salary".to_string(),
                owner: Some(claire.clone()),
                direction: StreamDirection::Income,
                annual_amount: 110_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(claire),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
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
            },
        ],
        social_security: vec![SocialSecurityBenefit {
            id: "enrique-social-security".to_string(),
            owner: enrique,
            benefit_at_fra: 32_000.0,
            full_retirement_age: 67,
            claiming_age: 70,
            cola_override: None,
        }],
        assumptions: default_assumptions(),
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
            show_monte_carlo_band: false,
        },
    }
}
