//! One-time contributions: a lump sum from outside the plan — a home sale's
//! proceeds — deposited into one account in one month.
//!
//! What these pin, and why each matters:
//!
//! - It lands exactly once, in the period its month falls in, on the same
//!   month-exact, end-exclusive grid every other boundary uses, stub period
//!   and horizon included.
//! - It is *not* household cash. Income, tax, contributions, surplus and
//!   withdrawals are identical with and without it; only balances move.
//!   Entered as a recurring contribution instead, the same dollars would come
//!   out of the household's cash and the portfolio would pay for them.
//! - Into a brokerage it carries its own cost basis, so spending it later
//!   realizes no gain.
//! - An inflation-grown amount is today's dollars: it deflates back to
//!   exactly the figure typed.
//! - A date tied to a person who is gone is reported rather than guessed.
//!
//! Setup, so the figures are checkable by hand: one person with nothing but
//! a brokerage, zero returns unless a test says otherwise, a 20% flat tax,
//! and a salary that covers spending with no sweep — so nothing but the lump
//! sum ever reaches the brokerage.

use engine::model::TaxFigures;
use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, OneTimeContribution, PeriodLength, Person, Plan,
    PlanType, SimConfig, StateTaxProfile, StreamBoundary, StreamDirection, StreamKind, YearMonth,
    SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, OneTimeInfo, PeriodSnapshot, Projection, SimWarning};

const PERSON: &str = "p1";
const BROKERAGE: &str = "brokerage";
const SALE: f64 = 350_000.0;

fn stream(
    id: &str,
    direction: StreamDirection,
    amount: f64,
    end: StreamBoundary,
) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: Some(PERSON.to_string()),
        direction,
        annual_amount: amount,
        start: StreamBoundary::PlanStart,
        end,
        growth: GrowthRule::None,
        survivor_percentage: None,
        kind: StreamKind::General,
    }
}

/// Born June 1970 with a life expectancy of 90, so the horizon — the
/// exclusive end of the projection — is June 2060, partway through the final
/// calendar-year period. Works until `retirement` on $100,000 against $60,000
/// of spending, so no working year draws on the portfolio; after retirement
/// nothing flows at all.
fn plan(start: YearMonth, retirement: YearMonth) -> Plan {
    let until_retirement = StreamBoundary::AtRetirement(PERSON.to_string());
    Plan {
        id: "one-time".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "one-time".to_string(),
        sample: false,
        people: vec![Person {
            id: PERSON.to_string(),
            name: "Sam".to_string(),
            birth: YearMonth::new(1970, 6),
            retirement,
            life_expectancy_age: 90,
        }],
        accounts: vec![Account {
            id: BROKERAGE.to_string(),
            owner: PERSON.to_string(),
            kind: AccountKind::Taxable,
            name: "Joint brokerage".to_string(),
            balance: 0.0,
            cost_basis: Some(0.0),
            allocation: AllocationRef::Moderate,
            plan_type: PlanType::None,
            contributions: vec![],
            one_time_contributions: vec![],
            employer_match: None,
            rule_of_55: false,
        }],
        streams: vec![
            stream(
                "salary",
                StreamDirection::Income,
                100_000.0,
                until_retirement.clone(),
            ),
            stream(
                "spending",
                StreamDirection::Expense,
                60_000.0,
                until_retirement,
            ),
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 90,
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
            display_real_dollars: false,
        },
    }
}

fn working_plan() -> Plan {
    plan(YearMonth::new(2026, 1), YearMonth::new(2040, 4))
}

fn month(year: i32, month: u8) -> StreamBoundary {
    StreamBoundary::Date(YearMonth::new(year, month))
}

fn sale(date: StreamBoundary) -> OneTimeContribution {
    OneTimeContribution {
        id: "house-sale".to_string(),
        name: "House sale".to_string(),
        amount: SALE,
        growth: GrowthRule::None,
        date,
    }
}

/// `sale`, under its own id, so a test holding several can tell them apart.
fn sale_named(id: &str, date: StreamBoundary) -> OneTimeContribution {
    OneTimeContribution {
        id: id.to_string(),
        ..sale(date)
    }
}

fn with(mut plan: Plan, entries: Vec<OneTimeContribution>) -> Plan {
    plan.accounts[0].one_time_contributions = entries;
    plan
}

fn run(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(&plan.assumptions.strategy_returns, 12);
    simulate(
        plan,
        &TaxFigures::built_in(),
        &returns,
        &FlatTax { rate: 0.2 },
        &ProportionalDrawdown,
        0,
    )
}

fn year(projection: &Projection, year: i32) -> &PeriodSnapshot {
    projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == year)
        .unwrap_or_else(|| panic!("no period for {year}"))
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 1e-6 * expected.abs().max(1.0),
        "{label}: expected {expected}, got {actual}"
    );
}

/// The headline case: a sale dated June 2031 is deposited once, in 2031, into
/// the account that names it — and the projection lists it by name.
#[test]
fn a_lump_sum_lands_once_in_the_period_its_month_falls_in() {
    let projection = run(&with(working_plan(), vec![sale(month(2031, 6))]));

    for s in &projection.snapshots {
        let expected = if s.period_start.year == 2031 {
            SALE
        } else {
            0.0
        };
        assert_eq!(
            s.one_time_contributions, expected,
            "{}",
            s.period_start.year
        );
    }
    assert_eq!(
        projection.one_time,
        vec![OneTimeInfo {
            account: BROKERAGE.to_string(),
            id: "house-sale".to_string(),
            name: "House sale".to_string(),
            period: 5,
            amount: SALE,
        }]
    );
    // Zero returns and no sweep: the brokerage holds the sale and nothing else.
    assert_eq!(year(&projection, 2030).balances[BROKERAGE], 0.0);
    assert_eq!(year(&projection, 2031).balances[BROKERAGE], SALE);
    assert_eq!(year(&projection, 2045).balances[BROKERAGE], SALE);
}

/// Month-exact and end-exclusive, like every other boundary. A September
/// plan's stub period 0 runs September through December: the start month
/// itself lands there, December still does, January is the next period, and
/// August — before the plan starts, where a sale the balances already hold
/// ends up after a refresh — lands nowhere, and is not worth a warning.
#[test]
fn the_landing_period_is_month_exact_on_a_stub_start() {
    let projection = run(&with(
        plan(YearMonth::new(2026, 9), YearMonth::new(2040, 4)),
        vec![
            sale_named("before-start", month(2026, 8)),
            sale_named("start-month", month(2026, 9)),
            sale_named("december", month(2026, 12)),
            sale_named("january", month(2027, 1)),
        ],
    ));

    let landed: Vec<(&str, usize)> = projection
        .one_time
        .iter()
        .map(|o| (o.id.as_str(), o.period))
        .collect();
    assert_eq!(
        landed,
        vec![("start-month", 0), ("december", 0), ("january", 1)]
    );
    assert_eq!(projection.snapshots[0].one_time_contributions, 2.0 * SALE);
    assert!(projection.warnings.is_empty(), "{:?}", projection.warnings);
}

/// The horizon is exclusive, and the final period running on to December does
/// not stretch it: Sam dies in June 2060, inside the 2060 period, and a sale
/// dated June or September of that year lands nowhere.
#[test]
fn nothing_lands_at_or_after_the_horizon() {
    let projection = run(&with(
        working_plan(),
        vec![
            sale_named("may", month(2060, 5)),
            sale_named("june", month(2060, 6)),
            sale_named("september", month(2060, 9)),
        ],
    ));

    assert_eq!(
        projection.snapshots.last().unwrap().period_start.year,
        2060,
        "the final period is the calendar year of the death"
    );
    let landed: Vec<&str> = projection.one_time.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(landed, vec!["may"]);
    assert!(projection.warnings.is_empty(), "{:?}", projection.warnings);
}

/// "When we retire" is a boundary, not a date typed once: moving the
/// retirement moves the sale with it.
#[test]
fn a_sale_at_retirement_moves_with_the_retirement_date() {
    for (retirement, landing_year) in [
        (YearMonth::new(2040, 4), 2040),
        (YearMonth::new(2042, 11), 2042),
    ] {
        let projection = run(&with(
            plan(YearMonth::new(2026, 1), retirement),
            vec![sale(StreamBoundary::AtRetirement(PERSON.to_string()))],
        ));
        let years: Vec<i32> = projection
            .one_time
            .iter()
            .map(|o| projection.snapshots[o.period].period_start.year)
            .collect();
        assert_eq!(years, vec![landing_year], "retiring {retirement:?}");
    }
}

/// The difference from a contribution, and the reason this is its own thing.
/// Every flow through the household is identical with and without the sale —
/// income, tax, contributions, surplus, withdrawals — and net worth is higher
/// by exactly the sale from the year it lands.
///
/// The same dollars entered as a one-month recurring contribution are the
/// counterexample: they come out of the household's cash, the year's income
/// cannot cover them, and the portfolio pays — so net worth ends up far short
/// of the sale.
#[test]
fn a_lump_sum_moves_no_household_cash() {
    let base = working_plan();
    let without = run(&base);
    let with_sale = run(&with(base.clone(), vec![sale(month(2031, 6))]));

    for (a, b) in without.snapshots.iter().zip(&with_sale.snapshots) {
        let y = a.period_start.year;
        assert_eq!(a.income, b.income, "{y} income");
        assert_eq!(a.expenses, b.expenses, "{y} expenses");
        assert_eq!(a.taxes, b.taxes, "{y} taxes");
        assert_eq!(a.contributions, b.contributions, "{y} contributions");
        assert_eq!(a.surplus, b.surplus, "{y} surplus");
        assert_eq!(a.withdrawals, b.withdrawals, "{y} withdrawals");
        let gained = if y >= 2031 { SALE } else { 0.0 };
        assert_eq!(b.net_worth - a.net_worth, gained, "{y} net worth");
    }

    let mut as_contribution = base;
    as_contribution.accounts[0]
        .contributions
        .push(Contribution {
            id: "sale-as-contribution".to_string(),
            name: "House sale".to_string(),
            // An annual rate over a one-month window: the whole sale, in June.
            rule: ContributionRule::FlatAmount {
                amount: 12.0 * SALE,
                growth: GrowthRule::None,
            },
            start: month(2031, 6),
            end: month(2031, 7),
        });
    let as_contribution = run(&as_contribution);
    let s = year(&as_contribution, 2031);
    assert_close(s.contributions, SALE, "the whole sale is contributed");
    assert!(
        s.net_worth < SALE - 100_000.0,
        "paid out of household cash, the portfolio funds most of it: net worth {}",
        s.net_worth
    );
}

/// Into a brokerage the sale carries its own cost basis — after-tax dollars,
/// not gains — so a retiree spending it down realizes nothing and owes no tax
/// on the withdrawals. And it is in the portfolio the moment it lands: the
/// year of the sale already draws on it.
#[test]
fn a_brokerage_deposit_is_after_tax_money_the_same_year_can_spend() {
    let mut retired = plan(YearMonth::new(2026, 1), YearMonth::new(2025, 1));
    retired.streams = vec![stream(
        "spending",
        StreamDirection::Expense,
        60_000.0,
        StreamBoundary::PlanEnd,
    )];
    let projection = run(&with(retired, vec![sale(month(2026, 3))]));

    for (y, balance) in [
        (2026, SALE - 60_000.0),
        (2027, SALE - 120_000.0),
        (2028, SALE - 180_000.0),
    ] {
        let s = year(&projection, y);
        assert_eq!(s.withdrawal_taxes, 0.0, "{y}: basis, not gain");
        assert_eq!(s.taxes, 0.0, "{y}");
        assert_close(s.balances[BROKERAGE], balance, &format!("{y} balance"));
    }
}

/// An inflation-grown amount is typed in today's dollars: it lands grown to
/// the start of its period, and deflates back to exactly the figure typed —
/// on a January start and on a September stub alike. A flat one is the exact
/// nominal figure.
#[test]
fn an_inflation_grown_sale_reads_back_in_todays_dollars() {
    // Years from the plan's start to January 2036: ten from January 2026,
    // nine and a third from September 2026.
    for (start, years) in [
        (YearMonth::new(2026, 1), 10.0),
        (YearMonth::new(2026, 9), 112.0 / 12.0),
    ] {
        let mut base = plan(start, YearMonth::new(2040, 4));
        base.assumptions.inflation = 0.03;

        let grown = OneTimeContribution {
            growth: GrowthRule::Inflation,
            ..sale(month(2036, 3))
        };
        let projection = run(&with(base.clone(), vec![grown]));
        let s = year(&projection, 2036);
        assert_close(
            s.one_time_contributions,
            SALE * 1.03_f64.powf(years),
            "grown to the period's start",
        );
        assert_close(
            s.one_time_contributions / s.deflator,
            SALE,
            "the figure typed, in today's dollars",
        );

        let flat = run(&with(base, vec![sale(month(2036, 3))]));
        assert_eq!(year(&flat, 2036).one_time_contributions, SALE);
    }
}

/// Growth is a whole-period operation: a sale that lands in December earns the
/// entire year's return, as any flow landing mid-year does. A documented
/// convention ("Time conventions"), not something prorated here.
#[test]
fn a_december_sale_earns_the_whole_years_return() {
    let mut base = working_plan();
    base.assumptions.strategy_returns = base.assumptions.strategy_returns.map(|_| 0.10);
    let projection = run(&with(base, vec![sale(month(2031, 12))]));
    assert_close(
        year(&projection, 2031).balances[BROKERAGE],
        SALE * 1.10,
        "a full year of 10%",
    );
}

/// A sale tied to the retirement of someone no longer in the plan has no month
/// to land in. It is reported, as a recurring entry's window is, rather than
/// guessed.
#[test]
fn a_sale_tied_to_a_missing_person_is_reported_not_guessed() {
    let projection = run(&with(
        working_plan(),
        vec![sale(StreamBoundary::AtRetirement("gone".to_string()))],
    ));
    assert!(projection.one_time.is_empty());
    assert_eq!(
        projection.warnings,
        vec![SimWarning::ContributionBoundaryUnresolved {
            account: BROKERAGE.to_string(),
        }]
    );
}
