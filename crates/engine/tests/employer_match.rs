//! Employer matching: tiered formula, the limit bucket it is held to, and
//! where the matched dollars land.
//!
//! One person on a $200k salary, 2026 start, born 1980 (so 46 in the first
//! year — no catch-up tier in play). Zero market return, so a balance is the
//! running sum of what went in.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    EmployerMatch, FilingStatus, GrowthRule, MatchDestination, MatchTier, PeriodLength, Person,
    Plan, PlanType, SimConfig, StateTaxProfile, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::presets::CONTRIBUTION_LIMITS;
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection};

const SALARY: f64 = 200_000.0;
const TAX_RATE: f64 = 0.2;

/// "100% of the first 3% of salary, then 50% of the next 2%" — the shape a
/// real plan document uses, and the reason a single flat percentage would
/// not do.
fn two_tier() -> Vec<MatchTier> {
    vec![
        MatchTier {
            employee_percent: 0.03,
            match_percent: 1.0,
        },
        MatchTier {
            employee_percent: 0.02,
            match_percent: 0.5,
        },
    ]
}

fn account(id: &str, kind: AccountKind, contribution: ContributionRule) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind,
        name: id.to_string(),
        balance: 0.0,
        cost_basis: None,
        allocation: AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)])),
        plan_type: PlanType::EmployerPlan,
        contribution,
        employer_match: None,
    }
}

fn plan_with(accounts: Vec<Account>) -> Plan {
    let person = "p1".to_string();
    Plan {
        id: "match".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "match".to_string(),
        people: vec![Person {
            id: person.clone(),
            name: "Saver".to_string(),
            birth: YearMonth::new(1980, 1),
            retirement: YearMonth::new(2050, 1),
            life_expectancy_age: 48,
        }],
        accounts,
        streams: vec![
            CashFlowStream {
                id: "salary".to_string(),
                name: "Salary".to_string(),
                owner: Some(person.clone()),
                direction: StreamDirection::Income,
                annual_amount: SALARY,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(person),
                growth: GrowthRule::None,
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
            inflation: 0.0,
            asset_returns: BTreeMap::from([(AssetClass::UsBonds, 0.0)]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 48,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn run(plan: &Plan) -> Projection {
    assert!(plan.validate().is_empty(), "{:?}", plan.validate());
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &returns,
        &FlatTax { rate: TAX_RATE },
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

#[test]
fn a_two_tier_match_pays_each_tier_at_its_own_rate() {
    // Employee defers 8%: the first 3% matched at 100%, the next 2% at 50%,
    // and the 3% above the tiers earns nothing. 3% + 1% = 4% of salary.
    let mut plan = plan_with(vec![account(
        "401k",
        AccountKind::TraditionalPreTax,
        ContributionRule::PercentOfSalary(0.08),
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::PreTax,
    });

    let p0 = &run(&plan).snapshots[0];
    assert_close(p0.contributions, 0.08 * SALARY, "employee defers 8%");
    assert_close(p0.employer_match, 0.04 * SALARY, "3% + 1% of salary");
    // Employer money raises the balance without passing through household
    // cash — so it is not in `contributions`, and income is untouched.
    assert_close(p0.income, SALARY, "match is not income");
    assert_close(p0.balances["401k"], 0.12 * SALARY, "both land in the plan");
}

#[test]
fn a_partial_deferral_only_reaches_the_tiers_it_pays_for() {
    let mut plan = plan_with(vec![account(
        "401k",
        AccountKind::TraditionalPreTax,
        ContributionRule::PercentOfSalary(0.02),
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::PreTax,
    });

    let p0 = &run(&plan).snapshots[0];
    // 2% is inside the first tier only, matched at 100%.
    assert_close(p0.employer_match, 0.02 * SALARY, "first tier only");
}

#[test]
fn the_match_is_not_reduced_when_the_employee_hits_the_deferral_limit() {
    // This is the failure mode the issue exists to prevent: matched dollars
    // do not count against the employee elective-deferral limit, so clamping
    // the employee's own 20%-of-salary deferral must leave the match whole.
    let mut plan = plan_with(vec![account(
        "401k",
        AccountKind::TraditionalPreTax,
        ContributionRule::PercentOfSalary(0.20),
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::PreTax,
    });

    let projection = run(&plan);
    let p0 = &projection.snapshots[0];
    assert_close(
        p0.contributions,
        CONTRIBUTION_LIMITS.employer_plan,
        "employee deferrals held to their own limit",
    );
    assert_close(
        p0.employer_match,
        0.04 * SALARY,
        "the full match, untouched by the employee's clamp",
    );
    // The clamp that did happen is the employee's, not the match's.
    assert!(
        projection
            .warnings
            .iter()
            .all(|w| !matches!(w, engine::SimWarning::AnnualAdditionsClamped { .. })),
        "415(c) was nowhere near: {:?}",
        projection.warnings
    );
}

/// Two accounts, identical but for where the match is sent. Only the
/// destination differs, so the whole tax difference is the deduction.
fn taxes_with(destination: MatchDestination) -> f64 {
    let mut plan = plan_with(vec![
        account(
            "401k",
            AccountKind::TraditionalPreTax,
            ContributionRule::PercentOfSalary(0.08),
        ),
        account(
            "roth-401k",
            AccountKind::Roth,
            ContributionRule::FlatAmount(0.0),
        ),
    ]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination,
    });
    let projection = run(&plan);
    let p0 = &projection.snapshots[0];
    assert_close(p0.employer_match, 0.04 * SALARY, "match paid either way");
    // Whichever way it is sent, it lands in the account whose tax treatment
    // matches — never merely labelled as one thing while sitting in another.
    let landed = if destination == MatchDestination::Roth {
        &p0.balances["roth-401k"]
    } else {
        &p0.balances["401k"]
    };
    assert!(
        *landed >= 0.04 * SALARY,
        "match landed in the right account"
    );
    p0.taxes
}

#[test]
fn a_roth_match_does_not_reduce_ordinary_income() {
    let pretax = taxes_with(MatchDestination::PreTax);
    let roth = taxes_with(MatchDestination::Roth);
    // A pre-tax match is deductible; a Roth match is not. The gap is exactly
    // the tax on the matched dollars.
    assert_close(
        roth - pretax,
        0.04 * SALARY * TAX_RATE,
        "Roth match is taxed, pre-tax match is deducted",
    );
}

#[test]
fn a_match_with_nowhere_to_land_is_reported_rather_than_mis_taxed() {
    // A pre-tax match on a plan whose only employer account is Roth. Putting
    // the money there anyway would make it withdraw untaxed forever.
    let mut plan = plan_with(vec![account(
        "roth-401k",
        AccountKind::Roth,
        ContributionRule::PercentOfSalary(0.08),
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::PreTax,
    });

    let projection = run(&plan);
    assert_close(projection.snapshots[0].employer_match, 0.0, "not deposited");
    assert!(
        projection
            .warnings
            .iter()
            .any(|w| matches!(w, engine::SimWarning::MatchUnallocated { .. })),
        "reported: {:?}",
        projection.warnings
    );
}

#[test]
fn deferrals_plus_match_are_held_to_the_annual_additions_cap() {
    // A deliberately extravagant formula so 415(c) is what bites, not the
    // employee's limit: 200% on the first 25% of salary.
    let mut plan = plan_with(vec![account(
        "401k",
        AccountKind::TraditionalPreTax,
        ContributionRule::FederalMaximum,
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: vec![MatchTier {
            employee_percent: 0.25,
            match_percent: 2.0,
        }],
        destination: MatchDestination::PreTax,
    });

    let projection = run(&plan);
    let p0 = &projection.snapshots[0];
    let cap = CONTRIBUTION_LIMITS.annual_additions_limit(46, 2026, 0.0);
    assert_close(
        p0.contributions + p0.employer_match,
        cap,
        "annual additions held to 415(c)",
    );
    assert_close(
        p0.contributions,
        CONTRIBUTION_LIMITS.employer_plan,
        "the employee's own deferrals are untouched — only the match gives way",
    );
    assert!(
        projection
            .warnings
            .iter()
            .any(|w| matches!(w, engine::SimWarning::AnnualAdditionsClamped { .. })),
        "reported: {:?}",
        projection.warnings
    );
}

#[test]
fn the_annual_additions_cap_is_far_above_the_deferral_limit() {
    // The distinction this whole issue rests on: folding a match into the
    // employee figure would clamp it at the deferral limit instead.
    assert!(
        CONTRIBUTION_LIMITS.annual_additions_limit(46, 2026, 0.0)
            > 2.0 * CONTRIBUTION_LIMITS.employer_plan,
    );
}

#[test]
fn no_salary_means_no_match() {
    // The match is a percentage of salary. Past retirement there is none,
    // and nothing is matched even though the formula is still declared.
    let mut plan = plan_with(vec![account(
        "401k",
        AccountKind::TraditionalPreTax,
        ContributionRule::PercentOfSalary(0.08),
    )]);
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::PreTax,
    });
    plan.people[0].retirement = YearMonth::new(2027, 1);

    let projection = run(&plan);
    assert_close(
        projection.snapshots[0].employer_match,
        0.04 * SALARY,
        "working",
    );
    assert_close(projection.snapshots[1].employer_match, 0.0, "retired");
}

#[test]
fn a_match_needs_an_employer_plan_to_sit_on() {
    let mut plan = plan_with(vec![account(
        "roth-ira",
        AccountKind::Roth,
        ContributionRule::FlatAmount(0.0),
    )]);
    plan.accounts[0].plan_type = PlanType::Ira;
    plan.accounts[0].employer_match = Some(EmployerMatch {
        tiers: two_tier(),
        destination: MatchDestination::Roth,
    });
    let errors = plan.validate();
    assert!(
        errors
            .iter()
            .any(|e| e.field == "accounts[0].employer_match"),
        "an IRA has no employer to match: {errors:?}"
    );
}
