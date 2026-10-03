//! A run against a `PriceLevel::Path` rather than the plan's one inflation
//! rate — what a historical replay needs, since 1970s returns without 1970s
//! inflation flatter a plan badly.
//!
//! Two things are pinned. A path that never leaves the plan's own rate
//! projects as the constant does, so the path machinery adds nothing of its
//! own. And a path that does move carries every inflation-driven figure
//! with it: an account earning exactly each year's inflation is flat in
//! real dollars, an inflation-grown expense is flat in real dollars, and a
//! flat real income pays a flat real tax however uneven the years between.

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus, GrowthRule,
    PeriodLength, Person, Plan, PlanType, PriceLevel, PricePath, SimConfig, StateTaxProfile,
    StrategyRates, StreamBoundary, StreamDirection, StreamKind, TaxFigures, YearMonth,
    SCHEMA_VERSION,
};
use engine::presets::seed_plan;
use engine::strategies::{
    BracketTax, FixedReturns, FlatTax, IncomeBreakdown, PeriodIndex, ProportionalDrawdown,
    ReturnModel, StrategyReturns, TaxModel,
};
use engine::{run_deterministic, run_with, simulate_with_prices, Projection};

const TOLERANCE: f64 = 1e-9;

/// Ten years of uneven inflation, deflation included, then the plan's own.
const RATES: [f64; 10] = [
    0.031, 0.112, 0.135, -0.021, 0.004, 0.064, 0.091, 0.018, 0.025, 0.0,
];

fn close(actual: f64, expected: f64) -> bool {
    (actual - expected).abs() <= TOLERANCE * expected.abs().max(1.0)
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        close(actual, expected),
        "{label}: expected {expected}, got {actual}"
    );
}

#[test]
fn a_path_at_the_plan_rate_projects_as_the_constant() {
    let figures = TaxFigures::built_in();
    for start in [YearMonth::new(2026, 1), YearMonth::new(2026, 10)] {
        let mut plan = seed_plan();
        plan.sim_config.start = start;
        let rate = plan.assumptions.inflation;
        let constant = run_deterministic(&plan, &figures);

        let path = PriceLevel::Path(PricePath::new(start, vec![rate; 100], rate));
        let returns = FixedReturns::new(&plan.assumptions.strategy_returns, 12);
        let replayed = run_with(&plan, &figures, &path, &returns, 0);

        assert_eq!(constant.snapshots.len(), replayed.snapshots.len());
        assert_eq!(constant.warnings, replayed.warnings);
        for (c, r) in constant.snapshots.iter().zip(&replayed.snapshots) {
            let year = c.period_start;
            for (label, c, r) in [
                ("deflator", c.deflator, r.deflator),
                ("deflator_end", c.deflator_end, r.deflator_end),
                ("income", c.income, r.income),
                ("expenses", c.expenses, r.expenses),
                ("taxes", c.taxes, r.taxes),
                ("contributions", c.contributions, r.contributions),
                ("net_worth", c.net_worth, r.net_worth),
            ] {
                assert_close(r, c, &format!("{start} start, {year} {label}"));
            }
        }
    }
}

/// Each period's return is that period's inflation, for every strategy.
struct InflationReturns(Vec<f64>);

impl ReturnModel for InflationReturns {
    fn returns_for(&self, period: PeriodIndex, _path_id: u64) -> StrategyReturns {
        let r = self.0.get(period).copied().unwrap_or(0.0);
        StrategyRates {
            very_aggressive: r,
            aggressive: r,
            moderate: r,
            conservative: r,
            very_conservative: r,
        }
    }
}

const OPENING_BALANCE: f64 = 1_000_000.0;
const SPENDING: f64 = 40_000.0;

/// One retired person and one Roth account priced on a strategy, with an
/// inflation-grown expense when `spending` — over exactly the years of
/// `RATES`.
fn plan(start: YearMonth, spending: bool) -> Plan {
    let person = "p1".to_string();
    let birth = YearMonth::new(1960, 1);
    let last_year = start.year + RATES.len() as i32 - 1;
    Plan {
        id: "price-path".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "price-path".to_string(),
        sample: false,
        people: vec![Person {
            id: person.clone(),
            name: "Solo".to_string(),
            birth,
            retirement: YearMonth::new(2020, 1),
            life_expectancy_age: (last_year + 1 - birth.year) as u8,
        }],
        accounts: vec![Account {
            id: "roth".to_string(),
            owner: person,
            kind: AccountKind::Roth,
            name: "Roth".to_string(),
            balance: OPENING_BALANCE,
            cost_basis: Some(OPENING_BALANCE),
            allocation: AllocationRef::Moderate,
            plan_type: PlanType::Ira,
            contributions: vec![],
            one_time_contributions: vec![],
            employer_match: None,
            rule_of_55: false,
        }],
        streams: if spending {
            vec![CashFlowStream {
                id: "spending".to_string(),
                name: "Spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: SPENDING,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
                kind: StreamKind::General,
            }]
        } else {
            vec![]
        },
        social_security: vec![],
        assumptions: Assumptions {
            // Deliberately unlike any rate on the path: nothing inside it
            // may fall back to the scalar.
            inflation: 0.5,
            strategy_returns: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: (last_year + 1 - birth.year) as u8,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            strategy_volatility: Default::default(),
            reinvest_into: None,
            drawdown: Default::default(),
            dividend_yield: 0.0,
        },
        sim_config: SimConfig {
            start,
            period: PeriodLength::Year,
            display_real_dollars: true,
        },
    }
}

fn run(plan: &Plan) -> Projection {
    let start = plan.sim_config.start;
    let prices = PriceLevel::Path(PricePath::new(
        start,
        RATES.to_vec(),
        plan.assumptions.inflation,
    ));
    simulate_with_prices(
        plan,
        &TaxFigures::built_in(),
        &prices,
        &InflationReturns(RATES.to_vec()),
        &FlatTax { rate: 0.0 },
        &ProportionalDrawdown,
        0,
    )
}

#[test]
fn an_account_earning_each_years_inflation_is_flat_in_real_dollars() {
    for start in [YearMonth::new(2026, 1), YearMonth::new(2026, 9)] {
        let projection = run(&plan(start, false));
        assert_eq!(projection.snapshots.len(), RATES.len());
        for s in &projection.snapshots {
            assert_close(
                s.net_worth / s.deflator_end,
                OPENING_BALANCE,
                &format!("{start} start, {} real net worth", s.period_start),
            );
        }
        // Periods tile the timeline, so one period's end is the next's start.
        for pair in projection.snapshots.windows(2) {
            assert_close(pair[1].deflator, pair[0].deflator_end, "deflators tile");
        }
    }
}

#[test]
fn an_inflation_grown_expense_is_flat_in_real_dollars() {
    let start = YearMonth::new(2026, 9);
    let projection = run(&plan(start, true));
    for s in &projection.snapshots {
        // Each period runs to the next January; only the stub is short.
        let next_january = YearMonth::new(s.period_start.year + 1, 1);
        let fraction = s.period_start.months_until(next_january) as f64 / 12.0;
        assert_close(
            s.expenses / s.deflator,
            SPENDING * fraction,
            &format!("{} real spending", s.period_start),
        );
    }
}

#[test]
fn a_flat_real_income_pays_a_flat_real_tax_through_uneven_years() {
    let figures = TaxFigures::built_in();
    let start = YearMonth::new(figures.tax_year, 1);
    let path = PriceLevel::Path(PricePath::new(start, RATES.to_vec(), 0.5));
    let tax = BracketTax::new(
        &figures,
        FilingStatus::Single,
        StateTaxProfile::none(),
        path.clone(),
        start.year,
        vec![],
    );
    let real_income = 150_000.0;
    let at_start = tax
        .tax(
            &IncomeBreakdown {
                ordinary: real_income,
                ..Default::default()
            },
            0,
        )
        .tax;
    for period in 1..RATES.len() {
        let factor = path.over_calendar_years(start.year, start.year + period as i32);
        let nominal = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: real_income * factor,
                    ..Default::default()
                },
                period,
            )
            .tax;
        // The federal table floors to $25 as it indexes, so a few dollars
        // of real tax move; a bracket that failed to follow the path would
        // move thousands.
        assert!(
            (nominal / factor - at_start).abs() < 100.0,
            "period {period}: real tax {} against {at_start}",
            nominal / factor
        );
    }
}
