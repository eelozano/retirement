//! The year's MAGI on the ACA definition (#186): the figure the premium tax
//! credit is tested against, read off the income the period settled on.
//!
//! Every fixture runs under a zero-rate `FlatTax` with no returns, no COLA and
//! no inflation, so a withdrawal's gross is exactly the cash the year needed
//! and each figure below is typed from paper, not read back from the engine.

use engine::model::TaxFigures;
use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus,
    FullRetirementAge, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    SocialSecurityBenefit, StateTaxProfile, StreamBoundary, StreamDirection, StreamKind, YearMonth,
    SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, PeriodSnapshot};

fn start_year() -> i32 {
    TaxFigures::tax_year_2026().tax_year
}

fn account(id: &str, kind: AccountKind, balance: f64, basis: Option<f64>) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind,
        name: id.to_string(),
        balance,
        cost_basis: basis,
        allocation: AllocationRef::FixedRate(0.0),
        plan_type: PlanType::None,
        contributions: vec![],
        one_time_contributions: vec![],
        employer_match: None,
        rule_of_55: false,
    }
}

/// One 70-year-old, retired and past claiming age (so no early-withdrawal
/// rule applies and no RMD yet), spending `spending` a year and drawing
/// `benefit` from Social Security.
fn retiree(accounts: Vec<Account>, spending: f64, benefit: Option<f64>) -> Plan {
    Plan {
        id: "magi".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "magi".to_string(),
        sample: false,
        people: vec![Person {
            id: "p1".to_string(),
            name: "Retiree".to_string(),
            birth: YearMonth::new(start_year() - 70, 1),
            retirement: YearMonth::new(start_year() - 5, 1),
            life_expectancy_age: 85,
        }],
        accounts,
        streams: vec![CashFlowStream {
            id: "spending".to_string(),
            name: "spending".to_string(),
            owner: None,
            direction: StreamDirection::Expense,
            annual_amount: spending,
            start: StreamBoundary::PlanStart,
            end: StreamBoundary::PlanEnd,
            growth: GrowthRule::None,
            survivor_percentage: None,
            kind: StreamKind::General,
        }],
        // Claiming at full retirement age, so `benefit_at_fra` is what is paid.
        social_security: benefit
            .map(|benefit_at_fra| SocialSecurityBenefit {
                id: "ss".to_string(),
                owner: "p1".to_string(),
                benefit_at_fra,
                full_retirement_age: Some(FullRetirementAge::new(67, 0)),
                claiming_age: 67,
                cola_override: None,
            })
            .into_iter()
            .collect(),
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            strategy_volatility: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 85,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            reinvest_into: None,
            drawdown: Default::default(),
            dividend_yield: 0.0,
        },
        sim_config: SimConfig {
            start: YearMonth::new(start_year(), 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn first_year(plan: &Plan) -> PeriodSnapshot {
    let returns = FixedReturns::new(
        &plan.assumptions.strategy_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &TaxFigures::tax_year_2026(),
        &returns,
        &FlatTax { rate: 0.0 },
        &ProportionalDrawdown,
        0,
    )
    .snapshots
    .remove(0)
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// A pre-tax withdrawal, a brokerage sale with known basis and Social
/// Security, all in one year.
///
/// ```text
/// spending                                  $80,000
/// Social Security (the whole benefit)       $30,000
/// withdrawn to cover the rest (no tax)      $50,000
///   split in proportion to the balances, $500,000 apiece:
///   401(k)         $25,000   -> ordinary income      $25,000
///   brokerage      $25,000   -> basis 40% = $10,000 returned, untaxed
///                               gain  60% = $15,000 -> capital gains
///
/// MAGI = 25,000 + 15,000 + 30,000 = $70,000
/// ```
///
/// The $30,000 is the benefit in full. The tax model would bracket only the
/// part of it that provisional income makes taxable; ACA MAGI adds back the
/// rest, so reading the taxed amount here would come out lower.
#[test]
fn magi_is_pretax_draw_plus_realized_gain_plus_the_whole_benefit() {
    let plan = retiree(
        vec![
            account("401k", AccountKind::TraditionalPreTax, 500_000.0, None),
            account(
                "brokerage",
                AccountKind::Taxable,
                500_000.0,
                Some(200_000.0),
            ),
        ],
        80_000.0,
        Some(30_000.0),
    );
    let year = first_year(&plan);

    assert_close(year.withdrawals["401k"], 25_000.0, "pre-tax draw");
    assert_close(year.withdrawals["brokerage"], 25_000.0, "brokerage draw");
    assert_close(year.magi, 70_000.0, "MAGI");
}

/// A Roth withdrawal is not income, and nothing else comes in: the year's
/// MAGI is zero however much it spends.
#[test]
fn a_roth_only_year_has_no_magi() {
    let plan = retiree(
        vec![account("roth", AccountKind::Roth, 1_000_000.0, None)],
        40_000.0,
        None,
    );
    let year = first_year(&plan);

    assert_close(year.withdrawals["roth"], 40_000.0, "Roth draw");
    assert_close(year.magi, 0.0, "MAGI");
}

/// No withdrawal at all — the benefit covers spending — still has a MAGI:
/// the benefit, whole.
#[test]
fn a_year_with_no_withdrawal_still_counts_the_benefit() {
    let plan = retiree(
        vec![account("roth", AccountKind::Roth, 1_000_000.0, None)],
        20_000.0,
        Some(30_000.0),
    );
    let year = first_year(&plan);

    assert!(year.withdrawals.is_empty(), "nothing should be drawn");
    assert_close(year.magi, 30_000.0, "MAGI");
}
