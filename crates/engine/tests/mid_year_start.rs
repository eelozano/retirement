//! A plan that starts in September (#106).
//!
//! The period grid is calendar years laid from the start month: period 0
//! runs from the start to the following January and is a **stub**, every
//! later period is a whole calendar year. These tests pin what a stub does
//! to each thing that is scaled by a period — flows, growth, contribution
//! caps, the deflator, required distributions — and what it deliberately
//! does *not* do to tax.
//!
//! Setup, so every figure below is derivable on paper: one person, zero
//! inflation, a single 100% bonds class returning 10%, a 20% flat tax, and
//! spending tuned so the household's cash comes out at exactly zero in a
//! full working year *and* in the stub.
//!
//!   Full year: 120,000 salary − 12,000 contribution
//!              − 21,600 tax ((120,000 − 12,000) × 20%) − 86,400 spending = 0
//!   Stub (4/12): every one of those figures × 1/3, so it is zero there too.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    StateTaxProfile, StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::presets::{seed_plan, uniform_lifetime_divisor, CONTRIBUTION_LIMITS};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{run_deterministic, simulate, Projection};

const SALARY: f64 = 120_000.0;
const CONTRIBUTION: f64 = 12_000.0;
const SPENDING: f64 = 86_400.0;
const RETURN: f64 = 0.10;
const OPENING_BALANCE: f64 = 100_000.0;
/// Four months of a year: September through December.
const STUB: f64 = 4.0 / 12.0;

fn run_with_flat_tax(plan: &Plan, rate: f64) -> Projection {
    // Annual rates, scaled to a period the same way `run_deterministic`
    // does: a period is a calendar year, and the loop takes the stub's
    // share of the year's return itself.
    let returns = FixedReturns::new(&plan.assumptions.asset_returns, 12);
    simulate(plan, &returns, &FlatTax { rate }, &ProportionalDrawdown, 0)
}

/// A working household whose plan starts in `start`, ending after the
/// calendar year `last_year`.
fn working_plan(start: YearMonth, last_year: i32, rule: ContributionRule) -> Plan {
    let person = "p1".to_string();
    let bonds_only = AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)]));
    let birth = YearMonth::new(1986, 1);
    Plan {
        id: "mid-year".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "mid-year".to_string(),
        sample: false,
        people: vec![Person {
            id: person.clone(),
            name: "Sam".to_string(),
            birth,
            // Far enough out that every period here is a working one.
            retirement: YearMonth::new(2051, 1),
            // The horizon ends in January, which is exclusive — so the last
            // period is `last_year`.
            life_expectancy_age: (last_year + 1 - birth.year) as u8,
        }],
        accounts: vec![Account {
            id: "401k".to_string(),
            owner: person.clone(),
            kind: AccountKind::TraditionalPreTax,
            name: "401k".to_string(),
            balance: OPENING_BALANCE,
            cost_basis: None,
            allocation: bonds_only,
            plan_type: PlanType::EmployerPlan,
            contributions: vec![Contribution::until_retirement("c", rule, &person)],
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
                growth: GrowthRule::None,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "spending".to_string(),
                name: "Spending".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: SPENDING,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::None,
                survivor_percentage: None,
            },
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::from([(AssetClass::UsBonds, RETURN)]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 100,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start,
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn flat_contribution() -> ContributionRule {
    ContributionRule::FlatAmount {
        amount: CONTRIBUTION,
        growth: GrowthRule::None,
    }
}

#[track_caller]
fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

#[test]
fn a_september_plan_opens_with_a_four_month_stub_and_then_whole_years() {
    let plan = working_plan(YearMonth::new(2026, 9), 2029, flat_contribution());
    let projection = run_with_flat_tax(&plan, 0.20);

    let starts: Vec<YearMonth> = projection
        .snapshots
        .iter()
        .map(|s| s.period_start)
        .collect();
    assert_eq!(
        starts,
        vec![
            YearMonth::new(2026, 9),
            YearMonth::new(2027, 1),
            YearMonth::new(2028, 1),
            YearMonth::new(2029, 1),
        ],
        "period 0 starts where the plan does; every later period starts in January"
    );

    // Every flow in the stub is a third of the annual figure.
    let stub = &projection.snapshots[0];
    assert_close(stub.income, SALARY * STUB, "stub income");
    assert_close(stub.expenses, SPENDING * STUB, "stub expenses");
    assert_close(stub.contributions, CONTRIBUTION * STUB, "stub contribution");
    assert_close(
        stub.taxes,
        (SALARY - CONTRIBUTION) * 0.20 * STUB,
        "stub tax",
    );
    assert_close(stub.surplus, 0.0, "stub surplus");
    assert_close(stub.deflator, 1.0, "stub deflator");
    assert_close(
        stub.required_distributions,
        0.0,
        "no required distribution in period 0",
    );

    // Four months of growth on the post-flow balance, not twelve.
    let post_flow = OPENING_BALANCE + CONTRIBUTION * STUB;
    let stub_growth = post_flow * ((1.0 + RETURN).powf(STUB) - 1.0);
    assert_close(stub.growth, stub_growth, "stub growth");
    assert_close(stub.net_worth, post_flow + stub_growth, "stub net worth");

    // The next period is an ordinary calendar year: whole flows, whole
    // growth, and a deflator that has moved by a third of a year's
    // inflation (zero here, by construction).
    let full = &projection.snapshots[1];
    assert_close(full.income, SALARY, "2027 income");
    assert_close(full.expenses, SPENDING, "2027 expenses");
    assert_close(full.contributions, CONTRIBUTION, "2027 contribution");
    assert_close(full.taxes, (SALARY - CONTRIBUTION) * 0.20, "2027 tax");
    let post_flow = stub.net_worth + CONTRIBUTION;
    assert_close(full.growth, post_flow * RETURN, "2027 growth");
}

/// The same plan started in January is the projection this app has always
/// produced: no stub, and the first period is a whole year.
#[test]
fn a_january_plan_has_no_stub() {
    let plan = working_plan(YearMonth::new(2026, 1), 2029, flat_contribution());
    let projection = run_with_flat_tax(&plan, 0.20);

    assert_eq!(projection.snapshots.len(), 4);
    let first = &projection.snapshots[0];
    assert_eq!(first.period_start, YearMonth::new(2026, 1));
    assert_close(first.income, SALARY, "first-year income");
    assert_close(
        first.growth,
        (OPENING_BALANCE + CONTRIBUTION) * RETURN,
        "a full year of growth",
    );
}

/// The statutory cap is an annual figure, so a stub period gets its share
/// of it — the same scaling the flows get.
#[test]
fn a_stub_period_caps_contributions_at_its_share_of_the_year() {
    let plan = working_plan(
        YearMonth::new(2026, 9),
        2027,
        ContributionRule::FederalMaximum,
    );
    let projection = run_with_flat_tax(&plan, 0.20);

    let limit = |year: i32| {
        CONTRIBUTION_LIMITS
            .annual_limit(PlanType::EmployerPlan, year - 1986, year, 0.0)
            .expect("employer plans have a limit")
    };
    assert_close(
        projection.snapshots[0].contributions,
        limit(2026) * STUB,
        "stub contribution is 4/12 of the 2026 limit",
    );
    assert_close(
        projection.snapshots[1].contributions,
        limit(2027),
        "2027 gets the whole 2027 limit",
    );
    assert!(
        projection.warnings.is_empty(),
        "a cap scaled to the period is not a clamp: {:?}",
        projection.warnings
    );
}

/// A required distribution is computed on the *prior* period's closing
/// balance, so the stub takes none — there is no prior period — and the
/// first full year takes the whole annual figure rather than a share of it.
#[test]
fn the_stub_takes_no_required_distribution_and_the_next_year_takes_a_whole_one() {
    let person = "p1".to_string();
    let cash = AllocationRef::Cash(0.0);
    let plan = Plan {
        id: "rmd".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "rmd".to_string(),
        sample: false,
        people: vec![Person {
            id: person.clone(),
            name: "Pat".to_string(),
            birth: YearMonth::new(1950, 1),
            retirement: YearMonth::new(2015, 1),
            life_expectancy_age: 78,
        }],
        accounts: vec![
            Account {
                id: "ira".to_string(),
                owner: person.clone(),
                kind: AccountKind::TraditionalPreTax,
                name: "IRA".to_string(),
                balance: OPENING_BALANCE,
                cost_basis: None,
                allocation: cash.clone(),
                plan_type: PlanType::Ira,
                contributions: vec![],
                employer_match: None,
            },
            Account {
                id: "brokerage".to_string(),
                owner: person,
                kind: AccountKind::Taxable,
                name: "Brokerage".to_string(),
                balance: 0.0,
                cost_basis: Some(0.0),
                allocation: cash,
                plan_type: PlanType::None,
                contributions: vec![],
                employer_match: None,
            },
        ],
        streams: vec![],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::new(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 78,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: None,
        },
        sim_config: SimConfig {
            start: YearMonth::new(2026, 9),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    };
    let projection = run_with_flat_tax(&plan, 0.0);

    assert_close(
        projection.snapshots[0].required_distributions,
        0.0,
        "no prior balance, no distribution",
    );
    // Age attained during 2027 is 77; the divisor is the Uniform Lifetime
    // Table's, applied to the stub's closing balance in full.
    let divisor = uniform_lifetime_divisor(77).expect("77 is on the table");
    assert_close(
        projection.snapshots[1].required_distributions,
        OPENING_BALANCE / divisor,
        "a whole year's distribution in the first full year",
    );
}

/// **The stub period's tax is not scaled, and that is a decision.**
///
/// `BracketTax` applies annual brackets and the whole standard deduction to
/// whatever income the period holds, so four months of income meets an
/// entire year's deduction and pays a lower effective rate than the
/// household really pays on those months — in the world, they are part of a
/// full tax year. Scaling the thresholds would need the period's fraction
/// inside `TaxModel::tax`, which #105's struct-field approach does not
/// provide. The figures are pinned here so the convention is a stated
/// choice rather than an oversight; see "Time conventions" in
/// `docs/ARCHITECTURE.md`.
#[test]
fn the_stub_periods_effective_tax_rate_is_below_the_full_years() {
    let mut plan = working_plan(YearMonth::new(2026, 9), 2027, flat_contribution());
    // Real brackets, not the flat rate the rest of this file uses.
    let projection = run_deterministic(&plan);
    let stub = &projection.snapshots[0];
    let full = &projection.snapshots[1];

    let stub_rate = stub.taxes / stub.income;
    let full_rate = full.taxes / full.income;
    assert!(
        stub_rate < full_rate,
        "stub effective rate {stub_rate} should be below the full year's {full_rate}"
    );
    // The size of the convention, stated. On $40,000 of stub income the
    // bill is $2,191.50 — 5.5% — because the whole standard deduction and
    // the bottom brackets meet four months of income; the full year pays
    // $15,209 on $120,000, 12.7%. A third of the full-year bill would be
    // $5,069.67, so the stub is $2,878.17 light, and the household will in
    // reality pay something near that on the months this plan begins in.
    assert_close(stub.taxes, 2_191.50, "stub bill");
    assert_close(full.taxes, 15_209.00, "full-year bill");
    assert_close(
        full.taxes * STUB - stub.taxes,
        2_878.1666666666665,
        "what the convention leaves untaxed",
    );

    // Started in January instead, the same household pays the full-year
    // rate in its first period — the convention costs nothing there.
    plan.sim_config.start = YearMonth::new(2026, 1);
    let january = run_deterministic(&plan);
    assert_close(
        january.snapshots[0].taxes / january.snapshots[0].income,
        full_rate,
        "a January plan's first period is an ordinary tax year",
    );
}

/// The example household is dated from the day it is loaded, and the engine
/// projects it from there — the whole point of the adapter setting its start
/// (see `storage::create_sample_plan`).
#[test]
fn the_seed_household_projects_from_any_start_month() {
    let mut plan = seed_plan();
    plan.sim_config.start = YearMonth::new(2029, 9);
    let projection = run_deterministic(&plan);

    let first = &projection.snapshots[0];
    assert_eq!(first.period_start, YearMonth::new(2029, 9));
    assert_eq!(
        projection.snapshots[1].period_start,
        YearMonth::new(2030, 1)
    );
    // Four months of household spending, not twelve.
    let full_year_spending = projection.snapshots[1].expenses;
    assert!(
        (first.expenses / full_year_spending - STUB).abs() < 0.02,
        "stub expenses {} against a full year's {full_year_spending}",
        first.expenses
    );
}
