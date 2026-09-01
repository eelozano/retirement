//! Survivor modelling (#34): what changes for a household after the first
//! death — Social Security dropping to the larger benefit, filing status,
//! the household spending step-down, and pension survivor percentages.
//!
//! Every fixture runs with zero inflation, zero returns, and zero COLA, so
//! the figures asserted below are the transition itself and nothing else.

use std::collections::BTreeMap;

use engine::model::{
    Assumptions, CashFlowStream, FilingStatus, GrowthRule, PeriodLength, Person, Plan, SimConfig,
    SocialSecurityBenefit, StateTaxProfile, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::run_deterministic;
use engine::sim::Projection;

const START: YearMonth = YearMonth {
    year: 2030,
    month: 1,
};

/// `first` (born 1960-01, dies at 75 → 2035-01) is outlived by `second`
/// (dies at 85 → 2045-01). Both are already retired at the plan start, so
/// nothing but the streams under test moves.
fn household() -> Plan {
    Plan {
        id: "survivor-test".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "survivor-test".to_string(),
        people: vec![
            person(
                "first",
                YearMonth {
                    year: 1960,
                    month: 1,
                },
                75,
            ),
            person(
                "second",
                YearMonth {
                    year: 1960,
                    month: 1,
                },
                85,
            ),
        ],
        accounts: vec![],
        streams: vec![],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::new(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 95,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
        },
        sim_config: SimConfig {
            start: START,
            period: PeriodLength::Year,
            display_real_dollars: false,
            show_monte_carlo_band: false,
        },
    }
}

fn person(id: &str, birth: YearMonth, life_expectancy_age: u8) -> Person {
    Person {
        id: id.to_string(),
        name: id.to_string(),
        birth,
        retirement: YearMonth {
            year: 2025,
            month: 1,
        },
        life_expectancy_age,
    }
}

/// A benefit whose full retirement age and claiming age are both 70, so the
/// claiming adjustment is exactly 1.0 and `benefit_at_fra` is what is paid.
fn benefit(owner: &str, annual: f64) -> SocialSecurityBenefit {
    SocialSecurityBenefit {
        id: format!("ss-{owner}"),
        owner: owner.to_string(),
        benefit_at_fra: annual,
        full_retirement_age: 70,
        claiming_age: 70,
        cola_override: None,
    }
}

fn stream(
    id: &str,
    owner: Option<&str>,
    direction: StreamDirection,
    annual: f64,
) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: owner.map(str::to_string),
        direction,
        annual_amount: annual,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::PlanEnd,
        growth: GrowthRule::None,
        survivor_percentage: None,
    }
}

fn year(projection: &Projection, year: i32) -> &engine::sim::PeriodSnapshot {
    projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == year)
        .unwrap_or_else(|| panic!("projection has a period for {year}"))
}

#[test]
fn the_first_death_is_the_earlier_expectancy_and_leaves_a_survivor() {
    let plan = household();
    let (month, decedent) = plan.first_death().expect("two people, two expectancies");
    assert_eq!(
        month,
        YearMonth {
            year: 2035,
            month: 1
        }
    );
    assert_eq!(decedent.id, "first");
}

/// One person cannot be survived, so nothing transitions — the whole
/// feature has to be inert for a solo plan.
#[test]
fn a_solo_plan_has_no_survivor_transition() {
    let mut plan = household();
    plan.people.truncate(1);
    assert!(plan.first_death().is_none());
}

/// The survivor keeps the larger of the two benefits, not both.
#[test]
fn social_security_drops_to_the_larger_benefit_at_the_first_death() {
    let mut plan = household();
    plan.social_security = vec![benefit("first", 40_000.0), benefit("second", 25_000.0)];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 65_000.0);
    // `first` dies 2035-01, the exact start of the 2035 period: the
    // household draws one benefit for all of it, and it is the larger of
    // the two — the decedent's own, here.
    assert_eq!(year(&projection, 2035).income, 40_000.0);
    assert_eq!(year(&projection, 2044).income, 40_000.0);
}

/// The mirror case: when the survivor's own benefit is the larger one, they
/// keep drawing it unchanged and it is the decedent's that stops.
#[test]
fn a_survivor_with_the_larger_benefit_keeps_their_own() {
    let mut plan = household();
    plan.social_security = vec![benefit("first", 25_000.0), benefit("second", 40_000.0)];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 65_000.0);
    assert_eq!(year(&projection, 2035).income, 40_000.0);
}

/// The common one-earner household: the survivor has no benefit of their
/// own on the plan and inherits the decedent's.
#[test]
fn a_survivor_with_no_benefit_of_their_own_inherits_the_decedents() {
    let mut plan = household();
    plan.social_security = vec![benefit("first", 40_000.0)];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 40_000.0);
    assert_eq!(year(&projection, 2035).income, 40_000.0);
    assert_eq!(year(&projection, 2044).income, 40_000.0);
}

/// A survivor who has not reached their own claiming age when the first
/// death happens steps up then, not at the death. That is a deliberate
/// simplification — a real survivor benefit can start at 60, independently
/// of one's own — and the conservative direction, so it is pinned here.
#[test]
fn a_survivor_steps_up_no_earlier_than_their_own_claiming_age() {
    let mut plan = household();
    // `second` is born in 1970, so they turn 70 (their claiming age) in
    // 2040 — five years after `first` dies.
    plan.people[1] = person(
        "second",
        YearMonth {
            year: 1970,
            month: 1,
        },
        75,
    );
    plan.social_security = vec![benefit("first", 40_000.0), benefit("second", 25_000.0)];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 40_000.0);
    assert_eq!(year(&projection, 2036).income, 0.0);
    assert_eq!(year(&projection, 2040).income, 40_000.0);
}

/// A survivor benefit goes to a spouse, and the model has no relationships
/// in it: with two people left there is no way to tell which of them it
/// transfers to. Such a household is left alone rather than guessed at —
/// each person keeps their own benefit to their own death.
#[test]
fn a_household_with_two_survivors_keeps_every_benefit_as_it_was() {
    let mut plan = household();
    plan.people.push(person(
        "third",
        YearMonth {
            year: 1960,
            month: 1,
        },
        90,
    ));
    plan.social_security = vec![
        benefit("first", 40_000.0),
        benefit("second", 25_000.0),
        benefit("third", 10_000.0),
    ];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 75_000.0);
    // Only `first`'s own benefit stops, at their own death.
    assert_eq!(year(&projection, 2035).income, 35_000.0);
    // And `second`'s stops at theirs, leaving `third`'s alone.
    assert_eq!(year(&projection, 2045).income, 10_000.0);
}

/// The tax cliff: the same income, taxed against half the brackets. The
/// household files jointly through the year of the death — the IRS rule —
/// and Single from the year after.
#[test]
fn filing_status_becomes_single_the_year_after_the_first_death() {
    let mut plan = household();
    plan.assumptions.filing_status = FilingStatus::MarriedFilingJointly;
    // Household income, unowned and flat to the horizon, so the only thing
    // that changes across the transition is the bracket schedule.
    plan.streams = vec![stream("pension", None, StreamDirection::Income, 120_000.0)];
    let projection = run_deterministic(&plan);

    for y in [2034, 2035, 2036] {
        assert_eq!(year(&projection, y).income, 120_000.0, "income is flat");
    }
    assert_eq!(
        year(&projection, 2035).taxes,
        year(&projection, 2034).taxes,
        "the year of the death still files jointly"
    );
    assert!(
        year(&projection, 2036).taxes > year(&projection, 2035).taxes,
        "the survivor's bill rises on unchanged income: {} -> {}",
        year(&projection, 2035).taxes,
        year(&projection, 2036).taxes
    );
}

/// A household already filing Single has no status to lose.
#[test]
fn a_single_filer_household_sees_no_bracket_change() {
    let mut plan = household();
    plan.streams = vec![stream("pension", None, StreamDirection::Income, 120_000.0)];
    let projection = run_deterministic(&plan);

    assert_eq!(
        year(&projection, 2036).taxes,
        year(&projection, 2034).taxes,
        "Single stays Single"
    );
}

#[test]
fn household_expenses_step_down_at_the_first_death() {
    let mut plan = household();
    plan.assumptions.survivor_expense_factor = 0.7;
    plan.streams = vec![stream(
        "spending",
        None,
        StreamDirection::Expense,
        100_000.0,
    )];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).expenses, 100_000.0);
    assert_eq!(year(&projection, 2035).expenses, 70_000.0);
    assert_eq!(year(&projection, 2044).expenses, 70_000.0);
}

/// A death partway through a period splits it: the months before the death
/// bill at the household rate and the months after at the survivor's,
/// rather than the whole period going one way.
#[test]
fn the_step_down_is_prorated_within_the_period_of_the_death() {
    let mut plan = household();
    plan.assumptions.survivor_expense_factor = 0.7;
    // Born 1960-07, so `first` dies 2035-07 — half way through the period.
    plan.people[0] = person(
        "first",
        YearMonth {
            year: 1960,
            month: 7,
        },
        75,
    );
    plan.streams = vec![stream(
        "spending",
        None,
        StreamDirection::Expense,
        100_000.0,
    )];
    let projection = run_deterministic(&plan);

    let expected = 0.5 * 100_000.0 + 0.5 * 70_000.0;
    assert!(
        (year(&projection, 2035).expenses - expected).abs() < 1e-9,
        "expected {expected}, got {}",
        year(&projection, 2035).expenses
    );
    assert_eq!(year(&projection, 2036).expenses, 70_000.0);
}

/// The factor is the *household's* — an expense a person owns is theirs,
/// and its own end boundary is what says when it stops.
#[test]
fn a_person_owned_expense_is_not_stepped_down() {
    let mut plan = household();
    plan.assumptions.survivor_expense_factor = 0.7;
    plan.streams = vec![stream(
        "second-care",
        Some("second"),
        StreamDirection::Expense,
        100_000.0,
    )];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2036).expenses, 100_000.0);
}

/// A 50%-survivor pension annuity: full amount for the owner's life, half
/// of it for the survivor's.
#[test]
fn a_survivor_percentage_continues_a_pension_at_the_reduced_rate() {
    let mut plan = household();
    let mut pension = stream("pension", Some("first"), StreamDirection::Income, 60_000.0);
    pension.end = StreamBoundary::AtDeath("first".to_string());
    pension.survivor_percentage = Some(0.5);
    plan.streams = vec![pension];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 60_000.0);
    assert_eq!(year(&projection, 2035).income, 30_000.0);
    assert_eq!(year(&projection, 2044).income, 30_000.0);
}

/// The percentage overrides the stream's own end in both directions: a
/// pension left running to the plan end still drops to the survivor share
/// at its owner's death rather than paying full freight to a dead person.
#[test]
fn a_survivor_percentage_stops_the_full_amount_at_the_owners_death() {
    let mut plan = household();
    let mut pension = stream("pension", Some("first"), StreamDirection::Income, 60_000.0);
    pension.end = StreamBoundary::PlanEnd;
    pension.survivor_percentage = Some(0.5);
    plan.streams = vec![pension];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2034).income, 60_000.0);
    assert_eq!(year(&projection, 2035).income, 30_000.0);
}

/// Nobody is left to pay a survivor annuity to when the owner is the last
/// to die, so the continuation must be empty rather than running to the
/// horizon.
#[test]
fn a_survivor_percentage_pays_nothing_when_the_owner_outlives_everyone() {
    let mut plan = household();
    let mut pension = stream("pension", Some("second"), StreamDirection::Income, 60_000.0);
    pension.end = StreamBoundary::AtDeath("second".to_string());
    pension.survivor_percentage = Some(0.5);
    plan.streams = vec![pension];
    let projection = run_deterministic(&plan);

    assert_eq!(year(&projection, 2044).income, 60_000.0);
    assert_eq!(
        projection
            .snapshots
            .last()
            .expect("periods")
            .period_start
            .year,
        2044
    );
}

/// Plans written before #34 carry neither field and must load — and
/// simulate — exactly as they did.
#[test]
fn plans_without_the_survivor_fields_load_unchanged() {
    let mut plan = household();
    plan.streams = vec![stream(
        "spending",
        None,
        StreamDirection::Expense,
        100_000.0,
    )];
    let mut value = serde_json::to_value(&plan).expect("plan serializes");
    value["assumptions"]
        .as_object_mut()
        .unwrap()
        .remove("survivor_expense_factor");
    for s in value["streams"].as_array_mut().unwrap() {
        s.as_object_mut().unwrap().remove("survivor_percentage");
    }

    let reloaded: Plan = serde_json::from_value(value).expect("pre-#34 plan parses");
    assert_eq!(reloaded.assumptions.survivor_expense_factor, 1.0);
    assert!(reloaded
        .streams
        .iter()
        .all(|s| s.survivor_percentage.is_none()));
    assert_eq!(
        year(&run_deterministic(&reloaded), 2036).expenses,
        100_000.0,
        "spending is untouched without a factor"
    );
}
