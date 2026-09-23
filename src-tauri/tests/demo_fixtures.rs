//! The committed demo household, and the scenarios branched from it.
//!
//! These exist so the app can be run — for screenshots, for a first look,
//! for a bug report — against plausible data that is nobody's real
//! finances. `RETIREMENT_DATA_DIR` points a run at a copy of them; see
//! `settings::DATA_ROOT_ENV`.
//!
//! The plans are defined here in Rust and the YAML under `fixtures/demo/`
//! is generated from them, so the fixtures cannot drift from the schema
//! without this test failing. Since #109 that is **one file**,
//! `demo-household.yaml`: one household's facts plus the six scenarios
//! branched from it, which is exactly what the split claims — the six
//! plans below differ only in retirement dates, claiming ages, a spending
//! amount, a house sale and a withdrawal order, and share every balance.
//! This test proves it, by decomposing all six and asserting the households
//! they produce agree.
//! To re-generate after an intentional schema change:
//!
//! ```text
//! UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures
//! ```
//!
//! PRIVACY: everything in this file is invented. Keep it that way — it is
//! the only plan data in the repository, and it is public.

use engine::model::PeriodLength;
use engine::model::{
    compose, decompose, empty_household, Account, AccountKind, AllocationRef, CashFlowStream,
    Contribution, ContributionRule, DrawdownPhase, DrawdownPolicy, EmployerMatch, FilingStatus,
    GrowthRule, Household, HouseholdFile, MatchDestination, MatchTier, OneTimeContribution, Person,
    PhaseStart, Plan, PlanType, SimConfig, SocialSecurityBenefit, StackEntry, StackSource,
    StateCode, StepUp, StreamBoundary, StreamDirection, StreamKind, YearMonth, SCHEMA_VERSION,
};
use engine::presets::{default_assumptions, presets};
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures/demo")
}

/// The one committed file. Named after the household rather than a
/// scenario, because that is what it holds — `storage` names a household
/// file by the household's id.
const HOUSEHOLD_ID: &str = "demo-household";
const HOUSEHOLD_NAME: &str = "Demo household";

fn fixture_path() -> PathBuf {
    fixtures_dir().join(format!("{HOUSEHOLD_ID}.yaml"))
}

const ALEX: &str = "alex";
const JORDAN: &str = "jordan";

fn tiered_match(tiers: &[(f64, f64)], destination: MatchDestination) -> EmployerMatch {
    EmployerMatch {
        nonelective_percent: 0.0,
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
/// RMDs eventually bite. Saving is dated and escalating too: a brokerage
/// transfer that goes up in 2027, a 401(k) that auto-escalates a point a
/// year, and a Roth IRA that does not open until 2029.
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
        // Invented, and committed to the repo — exactly what the flag is
        // for. See CLAUDE.md's privacy rule and `Plan::sample`.
        sample: true,
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
                // Two entries that overlap and sum: the $500/month standing
                // transfer they have now, plus the $700/month they add from
                // January 2027 once the car is paid off — $1,200/month from
                // then until Alex retires.
                contributions: vec![
                    Contribution::until_retirement(
                        "joint-brokerage-contribution",
                        ContributionRule::FlatAmount {
                            amount: 6_000.0,
                            growth: GrowthRule::None,
                        },
                        &ALEX.to_string(),
                    ),
                    Contribution {
                        id: "joint-brokerage-contribution-2027".to_string(),
                        name: "Car paid off".to_string(),
                        rule: ContributionRule::FlatAmount {
                            amount: 8_400.0,
                            growth: GrowthRule::None,
                        },
                        start: StreamBoundary::Date(YearMonth::new(2027, 1)),
                        end: StreamBoundary::AtRetirement(ALEX.to_string()),
                    },
                ],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
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
                // Auto-escalation, the way a plan document writes it:
                // 10% now, up a point each year, stopping at 15%.
                contributions: vec![Contribution::until_retirement(
                    "alex-401k-contribution",
                    ContributionRule::PercentOfSalary {
                        percent: 0.10,
                        step_up: Some(StepUp {
                            points_per_year: 0.01,
                            cap: 0.15,
                        }),
                    },
                    &ALEX.to_string(),
                )],
                one_time_contributions: vec![],
                // "100% of the first 3%, then 50% of the next 2%."
                employer_match: Some(tiered_match(
                    &[(0.03, 1.0), (0.02, 0.5)],
                    MatchDestination::PreTax,
                )),
                rule_of_55: false,
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
                    ContributionRule::PercentOfSalary {
                        percent: 0.08,
                        step_up: None,
                    },
                    &JORDAN.to_string(),
                )],
                one_time_contributions: vec![],
                employer_match: Some(tiered_match(&[(0.04, 0.5)], MatchDestination::PreTax)),
                rule_of_55: false,
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
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
            },
            // An account that does not exist yet: Alex opens a Roth IRA in
            // 2029, when the college bills are done, and funds it to the
            // maximum from then until retiring.
            Account {
                id: "alex-roth-ira".to_string(),
                owner: ALEX.to_string(),
                kind: AccountKind::Roth,
                name: "Alex Roth IRA".to_string(),
                balance: 0.0,
                cost_basis: None,
                allocation: AllocationRef::Aggressive,
                plan_type: PlanType::Ira,
                contributions: vec![Contribution {
                    id: "alex-roth-ira-contribution".to_string(),
                    name: String::new(),
                    rule: ContributionRule::FederalMaximum,
                    start: StreamBoundary::Date(YearMonth::new(2029, 1)),
                    end: StreamBoundary::AtRetirement(ALEX.to_string()),
                }],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
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
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
            },
            Account {
                id: "emergency-savings".to_string(),
                owner: JORDAN.to_string(),
                kind: AccountKind::Savings,
                name: "Emergency savings".to_string(),
                balance: 35_000.0,
                cost_basis: None,
                // An emergency fund earns a savings rate, not a market
                // return. It carried `Conservative` until #129, which meant
                // it earned *nothing*: `accrue_interest` wanted a cash rate
                // and `grow` skips every Savings account, so all $35k sat
                // flat through every screenshot this fixture has produced.
                allocation: AllocationRef::FixedRate(0.02),
                plan_type: PlanType::None,
                contributions: vec![Contribution::until_retirement(
                    "emergency-savings-contribution",
                    ContributionRule::FlatAmount {
                        amount: 0.0,
                        growth: GrowthRule::None,
                    },
                    &JORDAN.to_string(),
                )],
                one_time_contributions: vec![],
                employer_match: None,
                rule_of_55: false,
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
                kind: StreamKind::General,
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
                kind: StreamKind::General,
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
                kind: StreamKind::General,
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
                kind: StreamKind::General,
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
                kind: StreamKind::General,
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
                kind: StreamKind::Pension,
            },
        ],
        social_security: vec![
            SocialSecurityBenefit {
                id: "alex-social-security".to_string(),
                owner: ALEX.to_string(),
                benefit_at_fra: 42_000.0,
                // Derived from the birth year, which is how the app writes a
                // new benefit: Alex was born in 1979, so SSA's age is 67.
                full_retirement_age: None,
                claiming_age: 70,
                cola_override: None,
            },
            SocialSecurityBenefit {
                id: "jordan-social-security".to_string(),
                owner: JORDAN.to_string(),
                benefit_at_fra: 34_000.0,
                full_retirement_age: None,
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

    // Money from outside the plan: the house sells when Alex retires and
    // $350,000 in today's dollars lands in the brokerage. The house itself is
    // not modelled, so net worth jumps the year the sale lands.
    let mut sell_house = base.clone();
    sell_house.id = "sell-the-house-at-retirement".to_string();
    sell_house.name = "Sell the house at retirement".to_string();
    sell_house
        .accounts
        .iter_mut()
        .find(|a| a.id == "joint-brokerage")
        .expect("demo base plan has a joint brokerage")
        .one_time_contributions = vec![OneTimeContribution {
        id: "house-sale".to_string(),
        name: "House sale".to_string(),
        amount: 350_000.0,
        growth: GrowthRule::Inflation,
        date: StreamBoundary::AtRetirement(ALEX.to_string()),
    }];

    // Retiring before 59½, and the order that makes it work. Alex leaves
    // work in April 2034, the year he turns 55, so the Rule of 55 frees his
    // 401(k); Jordan leaves at 53, too early for it, so her 403(b) waits for
    // her 59½ in March 2041. Until then the household lives on the
    // brokerage and Alex's 401(k), and keeps $30,000 of emergency savings
    // back; from Jordan's 59½ on, the default order takes over.
    //
    // Eight years early at the base plan's $145,000 runs dry in the 2040s
    // whatever the order, so this scenario also spends $110,000 — enough to
    // last, which is what lets the order be the thing worth looking at. The
    // same dates drawn proportionally pay about $36,000 of penalties this
    // order avoids.
    let mut bridge = base.clone();
    bridge.id = "retire-at-55-on-a-bridge".to_string();
    bridge.name = "Retire at 55 on a bridge".to_string();
    bridge.people[0].retirement = YearMonth::new(2034, 4);
    bridge.people[1].retirement = YearMonth::new(2034, 9);
    stream_mut(&mut bridge, "spending-retired").annual_amount = 110_000.0;
    bridge
        .accounts
        .iter_mut()
        .find(|a| a.id == "alex-401k")
        .expect("demo base plan has Alex's 401(k)")
        .rule_of_55 = true;
    let entry = |id: &str, floor: f64| StackEntry {
        source: StackSource::Account(id.to_string()),
        floor,
    };
    bridge.assumptions.drawdown = DrawdownPolicy::Phased(vec![
        DrawdownPhase {
            id: "bridge".to_string(),
            name: "Bridge to 59½".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            stack: vec![
                entry("joint-brokerage", 0.0),
                entry("alex-401k", 0.0),
                entry("emergency-savings", 30_000.0),
            ],
        },
        DrawdownPhase {
            id: "standard".to_string(),
            name: "Standard".to_string(),
            start: PhaseStart::PenaltyFree(JORDAN.to_string()),
            stack: vec![],
        },
    ]);

    vec![base, retire_early, claim_early, leaner, sell_house, bridge]
}

/// The six plans, split into the one household they describe and the six
/// scenarios that differ. Every plan must decompose to the *same* household
/// — that is the claim #109 makes about this fixture, and asserting it here
/// is what keeps the claim true as the demo grows.
fn demo_household_file() -> HouseholdFile {
    let plans = demo_plans();
    let skeleton = empty_household(
        HOUSEHOLD_ID.to_string(),
        HOUSEHOLD_NAME.to_string(),
        plans[0].sim_config.start,
    );

    let mut household: Option<Household> = None;
    let mut scenarios = Vec::new();
    for plan in &plans {
        let (facts, scenario) = decompose(plan, &skeleton);
        match &household {
            None => household = Some(facts),
            Some(first) => assert_eq!(
                &facts, first,
                "scenario {:?} disagrees with the household about a fact — \
                 a balance is not a scenario variable (#109)",
                plan.id
            ),
        }
        scenarios.push(scenario);
    }

    HouseholdFile::new(household.expect("at least one demo plan"), scenarios)
}

#[test]
fn demo_fixtures_match_committed_yaml() {
    let dir = fixtures_dir();
    let update = std::env::var("UPDATE_FIXTURES").is_ok();
    if update {
        fs::create_dir_all(&dir).expect("creating fixtures dir");
    }

    let path = fixture_path();
    let actual =
        serde_yaml_ng::to_string(&demo_household_file()).expect("household serializes to YAML");

    if update {
        fs::write(&path, &actual).expect("writing fixture");
        // The four-files-per-household layout is gone; leave none behind.
        for plan in demo_plans() {
            let _ = fs::remove_file(dir.join(format!("{}.yaml", plan.id)));
        }
        return;
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

#[test]
fn committed_demo_fixture_loads_composes_validates_and_simulates() {
    // Guards the thing that actually matters at runtime: that the app can
    // open this file. Reads the YAML from disk rather than the in-memory
    // household, so a hand-edit to the fixture is caught too.
    let path = fixture_path();
    let yaml = fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "demo fixture {} missing — regenerate with \
             UPDATE_FIXTURES=1 cargo test -p retirement --test demo_fixtures",
            path.display()
        )
    });

    let file: HouseholdFile = serde_yaml_ng::from_str(&yaml)
        .unwrap_or_else(|e| panic!("{} does not parse as a household: {e}", path.display()));
    assert_eq!(file.schema_version, SCHEMA_VERSION);
    assert_eq!(file.scenarios.len(), demo_plans().len());

    for scenario in &file.scenarios {
        let plan = compose(&file.household(), scenario)
            .unwrap_or_else(|e| panic!("scenario {:?} does not compose: {e}", scenario.id));

        let errors = plan.validate();
        assert!(
            errors.is_empty(),
            "scenario {:?} does not validate: {}",
            scenario.id,
            errors
                .into_iter()
                .map(|e| e.message)
                .collect::<Vec<_>>()
                .join("; ")
        );

        let projection = engine::run_deterministic(&plan, &engine::model::TaxFigures::built_in());
        assert!(
            !projection.snapshots.is_empty(),
            "scenario {:?} simulated to an empty projection",
            scenario.id
        );
    }
}

/// Every scenario composes back to exactly the plan it was written as: the
/// split loses nothing.
#[test]
fn every_demo_scenario_round_trips_through_compose() {
    let file = demo_household_file();
    for plan in demo_plans() {
        let scenario = file
            .scenario(&plan.id)
            .unwrap_or_else(|| panic!("the household holds a scenario {:?}", plan.id));
        let composed = compose(&file.household(), scenario).expect("composes");
        assert_eq!(
            serde_yaml_ng::to_string(&composed).unwrap(),
            serde_yaml_ng::to_string(&plan).unwrap(),
            "scenario {:?} did not survive the round trip",
            plan.id
        );
    }
}

/// Seven accounts and six scenarios are seven balances, not forty-two.
#[test]
fn the_household_writes_each_balance_once() {
    let file = demo_household_file();
    assert_eq!(file.accounts.len(), 7);
    for account in &file.accounts {
        assert_eq!(
            account.observations.len(),
            1,
            "account {:?} carries more than the one reading it was written with",
            account.id
        );
    }
    // And no scenario holds a balance of its own: the policy maps carry
    // contributions and matches, and nothing else.
    let yaml = serde_yaml_ng::to_string(&file.scenarios).unwrap();
    assert!(!yaml.contains("balance"), "a scenario wrote down a balance");
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
        "demo scenario ids collide, so scenarios overwrite"
    );
}

fn golden_path() -> PathBuf {
    fixtures_dir().join("golden-projections.csv")
}

/// The deterministic projection of every committed demo scenario, one row
/// per period: net worth, the period's tax bill, the withdrawal gross-up's
/// share of it, the early-withdrawal penalty's share of that, and the gross
/// withdrawn from each account.
fn golden_projections() -> String {
    let yaml = fs::read_to_string(fixture_path()).expect("demo fixture present");
    let file: HouseholdFile = serde_yaml_ng::from_str(&yaml).expect("demo fixture parses");
    let figures = engine::model::TaxFigures::built_in();

    let accounts: Vec<String> = file.accounts.iter().map(|a| a.id.clone()).collect();
    let mut out = format!(
        "scenario,year,net_worth,taxes,withdrawal_taxes,early_withdrawal_penalty,{}\n",
        accounts
            .iter()
            .map(|id| format!("withdrawn:{id}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    for scenario in &file.scenarios {
        let plan = compose(&file.household(), scenario).expect("composes");
        let projection = engine::run_deterministic(&plan, &figures);
        for snapshot in &projection.snapshots {
            let withdrawn: Vec<String> = accounts
                .iter()
                .map(|id| {
                    format!(
                        "{:.6}",
                        snapshot.withdrawals.get(id).copied().unwrap_or(0.0)
                    )
                })
                .collect();
            out.push_str(&format!(
                "{},{},{:.6},{:.6},{:.6},{:.6},{}\n",
                scenario.id,
                snapshot.period_start.year,
                snapshot.net_worth,
                snapshot.taxes,
                snapshot.withdrawal_taxes,
                snapshot.early_withdrawal_penalty,
                withdrawn.join(",")
            ));
        }
    }
    out
}

/// An upgrade does not change a saved plan's projection (CLAUDE.md). The
/// committed demo scenarios are saved plans, so their projections are
/// pinned here: an engine change that moves them fails until it is made on
/// purpose.
///
/// Regenerated by its own variable rather than `UPDATE_FIXTURES`, so that
/// refreshing the fixture YAML after a schema change cannot quietly accept
/// a projection change along with it. When this moves, the PR body and the
/// release notes say by how much.
///
/// ```text
/// UPDATE_GOLDEN=1 cargo test -p retirement --test demo_fixtures
/// ```
#[test]
fn demo_projections_match_golden() {
    let path = golden_path();
    let actual = golden_projections();
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        fs::write(&path, &actual).expect("writing golden projections");
        return;
    }
    let expected = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "golden projections {} missing ({e}) — generate with \
             UPDATE_GOLDEN=1 cargo test -p retirement --test demo_fixtures",
            path.display()
        )
    });
    for (line, (actual, expected)) in actual.lines().zip(expected.lines()).enumerate() {
        assert!(
            same_row(actual, expected),
            "demo projection moved at line {} of {} — if that is intended, \
             regenerate with UPDATE_GOLDEN=1 and measure the change in the PR\n  \
             actual:   {actual}\n  expected: {expected}",
            line + 1,
            path.display()
        );
    }
    assert_eq!(
        actual.lines().count(),
        expected.lines().count(),
        "demo projection has a different number of periods than {}",
        path.display()
    );
}

/// Two golden rows agree when their text fields match and every figure is
/// within a part in a billion — the same tolerance, for the same reason, as
/// the engine's `tests/golden.rs`: `powf` is not correctly rounded, and
/// macOS and Linux disagree in the last bit of a mid-year plan's growth.
fn same_row(actual: &str, expected: &str) -> bool {
    let actual: Vec<&str> = actual.split(',').collect();
    let expected: Vec<&str> = expected.split(',').collect();
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(&expected)
            .all(|(a, e)| match (a.parse::<f64>(), e.parse::<f64>()) {
                (Ok(a), Ok(e)) => (a - e).abs() <= 1e-9 * e.abs().max(1.0),
                _ => a == e,
            })
}
