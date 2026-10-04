//! A drawdown phase that keeps the year's MAGI near a target (#187), end to
//! end through the period loop. The order rule's own arithmetic is pinned by
//! the unit tests beside `strategies::PhasedDrawdown`; these check what a
//! plan sees: the snapshot's MAGI, the warning, which accounts paid, and a
//! year split between two phases.
//!
//! Most fixtures run untaxed (a zero-rate `FlatTax`) with no returns and no
//! inflation, so a withdrawal's gross is exactly the cash the year needed
//! and every figure below is typed from paper. The first runs the real
//! brackets, because landing on the target *through* the gross-up is the
//! part that has to hold.

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, DrawdownPhase,
    DrawdownPolicy, FilingStatus, GrowthRule, PeriodLength, Person, PhaseRule, PhaseStart, Plan,
    PlanType, PriceLevel, SimConfig, StackEntry, StackSource, StateTaxProfile, StreamBoundary,
    StreamDirection, StreamKind, TaxFigures, YearMonth, SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, PhasedDrawdown};
use engine::{run_deterministic, simulate, MagiOverrun, Projection, SimWarning};

fn start_year() -> i32 {
    TaxFigures::tax_year_2026().tax_year
}

fn account(id: &str, owner: &str, kind: AccountKind, balance: f64, basis: f64) -> Account {
    Account {
        id: id.to_string(),
        owner: owner.to_string(),
        kind,
        name: id.to_string(),
        balance,
        cost_basis: Some(basis),
        allocation: AllocationRef::FixedRate(0.0),
        plan_type: match kind {
            AccountKind::TraditionalPreTax => PlanType::EmployerPlan,
            AccountKind::Roth => PlanType::Ira,
            _ => PlanType::None,
        },
        contributions: vec![],
        one_time_contributions: vec![],
        employer_match: None,
        rule_of_55: false,
    }
}

/// Retired at `age` when the plan opens in January of the tax year.
fn person(id: &str, age: i32) -> Person {
    Person {
        id: id.to_string(),
        name: id.to_string(),
        birth: YearMonth::new(start_year() - age, 1),
        retirement: YearMonth::new(start_year(), 1),
        life_expectancy_age: 90,
    }
}

fn stream(id: &str, direction: StreamDirection, amount: f64, growth: GrowthRule) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: None,
        direction,
        annual_amount: amount,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::PlanEnd,
        growth,
        survivor_percentage: None,
        kind: StreamKind::General,
    }
}

fn spending(amount: f64) -> CashFlowStream {
    stream(
        "spending",
        StreamDirection::Expense,
        amount,
        GrowthRule::None,
    )
}

fn target_phase(id: &str, start: PhaseStart, target: f64) -> DrawdownPhase {
    DrawdownPhase {
        id: id.to_string(),
        name: id.to_string(),
        start,
        rule: PhaseRule::MagiTarget { target },
        stack: vec![],
    }
}

fn from_start() -> PhaseStart {
    PhaseStart::Boundary(StreamBoundary::PlanStart)
}

fn household(
    people: Vec<Person>,
    accounts: Vec<Account>,
    streams: Vec<CashFlowStream>,
    phases: Vec<DrawdownPhase>,
) -> Plan {
    let filing_status = if people.len() > 1 {
        FilingStatus::MarriedFilingJointly
    } else {
        FilingStatus::Single
    };
    Plan {
        id: "magi-target".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "magi-target".to_string(),
        sample: false,
        people,
        accounts,
        streams,
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            strategy_returns: Default::default(),
            strategy_volatility: Default::default(),
            filing_status,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 90,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            reinvest_into: None,
            drawdown: DrawdownPolicy::Phased(phases),
            dividend_yield: 0.0,
        },
        sim_config: SimConfig {
            start: YearMonth::new(start_year(), 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

/// Untaxed, at the plan's own drawdown.
fn untaxed(plan: &Plan) -> Projection {
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
    let returns = FixedReturns::new(
        &plan.assumptions.strategy_returns,
        plan.sim_config.period.months(),
    );
    let drawdown = PhasedDrawdown::new(plan, PriceLevel::Constant(plan.assumptions.inflation))
        .expect("a phased plan");
    simulate(
        plan,
        &TaxFigures::tax_year_2026(),
        &returns,
        &FlatTax { rate: 0.0 },
        &drawdown,
        0,
    )
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

fn target_warnings(projection: &Projection) -> Vec<&SimWarning> {
    projection
        .warnings
        .iter()
        .filter(|w| matches!(w, SimWarning::MagiTargetExceeded { .. }))
        .collect()
}

/// A 60-year-old bridging to Medicare on 2026's brackets, with 3% inflation
/// growing both the spending and the $60,000 target. Each year needs more
/// than the target, and there is plenty of pre-tax and brokerage, so every
/// year's MAGI lands on the target grown to that year: $60,000 × 1.03ⁿ,
/// within a dollar, with the tax on the withdrawal drawn too.
#[test]
fn a_bridge_year_lands_magi_on_the_target_within_a_dollar() {
    let mut plan = household(
        vec![person("p1", 60)],
        vec![
            account(
                "401k",
                "p1",
                AccountKind::TraditionalPreTax,
                1_000_000.0,
                0.0,
            ),
            account(
                "brokerage",
                "p1",
                AccountKind::Taxable,
                500_000.0,
                250_000.0,
            ),
            account("roth", "p1", AccountKind::Roth, 300_000.0, 0.0),
        ],
        vec![stream(
            "spending",
            StreamDirection::Expense,
            90_000.0,
            GrowthRule::Inflation,
        )],
        vec![target_phase("aca", from_start(), 60_000.0)],
    );
    plan.assumptions.inflation = 0.03;
    let projection = run_deterministic(&plan, &TaxFigures::tax_year_2026());

    for (n, year) in projection.snapshots.iter().take(5).enumerate() {
        let target = 60_000.0 * 1.03f64.powi(n as i32);
        assert!(
            (year.magi - target).abs() < 1.0,
            "year {n}: MAGI {} against a target of {target}",
            year.magi
        );
        assert!(year.withdrawals["401k"] > 0.0 && year.withdrawals["brokerage"] > 0.0);
        assert!(
            !year.withdrawals.contains_key("roth"),
            "the Roth keeps growing"
        );
    }
    assert!(
        target_warnings(&projection)
            .iter()
            .all(|w| w.period() >= Some(5)),
        "{:?}",
        target_warnings(&projection)
    );
    // Nothing grows here, so the money runs out decades in; not in these
    // years.
    assert!(
        projection
            .warnings
            .iter()
            .filter(|w| matches!(w, SimWarning::DepletedFunds { .. }))
            .all(|w| w.period() >= Some(5)),
        "each of these years' need is met"
    );
}

/// A target is not a quota: $40,000 of need against a $60,000 target is
/// $40,000 of pre-tax, MAGI $40,000, and nothing else touched.
#[test]
fn a_year_whose_need_is_below_the_target_stays_below_it() {
    let plan = household(
        vec![person("p1", 60)],
        vec![
            account(
                "401k",
                "p1",
                AccountKind::TraditionalPreTax,
                1_000_000.0,
                0.0,
            ),
            account(
                "brokerage",
                "p1",
                AccountKind::Taxable,
                500_000.0,
                250_000.0,
            ),
        ],
        vec![spending(40_000.0)],
        vec![target_phase("aca", from_start(), 60_000.0)],
    );
    let year = &untaxed(&plan).snapshots[0];
    assert_close(year.withdrawals["401k"], 40_000.0, "pre-tax");
    assert!(!year.withdrawals.contains_key("brokerage"));
    assert_close(year.magi, 40_000.0, "MAGI");
}

/// An $80,000 pension against a $60,000 target and $100,000 of spending:
/// the $20,000 shortfall comes from money that adds no MAGI — $10,000 of
/// savings, then $10,000 of Roth — and the year, at MAGI $80,000, is
/// reported. Every year is over; the warning names the first, once.
#[test]
fn other_income_over_the_target_warns_and_draws_magi_free_money_first() {
    let plan = household(
        vec![person("p1", 60)],
        vec![
            account(
                "401k",
                "p1",
                AccountKind::TraditionalPreTax,
                1_000_000.0,
                0.0,
            ),
            account(
                "brokerage",
                "p1",
                AccountKind::Taxable,
                500_000.0,
                250_000.0,
            ),
            account("savings", "p1", AccountKind::Savings, 10_000.0, 0.0),
            account("roth", "p1", AccountKind::Roth, 300_000.0, 0.0),
        ],
        vec![
            stream(
                "pension",
                StreamDirection::Income,
                80_000.0,
                GrowthRule::None,
            ),
            spending(100_000.0),
        ],
        vec![target_phase("aca", from_start(), 60_000.0)],
    );
    let projection = untaxed(&plan);
    let year = &projection.snapshots[0];
    assert_close(year.withdrawals["savings"], 10_000.0, "savings");
    assert_close(year.withdrawals["roth"], 10_000.0, "then Roth");
    assert_eq!(year.withdrawals.len(), 2, "nothing that adds MAGI");
    assert_close(year.magi, 80_000.0, "MAGI is the pension");

    assert_eq!(
        target_warnings(&projection),
        vec![&SimWarning::MagiTargetExceeded {
            phase: "aca".to_string(),
            period: 0,
            target: 60_000.0,
            magi: 80_000.0,
            reason: MagiOverrun::OtherIncome,
        }]
    );
}

/// A spouse who retired at 51 with a 401(k) cannot touch it without the
/// 10% penalty until 59½. At $60,000 a year:
///
/// ```text
/// year 0   brokerage (all basis, so no MAGI)   $60,000
/// year 1   brokerage, the last of it           $40,000
///          Roth (qualified: its owner is 61)   $20,000
/// year 2   Roth, the last of it                $30,000
///          the spouse's 401(k): $30,000 net of the 10%
///                                 = 30,000 / 0.9 = $33,333.33
/// ```
#[test]
fn a_penalized_account_is_drawn_only_after_everything_else() {
    let mut spouse = person("spouse", 51);
    spouse.retirement = YearMonth::new(start_year(), 1);
    let plan = household(
        vec![person("p1", 60), spouse],
        vec![
            account(
                "brokerage",
                "p1",
                AccountKind::Taxable,
                100_000.0,
                100_000.0,
            ),
            account("roth", "p1", AccountKind::Roth, 50_000.0, 0.0),
            account(
                "spouse-401k",
                "spouse",
                AccountKind::TraditionalPreTax,
                1_000_000.0,
                0.0,
            ),
        ],
        vec![spending(60_000.0)],
        vec![target_phase("aca", from_start(), 60_000.0)],
    );
    let projection = untaxed(&plan);
    let years = &projection.snapshots;

    assert_close(
        years[0].withdrawals["brokerage"],
        60_000.0,
        "year 0 brokerage",
    );
    assert_eq!(years[0].withdrawals.len(), 1);
    assert_close(
        years[1].withdrawals["brokerage"],
        40_000.0,
        "year 1 brokerage",
    );
    assert_close(years[1].withdrawals["roth"], 20_000.0, "year 1 Roth");
    assert!(!years[1].withdrawals.contains_key("spouse-401k"));
    assert_close(
        years[0].early_withdrawal_penalty + years[1].early_withdrawal_penalty,
        0.0,
        "no penalty yet",
    );

    assert_close(years[2].withdrawals["roth"], 30_000.0, "year 2 Roth");
    assert_close(
        years[2].withdrawals["spouse-401k"],
        30_000.0 / 0.9,
        "the 401(k), last, grossed up for the penalty",
    );
    assert_close(years[2].early_withdrawal_penalty, 30_000.0 / 9.0, "the 10%");
}

/// A year split between a stack and a target: the target is the calendar
/// year's. $120,000 of spending, half in each phase's months, against a
/// $100,000 target:
///
/// ```text
/// the stack's six months     401(k)           $60,000   MAGI so far $60,000
/// the target's six months    headroom $40,000, need $60,000, brokerage half gain:
///                            P + B = 60,000 and P + B/2 = 40,000
///                            401(k)  $20,000, brokerage $40,000
/// the year                   401(k)  $80,000, brokerage $40,000
///                            MAGI    80,000 + 20,000 = $100,000
/// ```
///
/// The same holds with the phases the other way round — the target first —
/// because the target's months draw last, after the stack's: drawn in
/// calendar order instead, the target would have spent its headroom on
/// $60,000 of pre-tax and the stack taken MAGI to $120,000.
#[test]
fn a_year_split_at_a_phase_start_holds_the_calendar_year_to_the_target() {
    let july = PhaseStart::Boundary(StreamBoundary::Date(YearMonth::new(start_year(), 7)));
    let stack_phase = |start: PhaseStart| DrawdownPhase {
        id: "stack".to_string(),
        name: "stack".to_string(),
        start,
        rule: PhaseRule::Stack,
        stack: vec![StackEntry {
            source: StackSource::Account("401k".to_string()),
            floor: 0.0,
        }],
    };
    let accounts = vec![
        account(
            "401k",
            "p1",
            AccountKind::TraditionalPreTax,
            1_000_000.0,
            0.0,
        ),
        account(
            "brokerage",
            "p1",
            AccountKind::Taxable,
            1_000_000.0,
            500_000.0,
        ),
    ];

    for phases in [
        vec![
            stack_phase(from_start()),
            target_phase("aca", july.clone(), 100_000.0),
        ],
        vec![
            target_phase("aca", from_start(), 100_000.0),
            stack_phase(july.clone()),
        ],
    ] {
        let plan = household(
            vec![person("p1", 60)],
            accounts.clone(),
            vec![spending(120_000.0)],
            phases,
        );
        let year = &untaxed(&plan).snapshots[0];
        assert_close(year.withdrawals["401k"], 80_000.0, "pre-tax");
        assert_close(year.withdrawals["brokerage"], 40_000.0, "brokerage");
        assert_close(year.magi, 100_000.0, "MAGI on the target");
    }
}
