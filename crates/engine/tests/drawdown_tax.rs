//! One tax pass per period (#54): a retiree's withdrawal is taxed on top of
//! the income they already have, not on a fresh trip up the brackets.
//!
//! The engine used to tax each period twice and add the two bills — once on
//! stream income, once inside the drawdown's gross-up. Against a progressive
//! schedule that is strictly cheaper than taxing the same dollars together,
//! and because the gross-up started from an empty `IncomeBreakdown` no
//! amount of withdrawal could ever make a Social Security benefit taxable.
//!
//! The fixture runs with zero inflation, zero returns and zero COLA, so
//! every figure below is the tax treatment and nothing else.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    SocialSecurityBenefit, StateTaxProfile, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::run_deterministic;
use engine::strategies::{BracketTax, IncomeBreakdown, TaxModel};

const BENEFIT: f64 = 40_000.0;
const SPENDING: f64 = 90_000.0;

/// One retiree, filing Single, living on a $40,000 benefit and a $1.5M
/// pre-tax account against $90,000 of spending — so every period is a
/// benefit plus a drawdown, which is the shape the bug bit.
fn retiree() -> Plan {
    Plan {
        id: "one-tax-pass".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "one-tax-pass".to_string(),
        people: vec![Person {
            id: "p1".to_string(),
            name: "Retiree".to_string(),
            birth: YearMonth {
                year: 1955,
                month: 1,
            },
            retirement: YearMonth {
                year: 2020,
                month: 1,
            },
            life_expectancy_age: 85,
        }],
        accounts: vec![Account {
            id: "401k".to_string(),
            owner: "p1".to_string(),
            kind: AccountKind::TraditionalPreTax,
            name: "401k".to_string(),
            balance: 1_500_000.0,
            cost_basis: None,
            allocation: AllocationRef::Custom(BTreeMap::new()),
            plan_type: PlanType::EmployerPlan,
            contribution: ContributionRule::FlatAmount(0.0),
            employer_match: None,
        }],
        streams: vec![CashFlowStream {
            id: "spending".to_string(),
            name: "spending".to_string(),
            owner: None,
            direction: StreamDirection::Expense,
            annual_amount: SPENDING,
            start: StreamBoundary::PlanStart,
            end: StreamBoundary::PlanEnd,
            growth: GrowthRule::None,
            survivor_percentage: None,
        }],
        // Full retirement age and claiming age both 67, so the claiming
        // adjustment is exactly 1.0 and `benefit_at_fra` is what is paid.
        social_security: vec![SocialSecurityBenefit {
            id: "ss".to_string(),
            owner: "p1".to_string(),
            benefit_at_fra: BENEFIT,
            full_retirement_age: 67,
            claiming_age: 67,
            cola_override: None,
        }],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::new(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 85,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
        },
        sim_config: SimConfig {
            start: YearMonth {
                year: 2026,
                month: 1,
            },
            period: PeriodLength::Year,
            display_real_dollars: false,
            show_monte_carlo_band: false,
        },
    }
}

fn single_filer() -> BracketTax {
    BracketTax {
        filing_status: FilingStatus::Single,
        state_tax: StateTaxProfile::none(),
    }
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// The invariant, asserted period by period: what the engine reports is the
/// bill on the period's *whole* income — benefit and withdrawal in one
/// stack — and never the sum of two separate bills.
#[test]
fn a_periods_tax_is_one_pass_over_the_benefit_and_the_withdrawal_together() {
    let projection = run_deterministic(&retiree());
    let tax = single_filer();

    for snapshot in &projection.snapshots {
        let gross: f64 = snapshot.withdrawals.values().sum();
        assert!(gross > 0.0, "period {} should draw down", snapshot.period);
        assert_close(
            snapshot.taxes,
            tax.tax(
                &IncomeBreakdown {
                    ordinary: gross,
                    social_security: snapshot.income,
                    ..Default::default()
                },
                snapshot.period,
            )
            .tax,
            &format!("period {} tax", snapshot.period),
        );
    }
}

/// The size of what was being missed, on the first period: the two-pass
/// model billed the benefit and the withdrawal separately, and the benefit
/// alone is untaxed — provisional income is half of $40,000, under the
/// $25,000 Single base — so it contributed nothing at all.
#[test]
fn the_two_pass_model_understated_the_bill_by_a_wide_margin() {
    let projection = run_deterministic(&retiree());
    let tax = single_filer();
    let first = &projection.snapshots[0];
    let gross: f64 = first.withdrawals.values().sum();

    let benefit_alone = tax
        .tax(
            &IncomeBreakdown {
                social_security: BENEFIT,
                ..Default::default()
            },
            0,
        )
        .tax;
    assert_close(benefit_alone, 0.0, "the benefit alone is untaxed");

    let two_pass = benefit_alone
        + tax
            .tax(
                &IncomeBreakdown {
                    ordinary: gross,
                    ..Default::default()
                },
                0,
            )
            .tax;
    assert!(
        first.taxes > two_pass * 1.5,
        "one pass must cost materially more than two: {} vs {two_pass}",
        first.taxes
    );
}

/// Cash still conserves: the benefit plus the gross withdrawal funds the
/// spending and the whole tax bill, with nothing left over. A tax figure
/// that double-counted — or that the drawdown had not actually grossed up
/// for — would break this.
#[test]
fn the_withdrawal_is_grossed_up_to_cover_spending_and_the_whole_bill() {
    let projection = run_deterministic(&retiree());
    for snapshot in &projection.snapshots {
        let gross: f64 = snapshot.withdrawals.values().sum();
        assert_close(
            snapshot.income + gross,
            snapshot.expenses + snapshot.taxes + snapshot.surplus,
            &format!("period {} cash conservation", snapshot.period),
        );
    }
}
