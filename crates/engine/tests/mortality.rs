//! Per-person life expectancy (#28): `Plan::end_month` runs to the last
//! survivor, and `StreamBoundary::AtDeath` resolves against each person's
//! own figure rather than a shared household age.

use engine::model::TaxFigures;
use engine::model::{
    Assumptions, CashFlowStream, FilingStatus, GrowthRule, PeriodLength, Person, Plan, SimConfig,
    StateTaxProfile, StreamBoundary, StreamDirection, StreamKind, YearMonth, SCHEMA_VERSION,
};
use engine::run_deterministic;

const START: YearMonth = YearMonth {
    year: 2000,
    month: 1,
};

/// Two people who both start the plan at age 0: `short` is expected to live
/// to 5 (dies 2005-01), `long` to 10 (dies 2010-01). Only `short` has an
/// income stream, and it ends `AtDeath(short)`.
fn plan_with_two_lifespans() -> Plan {
    let short = "short".to_string();
    let long = "long".to_string();
    Plan {
        id: "mortality-test".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "mortality-test".to_string(),
        sample: false,
        people: vec![
            Person {
                id: short.clone(),
                name: "Short".to_string(),
                birth: START,
                retirement: START,
                life_expectancy_age: 5,
            },
            Person {
                id: long.clone(),
                name: "Long".to_string(),
                birth: START,
                retirement: START,
                life_expectancy_age: 10,
            },
        ],
        accounts: vec![],
        streams: vec![CashFlowStream {
            id: "short-income".to_string(),
            name: "Short's income".to_string(),
            owner: Some(short.clone()),
            direction: StreamDirection::Income,
            annual_amount: 1_000.0,
            start: StreamBoundary::PlanStart,
            end: StreamBoundary::AtDeath(short),
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
            // Deliberately left far from either person's real expectancy —
            // proves the household horizon and `AtDeath` no longer read it.
            plan_end_age: 200,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            strategy_volatility: Default::default(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start: START,
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

#[test]
fn end_month_is_the_max_over_per_person_expectancy() {
    let plan = plan_with_two_lifespans();
    // `long` (age 10) outlives `short` (age 5), so the horizon is `long`'s
    // death month, not the stale `assumptions.plan_end_age: 200`.
    assert_eq!(
        plan.end_month(),
        YearMonth {
            year: 2010,
            month: 1
        }
    );
}

#[test]
fn at_death_resolves_per_person_not_to_the_household_max() {
    let projection = run_deterministic(&plan_with_two_lifespans(), &TaxFigures::built_in());

    // The household runs 10 years (through `long`'s death), not 5 — the
    // shorter-lived `short` no longer caps the whole plan.
    assert_eq!(projection.snapshots.len(), 10);

    // While `short` is alive, their stream is fully active.
    let year_2004 = projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == 2004)
        .expect("period for 2004 exists");
    assert_eq!(year_2004.income, 1_000.0);

    // From `short`'s own death (2005-01) onward, their stream contributes
    // nothing — even though the household plan continues for `long`.
    let year_2005 = projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == 2005)
        .expect("period for 2005 exists");
    assert_eq!(year_2005.income, 0.0);

    let last = projection.snapshots.last().expect("at least one period");
    assert_eq!(last.period_start.year, 2009);
    assert_eq!(last.income, 0.0);
}

/// An age boundary is the month that person reaches the age — their birth
/// month, that many years on — so eligibility written as an age (a
/// pension's full benefit, Medicare, catch-up contributions) stays right
/// when a retirement date moves or a birth date is corrected.
#[test]
fn an_age_boundary_resolves_to_the_month_that_person_turns_it() {
    let mut plan = plan_with_two_lifespans();
    // Born in April rather than at the plan start, so the resolved months
    // are not the period boundaries themselves.
    plan.people[1].birth = YearMonth {
        year: 2000,
        month: 4,
    };
    plan.people[1].life_expectancy_age = 20;
    let mut income = plan.streams[0].clone();
    income.owner = Some("long".to_string());
    income.annual_amount = 12_000.0;
    income.start = StreamBoundary::AtAge("long".to_string(), 5);
    income.end = StreamBoundary::AtAge("long".to_string(), 10);
    plan.streams = vec![income];
    let projection = run_deterministic(&plan, &TaxFigures::built_in());

    let year = |y: i32| {
        projection
            .snapshots
            .iter()
            .find(|s| s.period_start.year == y)
            .expect("a period")
            .income
    };
    assert_eq!(year(2004), 0.0);
    assert!((year(2005) - 12_000.0 * 9.0 / 12.0).abs() < 1e-6);
    assert_eq!(year(2006), 12_000.0);
    assert!((year(2010) - 12_000.0 * 3.0 / 12.0).abs() < 1e-6);
    assert_eq!(year(2011), 0.0);
}
