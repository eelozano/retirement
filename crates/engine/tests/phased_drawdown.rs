//! An ordered drawdown end to end: through the plan file, the period loop,
//! and Monte Carlo. The waterfall's own arithmetic is pinned by the unit
//! tests beside `strategies::PhasedDrawdown`.

use engine::model::{
    Account, AccountKind, AllocationRef, DrawdownPhase, DrawdownPolicy, FilingStatus, GrowthRule,
    Person, PhaseStart, Plan, PlanType, StackEntry, StackSource, StateTaxProfile, StreamBoundary,
    StreamDirection, TaxFigures, YearMonth,
};
use engine::presets::seed_plan;
use engine::strategies::{BracketTax, IncomeBreakdown, TaxModel};
use engine::{run_deterministic, run_monte_carlo, MonteCarloConfig, SimWarning};

fn with_stack(mut plan: Plan, stack: Vec<StackEntry>) -> Plan {
    plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
        id: "only".to_string(),
        name: "Only".to_string(),
        start: PhaseStart::Boundary(StreamBoundary::PlanStart),
        stack,
    }]);
    plan
}

fn account(id: &str, floor: f64) -> StackEntry {
    StackEntry {
        source: StackSource::Account(id.to_string()),
        floor,
    }
}

/// A plan written before drawdown order existed has no `drawdown` key, and
/// reads as the proportional drawdown it always had.
#[test]
fn a_plan_without_a_drawdown_key_loads_as_proportional() {
    let mut json = serde_json::to_value(seed_plan()).unwrap();
    json["assumptions"]
        .as_object_mut()
        .unwrap()
        .remove("drawdown")
        .expect("a current plan writes the key");
    let plan: Plan = serde_json::from_value(json).unwrap();
    assert_eq!(plan.assumptions.drawdown, DrawdownPolicy::Proportional);
}

/// A phased policy survives the round trip through the plan file.
#[test]
fn a_phased_policy_round_trips() {
    let plan = with_stack(seed_plan(), vec![account("taxable-brokerage", 25_000.0)]);
    let yaml = serde_yaml_ng::to_string(&plan).unwrap();
    let back: Plan = serde_yaml_ng::from_str(&yaml).unwrap();
    assert_eq!(back.assumptions.drawdown, plan.assumptions.drawdown);
}

/// With the brokerage at the top of the stack, the seed household's first
/// retired years are paid from it alone — where the proportional drawdown
/// took from all three accounts at once.
#[test]
fn the_stack_decides_which_accounts_pay() {
    let figures = TaxFigures::built_in();
    let phased = run_deterministic(
        &with_stack(seed_plan(), vec![account("taxable-brokerage", 0.0)]),
        &figures,
    );
    let first_draw = phased
        .snapshots
        .iter()
        .find(|s| s.withdrawals.values().any(|w| *w > 0.0))
        .expect("the seed plan draws down");
    let drawn: Vec<&String> = first_draw
        .withdrawals
        .iter()
        .filter(|(_, w)| **w > 0.0)
        .map(|(id, _)| id)
        .collect();
    assert_eq!(drawn, vec!["taxable-brokerage"]);
    assert_eq!(first_draw.early_withdrawal_penalty, 0.0);

    let proportional = run_deterministic(&seed_plan(), &figures);
    let same_year = &proportional.snapshots[first_draw.period];
    assert!(same_year.withdrawals.len() > 1);
}

/// A floor the household cannot keep is released and reported, not held
/// while the plan runs dry.
#[test]
fn an_unkeepable_floor_is_released_and_reported() {
    let mut plan = with_stack(
        seed_plan(),
        vec![account("taxable-brokerage", 1_000_000_000.0)],
    );
    // Spend enough that the plan runs out.
    for stream in &mut plan.streams {
        if stream.direction == StreamDirection::Expense {
            stream.annual_amount *= 3.0;
        }
    }
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert!(projection.warnings.iter().any(|w| matches!(
        w,
        SimWarning::FloorReleased { account, .. } if account == "taxable-brokerage"
    )));
    for snapshot in &projection.snapshots {
        for (id, balance) in &snapshot.balances {
            assert!(*balance >= 0.0, "{id} went negative in {}", snapshot.period);
        }
    }
}

/// Monte Carlo runs the plan's policy too.
#[test]
fn monte_carlo_runs_a_phased_plan() {
    let result = run_monte_carlo(
        &with_stack(seed_plan(), vec![account("taxable-brokerage", 0.0)]),
        &TaxFigures::built_in(),
        &MonteCarloConfig {
            n_paths: 50,
            seed: 7,
        },
    );
    assert!((0.0..=1.0).contains(&result.success_rate));
    assert_eq!(result.percentiles.len(), 58);
}

/// The household this feature was built for, with invented balances: one
/// spouse retires in the year they turn 55 and relies on the Rule of 55 for
/// their 403(b); the other retires at 51, and their 401(k) is not to be
/// touched until they reach 59½. A bridge phase draws the 403(b), and a
/// standard phase starting at the younger spouse's 59½ opens their 401(k).
///
/// Zero returns and inflation, so the only thing moving the balances is the
/// drawdown.
fn bridge_household() -> Plan {
    let person = |id: &str, birth: YearMonth| Person {
        id: id.to_string(),
        name: id.to_string(),
        birth,
        retirement: YearMonth::new(2026, 1),
        life_expectancy_age: 70,
    };
    let account = |id: &str, owner: &str, kind: AccountKind, plan_type, balance, basis| Account {
        id: id.to_string(),
        owner: owner.to_string(),
        kind,
        name: id.to_string(),
        balance,
        cost_basis: basis,
        allocation: AllocationRef::FixedRate(0.0),
        plan_type,
        contributions: vec![],
        one_time_contributions: vec![],
        employer_match: None,
        rule_of_55: false,
    };
    let mut his_403b = account(
        "his-403b",
        "him",
        AccountKind::TraditionalPreTax,
        PlanType::EmployerPlan,
        1_500_000.0,
        None,
    );
    his_403b.rule_of_55 = true;

    let mut plan = seed_plan();
    plan.people = vec![
        // Turns 55 in 2026: separating in January 2026 qualifies.
        person("him", YearMonth::new(1971, 6)),
        // 51 in 2026; 59½ in July 2034.
        person("her", YearMonth::new(1975, 1)),
    ];
    plan.accounts = vec![
        his_403b,
        account(
            "her-401k",
            "her",
            AccountKind::TraditionalPreTax,
            PlanType::EmployerPlan,
            800_000.0,
            None,
        ),
        account(
            "brokerage",
            "him",
            AccountKind::Taxable,
            PlanType::None,
            300_000.0,
            Some(300_000.0),
        ),
    ];
    plan.streams
        .retain(|s| s.direction == StreamDirection::Expense);
    for stream in &mut plan.streams {
        stream.owner = None;
        stream.start = StreamBoundary::PlanStart;
        stream.end = StreamBoundary::PlanEnd;
        stream.annual_amount = 90_000.0;
        stream.growth = GrowthRule::None;
    }
    plan.streams.truncate(1);
    plan.social_security = vec![];
    plan.sim_config.start = YearMonth::new(2026, 1);
    plan.assumptions.inflation = 0.0;
    plan.assumptions.filing_status = FilingStatus::MarriedFilingJointly;
    plan.assumptions.state_tax = StateTaxProfile::none();
    plan.assumptions.strategy_returns = Default::default();
    plan.assumptions.sweep_surplus_from = None;
    plan.assumptions.reinvest_into = None;
    plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![
        DrawdownPhase {
            id: "bridge".to_string(),
            name: "Bridge to 59½".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            stack: vec![account_entry("his-403b"), account_entry("brokerage")],
        },
        DrawdownPhase {
            id: "standard".to_string(),
            name: "Standard".to_string(),
            start: PhaseStart::PenaltyFree("her".to_string()),
            stack: vec![account_entry("her-401k"), account_entry("his-403b")],
        },
    ]);
    plan
}

fn account_entry(id: &str) -> StackEntry {
    account(id, 0.0)
}

#[test]
fn the_bridge_household_validates() {
    let errors = bridge_household().validate();
    assert!(errors.is_empty(), "{errors:?}");
}

/// Her 401(k) is untouched until the month she reaches 59½, is drawn from
/// then on — including the back half of the year she reaches it — and
/// nothing the household draws is ever penalized.
#[test]
fn the_bridge_leaves_her_401k_alone_until_59_and_a_half() {
    let projection = run_deterministic(&bridge_household(), &TaxFigures::built_in());
    let drawn =
        |s: &engine::PeriodSnapshot, id: &str| s.withdrawals.get(id).copied().unwrap_or(0.0);

    for snapshot in &projection.snapshots {
        let year = snapshot.period_start.year;
        assert_eq!(
            snapshot.early_withdrawal_penalty, 0.0,
            "{year}: the 403(b) is covered by the Rule of 55 and her 401(k) waits"
        );
        if year < 2034 {
            assert_eq!(
                drawn(snapshot, "her-401k"),
                0.0,
                "{year}: her 401(k) touched"
            );
            assert!(
                drawn(snapshot, "his-403b") > 0.0,
                "{year}: the bridge draws the 403(b)"
            );
            assert_eq!(snapshot.drawdown_phase.as_deref(), Some("bridge"));
        }
    }

    // 2034 is split at July: the first half of the year's need from the
    // 403(b), the second from her 401(k).
    let straddle = &projection.snapshots[8];
    assert_eq!(straddle.period_start.year, 2034);
    assert!(drawn(straddle, "his-403b") > 0.0);
    assert!(drawn(straddle, "her-401k") > 0.0);
    assert_eq!(straddle.drawdown_phase.as_deref(), Some("bridge"));

    let after = &projection.snapshots[9];
    assert_eq!(after.drawdown_phase.as_deref(), Some("standard"));
    assert!(drawn(after, "her-401k") > 0.0);
    assert_eq!(drawn(after, "his-403b"), 0.0, "her 401(k) comes first now");
}

/// Without the election, the same bridge pays the 10% on every 403(b)
/// dollar he draws before his own 59½.
#[test]
fn without_the_rule_of_55_the_bridge_is_penalized() {
    let mut plan = bridge_household();
    plan.accounts[0].rule_of_55 = false;
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    assert!(projection.snapshots[0].early_withdrawal_penalty > 0.0);
}

/// A year split between two phases still meets the tax schedule once: its
/// whole tax bill is the bill on everything drawn, whichever phase drew it.
#[test]
fn a_split_year_is_taxed_as_one_stack() {
    let plan = bridge_household();
    let projection = run_deterministic(&plan, &TaxFigures::built_in());
    let straddle = &projection.snapshots[8];
    let gross: f64 = straddle.withdrawals.values().sum();
    let tax = BracketTax::new(
        &TaxFigures::built_in(),
        FilingStatus::MarriedFilingJointly,
        StateTaxProfile::none(),
        0.0,
        TaxFigures::built_in().tax_year,
        plan.people.iter().map(|p| p.birth.year).collect(),
    );
    let expected = tax
        .tax(
            &IncomeBreakdown {
                ordinary: gross,
                ..Default::default()
            },
            straddle.period,
        )
        .tax;
    assert!(
        (straddle.taxes - expected).abs() < 1e-6,
        "{} vs {expected}",
        straddle.taxes
    );
    assert!(
        (gross - straddle.taxes - 90_000.0).abs() < 1e-6,
        "the need is met"
    );
}
