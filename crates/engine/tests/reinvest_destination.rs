//! Where reinvested cash lands (#58): `Assumptions::reinvest_into` names the
//! account that receives both the surplus sweep and any required minimum
//! distribution's after-tax remainder, replacing the implicit "first
//! `Taxable` account in plan order" every prior version used.
//!
//! Every fixture has two taxable accounts with different allocations, so a
//! wrong destination is visible in the numbers, not just in which balance
//! moved.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, AssetClass, Assumptions, CashFlowStream, ContributionRule,
    FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile,
    StreamBoundary, StreamDirection, YearMonth, SCHEMA_VERSION,
};
use engine::run_deterministic;

const START_YEAR: i32 = 2026;

fn bonds() -> AllocationRef {
    AllocationRef::Custom(BTreeMap::from([(AssetClass::UsBonds, 1.0)]))
}

fn equity() -> AllocationRef {
    AllocationRef::Custom(BTreeMap::from([(AssetClass::UsEquity, 1.0)]))
}

fn taxable(id: &str, allocation: AllocationRef) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind: AccountKind::Taxable,
        name: id.to_string(),
        balance: 0.0,
        cost_basis: Some(0.0),
        allocation,
        plan_type: PlanType::None,
        contribution: ContributionRule::FlatAmount(0.0),
        employer_match: None,
    }
}

fn pretax(id: &str, balance: f64) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind: AccountKind::TraditionalPreTax,
        name: id.to_string(),
        balance,
        cost_basis: None,
        allocation: bonds(),
        plan_type: PlanType::EmployerPlan,
        contribution: ContributionRule::FlatAmount(0.0),
        employer_match: None,
    }
}

fn stream(id: &str, direction: StreamDirection, amount: f64) -> CashFlowStream {
    CashFlowStream {
        id: id.to_string(),
        name: id.to_string(),
        owner: match direction {
            StreamDirection::Income => Some("p1".to_string()),
            StreamDirection::Expense => None,
        },
        direction,
        annual_amount: amount,
        start: StreamBoundary::PlanStart,
        end: StreamBoundary::PlanEnd,
        growth: GrowthRule::None,
        survivor_percentage: None,
    }
}

/// A single retiree, already retired, whose pension comfortably covers
/// spending — so every period sweeps a surplus — plus a $1,000,000 pre-tax
/// balance that starts forcing RMDs once they turn 75 in 2027 (born 1952).
/// `accounts` lists whatever taxable/pre-tax accounts the test wants, in
/// whatever order it wants to prove doesn't matter.
fn plan(accounts: Vec<Account>, sweep_from_start: bool, reinvest_into: Option<&str>) -> Plan {
    Plan {
        id: "reinvest".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "reinvest".to_string(),
        people: vec![Person {
            id: "p1".to_string(),
            name: "Retiree".to_string(),
            birth: YearMonth::new(1952, 1),
            retirement: YearMonth::new(START_YEAR - 1, 1),
            life_expectancy_age: 90,
        }],
        accounts,
        streams: vec![
            stream("pension", StreamDirection::Income, 100_000.0),
            stream("spending", StreamDirection::Expense, 60_000.0),
        ],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.0,
            asset_returns: BTreeMap::from([
                (AssetClass::UsBonds, 0.0),
                (AssetClass::UsEquity, 0.08),
            ]),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: 90,
            sweep_surplus_from: if sweep_from_start {
                Some(StreamBoundary::PlanStart)
            } else {
                None
            },
            survivor_expense_factor: 1.0,
            social_security_cola: 0.0,
            asset_volatility: BTreeMap::new(),
            reinvest_into: reinvest_into.map(str::to_string),
        },
        sim_config: SimConfig {
            start: YearMonth::new(START_YEAR, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
            show_monte_carlo_band: false,
        },
    }
}

fn balance_in(projection: &engine::Projection, year: i32, account: &str) -> f64 {
    projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == year)
        .unwrap_or_else(|| panic!("no snapshot for {year}"))
        .balances[account]
}

/// The headline case: naming a destination with a different allocation than
/// the default first-listed taxable account visibly changes the projection.
#[test]
fn a_named_destination_receives_the_sweep_and_the_projection_differs() {
    let accounts = || {
        vec![
            pretax("401k", 0.0),
            taxable("brokerage_a", bonds()),
            taxable("brokerage_b", equity()),
        ]
    };

    let default = run_deterministic(&plan(accounts(), true, None));
    let named = run_deterministic(&plan(accounts(), true, Some("brokerage_b")));

    // The default (unset) destination is the first taxable account in plan
    // order: brokerage_a. Every dollar swept lands there, none in b.
    assert_eq!(balance_in(&default, START_YEAR, "brokerage_b"), 0.0);
    assert!(balance_in(&default, START_YEAR, "brokerage_a") > 0.0);

    // Naming brokerage_b routes the same cash there instead.
    assert_eq!(balance_in(&named, START_YEAR, "brokerage_a"), 0.0);
    assert!(balance_in(&named, START_YEAR, "brokerage_b") > 0.0);

    // brokerage_b compounds at 8%, brokerage_a at 0% — a few years in, the
    // two runs' net worth has to have diverged, not just moved the same
    // dollars to a different bucket.
    let net_worth = |p: &engine::Projection, year: i32| {
        p.snapshots
            .iter()
            .find(|s| s.period_start.year == year)
            .unwrap()
            .net_worth
    };
    assert!(
        net_worth(&named, 2031) > net_worth(&default, 2031),
        "the equity-allocated destination must compound to more: {} vs {}",
        net_worth(&named, 2031),
        net_worth(&default, 2031)
    );
}

/// The RMD remainder follows the same named destination as the sweep — not
/// the first taxable account in plan order, which here is a different one.
/// Both taxable accounts hold bonds at 0% here so the reinvested dollars
/// don't grow within the same period, keeping the balance an exact readout
/// of what was deposited — allocation divergence is `a_named_destination_*`'s
/// job, not this test's.
#[test]
fn the_rmd_remainder_lands_in_the_named_account_not_the_first_one() {
    let accounts = vec![
        pretax("401k", 1_000_000.0),
        // Listed first, but not named — must receive nothing.
        taxable("first_listed", bonds()),
        taxable("named", bonds()),
    ];
    // Sweep off: isolates the RMD remainder as the only source of
    // reinvested cash, exactly like `required_distributions.rs`'s
    // money-destruction regression.
    let projection = run_deterministic(&plan(accounts, false, Some("named")));

    let s = projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == 2027)
        .expect("2027 has a prior balance to force a distribution from");
    assert!(s.required_distributions > 0.0, "the fixture must force one");
    assert_eq!(
        s.balances["first_listed"], 0.0,
        "the un-named first-listed taxable account gets nothing"
    );
    assert_eq!(
        s.balances["named"], s.required_distributions,
        "the named account receives exactly the remainder"
    );
}

/// A plan that leaves the destination unset must project identically to one
/// that explicitly names the first taxable account in plan order — the
/// contract that makes `None` a no-op for every plan saved before this field
/// existed.
#[test]
fn unset_projects_identically_to_naming_the_first_taxable_account() {
    let accounts = || {
        vec![
            pretax("401k", 1_000_000.0),
            taxable("first", bonds()),
            taxable("second", equity()),
        ]
    };
    let unset = run_deterministic(&plan(accounts(), true, None));
    let named_first = run_deterministic(&plan(accounts(), true, Some("first")));

    let net_worth =
        |p: &engine::Projection| -> Vec<f64> { p.snapshots.iter().map(|s| s.net_worth).collect() };
    assert_eq!(net_worth(&unset), net_worth(&named_first));
}

/// The regression the field exists to prevent: once a destination is named,
/// reordering `accounts` must change nothing about the projection.
#[test]
fn reordering_accounts_changes_nothing_once_a_destination_is_named() {
    let forward = vec![
        pretax("401k", 1_000_000.0),
        taxable("brokerage_a", bonds()),
        taxable("brokerage_b", equity()),
    ];
    let reversed = vec![
        pretax("401k", 1_000_000.0),
        taxable("brokerage_b", equity()),
        taxable("brokerage_a", bonds()),
    ];

    let a = run_deterministic(&plan(forward, true, Some("brokerage_b")));
    let b = run_deterministic(&plan(reversed, true, Some("brokerage_b")));

    let net_worth =
        |p: &engine::Projection| -> Vec<f64> { p.snapshots.iter().map(|s| s.net_worth).collect() };
    assert_eq!(net_worth(&a), net_worth(&b));

    // Not just the total — the per-account split has to match too.
    for year in [2026, 2028, 2030] {
        assert_eq!(
            balance_in(&a, year, "brokerage_a"),
            balance_in(&b, year, "brokerage_a"),
        );
        assert_eq!(
            balance_in(&a, year, "brokerage_b"),
            balance_in(&b, year, "brokerage_b"),
        );
    }
}
