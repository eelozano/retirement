//! HSA coverage (#150): a self-only HSA (`PlanType::Hsa`) is held to its
//! own per-person limit, a family-coverage HSA (`PlanType::HsaFamily`) to
//! the family limit — which the household's family-coverage HSAs share —
//! and the age-55 catch-up stays per person under both.

use engine::model::TaxFigures;
use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    StateTaxProfile, StrategyRates, StreamBoundary, StreamDirection, StreamKind, YearMonth,
    SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection, SimWarning};

const INFLATION: f64 = 0.025;
const START_YEAR: i32 = 2026;

/// Two earners: `young` is 46 in 2026, `older` turns 55 that year.
fn person(id: &str, birth_year: i32) -> Person {
    Person {
        id: id.to_string(),
        name: id.to_string(),
        birth: YearMonth::new(birth_year, 1),
        retirement: YearMonth::new(2040, 1),
        life_expectancy_age: 90,
    }
}

fn salary(owner: &str) -> CashFlowStream {
    CashFlowStream {
        id: format!("{owner}-salary"),
        name: "Salary".to_string(),
        owner: Some(owner.to_string()),
        direction: StreamDirection::Income,
        annual_amount: 150_000.0,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::AtRetirement(owner.to_string()),
        growth: GrowthRule::Inflation,
        survivor_percentage: None,
        kind: StreamKind::General,
    }
}

fn hsa(id: &str, owner: &str, plan_type: PlanType, rule: ContributionRule) -> Account {
    Account {
        id: id.to_string(),
        owner: owner.to_string(),
        kind: AccountKind::Hsa,
        name: id.to_string(),
        balance: 0.0,
        cost_basis: None,
        allocation: AllocationRef::FixedRate(0.05),
        plan_type,
        contributions: vec![Contribution::until_retirement(
            "contribution",
            rule,
            &owner.to_string(),
        )],
        one_time_contributions: vec![],
        employer_match: None,
        rule_of_55: false,
    }
}

fn plan(accounts: Vec<Account>) -> Plan {
    Plan {
        id: "hsa-coverage".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "hsa-coverage".to_string(),
        sample: false,
        people: vec![person("young", 1980), person("older", 1971)],
        accounts,
        streams: vec![salary("young"), salary("older")],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: INFLATION,
            strategy_returns: StrategyRates {
                very_aggressive: 0.05,
                aggressive: 0.05,
                moderate: 0.05,
                conservative: 0.05,
                very_conservative: 0.05,
            },
            filing_status: FilingStatus::MarriedFilingJointly,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 90,
            sweep_surplus_from: None,
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            social_security_reduction: None,
            strategy_volatility: Default::default(),
            reinvest_into: None,
            drawdown: Default::default(),
            dividend_yield: 0.0,
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
        &plan.assumptions.strategy_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &TaxFigures::built_in(),
        &returns,
        &FlatTax { rate: 0.2 },
        &ProportionalDrawdown,
        0,
    )
}

/// What `account` received in the plan's first year.
fn first_year(projection: &Projection, account: &str) -> f64 {
    projection.snapshots[0].contributions_by_account[account]
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

#[test]
fn the_2026_figures_are_rev_proc_2025_19() {
    let figures = TaxFigures::built_in();
    assert_eq!(figures.tax_year, 2026);
    let limit = |plan_type, age| {
        figures
            .annual_limit(plan_type, age, 2026, INFLATION)
            .unwrap()
    };
    assert_eq!(limit(PlanType::Hsa, 46), 4_400.0, "self-only");
    assert_eq!(limit(PlanType::HsaFamily, 46), 8_750.0, "family");
    assert_eq!(limit(PlanType::Hsa, 55) - limit(PlanType::Hsa, 46), 1_000.0);
    assert_eq!(
        limit(PlanType::HsaFamily, 55) - limit(PlanType::HsaFamily, 46),
        1_000.0,
        "the catch-up is the same under family coverage",
    );
}

#[test]
fn family_coverage_at_the_federal_maximum_contributes_the_family_limit() {
    let projection = run(&plan(vec![
        hsa(
            "young-hsa",
            "young",
            PlanType::HsaFamily,
            ContributionRule::FederalMaximum,
        ),
        hsa(
            "older-hsa",
            "older",
            PlanType::HsaFamily,
            ContributionRule::FlatAmount {
                amount: 0.0,
                growth: GrowthRule::None,
            },
        ),
    ]));
    assert_close(first_year(&projection, "young-hsa"), 8_750.0, "under 55");

    let projection = run(&plan(vec![hsa(
        "older-hsa",
        "older",
        PlanType::HsaFamily,
        ContributionRule::FederalMaximum,
    )]));
    assert_close(first_year(&projection, "older-hsa"), 9_750.0, "at 55");
}

/// The family limit is the household's: two spouses' family HSAs share one
/// figure, and only the catch-up is each person's own.
#[test]
fn two_family_hsas_share_one_family_limit_and_keep_their_own_catch_ups() {
    let projection = run(&plan(vec![
        hsa(
            "young-hsa",
            "young",
            PlanType::HsaFamily,
            ContributionRule::FederalMaximum,
        ),
        hsa(
            "older-hsa",
            "older",
            PlanType::HsaFamily,
            ContributionRule::FederalMaximum,
        ),
    ]));
    // Plan order: the first account fills the shared figure, the second is
    // left only its owner's catch-up — and is told so.
    assert_close(first_year(&projection, "young-hsa"), 8_750.0, "first");
    assert_close(first_year(&projection, "older-hsa"), 1_000.0, "second");
    assert!(projection.warnings.iter().any(|w| matches!(
        w,
        SimWarning::ContributionClamped { account, .. } if account == "older-hsa"
    )));
}

/// An account spends its owner's catch-up before the shared figure, which
/// leaves the other spouse the most room.
#[test]
fn a_family_hsa_uses_its_own_catch_up_before_the_shared_limit() {
    let flat = |amount| ContributionRule::FlatAmount {
        amount,
        growth: GrowthRule::None,
    };
    let projection = run(&plan(vec![
        hsa("older-hsa", "older", PlanType::HsaFamily, flat(5_000.0)),
        hsa("young-hsa", "young", PlanType::HsaFamily, flat(5_000.0)),
    ]));
    assert_close(first_year(&projection, "older-hsa"), 5_000.0, "older");
    // $4,000 of the older spouse's $5,000 came from the shared $8,750.
    assert_close(first_year(&projection, "young-hsa"), 4_750.0, "younger");
}

/// Self-only coverage stays per person: two self-only HSAs each get the
/// full figure, as they always have.
#[test]
fn self_only_hsas_are_still_capped_per_person() {
    let projection = run(&plan(vec![
        hsa(
            "young-hsa",
            "young",
            PlanType::Hsa,
            ContributionRule::FederalMaximum,
        ),
        hsa(
            "older-hsa",
            "older",
            PlanType::Hsa,
            ContributionRule::FederalMaximum,
        ),
    ]));
    assert_close(first_year(&projection, "young-hsa"), 4_400.0, "young");
    assert_close(first_year(&projection, "older-hsa"), 5_400.0, "older");
}

/// A plan saved before coverage existed says `plan_type: Hsa`, which still
/// means self-only — and a `tax-figures.yaml` written before `hsa_family`
/// existed still loads, rather than failing and falling back to the
/// built-in figures wholesale.
#[test]
fn a_plan_and_tax_figures_saved_before_family_coverage_project_as_before() {
    let mut yaml = serde_yaml_ng::to_string(&TaxFigures::built_in()).unwrap();
    yaml = yaml
        .lines()
        .filter(|line| !line.contains("hsa_family"))
        .collect::<Vec<_>>()
        .join("\n");
    let figures: TaxFigures = serde_yaml_ng::from_str(&yaml).unwrap();
    assert_eq!(figures, TaxFigures::built_in());

    let account: Account = serde_yaml_ng::from_str(
        "id: hsa\nowner: young\nkind: Hsa\nplan_type: Hsa\nname: HSA\nbalance: 0\n\
         allocation: Moderate\ncontributions:\n- id: c\n  rule: FederalMaximum\n  \
         start: PlanStart\n  end: !AtRetirement young\n",
    )
    .unwrap();
    assert_eq!(account.plan_type, PlanType::Hsa);
    let projection = run(&plan(vec![account]));
    assert_close(first_year(&projection, "hsa"), 4_400.0, "self-only");
}
