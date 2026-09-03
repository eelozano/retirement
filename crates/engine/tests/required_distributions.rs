//! Required minimum distributions (#49): pre-tax money the IRS forces out
//! whether or not the household needs it, and what that does to the bill.
//!
//! Every fixture here runs with zero inflation, zero market returns and zero
//! COLA, so each figure is the distribution rule and the tax treatment and
//! nothing else. The sweep toggle is **off** everywhere, which is both the
//! default and the setting the money-destruction regression needs.

use std::collections::BTreeMap;

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    ContributionRule, FilingStatus, GrowthRule, PeriodLength, Person, Plan, PlanType, SimConfig,
    SocialSecurityBenefit, StateTaxProfile, StreamBoundary, StreamDirection, YearMonth,
    SCHEMA_VERSION,
};
use engine::presets::{rmd_age, uniform_lifetime_divisor};
use engine::strategies::{BracketTax, IncomeBreakdown, TaxModel};
use engine::{run_deterministic, PeriodSnapshot, Projection, SimWarning};

const START_YEAR: i32 = 2026;
const PRETAX: f64 = 1_000_000.0;

fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "{label}: expected {expected}, got {actual}"
    );
}

fn single_filer() -> BracketTax {
    BracketTax {
        filing_status: FilingStatus::Single,
        state_tax: StateTaxProfile::none(),
    }
}

fn account(id: &str, kind: AccountKind, balance: f64, basis: Option<f64>) -> Account {
    Account {
        id: id.to_string(),
        owner: "p1".to_string(),
        kind,
        name: id.to_string(),
        balance,
        cost_basis: basis,
        allocation: AllocationRef::Custom(BTreeMap::new()),
        plan_type: match kind {
            AccountKind::Taxable => PlanType::None,
            _ => PlanType::EmployerPlan,
        },
        contributions: vec![Contribution::until_retirement(
            "contribution",
            ContributionRule::FlatAmount { amount: 0.0 },
            &"p1".to_string(),
        )],
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

/// One retired person, no growth of any kind. `birth_year` is the only knob
/// the distribution rule reads, which is what makes it the counterfactual
/// throughout: the same plan with an owner too young to be forced.
struct Fixture {
    birth_year: i32,
    accounts: Vec<Account>,
    streams: Vec<CashFlowStream>,
    social_security: Option<f64>,
}

impl Fixture {
    fn new(birth_year: i32) -> Self {
        Fixture {
            birth_year,
            accounts: vec![account(
                "401k",
                AccountKind::TraditionalPreTax,
                PRETAX,
                None,
            )],
            streams: Vec::new(),
            social_security: None,
        }
    }

    fn plan(self) -> Plan {
        Plan {
            id: "rmd".to_string(),
            schema_version: SCHEMA_VERSION,
            name: "rmd".to_string(),
            people: vec![Person {
                id: "p1".to_string(),
                name: "Retiree".to_string(),
                birth: YearMonth {
                    year: self.birth_year,
                    month: 1,
                },
                // Before the simulation starts, so nobody contributes and
                // the whole projection is retirement.
                retirement: YearMonth {
                    year: START_YEAR - 1,
                    month: 1,
                },
                life_expectancy_age: (START_YEAR + 30 - self.birth_year) as u8,
            }],
            accounts: self.accounts,
            streams: self.streams,
            // Full retirement age and claiming age both 67, so the claiming
            // adjustment is 1.0 and `benefit_at_fra` is what is paid.
            social_security: self
                .social_security
                .map(|benefit| SocialSecurityBenefit {
                    id: "ss".to_string(),
                    owner: "p1".to_string(),
                    benefit_at_fra: benefit,
                    full_retirement_age: 67,
                    claiming_age: 67,
                    cola_override: None,
                })
                .into_iter()
                .collect(),
            assumptions: Assumptions {
                inflation: 0.0,
                asset_returns: BTreeMap::new(),
                filing_status: FilingStatus::Single,
                state_tax: StateTaxProfile::none(),
                plan_end_age: 90,
                // Off — the setting the whole reinvestment rule exists for.
                sweep_surplus_from: None,
                survivor_expense_factor: 1.0,
                social_security_cola: 0.0,
                asset_volatility: BTreeMap::new(),
                reinvest_into: None,
            },
            sim_config: SimConfig {
                start: YearMonth {
                    year: START_YEAR,
                    month: 1,
                },
                period: PeriodLength::Year,
                display_real_dollars: false,
            },
        }
    }
}

fn year_of(projection: &Projection, year: i32) -> &PeriodSnapshot {
    projection
        .snapshots
        .iter()
        .find(|s| s.period_start.year == year)
        .unwrap_or_else(|| panic!("no snapshot for {year}"))
}

/// A pensioner whose $100,000 pension comfortably covers $60,000 of
/// spending: nothing would ever leave the 401(k) on its own.
fn pensioner(birth_year: i32) -> Plan {
    let mut fixture = Fixture::new(birth_year);
    fixture.accounts.push(account(
        "brokerage",
        AccountKind::Taxable,
        10_000.0,
        Some(10_000.0),
    ));
    fixture
        .streams
        .push(stream("pension", StreamDirection::Income, 100_000.0));
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 60_000.0));
    fixture.plan()
}

// -- the presets ---------------------------------------------------------

#[test]
fn the_required_beginning_age_steps_with_the_birth_year() {
    assert_eq!(rmd_age(1959), 73, "SECURE 2.0: born 1951-1959");
    assert_eq!(rmd_age(1960), 75, "SECURE 2.0: born 1960 and later");
    assert_eq!(rmd_age(1951), 73);
    assert_eq!(rmd_age(1985), 75);
    // Everyone born before the SECURE 2.0 cohorts is already distributing
    // by the earliest year this app can project.
    assert_eq!(rmd_age(1949), 72);
}

#[test]
fn the_uniform_lifetime_divisors_match_the_irs_table() {
    assert_eq!(uniform_lifetime_divisor(71), None, "below the first row");
    assert_eq!(uniform_lifetime_divisor(73), Some(26.5));
    assert_eq!(uniform_lifetime_divisor(90), Some(12.2));
    // The table's last row is "120 and older".
    assert_eq!(uniform_lifetime_divisor(120), Some(2.0));
    assert_eq!(uniform_lifetime_divisor(130), Some(2.0));
}

/// The divisors are a mortality table, not a dollar figure, so they must not
/// index with inflation the way `CONTRIBUTION_LIMITS` does. Pinned by
/// running the same plan under 0% and 8% inflation and checking the
/// distribution is the same share of the prior balance in both.
#[test]
fn the_divisor_does_not_index_with_inflation() {
    let share = |inflation: f64| {
        let mut plan = pensioner(1952);
        plan.assumptions.inflation = inflation;
        let projection = run_deterministic(&plan);
        let prior = year_of(&projection, 2026).balances["401k"];
        year_of(&projection, 2027).required_distributions / prior
    };
    assert_close(share(0.0), 1.0 / 24.6, "no inflation");
    assert_close(share(0.08), 1.0 / 24.6, "8% inflation");
}

// -- the distribution itself ---------------------------------------------

/// The headline case: income covers spending in full, so the discretionary
/// drawdown is never reached — and the 401(k) is drawn down anyway.
#[test]
fn an_owner_past_the_rmd_age_distributes_even_with_spending_fully_covered() {
    // Born 1952: age 75 in 2027, divisor 24.6.
    let projection = run_deterministic(&pensioner(1952));
    let first = year_of(&projection, 2026);
    let second = year_of(&projection, 2027);

    // The first projection period has no prior year-end balance to divide,
    // so it takes nothing — see the module doc on `required_distributions`.
    assert_close(first.required_distributions, 0.0, "no prior balance");
    assert!(
        first.withdrawals.values().sum::<f64>() == 0.0,
        "nothing is needed, so nothing is withdrawn in the first period"
    );

    let expected = PRETAX / 24.6;
    assert_close(second.required_distributions, expected, "the distribution");
    assert_close(
        second.balances["401k"],
        PRETAX - expected,
        "the pre-tax balance falls by exactly the distribution",
    );
    assert_close(
        second.withdrawals["401k"],
        expected,
        "the forced draw is reported as a withdrawal like any other",
    );
    assert!(
        second.taxes > first.taxes,
        "the distribution is taxed: {} vs {}",
        second.taxes,
        first.taxes
    );
}

/// **The money-destruction regression.** With the surplus sweep
/// off, the after-tax remainder still has to land somewhere: the dollars
/// have already left the pre-tax balance, and dropping them would delete
/// real wealth every year and report the result as a failing plan.
///
/// Here the equality is exact. The pre-tax account loses the distribution,
/// the taxable account gains it, and the extra tax comes out of a surplus
/// that a sweep-off plan discards anyway — so net worth is *identical* to
/// the same household with an owner too young to be forced.
#[test]
fn the_distribution_is_reinvested_with_the_sweep_off() {
    let forced = run_deterministic(&pensioner(1952));
    // Born 1970: 57 in 2027, decades short of any required beginning age.
    let untouched = run_deterministic(&pensioner(1970));

    let a = year_of(&forced, 2027);
    let b = year_of(&untouched, 2027);
    assert!(a.required_distributions > 0.0, "the fixture must force one");
    assert_close(b.required_distributions, 0.0, "the counterfactual is idle");

    assert_close(
        a.balances["brokerage"],
        b.balances["brokerage"] + a.required_distributions,
        "the taxable account receives the distribution",
    );
    assert_close(
        a.net_worth,
        b.net_worth,
        "net worth must not fall by the distribution",
    );
    assert!(
        forced.warnings.is_empty(),
        "nothing to warn about: {:?}",
        forced.warnings
    );
}

/// With no taxable account the remainder genuinely has nowhere to go, and
/// the engine says so rather than losing the money quietly.
#[test]
fn a_distribution_with_nowhere_to_land_is_reported() {
    let mut fixture = Fixture::new(1952);
    fixture
        .streams
        .push(stream("pension", StreamDirection::Income, 100_000.0));
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 60_000.0));
    let projection = run_deterministic(&fixture.plan());

    let unallocated: Vec<_> = projection
        .warnings
        .iter()
        .filter(|w| matches!(w, SimWarning::RequiredDistributionUnallocated { .. }))
        .collect();
    assert_eq!(
        unallocated.len(),
        1,
        "reported once, for the first period it happens in: {:?}",
        projection.warnings
    );
    assert_eq!(
        unallocated[0],
        &SimWarning::RequiredDistributionUnallocated { period: 1 },
        "2027 is the first period with a prior balance to divide",
    );
}

/// Reinvested proceeds are after-tax dollars, so they raise `cost_basis`
/// alongside `balance`. Skipping the basis would tax the same money a second
/// time as capital gain when it is eventually withdrawn.
///
/// `cost_basis` is engine-internal, so this is pinned where it shows: the
/// taxable account starts empty and grows only from distributions, and a
/// later shortfall year's tax bill has to carry **no** capital-gains
/// component at all.
#[test]
fn reinvested_proceeds_carry_their_cost_basis() {
    let mut fixture = Fixture::new(1952);
    // Starts empty: every dollar in it arrived as a distribution.
    fixture
        .accounts
        .push(account("brokerage", AccountKind::Taxable, 0.0, Some(0.0)));
    fixture
        .streams
        .push(stream("pension", StreamDirection::Income, 100_000.0));
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 60_000.0));
    let mut plan = fixture.plan();
    // A one-off shock in 2035, after eight years of proceeds have piled up,
    // that only a drawdown can cover.
    let mut shock = stream("shock", StreamDirection::Expense, 300_000.0);
    shock.start = StreamBoundary::Date(YearMonth {
        year: 2035,
        month: 1,
    });
    shock.end = StreamBoundary::Date(YearMonth {
        year: 2036,
        month: 1,
    });
    plan.streams.push(shock);

    let projection = run_deterministic(&plan);
    let s = year_of(&projection, 2035);
    let from_brokerage = s.withdrawals["brokerage"];
    assert!(
        from_brokerage > 0.0,
        "the shock year must sell some of the reinvested proceeds"
    );

    let ordinary = s.income + s.withdrawals["401k"];
    let tax = single_filer();
    let no_gain = tax
        .tax(
            &IncomeBreakdown {
                ordinary,
                untaxed: from_brokerage,
                ..Default::default()
            },
            s.period,
        )
        .tax;
    assert_close(
        s.taxes,
        no_gain,
        "reinvested dollars come back out as returned principal",
    );

    // What it would have cost had the basis not been credited: the same
    // sale, every dollar of it a realized gain.
    let all_gain = tax
        .tax(
            &IncomeBreakdown {
                ordinary,
                capital_gains: from_brokerage,
                ..Default::default()
            },
            s.period,
        )
        .tax;
    assert!(
        all_gain > no_gain,
        "the counterfactual has to actually differ: {all_gain} vs {no_gain}"
    );
}

// -- who is in scope, and from when --------------------------------------

#[test]
fn the_year_before_the_required_beginning_age_is_untouched() {
    // Born 1955: 72 in 2027, 73 — the required beginning age for their
    // cohort — in 2028.
    let projection = run_deterministic(&pensioner(1955));
    assert_close(
        year_of(&projection, 2027).required_distributions,
        0.0,
        "at 72, nothing",
    );
    assert!(
        year_of(&projection, 2028).required_distributions > 0.0,
        "at 73, forced",
    );
}

/// The SECURE 2.0 step: one birth year apart, two years apart in when the
/// distributions start.
#[test]
fn born_1959_starts_at_73_and_born_1960_starts_at_75() {
    let first_forced_year = |birth_year: i32| {
        run_deterministic(&pensioner(birth_year))
            .snapshots
            .iter()
            .find(|s| s.required_distributions > 0.0)
            .map(|s| s.period_start.year)
            .expect("some period must force a distribution")
    };
    assert_eq!(first_forced_year(1959), 1959 + 73);
    assert_eq!(first_forced_year(1960), 1960 + 75);
}

/// Roth accounts have no lifetime RMD under SECURE 2.0, and a taxable
/// brokerage was never in scope.
#[test]
fn only_pre_tax_accounts_are_forced() {
    let mut fixture = Fixture::new(1952);
    fixture.accounts.clear();
    fixture
        .accounts
        .push(account("roth", AccountKind::Roth, PRETAX, None));
    fixture.accounts.push(account(
        "brokerage",
        AccountKind::Taxable,
        PRETAX,
        Some(PRETAX),
    ));
    fixture
        .streams
        .push(stream("pension", StreamDirection::Income, 100_000.0));
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 60_000.0));

    let projection = run_deterministic(&fixture.plan());
    for s in &projection.snapshots {
        assert_close(
            s.required_distributions,
            0.0,
            &format!("period {} has no pre-tax account", s.period),
        );
    }
}

/// One figure per owner over their aggregate pre-tax balance, satisfied pro
/// rata across their accounts. The model has no IRA-versus-401(k) grouping,
/// so pro rata is the deliberate simplification — see the module doc.
#[test]
fn one_owner_with_two_pre_tax_accounts_is_aggregated_then_pro_rated() {
    let mut fixture = Fixture::new(1952);
    fixture.accounts.clear();
    fixture.accounts.push(account(
        "401k",
        AccountKind::TraditionalPreTax,
        750_000.0,
        None,
    ));
    fixture.accounts.push(account(
        "ira",
        AccountKind::TraditionalPreTax,
        250_000.0,
        None,
    ));
    fixture.accounts.push(account(
        "brokerage",
        AccountKind::Taxable,
        10_000.0,
        Some(10_000.0),
    ));
    fixture
        .streams
        .push(stream("pension", StreamDirection::Income, 100_000.0));
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 60_000.0));

    let projection = run_deterministic(&fixture.plan());
    let s = year_of(&projection, 2027);
    assert_close(
        s.required_distributions,
        1_000_000.0 / 24.6,
        "computed on the aggregate, not per account",
    );
    assert_close(
        s.withdrawals["401k"],
        0.75 * s.required_distributions,
        "pro rata by balance",
    );
    assert_close(
        s.withdrawals["ira"],
        0.25 * s.required_distributions,
        "ditto",
    );
}

// -- the tax, which is the whole point -----------------------------------

/// **The stacking test.** A forced distribution lands on top of everything
/// else the household has: it climbs from the household's real marginal rate
/// rather than re-entering the brackets at $0, and it drags a Social
/// Security benefit into taxability that would otherwise be untaxed.
///
/// Taxed in isolation and added — the two-pass model #54 removed — the same
/// dollars cost a fraction of this. That is the regression that would
/// silently reappear if the two-pass structure ever came back, and it is the
/// reason RMDs are worth modelling at all.
#[test]
fn a_distribution_stacked_on_social_security_costs_more_than_the_two_taxed_apart() {
    let mut fixture = Fixture::new(1952);
    fixture.accounts.clear();
    fixture.accounts.push(account(
        "401k",
        AccountKind::TraditionalPreTax,
        1_500_000.0,
        None,
    ));
    fixture.accounts.push(account(
        "brokerage",
        AccountKind::Taxable,
        10_000.0,
        Some(10_000.0),
    ));
    // Spending the benefit alone covers, so 2026 leaves the balance
    // untouched and 2027's distribution is exactly the starting balance over
    // the age-75 divisor.
    fixture
        .streams
        .push(stream("spending", StreamDirection::Expense, 30_000.0));
    fixture.social_security = Some(40_000.0);

    let projection = run_deterministic(&fixture.plan());
    let s = year_of(&projection, 2027);
    let rmd = s.required_distributions;
    assert_close(rmd, 1_500_000.0 / 24.6, "the distribution");
    assert_close(
        s.withdrawals.values().sum::<f64>(),
        rmd,
        "the benefit and the distribution cover spending, so nothing else is sold",
    );

    let tax = single_filer();
    let benefit_alone = tax
        .tax(
            &IncomeBreakdown {
                social_security: s.income,
                ..Default::default()
            },
            s.period,
        )
        .tax;
    assert_close(
        benefit_alone,
        0.0,
        "the benefit on its own is federally untaxed",
    );
    let distribution_alone = tax
        .tax(
            &IncomeBreakdown {
                ordinary: rmd,
                ..Default::default()
            },
            s.period,
        )
        .tax;

    assert_close(
        s.taxes,
        tax.tax(
            &IncomeBreakdown {
                ordinary: rmd,
                social_security: s.income,
                ..Default::default()
            },
            s.period,
        )
        .tax,
        "one pass over the whole period",
    );
    assert!(
        s.taxes > 2.0 * (benefit_alone + distribution_alone),
        "stacked must cost materially more than taxed apart: {} vs {}",
        s.taxes,
        benefit_alone + distribution_alone
    );
}

/// In a year the household *does* need cash, the distribution counts toward
/// the need instead of being taken on top of it — otherwise the same dollars
/// are withdrawn and taxed twice in one period.
#[test]
fn a_shortfall_year_draws_the_larger_of_the_need_and_the_distribution() {
    let shortfall = |birth_year: i32| {
        let mut fixture = Fixture::new(birth_year);
        fixture.accounts.clear();
        fixture.accounts.push(account(
            "401k",
            AccountKind::TraditionalPreTax,
            1_500_000.0,
            None,
        ));
        fixture.accounts.push(account(
            "brokerage",
            AccountKind::Taxable,
            200_000.0,
            Some(200_000.0),
        ));
        fixture
            .streams
            .push(stream("spending", StreamDirection::Expense, 150_000.0));
        fixture.social_security = Some(40_000.0);
        fixture.plan()
    };

    let forced = run_deterministic(&shortfall(1952));
    let untouched = run_deterministic(&shortfall(1970));
    let a = year_of(&forced, 2027);
    let b = year_of(&untouched, 2027);

    let rmd = a.required_distributions;
    let gross: f64 = a.withdrawals.values().sum();
    let need_alone: f64 = b.withdrawals.values().sum();
    assert!(rmd > 0.0 && need_alone > 0.0, "the fixture must do both");

    assert!(
        gross >= rmd,
        "the distribution is a floor: {gross} vs {rmd}",
    );
    // The distribution is all ordinary income where the proportional draw is
    // part return of principal, so covering the same spending costs a little
    // more gross. What it must never approach is `need_alone + rmd`, which
    // is the double-withdrawal this test exists to rule out.
    assert!(
        gross < need_alone + 0.25 * rmd,
        "the distribution must count toward the need, not stack on it: \
         {gross} against a need of {need_alone} plus a distribution of {rmd}",
    );
    assert_close(a.surplus, 0.0, "a shortfall year has no surplus");
    assert_close(
        a.income + gross,
        a.expenses + a.taxes + a.surplus,
        "cash still conserves",
    );
}
