//! A brand-new plan is a household and nothing else — no accounts, no
//! income, no spending. Before #103 that state was unreachable (every fresh
//! install was bootstrapped with the invented example household), so nothing
//! checked that the engine survives it. It is now the first thing a new user
//! has, and it must validate and project rather than panic or emit NaN.

use engine::model::{Person, Plan, YearMonth};
use engine::presets::new_plan;
use engine::{run_deterministic, run_monte_carlo, MonteCarloConfig};

fn person(id: &str, birth_year: i32, retirement_year: i32) -> Person {
    Person {
        id: id.to_string(),
        name: id.to_string(),
        birth: YearMonth::new(birth_year, 6),
        retirement: YearMonth::new(retirement_year, 6),
        life_expectancy_age: 95,
    }
}

fn solo() -> Plan {
    new_plan(
        "My plan",
        YearMonth::new(2026, 1),
        vec![person("me", 1985, 2050)],
    )
}

#[test]
fn empty_plan_is_valid() {
    assert_eq!(solo().validate(), vec![]);
}

#[test]
fn empty_plan_projects_without_nan() {
    let projection = run_deterministic(&solo());
    assert!(
        !projection.snapshots.is_empty(),
        "an empty plan still has a horizon to project over"
    );
    for snapshot in &projection.snapshots {
        assert!(
            snapshot.net_worth.is_finite(),
            "period {} produced a non-finite net worth from an empty portfolio",
            snapshot.period
        );
        assert_eq!(
            snapshot.net_worth, 0.0,
            "no accounts and no cash flows means nothing to accumulate"
        );
    }
}

#[test]
fn empty_plan_runs_monte_carlo() {
    // The store starts a run as soon as a plan is activated, so this path is
    // hit immediately after the first plan is created — an empty portfolio
    // must not divide by a zero allocation weight.
    let result = run_monte_carlo(
        &solo(),
        &MonteCarloConfig {
            n_paths: 64,
            seed: 1,
        },
    );
    assert!(result.success_rate.is_finite());
}

#[test]
fn a_new_plan_is_not_marked_as_an_example() {
    assert!(!solo().sample, "the user's own plan is never an example");
    assert!(
        engine::presets::seed_plan().sample,
        "the invented household always identifies itself as one"
    );
}

#[test]
fn two_person_plan_runs_to_the_last_survivor() {
    let plan = new_plan(
        "Ours",
        YearMonth::new(2026, 1),
        vec![person("a", 1985, 2050), person("b", 1990, 2055)],
    );
    assert_eq!(plan.validate(), vec![]);
    // b is younger with the same expectancy, so the horizon is b's.
    assert_eq!(plan.end_month(), YearMonth::new(2085, 6));
}
