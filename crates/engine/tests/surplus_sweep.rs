//! Where the surplus sweep starts (#50).
//!
//! Surplus is two different quantities either side of retirement: while the
//! household is working it is *current spending* (this app takes savings as
//! the input and leaves spending as the residual), and in retirement it is
//! cash genuinely left over. `Assumptions::sweep_surplus_from` is the
//! boundary between them, and these tests pin what it does at each of its
//! three settings — plus the migration from the boolean it replaced.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile,
    StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::strategies::{FixedReturns, FlatTax, ProportionalDrawdown};
use engine::{simulate, Projection, SimWarning};

/// Untaxed, no-growth arithmetic: the brokerage balance in any period is
/// exactly the sum of the surplus swept into it so far, so what the boundary
/// admits is readable off the balance with nothing else in the way. (Tax and
/// growth have their own coverage; mixing them in here would only obscure
/// the one thing this file is about.)
fn run(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(
        plan,
        &returns,
        &FlatTax { rate: 0.0 },
        &ProportionalDrawdown,
        0,
    )
}

/// Two earners retiring two years apart, into a household annuity that keeps
/// running afterward — so every period has surplus, and the only question is
/// which periods invest it.
///
/// Per-period surplus, with no tax, no contributions and no expenses:
///
/// | periods     | who is working | surplus |
/// |-------------|----------------|---------|
/// | 2026–2028   | both           | 130,000 |
/// | 2029–2030   | Later only     |  70,000 |
/// | 2031–2032   | nobody         |  30,000 |
fn staggered_household() -> Plan {
    let bonds_only = AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)]));
    let salary = |id: &str, owner: &str, amount: f64| CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: Some(owner.to_string()),
        direction: StreamDirection::Income,
        annual_amount: amount,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::AtRetirement(owner.to_string()),
        growth: GrowthRule::None,
        survivor_percentage: None,
    };
    Plan {
        id: "sweep".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "sweep".to_string(),
        people: vec![
            Person {
                id: "early".to_string(),
                name: "Early".to_string(),
                birth: YearMonth::new(1966, 1),
                retirement: YearMonth::new(2029, 1),
                // Both expectancies land in 2033-01: the plan runs seven
                // annual periods (2026..=2032) and has no survivor
                // transition to perturb the arithmetic above.
                life_expectancy_age: 67,
            },
            Person {
                id: "later".to_string(),
                name: "Later".to_string(),
                birth: YearMonth::new(1968, 1),
                retirement: YearMonth::new(2031, 1),
                life_expectancy_age: 65,
            },
        ],
        accounts: vec![Account {
            id: "brokerage".to_string(),
            owner: "early".to_string(),
            kind: AccountKind::Taxable,
            name: "Brokerage".to_string(),
            balance: 0.0,
            cost_basis: Some(0.0),
            allocation: bonds_only,
            plan_type: PlanType::None,
            contribution: ContributionRule::FlatAmount(0.0),
            employer_match: None,
        }],
        streams: vec![
            salary("early-salary", "early", 60_000.0),
            salary("later-salary", "later", 40_000.0),
            CashFlowStream {
                id: "annuity".to_string(),
                name: "Annuity".to_string(),
                owner: None,
                direction: StreamDirection::Income,
                annual_amount: 30_000.0,
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
            plan_end_age: 67,
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
            show_monte_carlo_band: false,
        },
    }
}

fn sweeping_from(boundary: Option<StreamBoundary>) -> Projection {
    let mut plan = staggered_household();
    plan.assumptions.sweep_surplus_from = boundary;
    run(&plan)
}

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

/// Balance and surplus for the period starting in January of `year`.
fn year_of(projection: &Projection, year: i32) -> (f64, f64) {
    let s = projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == year)
        .unwrap_or_else(|| panic!("no period starting in {year}"));
    (s.balances["brokerage"], s.surplus)
}

#[test]
fn a_retirement_boundary_invests_retirement_surplus_and_not_working_surplus() {
    let projection = sweeping_from(Some(StreamBoundary::AtRetirement("later".to_string())));

    // Working years: the surplus is what the household lives on. It is
    // reported, and it stays out of the portfolio.
    let (balance, surplus) = year_of(&projection, 2030);
    assert_close(surplus, 70_000.0, "2030 surplus");
    assert_close(balance, 0.0, "2030 brokerage");

    // From the boundary on, the same arithmetic is real leftover cash.
    let (balance, surplus) = year_of(&projection, 2031);
    assert_close(surplus, 30_000.0, "2031 surplus");
    assert_close(balance, 30_000.0, "2031 brokerage");
    let (balance, _) = year_of(&projection, 2032);
    assert_close(balance, 60_000.0, "2032 brokerage");

    assert!(
        projection.warnings.is_empty(),
        "unexpected warnings: {:?}",
        projection.warnings
    );
}

/// Whose retirement, exactly. With staggered dates the boundary has to
/// resolve to the person it names — not the household's first or last.
#[test]
fn the_boundary_follows_the_person_it_names() {
    let early = sweeping_from(Some(StreamBoundary::AtRetirement("early".to_string())));
    let later = sweeping_from(Some(StreamBoundary::AtRetirement("later".to_string())));

    // 2029 is Early's first retired year and one of Later's working ones.
    assert_close(year_of(&early, 2029).0, 70_000.0, "early's 2029 brokerage");
    assert_close(year_of(&later, 2029).0, 0.0, "later's 2029 brokerage");
    // By 2031 both are retired, and the two runs differ only by what the
    // earlier boundary already swept.
    assert_close(year_of(&early, 2031).0, 170_000.0, "early's 2031 brokerage");
    assert_close(year_of(&later, 2031).0, 30_000.0, "later's 2031 brokerage");
}

/// A retirement inside a period leaves that period part working, so its
/// surplus is part current spending. The sweep waits for the first period
/// that *begins* on or after the boundary rather than banking money the
/// household has already spent.
#[test]
fn a_mid_period_boundary_starts_the_sweep_at_the_next_period() {
    let mut plan = staggered_household();
    plan.people[1].retirement = YearMonth::new(2031, 7);
    plan.assumptions.sweep_surplus_from = Some(StreamBoundary::AtRetirement("later".to_string()));

    let projection = run(&plan);

    // Half a year of salary still lands in 2031, and none of it is swept.
    let (balance, surplus) = year_of(&projection, 2031);
    assert_close(surplus, 50_000.0, "2031 surplus");
    assert_close(balance, 0.0, "2031 brokerage");
    assert_close(year_of(&projection, 2032).0, 30_000.0, "2032 brokerage");
}

#[test]
fn plan_start_sweeps_every_period_and_none_sweeps_nothing() {
    let always = sweeping_from(Some(StreamBoundary::PlanStart));
    assert_close(year_of(&always, 2026).0, 130_000.0, "2026 brokerage");
    // 130k x 3 working years + 70k x 2 + 30k x 2.
    assert_close(year_of(&always, 2032).0, 590_000.0, "2032 brokerage");

    let never = sweeping_from(None);
    for snapshot in &never.snapshots {
        assert_close(
            snapshot.balances["brokerage"],
            0.0,
            "nothing is ever swept with no boundary",
        );
        assert!(snapshot.surplus > 0.0, "surplus is still reported");
    }
}

/// A plan saved before #50 carries the boolean. Both settings must project
/// exactly as they did then: `true` sweeping from plan start, `false`
/// sweeping nothing.
#[test]
fn legacy_plans_project_identically_after_migration() {
    let legacy_plan = |flag: bool| -> Plan {
        let mut value = serde_json::to_value(staggered_household()).expect("plan serializes");
        let assumptions = value["assumptions"].as_object_mut().unwrap();
        assumptions.remove("sweep_surplus_from");
        assumptions.insert("sweep_surplus_to_taxable".to_string(), flag.into());
        serde_json::from_value(value).expect("legacy plan parses")
    };
    let net_worth = |projection: &Projection| -> Vec<f64> {
        projection.snapshots.iter().map(|s| s.net_worth).collect()
    };

    assert_eq!(
        net_worth(&run(&legacy_plan(true))),
        net_worth(&sweeping_from(Some(StreamBoundary::PlanStart))),
        "`true` sweeps from plan start"
    );
    assert_eq!(
        net_worth(&run(&legacy_plan(false))),
        net_worth(&sweeping_from(None)),
        "`false` sweeps nothing"
    );
}

/// The boundary names someone who has since been deleted from the plan. The
/// fallback is "never", and it is reported: quietly sweeping from plan start
/// would pour years of working-phase spending into the portfolio.
#[test]
fn an_unresolvable_boundary_sweeps_nothing_and_says_so() {
    let projection = sweeping_from(Some(StreamBoundary::AtRetirement("ghost".to_string())));

    for snapshot in &projection.snapshots {
        assert_close(snapshot.balances["brokerage"], 0.0, "nothing is swept");
    }
    assert_eq!(
        projection.warnings,
        vec![SimWarning::SweepBoundaryUnresolved]
    );
}
