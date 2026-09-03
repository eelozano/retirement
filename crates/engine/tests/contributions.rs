//! The three contribution modes, against the indexed statutory limit table.
//!
//! The plan below is deliberately long and inflationary — the point of
//! `PercentOfSalary` and `FederalMaximum` is what they do over a career, and
//! neither differs from a flat amount in period 0.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    StateTaxProfile, StepUp, StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::presets::CONTRIBUTION_LIMITS;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection};

const INFLATION: f64 = 0.025;
const START_YEAR: i32 = 2026;
const SALARY: f64 = 200_000.0;

/// Born January 1980, so the owner turns 46 in the first simulated year and
/// 50 in 2030 — the fifth period, well inside the working window.
fn plan_with(contribution: ContributionRule, kind: AccountKind, plan_type: PlanType) -> Plan {
    let person = "p1".to_string();
    Plan {
        id: "modes".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "modes".to_string(),
        people: vec![Person {
            id: person.clone(),
            name: "Saver".to_string(),
            birth: YearMonth::new(1980, 1),
            retirement: YearMonth::new(2050, 1),
            life_expectancy_age: 71,
        }],
        accounts: vec![Account {
            id: "plan".to_string(),
            owner: person.clone(),
            kind,
            name: "Plan".to_string(),
            balance: 0.0,
            cost_basis: None,
            // Zero return, so a snapshot balance is the running sum of what
            // actually went in — no growth to unwind.
            allocation: AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
            plan_type,
            contributions: vec![Contribution::until_retirement(
                "contribution",
                contribution,
                &person,
            )],
            employer_match: None,
        }],
        streams: vec![
            CashFlowStream {
                id: "salary".to_string(),
                name: "Salary".to_string(),
                owner: Some(person.clone()),
                direction: StreamDirection::Income,
                annual_amount: SALARY,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(person),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "spending".to_string(),
                name: "Spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 1.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::None,
                survivor_percentage: None,
            },
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: INFLATION,
            asset_returns: BTreeMap::from([(AssetClass::UsBonds, 0.0)]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 71,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start: YearMonth::new(START_YEAR, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn run(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &returns,
        &FlatTax { rate: 0.2 },
        &ProportionalDrawdown,
        0,
    )
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// Salary in the period starting `year`, grown from the plan's start.
fn salary_in(year: i32) -> f64 {
    SALARY * (1.0 + INFLATION).powi(year - START_YEAR)
}

fn contributions_in(projection: &Projection, year: i32) -> f64 {
    projection.snapshots[(year - START_YEAR) as usize].contributions
}

#[test]
fn percent_of_salary_rises_with_an_inflating_salary() {
    let plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.08,
            step_up: None,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);

    for year in [START_YEAR, START_YEAR + 1, START_YEAR + 12] {
        assert_close(
            contributions_in(&projection, year),
            0.08 * salary_in(year),
            &format!("8% of the {year} salary"),
        );
    }
    // The whole point: in today's dollars the contribution holds still,
    // where a flat nominal amount would visibly shrink every year.
    let real = |year: i32| {
        let snapshot = &projection.snapshots[(year - START_YEAR) as usize];
        snapshot.contributions / snapshot.deflator
    };
    assert_close(real(START_YEAR + 12), real(START_YEAR), "real terms hold");
}

#[test]
fn a_flat_amount_stays_nominal_and_so_decays_in_real_terms() {
    // Documented behavior, not an oversight: a fixed standing transfer is a
    // fixed number of dollars. The UI says so where it is entered.
    let plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 10_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, START_YEAR + 12),
        10_000.0,
        "flat in nominal dollars",
    );
}

#[test]
fn federal_maximum_steps_up_when_the_owner_turns_50() {
    let plan = plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);

    // Born January 1980: turns 49 in 2029 and 50 in 2030. Catch-up
    // eligibility is by the age attained during the year, so 2030 is the
    // first year it applies.
    let before = contributions_in(&projection, 2029);
    let after = contributions_in(&projection, 2030);
    assert_close(
        before,
        CONTRIBUTION_LIMITS
            .annual_limit(PlanType::EmployerPlan, 49, 2029, INFLATION)
            .unwrap(),
        "the plain deferral limit at 49",
    );
    assert!(
        after - before > 8_000.0,
        "turning 50 adds the catch-up tier: {before} -> {after}"
    );

    // And the higher SECURE 2.0 tier replaces it for the years they turn 60
    // through 63, then drops back to the ordinary catch-up at 64.
    assert!(
        contributions_in(&projection, 2040) > contributions_in(&projection, 2039),
        "age 60 steps up again"
    );
    // Comparing adjacent years isolates the tier change: one year of
    // indexing on the base limit cannot outweigh losing the higher tier.
    assert!(
        contributions_in(&projection, 2044) < contributions_in(&projection, 2043),
        "age 64 drops back to the ordinary catch-up"
    );
}

#[test]
fn federal_maximum_on_an_ira_resolves_to_the_ira_limit() {
    let employer = run(&plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    ));
    let ira = run(&plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::Roth,
        PlanType::Ira,
    ));

    assert_close(
        contributions_in(&ira, START_YEAR),
        CONTRIBUTION_LIMITS.ira,
        "the IRA limit, not the deferral limit",
    );
    assert!(
        contributions_in(&ira, START_YEAR) < contributions_in(&employer, START_YEAR),
        "the IRA bucket is the separate, much smaller one",
    );
}

#[test]
fn limits_index_forward_from_the_basis_year() {
    let plan = plan_with(
        ContributionRule::FederalMaximum,
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, START_YEAR),
        CONTRIBUTION_LIMITS.employer_plan,
        "the seeded figure applies unindexed in its own basis year",
    );
    assert!(
        contributions_in(&projection, START_YEAR + 12) > 1.3 * CONTRIBUTION_LIMITS.employer_plan,
        "12 years of indexing at 2.5% is a third again, before catch-up",
    );
}

/// Indexed figures step in statutory increments rather than drifting
/// smoothly, which is what the real schedule does.
#[test]
fn indexed_limits_round_down_to_statutory_increments() {
    for year in START_YEAR..START_YEAR + 25 {
        let limit = CONTRIBUTION_LIMITS
            .annual_limit(PlanType::EmployerPlan, 40, year, INFLATION)
            .unwrap();
        assert_close(limit % 500.0, 0.0, &format!("{year} limit lands on $500"));
    }
}

#[test]
fn a_taxable_account_has_no_federal_maximum_to_resolve() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 0.0,
            growth: GrowthRule::None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());

    plan.accounts[0].contributions[0].rule = ContributionRule::FederalMaximum;
    let errors = plan.validate();
    assert!(
        errors
            .iter()
            .any(|e| e.field == "accounts[0].contributions[0].rule"),
        "a taxable brokerage has no statutory maximum: {errors:?}"
    );
}

#[test]
fn a_clamp_is_reported_once_for_the_first_year_it_bites() {
    // 20% of a $200k salary is far above the deferral limit, and stays
    // above it for every year of the projection — one finding, not thirty.
    let plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.20,
            step_up: None,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    let clamps: Vec<_> = projection
        .warnings
        .iter()
        .filter_map(|w| match w {
            engine::SimWarning::ContributionClamped {
                period, allowed, ..
            } => Some((*period, *allowed)),
            _ => None,
        })
        .collect();
    assert_eq!(clamps.len(), 1, "reported once: {clamps:?}");
    assert_eq!(clamps[0].0, 0, "reported for the first period it bites");
    assert_close(
        clamps[0].1,
        CONTRIBUTION_LIMITS.employer_plan,
        "held to the statutory cap",
    );
}

// ---- Dated entries (#78) --------------------------------------------------

fn clamps_in(projection: &Projection) -> Vec<(usize, f64, f64)> {
    projection
        .warnings
        .iter()
        .filter_map(|w| match w {
            engine::SimWarning::ContributionClamped {
                period,
                requested,
                allowed,
                ..
            } => Some((*period, *requested, *allowed)),
            _ => None,
        })
        .collect()
}

#[test]
fn an_entry_starting_at_a_date_contributes_nothing_before_it_and_prorates_its_first_year() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 12_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].start = StreamBoundary::Date(YearMonth::new(2028, 7));
    let projection = run(&plan);

    assert_close(contributions_in(&projection, 2026), 0.0, "before the start");
    assert_close(contributions_in(&projection, 2027), 0.0, "still before");
    assert_close(
        contributions_in(&projection, 2028),
        6_000.0,
        "July start: half the year",
    );
    assert_close(contributions_in(&projection, 2029), 12_000.0, "full year");
}

#[test]
fn an_entry_ending_at_a_date_before_retirement_stops_there() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 12_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].end = StreamBoundary::Date(YearMonth::new(2030, 4));
    let projection = run(&plan);

    assert_close(contributions_in(&projection, 2029), 12_000.0, "full year");
    assert_close(
        contributions_in(&projection, 2030),
        3_000.0,
        "ends in April: a quarter",
    );
    assert_close(contributions_in(&projection, 2031), 0.0, "stopped");
    // The owner is still working — the entry's own end is what stopped it.
    assert!(projection.snapshots[5].income > 0.0);
}

/// "$200/mo now, $1,200/mo from January" is two entries on one account.
/// They sum, the account is clamped as one, and it is reported once.
#[test]
fn two_entries_on_one_account_sum_and_clamp_together_with_one_warning() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 2_400.0,
            growth: GrowthRule::None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions.push(Contribution {
        id: "raise".to_string(),
        rule: ContributionRule::FlatAmount {
            amount: 12_000.0,
            growth: GrowthRule::None,
        },
        start: StreamBoundary::Date(YearMonth::new(2027, 1)),
        end: StreamBoundary::AtRetirement("p1".to_string()),
    });
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, 2026),
        2_400.0,
        "first entry alone",
    );
    assert_close(
        contributions_in(&projection, 2027),
        14_400.0,
        "both entries, summed",
    );
    assert_eq!(
        projection.snapshots[1].contributions_by_account["plan"], 14_400.0,
        "attributed to the one account, not per entry"
    );

    // Now on a capped account: the sum is what is clamped, and the account
    // — not each entry — is what is reported.
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 15_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    plan.accounts[0]
        .contributions
        .push(Contribution::until_retirement(
            "second",
            ContributionRule::FlatAmount {
                amount: 15_000.0,
                growth: GrowthRule::None,
            },
            &"p1".to_string(),
        ));
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, START_YEAR),
        CONTRIBUTION_LIMITS.employer_plan,
        "the sum is held to the cap",
    );
    let clamps = clamps_in(&projection);
    assert_eq!(clamps.len(), 1, "one warning for the account: {clamps:?}");
    assert_close(clamps[0].1, 30_000.0, "requested is the sum of the entries");
}

/// The percent-of-salary ratio, against the hand-computed cases in #78.
#[test]
fn percent_of_salary_scales_by_the_entrys_share_of_the_salary_earned() {
    // Full working year, entry starts in July: half of a full year's salary.
    let mut plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.10,
            step_up: None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].start = StreamBoundary::Date(YearMonth::new(2028, 7));
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, 2028),
        0.10 * salary_in(2028) * 0.5,
        "July start of a full working year: ½",
    );
    assert_close(
        contributions_in(&projection, 2029),
        0.10 * salary_in(2029),
        "full year after",
    );

    // Retires in April, entry ends at retirement: 10% of the salary
    // actually earned — three months' worth — not docked a second time.
    let mut plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.10,
            step_up: None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.people[0].retirement = YearMonth::new(2049, 4);
    let projection = run(&plan);
    let earned = projection.snapshots[(2049 - START_YEAR) as usize].income;
    assert_close(
        earned,
        salary_in(2049) * 3.0 / 12.0,
        "three months of salary",
    );
    assert_close(
        contributions_in(&projection, 2049),
        0.10 * earned,
        "retirement year: the whole 10% of what was earned",
    );

    // Retires in April, entry runs to plan end: the ratio caps at 1, so the
    // same answer — and nothing after, since there is no salary to be a
    // percentage of.
    plan.accounts[0].contributions[0].end = StreamBoundary::PlanEnd;
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, 2049),
        0.10 * earned,
        "capped at all of the salary earned",
    );
    assert_close(
        contributions_in(&projection, 2050),
        0.0,
        "retired: no salary",
    );
}

/// A spousal IRA: funded after the owner's own retirement, so the cap
/// cannot be prorated by the months they worked.
#[test]
fn an_ira_entry_can_run_past_the_owners_retirement() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 5_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::Roth,
        PlanType::Ira,
    );
    plan.accounts[0].contributions[0].end = StreamBoundary::PlanEnd;
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, 2050),
        5_000.0,
        "the first fully retired year still contributes",
    );
    assert!(
        clamps_in(&projection).is_empty(),
        "{:?}",
        projection.warnings
    );
}

#[test]
fn a_boundary_naming_a_deleted_person_is_reported_and_contributes_nothing() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 12_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].end = StreamBoundary::AtRetirement("ghost".to_string());
    let projection = run(&plan);
    assert!(
        projection
            .warnings
            .contains(&engine::SimWarning::ContributionBoundaryUnresolved {
                account: "plan".to_string()
            }),
        "{:?}",
        projection.warnings
    );
    assert!(
        projection.snapshots.iter().all(|s| s.contributions == 0.0),
        "nothing contributed from an entry with no window"
    );
}

// ---- Escalation (#79) -----------------------------------------------------

/// The plan-document sentence this exists for: "10% of salary now, up a
/// point a year for five years until 15%."
#[test]
fn a_step_up_adds_a_point_a_year_until_it_reaches_the_cap() {
    let plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.10,
            step_up: Some(StepUp {
                points_per_year: 0.01,
                cap: 0.15,
            }),
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    let projection = run(&plan);

    for (offset, percent) in [
        (0, 0.10),
        (1, 0.11),
        (2, 0.12),
        (3, 0.13),
        (4, 0.14),
        (5, 0.15),
        (6, 0.15),
        (12, 0.15),
    ] {
        let year = START_YEAR + offset;
        assert_close(
            contributions_in(&projection, year),
            percent * salary_in(year),
            &format!("{:.0}% of the {year} salary", percent * 100.0),
        );
    }
}

/// Years count from the *entry's* start, not the plan's: "open a Roth in
/// 2029 at 5%, up a point a year" is 5% in 2029, not 5% plus three years of
/// steps it never took.
#[test]
fn a_step_up_counts_years_from_the_entrys_own_start() {
    let mut plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.05,
            step_up: Some(StepUp {
                points_per_year: 0.01,
                cap: 0.15,
            }),
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].start = StreamBoundary::Date(YearMonth::new(2029, 1));
    let projection = run(&plan);

    assert_close(contributions_in(&projection, 2028), 0.0, "before it starts");
    assert_close(
        contributions_in(&projection, 2029),
        0.05 * salary_in(2029),
        "its first year is its starting percentage",
    );
    assert_close(
        contributions_in(&projection, 2030),
        0.06 * salary_in(2030),
        "one whole year in: one point",
    );
    assert_close(
        contributions_in(&projection, 2032),
        0.08 * salary_in(2032),
        "three whole years in: three points",
    );
}

/// A step-up crossing the statutory limit is still one finding, not one a
/// year — the escalation is what pushes it over, and the dedup is by
/// account.
#[test]
fn a_step_up_that_crosses_the_limit_is_reported_once() {
    // 8% of $200k is under the deferral limit; 20% is well over it, so the
    // clamp starts biting partway through rather than in period 0.
    let plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.08,
            step_up: Some(StepUp {
                points_per_year: 0.01,
                cap: 0.20,
            }),
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);
    let clamps = clamps_in(&projection);
    assert_eq!(clamps.len(), 1, "one finding for the account: {clamps:?}");
    assert!(
        clamps[0].0 > 0,
        "the first year the escalated percentage crosses the limit, not period 0: {clamps:?}"
    );
    assert_close(
        clamps[0].2,
        CONTRIBUTION_LIMITS
            .annual_limit(
                PlanType::EmployerPlan,
                (START_YEAR + clamps[0].0 as i32) - 1980,
                START_YEAR + clamps[0].0 as i32,
                INFLATION,
            )
            .unwrap(),
        "held to that year's statutory cap",
    );
}

/// The mirror of `a_flat_amount_stays_nominal_and_so_decays_in_real_terms`:
/// the same entry with a growth rule keeps its buying power instead.
#[test]
fn a_flat_amount_with_a_growth_rule_holds_its_real_value() {
    let plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 10_000.0,
            growth: GrowthRule::Inflation,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    );
    let projection = run(&plan);

    // Nominal: $10,000 grown twelve years at the plan's inflation rate.
    assert_close(
        contributions_in(&projection, START_YEAR + 12),
        10_000.0 * (1.0 + INFLATION).powi(12),
        "grown from plan start",
    );
    // Real: the same $10,000 it started as — the point of the rule.
    let real = |year: i32| {
        let snapshot = &projection.snapshots[(year - START_YEAR) as usize];
        snapshot.contributions / snapshot.deflator
    };
    assert_close(real(START_YEAR), 10_000.0, "today's dollars in year one");
    assert_close(real(START_YEAR + 12), 10_000.0, "and twelve years on");

    // And `None` — the default, and what every plan written before this
    // field loads as — still decays, unchanged.
    let flat = run(&plan_with(
        ContributionRule::FlatAmount {
            amount: 10_000.0,
            growth: GrowthRule::None,
        },
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
    ));
    assert_close(
        contributions_in(&flat, START_YEAR + 12),
        10_000.0,
        "nominal, as before",
    );
}

/// An inflation-growing amount is entered in *simulation-start* dollars —
/// the stream convention — so it means the same thing whichever year the
/// entry begins.
#[test]
fn a_growing_flat_amount_grows_from_plan_start_not_from_the_entrys_start() {
    let mut plan = plan_with(
        ContributionRule::FlatAmount {
            amount: 10_000.0,
            growth: GrowthRule::Inflation,
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    plan.accounts[0].contributions[0].start = StreamBoundary::Date(YearMonth::new(2029, 1));
    let projection = run(&plan);
    assert_close(
        contributions_in(&projection, 2029),
        10_000.0 * (1.0 + INFLATION).powi(3),
        "three years of inflation on today's $10,000, not a fresh $10,000",
    );
}

#[test]
fn validation_rejects_a_step_up_that_cannot_step() {
    let cases: [(StepUp, &str); 3] = [
        (
            StepUp {
                points_per_year: 0.0,
                cap: 0.15,
            },
            "a step of zero points never moves",
        ),
        (
            StepUp {
                points_per_year: -0.01,
                cap: 0.15,
            },
            "stepping down is not modelled",
        ),
        (
            StepUp {
                points_per_year: 0.01,
                cap: 0.05,
            },
            "a cap below the starting percentage is a silent no-op",
        ),
    ];
    for (step_up, why) in cases {
        let mut plan = plan_with(
            ContributionRule::PercentOfSalary {
                percent: 0.10,
                step_up: None,
            },
            AccountKind::Taxable,
            PlanType::None,
        );
        assert!(plan.validate().is_empty(), "{:?}", plan.validate());
        plan.accounts[0].contributions[0].rule = ContributionRule::PercentOfSalary {
            percent: 0.10,
            step_up: Some(step_up),
        };
        let errors = plan.validate();
        assert!(
            errors
                .iter()
                .any(|e| e.field == "accounts[0].contributions[0].rule"),
            "{why}: {errors:?}"
        );
    }

    // The valid escalation the rejections are drawn around.
    let plan = plan_with(
        ContributionRule::PercentOfSalary {
            percent: 0.10,
            step_up: Some(StepUp {
                points_per_year: 0.01,
                cap: 0.15,
            }),
        },
        AccountKind::Taxable,
        PlanType::None,
    );
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
}
