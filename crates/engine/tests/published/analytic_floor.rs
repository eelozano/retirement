//! The one projection whose answer needs no publication at all: with no
//! return, no inflation and no tax, $1,000,000 spent at $40,000 a year is
//! gone in exactly 25 years. Anything the loop adds or loses — a period
//! counted twice, growth applied to a withdrawal, a flow dropped — shows
//! here first, in the simplest arithmetic there is.

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus, GrowthRule,
    PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile, StreamBoundary,
    StreamDirection, StreamKind, TaxFigures, YearMonth, SCHEMA_VERSION,
};
use engine::simulate;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};

use crate::assert_cents;

fn floor_plan() -> Plan {
    let person = "p1".to_string();
    Plan {
        id: "floor".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "analytic floor".to_string(),
        sample: false,
        // Retired from the first month, so there is no salary and no
        // early-withdrawal question; the horizon ends in January of the
        // year they turn 91, so the last period is 2050 and there are 25.
        people: vec![Person {
            id: person.clone(),
            name: "Solo".to_string(),
            birth: YearMonth::new(1960, 1),
            retirement: YearMonth::new(2026, 1),
            life_expectancy_age: 91,
        }],
        // A taxable account whose basis is its whole balance: a sale
        // realizes no gain, so even a real tax model would have nothing
        // to tax.
        accounts: vec![Account {
            id: "brokerage".to_string(),
            owner: person.clone(),
            kind: AccountKind::Taxable,
            name: "Brokerage".to_string(),
            balance: 1_000_000.0,
            cost_basis: Some(1_000_000.0),
            allocation: AllocationRef::FixedRate(0.0),
            plan_type: PlanType::None,
            contributions: vec![],
            one_time_contributions: vec![],
            employer_match: None,
            rule_of_55: false,
        }],
        streams: vec![CashFlowStream {
            id: "spending".to_string(),
            name: "Spending".to_string(),
            owner: None,
            direction: StreamDirection::Expense,
            annual_amount: 40_000.0,
            start: StreamBoundary::PlanStart,
            end: StreamBoundary::PlanEnd,
            growth: GrowthRule::None,
            survivor_percentage: None,
            kind: StreamKind::General,
        }],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 91,
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
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

/// After year n (counting from 1) the balance is 1,000,000 - 40,000 x n,
/// and after year 25 it is 1,000,000 - 1,000,000 = 0.
#[test]
fn a_million_at_forty_thousand_a_year_lasts_exactly_25_years() {
    let plan = floor_plan();
    let returns = FixedReturns::new(
        &plan.assumptions.strategy_returns,
        plan.sim_config.period.months(),
    );
    let projection = simulate(
        &plan,
        &TaxFigures::built_in(),
        &returns,
        &FlatTax { rate: 0.0 },
        &ProportionalDrawdown,
        0,
    );

    assert_eq!(projection.snapshots.len(), 25, "periods 2026 through 2050");
    for (i, snapshot) in projection.snapshots.iter().enumerate() {
        let years_spent = (i + 1) as f64;
        assert_cents(
            snapshot.expenses,
            40_000.0,
            &format!("year {} spending", i + 1),
        );
        assert_cents(snapshot.taxes, 0.0, &format!("year {} tax", i + 1));
        assert_cents(
            snapshot.net_worth,
            1_000_000.0 - 40_000.0 * years_spent,
            &format!("year {} net worth", i + 1),
        );
    }
    assert_cents(
        projection.snapshots.last().unwrap().net_worth,
        0.0,
        "ending balance",
    );
}
