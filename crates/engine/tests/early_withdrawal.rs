//! Early withdrawal: the 10% additional tax before 59½, the Rule of 55, a
//! 457(b)'s exemption, and a Roth's contributions coming back free while
//! its earnings do not. See `sim::early_access`.
//!
//! Every fixture runs with zero inflation and zero returns, one person,
//! filing Single, no state tax and no income — so each period is a
//! withdrawal against a fixed spending figure and nothing else, and every
//! expected figure is computed from `BracketTax` directly.

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    StateTaxProfile, StreamBoundary, StreamDirection, StreamKind, TaxFigures, YearMonth,
    SCHEMA_VERSION,
};
use engine::strategies::{BracketTax, IncomeBreakdown, TaxModel};
use engine::{run_deterministic, Rule55Ineligibility, SimWarning};

const SPENDING: f64 = 60_000.0;
const START: YearMonth = YearMonth {
    year: 2026,
    month: 1,
};

fn account(kind: AccountKind, plan_type: PlanType, balance: f64, basis: Option<f64>) -> Account {
    Account {
        id: "acct".to_string(),
        owner: "p1".to_string(),
        kind,
        name: "acct".to_string(),
        balance,
        cost_basis: basis,
        allocation: AllocationRef::FixedRate(0.0),
        plan_type,
        contributions: vec![],
        one_time_contributions: vec![],
        employer_match: None,
        rule_of_55: false,
    }
}

fn stream(
    id: &str,
    direction: StreamDirection,
    amount: f64,
    start: StreamBoundary,
    end: StreamBoundary,
) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: None,
        direction,
        annual_amount: amount,
        start,
        end,
        growth: GrowthRule::None,
        survivor_percentage: None,
        kind: StreamKind::General,
    }
}

/// One person born `birth`, retired `retirement`, holding `account` and
/// spending `SPENDING` a year from plan start.
fn plan(birth: YearMonth, retirement: YearMonth, account: Account) -> Plan {
    Plan {
        id: "early".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "early".to_string(),
        sample: false,
        people: vec![Person {
            id: "p1".to_string(),
            name: "Early retiree".to_string(),
            birth,
            retirement,
            life_expectancy_age: 90,
        }],
        accounts: vec![account],
        streams: vec![stream(
            "spending",
            StreamDirection::Expense,
            SPENDING,
            StreamBoundary::PlanStart,
            StreamBoundary::PlanEnd,
        )],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 62,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            strategy_volatility: Default::default(),
            reinvest_into: None,
            drawdown: Default::default(),
        },
        sim_config: SimConfig {
            start: START,
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn single_filer() -> BracketTax {
    let figures = TaxFigures::built_in();
    BracketTax::new(
        &figures,
        FilingStatus::Single,
        StateTaxProfile::none(),
        0.0,
        figures.tax_year,
        vec![],
    )
}

fn ordinary_tax(ordinary: f64) -> f64 {
    single_filer()
        .tax(
            &IncomeBreakdown {
                ordinary,
                ..Default::default()
            },
            0,
        )
        .tax
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

const AGE_52: YearMonth = YearMonth {
    year: 1974,
    month: 6,
};

/// Retired at 51, drawing from a traditional IRA at 52: the whole draw is
/// ordinary income and 10% of it is added on top, inside the gross-up — so
/// the draw still nets the spending after both.
#[test]
fn a_pre_tax_draw_before_59_and_a_half_pays_ten_percent_more() {
    let plan = plan(
        AGE_52,
        YearMonth::new(2025, 6),
        account(
            AccountKind::TraditionalPreTax,
            PlanType::Ira,
            1_000_000.0,
            None,
        ),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    let gross = first.withdrawals["acct"];

    assert_close(first.early_withdrawal_penalty, 0.10 * gross, "penalty");
    assert_close(
        first.taxes,
        ordinary_tax(gross) + 0.10 * gross,
        "income tax plus penalty",
    );
    assert_close(gross - first.taxes, SPENDING, "the draw nets the spending");
    assert!(first.early_withdrawal_penalty <= first.withdrawal_taxes);
    assert!(projection
        .warnings
        .contains(&SimWarning::EarlyWithdrawalPenalty { period: 0 }));
}

/// 59½ falls in July 2026 for someone born in January 1967, so half the
/// year's withdrawals are taken before it — split at the month, as every
/// boundary splits a period.
#[test]
fn a_period_straddling_59_and_a_half_is_penalized_for_its_months_before_it() {
    let plan = plan(
        YearMonth::new(1967, 1),
        YearMonth::new(2025, 1),
        account(
            AccountKind::TraditionalPreTax,
            PlanType::Ira,
            1_000_000.0,
            None,
        ),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    let gross = first.withdrawals["acct"];
    assert_close(
        first.early_withdrawal_penalty,
        0.10 * gross * 6.0 / 12.0,
        "half-year penalty",
    );

    let second = &projection.snapshots[1];
    assert_close(second.early_withdrawal_penalty, 0.0, "no penalty past 59½");
}

fn employer_plan_rule_of_55(retirement: YearMonth, elect: bool) -> Plan {
    let mut acct = account(
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
        1_000_000.0,
        None,
    );
    acct.rule_of_55 = elect;
    // Turns 55 in June 2026.
    plan(YearMonth::new(1971, 6), retirement, acct)
}

/// Separating in January of the year they turn 55 qualifies, even though
/// the birthday is still months away: the statute reads the calendar year.
#[test]
fn the_rule_of_55_waives_the_penalty_when_elected_and_eligible() {
    let projection = run_deterministic(
        &employer_plan_rule_of_55(START, true),
        &TaxFigures::built_in(),
    );
    for snapshot in &projection.snapshots {
        assert_close(snapshot.early_withdrawal_penalty, 0.0, "no penalty");
    }
    assert!(!projection
        .warnings
        .iter()
        .any(|w| matches!(w, SimWarning::Rule55Ineligible { .. })));
}

/// Opt-in: the same eligible household that does not elect it pays.
#[test]
fn the_rule_of_55_is_never_assumed() {
    let projection = run_deterministic(
        &employer_plan_rule_of_55(START, false),
        &TaxFigures::built_in(),
    );
    assert!(projection.snapshots[0].early_withdrawal_penalty > 0.0);
}

/// Separating in December of the year they turn 54 is one year short: the
/// election is reported, not honored.
#[test]
fn separating_before_the_year_turning_55_does_not_qualify() {
    let projection = run_deterministic(
        &employer_plan_rule_of_55(YearMonth::new(2025, 12), true),
        &TaxFigures::built_in(),
    );
    assert!(projection.snapshots[0].early_withdrawal_penalty > 0.0);
    assert!(projection.warnings.contains(&SimWarning::Rule55Ineligible {
        account: "acct".to_string(),
        reason: Rule55Ineligibility::SeparatedBefore55,
    }));
}

/// An IRA never qualifies, whatever the dates.
#[test]
fn an_ira_cannot_elect_the_rule_of_55() {
    let mut acct = account(
        AccountKind::TraditionalPreTax,
        PlanType::Ira,
        1_000_000.0,
        None,
    );
    acct.rule_of_55 = true;
    let projection = run_deterministic(
        &plan(YearMonth::new(1971, 6), START, acct),
        &TaxFigures::built_in(),
    );
    assert!(projection.snapshots[0].early_withdrawal_penalty > 0.0);
    assert!(projection.warnings.contains(&SimWarning::Rule55Ineligible {
        account: "acct".to_string(),
        reason: Rule55Ineligibility::NotAnEmployerPlan,
    }));
}

/// A 457(b) carries no additional tax at any age — still ordinary income.
#[test]
fn a_457b_draw_is_never_penalized() {
    let plan = plan(
        AGE_52,
        YearMonth::new(2025, 6),
        account(
            AccountKind::TraditionalPreTax,
            PlanType::Plan457b,
            1_000_000.0,
            None,
        ),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    assert_close(first.early_withdrawal_penalty, 0.0, "no penalty");
    assert_close(
        first.taxes,
        ordinary_tax(first.withdrawals["acct"]),
        "income tax only",
    );
}

/// A Roth IRA pays out contributions first: the first $50,000 is free of
/// tax and penalty, and only the rest — earnings — is ordinary income plus
/// 10%.
#[test]
fn a_roth_ira_returns_contributions_before_earnings() {
    let plan = plan(
        AGE_52,
        YearMonth::new(2025, 6),
        account(AccountKind::Roth, PlanType::Ira, 200_000.0, Some(50_000.0)),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    let gross = first.withdrawals["acct"];
    let earnings = gross - 50_000.0;
    assert!(earnings > 0.0);
    assert_close(
        first.early_withdrawal_penalty,
        0.10 * earnings,
        "penalty on earnings",
    );
    assert_close(
        first.taxes,
        ordinary_tax(earnings) + 0.10 * earnings,
        "earnings are ordinary income",
    );

    // Contributions are spent: the next year is all earnings.
    let second = &projection.snapshots[1];
    let gross = second.withdrawals["acct"];
    assert_close(
        second.early_withdrawal_penalty,
        0.10 * gross,
        "all earnings now",
    );
}

/// A Roth employer plan pays out pro rata: a quarter of the balance is
/// contributions, so a quarter of every dollar is.
#[test]
fn a_roth_employer_plan_returns_contributions_pro_rata() {
    let plan = plan(
        AGE_52,
        YearMonth::new(2025, 6),
        account(
            AccountKind::Roth,
            PlanType::EmployerPlan,
            200_000.0,
            Some(50_000.0),
        ),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    let earnings = 0.75 * first.withdrawals["acct"];
    assert_close(
        first.early_withdrawal_penalty,
        0.10 * earnings,
        "penalty on earnings",
    );
}

/// No contributions entered reads as none: the whole balance is earnings.
#[test]
fn a_roth_with_no_contributions_figure_is_all_earnings() {
    let plan = plan(
        AGE_52,
        YearMonth::new(2025, 6),
        account(AccountKind::Roth, PlanType::Ira, 200_000.0, None),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    assert_close(
        first.early_withdrawal_penalty,
        0.10 * first.withdrawals["acct"],
        "all earnings",
    );
}

/// After 59½ a Roth is untaxed, contributions figure or not.
#[test]
fn a_qualified_roth_draw_is_untaxed() {
    let plan = plan(
        YearMonth::new(1960, 1),
        YearMonth::new(2025, 1),
        account(AccountKind::Roth, PlanType::Ira, 500_000.0, None),
    );
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let first = &projection.snapshots[0];
    assert_close(first.taxes, 0.0, "no tax");
    assert_close(first.withdrawals["acct"], SPENDING, "gross is the spending");
}

/// Contributions made during the plan become contributions the Roth can
/// return: $7,000 goes in during the last working year, and the first
/// retired year's draw gets exactly that much back free.
#[test]
fn roth_contributions_during_the_plan_raise_its_basis() {
    let retirement = YearMonth::new(2027, 1);
    let mut acct = account(AccountKind::Roth, PlanType::Ira, 100_000.0, None);
    acct.contributions = vec![Contribution::until_retirement(
        "roth-contribution",
        ContributionRule::FlatAmount {
            amount: 7_000.0,
            growth: GrowthRule::None,
        },
        &"p1".to_string(),
    )];
    let mut plan = plan(AGE_52, retirement, acct);
    plan.streams = vec![
        stream(
            "salary",
            StreamDirection::Income,
            200_000.0,
            StreamBoundary::PlanStart,
            StreamBoundary::AtRetirement("p1".to_string()),
        ),
        stream(
            "spending",
            StreamDirection::Expense,
            SPENDING,
            StreamBoundary::AtRetirement("p1".to_string()),
            StreamBoundary::PlanEnd,
        ),
    ];
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let retired = &projection.snapshots[1];
    let gross = retired.withdrawals["acct"];
    assert_close(
        retired.early_withdrawal_penalty,
        0.10 * (gross - 7_000.0),
        "the year's contribution came back free",
    );
}
