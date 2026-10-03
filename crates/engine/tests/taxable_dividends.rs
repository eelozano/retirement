//! Qualified dividends on `Taxable` accounts (#148): paid out of the
//! account's total return each period, reinvested into basis, and taxed on
//! the long-term capital gains schedule in the period they are paid rather
//! than deferred to withdrawal.

use engine::model::TaxFigures;
use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus, GrowthRule,
    PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile, StrategyRates,
    StreamBoundary, StreamDirection, StreamKind, YearMonth, SCHEMA_VERSION,
};
use engine::strategies::{BracketTax, FixedReturns, FlatTax, ProportionalDrawdown, TaxModel};
use engine::{simulate, Projection};

const RETURN: f64 = 0.05;
const BALANCE: f64 = 1_000_000.0;

fn start_year() -> i32 {
    TaxFigures::built_in().tax_year
}

fn stream(id: &str, direction: StreamDirection, amount: f64) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: None,
        direction,
        annual_amount: amount,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::PlanEnd,
        growth: GrowthRule::None,
        survivor_percentage: None,
        kind: StreamKind::General,
    }
}

/// One retiree holding a single brokerage account with no unrealized gain —
/// every dollar in it is basis, so any gain a withdrawal realizes can only
/// come from basis the dividend step failed to add.
fn retiree(dividend_yield: f64, streams: Vec<CashFlowStream>) -> Plan {
    Plan {
        id: "dividends".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "dividends".to_string(),
        sample: false,
        people: vec![Person {
            id: "p1".to_string(),
            name: "Retiree".to_string(),
            birth: YearMonth::new(start_year() - 60, 1),
            retirement: YearMonth::new(start_year(), 1),
            life_expectancy_age: 70,
        }],
        accounts: vec![Account {
            id: "brokerage".to_string(),
            owner: "p1".to_string(),
            kind: AccountKind::Taxable,
            name: "Brokerage".to_string(),
            balance: BALANCE,
            cost_basis: Some(BALANCE),
            allocation: AllocationRef::FixedRate(RETURN),
            plan_type: PlanType::None,
            contributions: vec![],
            one_time_contributions: vec![],
            employer_match: None,
            rule_of_55: false,
        }],
        streams,
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: StrategyRates {
                very_aggressive: RETURN,
                aggressive: RETURN,
                moderate: RETURN,
                conservative: RETURN,
                very_conservative: RETURN,
            },
            strategy_volatility: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 70,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            reinvest_into: None,
            drawdown: Default::default(),
            dividend_yield,
        },
        sim_config: SimConfig {
            start: YearMonth::new(start_year(), 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn run(plan: &Plan, tax: &dyn TaxModel) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.strategy_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &TaxFigures::built_in(),
        &returns,
        tax,
        &ProportionalDrawdown,
        0,
    )
}

fn single_filer(plan: &Plan) -> BracketTax {
    BracketTax::new(
        &TaxFigures::built_in(),
        FilingStatus::Single,
        StateTaxProfile::none(),
        0.0,
        start_year(),
        plan.people.iter().map(|p| p.birth.year).collect(),
    )
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// The dividend raises basis by exactly what it paid, so withdrawing it the
/// same period realizes no gain: the only tax is the dividend's own.
#[test]
fn a_dividend_raises_basis_so_withdrawing_it_is_untaxed() {
    let spending = 10_000.0;
    let plan = retiree(
        0.02,
        vec![stream("spending", StreamDirection::Expense, spending)],
    );
    let projection = run(&plan, &FlatTax { rate: 0.2 });
    let first = &projection.snapshots[0];

    let dividend = BALANCE * 0.02;
    assert_close(first.taxes, 0.2 * dividend, "only the dividend is taxed");
    assert_close(
        first.withdrawal_taxes,
        0.0,
        "the withdrawal realizes no gain: the dividend is basis",
    );
    let withdrawn = spending + 0.2 * dividend;
    assert_close(
        first.withdrawals["brokerage"],
        withdrawn,
        "spending plus the dividend's tax, and nothing more",
    );
    assert_close(
        first.balances["brokerage"],
        (BALANCE - withdrawn) * (1.0 + RETURN),
        "the dividend is part of the 5% total return, not added to it",
    );
}

/// Qualified dividends take the LTCG schedule. With salary filling the
/// ordinary brackets well into 22%, a dividend that stays inside the 15%
/// gains bracket adds exactly 15% of itself to the bill.
#[test]
fn a_dividend_is_taxed_on_the_capital_gains_schedule() {
    let salary = vec![stream("salary", StreamDirection::Income, 100_000.0)];
    let without = retiree(0.0, salary.clone());
    let with = retiree(0.03, salary);

    let base = run(&without, &single_filer(&without)).snapshots[0].taxes;
    let taxed = run(&with, &single_filer(&with)).snapshots[0].taxes;

    assert_close(
        taxed - base,
        0.15 * BALANCE * 0.03,
        "15% LTCG, not the 22% ordinary bracket the salary reaches",
    );
}

/// And the 0% bracket shelters it entirely: $30,000 of dividends and no
/// other income sits under the standard deduction plus the 0% gains band,
/// where the same dollars as interest would owe ordinary tax.
#[test]
fn a_dividend_in_the_zero_percent_band_owes_nothing() {
    let plan = retiree(0.03, vec![]);
    let projection = run(&plan, &single_filer(&plan));
    assert_close(projection.snapshots[0].taxes, 0.0, "0% LTCG band");
}

/// The dividend changes basis and tax, never the balance a given set of
/// flows reaches: with tax switched off, every balance in every period is
/// what it is with no dividend at all — including the periods where a
/// withdrawal takes more than the dividend back out.
#[test]
fn with_no_tax_a_dividend_changes_no_balance() {
    let spending = vec![stream("spending", StreamDirection::Expense, 80_000.0)];
    let without = run(&retiree(0.0, spending.clone()), &FlatTax { rate: 0.0 });
    let with = run(&retiree(0.02, spending), &FlatTax { rate: 0.0 });

    for (a, b) in without.snapshots.iter().zip(&with.snapshots) {
        assert_close(
            b.balances["brokerage"],
            a.balances["brokerage"],
            &format!("period {}", a.period),
        );
        assert_close(b.growth, a.growth, &format!("growth, period {}", a.period));
    }
}
