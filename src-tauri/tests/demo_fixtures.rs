//! The committed demo household, and the scenarios branched from it.
//!
//! These exist so the app can be run — for screenshots, for a first look,
//! for a bug report — against plausible data that is nobody's real
//! finances. `RETIREMENT_DATA_DIR` points a run at a copy of them; see
//! `settings::DATA_ROOT_ENV`.
//!
//! The plans are defined here in Rust and the YAML under `fixtures/demo/`
//! is generated from them, so the fixtures cannot drift from the schema
//! without this test failing. To re-generate after an intentional schema
//! change:
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures
//! ```
//!
//! PRIVACY: everything in this file is invented. Keep it that way — it is
//! the only plan data in the repository, and it is public.

use engine::model::PeriodLength;
use engine::model::{
    Account, AccountKind, AllocationRef, CashFlowStream, Contribution, ContributionRule,
    EmployerMatch, FilingStatus, GrowthRule, MatchDestination, MatchTier, Person, Plan, PlanType,
    SimConfig, SocialSecurityBenefit, StateCode, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::presets::{default_assumptions, presets};
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/demo")
}

const ALEX: &str = "alex";
const JORDAN: &str = "jordan";

fn tiered_match(tiers: &[(f64, f64)], destination: MatchDestination) -> EmployerMatch {
    EmployerMatch {
        tiers: tiers
            .iter()
            .map(|(employee_percent, match_percent)| MatchTier {
                employee_percent: *employee_percent,
                match_percent: *match_percent,
            })
            .collect(),
        destination,
    }
}

/// A two-earner household a decade or so out from retiring, with enough
/// going on to exercise the parts of the app worth looking at: an employer
/// match, a pre-Medicare healthcare bridge, a survivor pension, spending
/// that steps down at retirement, and pre-tax balances large enough that
/// RMDs eventually bite.
fn demo_base() -> Plan {
    let mut assumptions = default_assumptions();
    assumptions.filing_status = FilingStatus::MarriedFilingJointly;
    assumptions.state_tax = presets()
        .state_tax_profiles
        .get(&StateCode::Colorado)
        .cloned()
        .expect("Colorado has a bundled state tax profile");
    // The survivor keeps the house and the utilities but not two of
    // everything.
    assumptions.survivor_expense_factor = 0.75;
    // Surplus is real money only once income is fixed — see the field docs
    // on `sweep_surplus_from`.
    assumptions.sweep_surplus_from = Some(StreamBoundary::AtRetirement(ALEX.to_string()));
    assumptions.reinvest_into = Some("joint-brokerage".to_string());

    Plan {
        id: "base-plan".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "Base plan".to_string(),
        people: vec![
            Person {
                id: ALEX.to_string(),
                name: "Alex".to_string(),
                birth: YearMonth::new(1979, 4),
                retirement: YearMonth::new(2042, 4),
                life_expectancy_age: 88,
            },
            Person {
                id: JORDAN.to_string(),
                name: "Jordan".to_string(),
                birth: YearMonth::new(1981, 9),
                retirement: YearMonth::new(2044, 9),
                life_expectancy_age: 91,
            },
        ],
        accounts: vec![
            Account {
                id: "joint-brokerage".to_string(),
                owner: ALEX.to_string(),
                kind: AccountKind::Taxable,
                name: "Joint brokerage".to_string(),
                balance: 120_000.0,
                cost_basis: Some(88_000.0),
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::None,
                contributions: vec![Contribution::until_retirement(
                    "joint-brokerage-contribution",
                    ContributionRule::FlatAmount { amount: 6_000.0 },
                    &ALEX.to_string(),
                )],
                employer_match: None,
            },
            Account {
                id: "alex-401k".to_string(),
                owner: ALEX.to_string(),
                kind: AccountKind::TraditionalPreTax,
                name: "Alex 401(k)".to_string(),
                balance: 340_000.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::EmployerPlan,
                contributions: vec![Contribution::until_retirement(
                    "alex-401k-contribution",
                    ContributionRule::PercentOfSalary { percent: 0.10 },
                    &ALEX.to_string(),
                )],
                // "100% of the first 3%, then 50% of the next 2%."
                employer_match: Some(tiered_match(
                    &[(0.03, 1.0), (0.02, 0.5)],
                    MatchDestination::PreTax,
                )),
            },
            Account {
                id: "jordan-403b".to_string(),
                owner: JORDAN.to_string(),
                kind: AccountKind::TraditionalPreTax,
                name: "Jordan 403(b)".to_string(),
                balance: 210_000.0,
                cost_basis: None,
                allocation: AllocationRef::Moderate,
                plan_type: PlanType::EmployerPlan,
                contributions: vec![Contribution::until_retirement(
                    "jordan-403b-contribution",
                    ContributionRule::PercentOfSalary { percent: 0.08 },
                    &JORDAN.to_string(),
                )],
                employer_match: Some(tiered_match(&[(0.04, 0.5)], MatchDestination::PreTax)),
            },
            Account {
                id: "jordan-roth-ira".to_string(),
                owner: JORDAN.to_string(),
                kind: AccountKind::Roth,
                name: "Jordan Roth IRA".to_string(),
                balance: 65_000.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::Ira,
                contributions: vec![Contribution::until_retirement(
                    "jordan-roth-ira-contribution",
                    ContributionRule::FederalMaximum,
                    &JORDAN.to_string(),
                )],
                employer_match: None,
            },
            Account {
                id: "alex-hsa".to_string(),
                owner: ALEX.to_string(),
                kind: AccountKind::Hsa,
                name: "Alex HSA".to_string(),
                balance: 18_000.0,
                cost_basis: None,
                allocation: AllocationRef::Moderate,
                plan_type: PlanType::Hsa,
                contributions: vec![Contribution::until_retirement(
                    "alex-hsa-contribution",
                    ContributionRule::FederalMaximum,
                    &ALEX.to_string(),
                )],
                employer_match: None,
            },
            Account {
                id: "emergency-savings".to_string(),
                owner: JORDAN.to_string(),
                kind: AccountKind::Savings,
                name: "Emergency savings".to_string(),
                balance: 35_000.0,
                cost_basis: None,
                allocation: AllocationRef::Conservative,
                plan_type: PlanType::None,
                contributions: vec![Contribution::until_retirement(
                    "emergency-savings-contribution",
                    ContributionRule::FlatAmount { amount: 0.0 },
                    &JORDAN.to_string(),
                )],
                employer_match: None,
            },
        ],
        streams: vec![
            CashFlowStream {
                id: "alex-salary".to_string(),
                name: "Alex salary".to_string(),
                owner: Some(ALEX.to_string()),
                direction: StreamDirection::Income,
                annual_amount: 145_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(ALEX.to_string()),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "jordan-salary".to_string(),
                name: "Jordan salary".to_string(),
                owner: Some(JORDAN.to_string()),
                direction: StreamDirection::Income,
                annual_amount: 105_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(JORDAN.to_string()),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            // Spending is two streams, not one, so a scenario can change
            // retirement spending without rewriting the working years.
            CashFlowStream {
                id: "spending-working".to_string(),
                name: "Household spending (working)".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 150_000.0,
                start: StreamBoundary::PlanStart,
                end: StreamBoundary::AtRetirement(ALEX.to_string()),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "spending-retired".to_string(),
                name: "Household spending (retired)".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 145_000.0,
                start: StreamBoundary::AtRetirement(ALEX.to_string()),
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            // The gap between retiring and Medicare at 65, which is the
            // expense that most often decides whether retiring early works.
            CashFlowStream {
                id: "healthcare-bridge".to_string(),
                name: "Pre-Medicare health insurance".to_string(),
                owner: None,
                direction: StreamDirection::Expense,
                annual_amount: 26_000.0,
                start: StreamBoundary::AtRetirement(ALEX.to_string()),
                end: StreamBoundary::Date(YearMonth::new(2044, 4)),
                growth: GrowthRule::Inflation,
                survivor_percentage: None,
            },
            CashFlowStream {
                id: "jordan-pension".to_string(),
                name: "Jordan pension".to_string(),
                owner: Some(JORDAN.to_string()),
                direction: StreamDirection::Income,
                annual_amount: 18_000.0,
                start: StreamBoundary::AtRetirement(JORDAN.to_string()),
                end: StreamBoundary::PlanEnd,
                growth: GrowthRule::None,
                survivor_percentage: Some(0.5),
            },
        ],
        social_security: vec![
            SocialSecurityBenefit {
                id: "alex-social-security".to_string(),
                owner: ALEX.to_string(),
                benefit_at_fra: 42_000.0,
                full_retirement_age: 67,
                claiming_age: 70,
                cola_override: None,
            },
            SocialSecurityBenefit {
                id: "jordan-social-security".to_string(),
                owner: JORDAN.to_string(),
                benefit_at_fra: 34_000.0,
                full_retirement_age: 67,
                claiming_age: 67,
                cola_override: None,
            },
        ],
        assumptions,
        sim_config: SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        },
    }
}

fn stream_mut<'a>(plan: &'a mut Plan, id: &str) -> &'a mut CashFlowStream {
    plan.streams
        .iter_mut()
        .find(|s| s.id == id)
        .unwrap_or_else(|| panic!("demo base plan has a stream {id:?}"))
}

/// Every demo plan. The file each is written to is named by its id, because
/// that is what `storage` names a plan file.
fn demo_plans() -> Vec<Plan> {
    let base = demo_base();

    let mut retire_early = base.clone();
    retire_early.id = "retire-two-years-early".to_string();
    retire_early.name = "Retire two years early".to_string();
    retire_early.people[0].retirement = YearMonth::new(2040, 4);
    retire_early.people[1].retirement = YearMonth::new(2042, 9);

    let mut claim_early = base.clone();
    claim_early.id = "claim-social-security-at-62".to_string();
    claim_early.name = "Claim Social Security at 62".to_string();
    claim_early.social_security[0].claiming_age = 62;
    claim_early.social_security[1].claiming_age = 62;

    let mut leaner = base.clone();
    leaner.id = "leaner-retirement".to_string();
    leaner.name = "Leaner retirement spending".to_string();
    stream_mut(&mut leaner, "spending-retired").annual_amount = 120_000.0;

    vec![base, retire_early, claim_early, leaner]
}

#[test]
fn demo_fixtures_match_committed_yaml() {
    let dir = fixtures_dir();
    let update = std::env::var("UPDATE_FIXTURES").is_ok();
    if update {
        fs::create_dir_all(&dir).expect("creating fixtures dir");
    }

    for plan in demo_plans() {
        let path = dir.join(format!("{}.yaml", plan.id));
        let actual = serde_yaml_ng::to_string(&plan).expect("plan serializes to YAML");

        if update {
            fs::write(&path, &actual).expect("writing fixture");
            continue;
        }

        let expected = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "demo fixture {} missing ({e}) — regenerate with \
                 UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures",
                path.display()
            )
        });
        assert_eq!(
            actual,
            expected,
            "demo fixture {} is stale — regenerate with \
             UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures",
            path.display()
        );
    }
}

#[test]
fn committed_demo_fixtures_load_validate_and_simulate() {
    // Guards the thing that actually matters at runtime: that the app can
    // open these files. Reads the YAML from disk rather than the in-memory
    // plans, so a hand-edit to a fixture is caught too.
    for plan in demo_plans() {
        let path = fixtures_dir().join(format!("{}.yaml", plan.id));
        let yaml = fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!(
                "demo fixture {} missing — regenerate with \
                 UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures",
                path.display()
            )
        });

        let loaded: Plan = serde_yaml_ng::from_str(&yaml)
            .unwrap_or_else(|e| panic!("{} does not parse as a Plan: {e}", path.display()));

        let errors = loaded.validate();
        assert!(
            errors.is_empty(),
            "{} does not validate: {}",
            path.display(),
            errors
                .into_iter()
                .map(|e| e.message)
                .collect::<Vec<_>>()
                .join("; ")
        );

        let projection = engine::run_deterministic(&loaded);
        assert!(
            !projection.snapshots.is_empty(),
            "{} simulated to an empty projection",
            path.display()
        );
    }
}

#[test]
fn demo_plan_ids_are_unique() {
    let mut ids: Vec<String> = demo_plans().into_iter().map(|p| p.id).collect();
    ids.sort();
    let count = ids.len();
    ids.dedup();
    assert_eq!(
        count,
        ids.len(),
        "demo plan ids collide, so files overwrite"
    );
}
