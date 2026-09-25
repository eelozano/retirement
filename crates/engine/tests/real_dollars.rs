//! The real-dollar convention (#146): a flow is deflated by the period's
//! start factor (`deflator`), a balance by its end factor (`deflator_end`).
//!
//! The case that pins it is an account earning exactly the inflation rate
//! with nothing going in or out. Its real value is what it started as, in
//! every year, by construction — so any figure that is not flat is the
//! convention's error, not the plan's.
//!
//! Zero-tax throughout: these tests are about which factor a figure is
//! divided by, and a tax bill would only put arithmetic between the two.

use engine::model::TaxFigures;
use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus, GrowthRule,
    PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile, StreamBoundary,
    StreamDirection, StreamKind, YearMonth, SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{run_monte_carlo, simulate, MonteCarloConfig, Projection};

const RATE: f64 = 0.03;
const OPENING_BALANCE: f64 = 1_000_000.0;
const SPENDING: f64 = 40_000.0;
/// The tolerance the acceptance criteria set: a real balance is flat to a
/// billionth, relative.
const TOLERANCE: f64 = 1e-9;

/// One person and one taxable account earning exactly `RATE`, under an
/// inflation assumption of the same `RATE`, from `start` for five calendar
/// years. With `spending`, an inflation-grown expense as well.
fn plan(start: YearMonth, spending: bool) -> Plan {
    let person = "p1".to_string();
    let birth = YearMonth::new(1966, 1);
    let last_year = start.year + 4;
    Plan {
        id: "real-dollars".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "real-dollars".to_string(),
        sample: false,
        people: vec![Person {
            id: person.clone(),
            name: "Solo".to_string(),
            birth,
            retirement: YearMonth::new(2020, 1),
            // The horizon's January is exclusive, so the last period is
            // `last_year`.
            life_expectancy_age: (last_year + 1 - birth.year) as u8,
        }],
        accounts: vec![Account {
            id: "brokerage".to_string(),
            owner: person,
            kind: AccountKind::Taxable,
            name: "Brokerage".to_string(),
            balance: OPENING_BALANCE,
            cost_basis: Some(OPENING_BALANCE),
            allocation: AllocationRef::FixedRate(RATE),
            plan_type: PlanType::None,
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
            inflation: RATE,
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
        },
        sim_config: SimConfig {
            start,
            period: PeriodLength::Year,
            display_real_dollars: true,
        },
    }
}

fn run(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(&plan.assumptions.strategy_returns, 12);
    simulate(
        plan,
        &TaxFigures::built_in(),
        &returns,
        &FlatTax { rate: 0.0 },
        &ProportionalDrawdown,
        0,
    )
}

fn assert_flat(actual: f64, expected: f64, label: &str) {
    assert!(
        ((actual - expected) / expected).abs() < TOLERANCE,
        "{label}: expected {expected}, got {actual}"
    );
}

/// The defect itself, and its fix: an account that only keeps pace with
/// inflation is flat in real dollars when divided by the end-of-period
/// factor, and — this is what the old convention showed — a year ahead of
/// itself when divided by the start factor.
#[test]
fn an_account_earning_inflation_is_flat_in_real_dollars() {
    let projection = run(&plan(YearMonth::new(2026, 1), false));
    assert_eq!(projection.snapshots.len(), 5);

    for s in &projection.snapshots {
        let year = s.period_start.year;
        assert_flat(
            s.net_worth / s.deflator_end,
            OPENING_BALANCE,
            &format!("{year} net worth"),
        );
        assert_flat(
            s.balances["brokerage"] / s.deflator_end,
            OPENING_BALANCE,
            &format!("{year} brokerage"),
        );
        // The start factor leaves exactly one year of inflation in.
        assert_flat(
            s.net_worth / s.deflator,
            OPENING_BALANCE * (1.0 + RATE),
            &format!("{year} net worth over the start factor"),
        );
    }
}

/// The same holds through a stub first period, where "a year of inflation"
/// is four months of it: the end factor is the factor at the January the
/// stub runs to.
#[test]
fn a_stub_period_deflates_by_the_factor_at_its_own_end() {
    let projection = run(&plan(YearMonth::new(2026, 9), false));
    assert_eq!(projection.snapshots.len(), 5);

    let stub = &projection.snapshots[0];
    assert_flat(stub.deflator, 1.0, "stub start factor");
    assert_flat(
        stub.deflator_end,
        (1.0 + RATE).powf(4.0 / 12.0),
        "stub end factor",
    );

    for s in &projection.snapshots {
        assert_flat(
            s.net_worth / s.deflator_end,
            OPENING_BALANCE,
            &format!("{} net worth", s.period_start.year),
        );
    }
}

/// Periods tile the timeline, so where one ends the next begins — the end
/// factor is not a second clock, just the start factor a period later.
#[test]
fn a_periods_end_factor_is_the_next_periods_start_factor() {
    for start in [YearMonth::new(2026, 1), YearMonth::new(2026, 9)] {
        let projection = run(&plan(start, false));
        for pair in projection.snapshots.windows(2) {
            assert_flat(
                pair[0].deflator_end,
                pair[1].deflator,
                &format!("{} end vs {} start", pair[0].period, pair[1].period),
            );
        }
        for s in &projection.snapshots {
            assert!(s.deflator_end > s.deflator, "period {}", s.period);
        }
    }
}

/// The fix changes what a balance is divided by and nothing about a flow:
/// an expense typed in today's dollars and grown by inflation is that same
/// figure in every year over the start factor, and the start factor is
/// still 1.0 in period 0.
#[test]
fn flows_are_still_deflated_by_the_start_factor() {
    for start in [YearMonth::new(2026, 1), YearMonth::new(2026, 9)] {
        let projection = run(&plan(start, true));
        assert_flat(
            projection.snapshots[0].deflator,
            1.0,
            "period 0 start factor",
        );
        for s in &projection.snapshots {
            let months = if s.period == 0 {
                (13 - start.month) as f64
            } else {
                12.0
            };
            assert_flat(
                s.expenses / s.deflator,
                SPENDING * months / 12.0,
                &format!("{} expenses", s.period_start.year),
            );
        }
    }
}

/// The Monte Carlo percentiles carry the same pair, taken from the same
/// timeline as the deterministic run.
#[test]
fn percentiles_carry_the_same_deflators_as_the_projection() {
    let plan = plan(YearMonth::new(2026, 9), false);
    let projection = run(&plan);
    let result = run_monte_carlo(
        &plan,
        &TaxFigures::built_in(),
        &MonteCarloConfig {
            n_paths: 8,
            seed: 1,
        },
    );
    assert_eq!(result.percentiles.len(), projection.snapshots.len());
    for (p, s) in result.percentiles.iter().zip(&projection.snapshots) {
        assert_flat(p.deflator, s.deflator, "percentile start factor");
        assert_flat(p.deflator_end, s.deflator_end, "percentile end factor");
    }
}
