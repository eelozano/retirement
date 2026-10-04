//! Historical backtesting (#178): the plan replayed against every start
//! year in the bundled record.
//!
//! The bundled data is checked against figures anyone can look up. The
//! classification of a start year — succeeded, depleted, still in progress
//! — is checked on a made-up history where each outcome can be worked by
//! hand. And the whole replay is anchored to a publication: the Trinity
//! study's 4% rule.

use engine::model::{
    Account, AccountKind, AllocationRef, Assumptions, CashFlowStream, FilingStatus, GrowthRule,
    PeriodLength, Person, Plan, PlanType, SimConfig, StateTaxProfile, StrategyRates,
    StreamBoundary, StreamDirection, StreamKind, TaxFigures, YearMonth, SCHEMA_VERSION,
};
use engine::presets::{seed_plan, strategy_stock_share};
use engine::sim::{backtest, history, HistoricalYear};
use engine::{run_backtest, run_backtest_cohort, run_with, CohortStatus};

fn year(year: i32) -> HistoricalYear {
    *history()
        .iter()
        .find(|y| y.year == year)
        .unwrap_or_else(|| panic!("{year} is in the bundled history"))
}

fn near(actual: f64, expected: f64, within: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= within,
        "{label}: expected {expected} ± {within}, got {actual}"
    );
}

/// Years are contiguous from 1871 through the last complete year, and the
/// figures that made history are where they should be. Shiller's prices are
/// monthly averages taken January to January, so these differ from the
/// calendar-year figures usually quoted by a few points.
#[test]
fn the_bundled_history_holds_the_years_it_should() {
    let years = history();
    assert_eq!(years[0].year, 1871);
    assert!(years.last().unwrap().year >= 2025);
    for pair in years.windows(2) {
        assert_eq!(pair[1].year, pair[0].year + 1, "contiguous");
    }
    near(year(1931).stocks, -0.44, 0.03, "1931 stocks");
    near(year(1974).inflation, 0.12, 0.01, "1974 inflation");
    near(year(1980).inflation, 0.12, 0.01, "1980 inflation");
    near(year(2008).stocks, -0.36, 0.03, "2008 stocks");
    near(year(2022).bonds, -0.12, 0.02, "2022 bonds");
    assert!(year(1931).inflation < -0.05, "the Depression deflation");
}

const OPENING: f64 = 1_000_000.0;

/// One retired person, one Roth IRA (no tax on what it pays out), and an
/// inflation-grown expense — over `periods` calendar years from January.
fn retiree(periods: i32, spending: f64, allocation: AllocationRef) -> Plan {
    let person = "p1".to_string();
    let birth = YearMonth::new(1950, 1);
    let start = YearMonth::new(2026, 1);
    let last_year = start.year + periods - 1;
    Plan {
        id: "retiree".to_string(),
        schema_version: SCHEMA_VERSION,
        name: "retiree".to_string(),
        sample: false,
        people: vec![Person {
            id: person.clone(),
            name: "Solo".to_string(),
            birth,
            retirement: YearMonth::new(2015, 1),
            life_expectancy_age: (last_year + 1 - birth.year) as u8,
        }],
        accounts: vec![Account {
            id: "roth".to_string(),
            owner: person,
            kind: AccountKind::Roth,
            name: "Roth".to_string(),
            balance: OPENING,
            cost_basis: Some(OPENING),
            allocation,
            plan_type: PlanType::Ira,
            contributions: vec![],
            one_time_contributions: vec![],
            employer_match: None,
            rule_of_55: false,
        }],
        streams: vec![CashFlowStream {
            id: "spending".to_string(),
            name: "Spending".to_string(),
            owner: None,
            direction: StreamDirection::Expense,
            annual_amount: spending,
            start: StreamBoundary::PlanStart,
            end: StreamBoundary::PlanEnd,
            growth: GrowthRule::Inflation,
            survivor_percentage: None,
            kind: StreamKind::General,
        }],
        social_security: vec![],
        assumptions: Assumptions {
            inflation: 0.03,
            strategy_returns: Default::default(),
            filing_status: FilingStatus::Single,
            state_tax: StateTaxProfile::none(),
            plan_end_age: (last_year + 1 - birth.year) as u8,
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
            start,
            period: PeriodLength::Year,
            display_real_dollars: true,
        },
    }
}

/// A flat history — no returns, no inflation — with one 90% crash.
fn flat_history_with_crash(len: usize, crash_at: usize) -> Vec<HistoricalYear> {
    (0..len)
        .map(|i| {
            let r = if i == crash_at { -0.9 } else { 0.0 };
            HistoricalYear {
                year: 1900 + i as i32,
                stocks: r,
                bonds: r,
                inflation: 0.0,
            }
        })
        .collect()
}

/// Ten-year plan, $50,000 a year from $1M: on flat returns it lasts twenty
/// years, so only the crash can sink it. Worked by hand:
///
/// - From 1900: never meets the crash (1912) inside its ten years.
/// - From 1905: the crash is its period 7. $1M less eight years' spending
///   is $600,000, cut to $60,000; period 8 spends $50,000, and period 9
///   cannot be covered. Depleted, on a complete window.
/// - From 1911: only four years of history. The crash is its period 1:
///   $900,000 cut to $90,000, $40,000 after period 2, and period 3 cannot be
///   covered. Depleted, though history stops short of the horizon.
/// - From 1913: two years of history, both flat. Solvent when the data ends:
///   in progress, and out of the success rate.
#[test]
fn each_start_year_is_judged_on_the_years_history_covers() {
    let plan = retiree(10, 50_000.0, AllocationRef::Moderate);
    let figures = TaxFigures::tax_year_2026();
    let history = flat_history_with_crash(15, 12);
    let result = backtest(
        &plan,
        &history,
        strategy_stock_share(),
        &|prices, returns| run_with(&plan, &figures, prices, returns, 0),
    );

    assert_eq!(result.cohorts.len(), 15);
    assert_eq!(result.n_periods, 10);
    let cohort = |y: i32| {
        result
            .cohorts
            .iter()
            .find(|c| c.start_year == y)
            .unwrap()
            .clone()
    };

    let from_1900 = cohort(1900);
    assert_eq!(from_1900.status, CohortStatus::Succeeded);
    assert_eq!(from_1900.periods_covered, 10);

    let from_1905 = cohort(1905);
    assert_eq!(from_1905.status, CohortStatus::Depleted);
    assert_eq!(from_1905.depleted_period, Some(9));

    let from_1911 = cohort(1911);
    assert_eq!(from_1911.periods_covered, 4);
    assert_eq!(from_1911.status, CohortStatus::Depleted);
    assert_eq!(from_1911.depleted_period, Some(3));

    let from_1913 = cohort(1913);
    assert_eq!(from_1913.periods_covered, 2);
    assert_eq!(from_1913.status, CohortStatus::InProgress);
    assert_eq!(from_1913.net_worth_real.len(), 2);

    assert_eq!(
        result.succeeded + result.depleted + result.in_progress,
        15,
        "every start year is exactly one of the three"
    );
    // 1900–1902 never meet the crash in ten years. 1903 meets it in its
    // last period, after that year's spending, and 1904 in its second to
    // last, with $55,000 left for a final $50,000 year: both survive.
    // 1905–1912 all deplete — those whose window runs past the data
    // included — and 1913–1914 are in progress.
    assert_eq!(result.succeeded, 5);
    assert_eq!(result.depleted, 8);
    assert_eq!(result.in_progress, 2);
    assert_eq!(result.success_rate, Some(5.0 / 13.0));
}

/// The real-dollar pin over a history whose inflation swings, deflation
/// included: an account earning exactly each year's inflation, with
/// nothing going in or out, is flat in today's dollars in every cohort.
#[test]
fn an_account_earning_each_years_inflation_is_flat_in_every_cohort() {
    let mut plan = retiree(8, 0.0, AllocationRef::Aggressive);
    plan.streams.clear();
    let figures = TaxFigures::tax_year_2026();
    let rates = [0.02, 0.11, 0.14, -0.06, -0.09, 0.0, 0.05, 0.03, 0.08, 0.01];
    let history: Vec<HistoricalYear> = rates
        .iter()
        .enumerate()
        .map(|(i, &r)| HistoricalYear {
            year: 1920 + i as i32,
            stocks: r,
            bonds: r,
            inflation: r,
        })
        .collect();
    let result = backtest(
        &plan,
        &history,
        strategy_stock_share(),
        &|prices, returns| run_with(&plan, &figures, prices, returns, 0),
    );
    for cohort in &result.cohorts {
        for (period, real) in cohort.net_worth_real.iter().enumerate() {
            near(
                *real,
                OPENING,
                1e-6,
                &format!("from {}, period {period}", cohort.start_year),
            );
        }
    }
}

/// The Trinity study (Cooley, Hubbard and Walz, 1998) found a 4% inflation-
/// adjusted withdrawal from a 50/50 portfolio lasted 30 years in about 95%
/// of historical windows (1926–1995, corporate bonds). Shiller's longer
/// record and Treasury bonds are not the same data, so the band is loose;
/// a replay outside it would mean the machinery, not the data, is off.
#[test]
fn the_four_percent_rule_lasts_about_as_often_as_trinity_found() {
    let plan = retiree(30, 40_000.0, AllocationRef::Moderate);
    let figures = TaxFigures::tax_year_2026();
    let half = StrategyRates {
        very_aggressive: 0.5,
        aggressive: 0.5,
        moderate: 0.5,
        conservative: 0.5,
        very_conservative: 0.5,
    };
    let result = backtest(&plan, history(), half, &|prices, returns| {
        run_with(&plan, &figures, prices, returns, 0)
    });
    // Trinity counts complete windows only.
    let complete: Vec<_> = result
        .cohorts
        .iter()
        .filter(|c| c.periods_covered == 30)
        .collect();
    let lasted = complete
        .iter()
        .filter(|c| c.status == CohortStatus::Succeeded)
        .count();
    let rate = lasted as f64 / complete.len() as f64;
    println!(
        "4%, 50/50, 30 years: {lasted} of {} complete windows ({:.1}%); headline {:?}",
        complete.len(),
        rate * 100.0,
        result.success_rate
    );
    assert!(
        (0.88..=1.0).contains(&rate),
        "4% / 50-50 / 30y success {rate} is far from Trinity's ~95%"
    );
}

/// The ledger's shape on a real plan: the market rows line up with the
/// snapshots, the first is the start year, and nothing past the covered
/// periods leaks through.
#[test]
fn a_cohorts_detail_lines_up_with_its_market_years() {
    let plan = seed_plan();
    let figures = TaxFigures::tax_year_2026();
    for start_year in [1929, 1966, 2000] {
        let detail = run_backtest_cohort(&plan, &figures, start_year).expect("in history");
        let covered = detail.periods_covered as usize;
        assert_eq!(detail.projection.snapshots.len(), covered);
        assert_eq!(detail.market.len(), covered);
        assert_eq!(detail.market[0].historical_year, start_year);
        assert!(detail
            .projection
            .warnings
            .iter()
            .all(|w| w.period().is_none_or(|p| p < covered)));
    }
    assert!(run_backtest_cohort(&plan, &figures, 1700).is_none());
}

/// The summary and a cohort's detail are the same run.
#[test]
fn the_summary_and_the_detail_agree() {
    let plan = seed_plan();
    let figures = TaxFigures::tax_year_2026();
    let result = run_backtest(&plan, &figures);
    assert_eq!(result.cohorts.len(), history().len());
    // Over the record, the 80/20 mix compounded at about 6.4% after
    // inflation and the all-stock one at about 7.1%.
    near(
        result.historical_real_return.aggressive,
        0.064,
        0.003,
        "80/20 real",
    );
    near(
        result.historical_real_return.very_aggressive,
        0.071,
        0.003,
        "100/0 real",
    );
    let recent = result.cohorts.last().unwrap();
    assert_eq!(recent.periods_covered, 1);

    let summary = result
        .cohorts
        .iter()
        .find(|c| c.start_year == 1966)
        .unwrap();
    let detail = run_backtest_cohort(&plan, &figures, 1966).unwrap();
    assert_eq!(summary.status, detail.status);
    assert_eq!(summary.depleted_period, detail.depleted_period);
    for (real, snapshot) in summary
        .net_worth_real
        .iter()
        .zip(&detail.projection.snapshots)
    {
        assert_eq!(*real, snapshot.net_worth / snapshot.deflator_end);
    }
}
