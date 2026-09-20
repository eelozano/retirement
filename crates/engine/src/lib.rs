//! Pure retirement projection engine.
//!
//! This crate must stay free of Tauri (and any UI/IPC) dependencies so it can
//! be unit-tested with `cargo test`, parallelized for Monte Carlo in V2, and
//! potentially compiled to WASM.

pub mod model;
pub mod presets;
pub mod sim;
mod state_tax_data;
pub mod strategies;

pub use model::{Plan, YearMonth};
pub use sim::{
    run_monte_carlo as run_monte_carlo_sim, run_monte_carlo_with as run_monte_carlo_sim_with,
    simulate, Cancelled, MonteCarloConfig, MonteCarloDiagnostics, MonteCarloResult, OneTimeInfo,
    PathGroupStats, PeriodPercentiles, PeriodSnapshot, Projection, Rule55Ineligibility, RunControl,
    SimWarning, Spread, StreamInfo, EARLY_RETIREMENT_WINDOW_YEARS,
};

use model::{FilingStatus, TaxFigures};
use strategies::{
    BracketTax, DrawdownStrategy, FixedReturns, PhasedDrawdown, ProportionalDrawdown,
    StochasticReturns, SurvivorTax,
};

/// What a return model scales its annual rates to. A period is a calendar
/// year by construction (#106) — the loop lays its grid on calendar
/// boundaries and does not read `SimConfig::period` at all — so this is 12
/// rather than the schema's unsupported `PeriodLength`. A stub first period
/// takes its share of the year's return inside the loop, where the
/// period's `fraction` is known; a return model has no way to know it.
const MONTHS_PER_PERIOD: i64 = 12;

/// The plan's tax model, with the household's filing status switching to
/// Single after the first death (#34).
///
/// Only a joint filer has anything to lose, so a plan already filing Single
/// gets no transition. The state schedule carries over unchanged: a
/// `StateTaxProfile` is a single editable bracket table with no filing-status
/// dimension, and inventing a survivor variant of the user's own brackets
/// would be worse than leaving them alone.
///
/// Each side is also told whose return it is, because the age-65 additional
/// standard deduction depends on who is on it: everyone through the year of
/// the first death, and only those who outlive it after.
fn tax_model(plan: &Plan, figures: &TaxFigures) -> SurvivorTax {
    let start_year = plan.sim_config.start.year;
    let household = BracketTax::new(
        figures,
        plan.assumptions.filing_status,
        plan.assumptions.state_tax.clone(),
        plan.assumptions.inflation,
        start_year,
        birth_years(plan.people.iter()),
    );
    let survivor_from = match (plan.assumptions.filing_status, plan.first_death()) {
        (FilingStatus::MarriedFilingJointly, Some((month, _))) => {
            Some(plan.sim_config.first_period_after(month))
        }
        _ => None,
    };
    let survivors = match plan.first_death() {
        Some((month, _)) => birth_years(plan.survivors_after(month)),
        None => household.filer_birth_years.clone(),
    };
    SurvivorTax {
        survivor: BracketTax::new(
            figures,
            FilingStatus::Single,
            household.state_tax.clone(),
            household.inflation,
            start_year,
            survivors,
        ),
        household,
        survivor_from,
    }
}

fn birth_years<'a>(people: impl Iterator<Item = &'a model::Person>) -> Vec<i32> {
    people.map(|p| p.birth.year).collect()
}

/// The plan's drawdown policy, as the strategy that carries it out.
fn drawdown(plan: &Plan) -> Box<dyn DrawdownStrategy + Sync> {
    match PhasedDrawdown::new(plan) {
        Some(phased) => Box::new(phased),
        None => Box::new(ProportionalDrawdown),
    }
}

/// The V1 configuration: deterministic fixed returns, federal + state
/// bracket tax, and the plan's drawdown policy — all read from the plan's
/// assumptions, under the given yearly tax `figures`.
pub fn run_deterministic(plan: &Plan, figures: &TaxFigures) -> Projection {
    let returns = FixedReturns::new(&plan.assumptions.strategy_returns, MONTHS_PER_PERIOD);
    simulate(
        plan,
        figures,
        &returns,
        &tax_model(plan, figures),
        &*drawdown(plan),
        0,
    )
}

/// V2: Monte Carlo over `StochasticReturns`, reading both the mean
/// (`strategy_returns`) and the spread (`strategy_volatility`) from the plan
/// — same tax and drawdown strategies as `run_deterministic`.
pub fn run_monte_carlo(
    plan: &Plan,
    figures: &TaxFigures,
    config: &MonteCarloConfig,
) -> MonteCarloResult {
    let returns = stochastic_returns(plan, config);
    run_monte_carlo_sim(
        plan,
        figures,
        &returns,
        &tax_model(plan, figures),
        &*drawdown(plan),
        config,
    )
}

/// `run_monte_carlo`, observable and interruptible through `control` — the
/// form a UI drives, with a progress counter to sample and a cancel flag to
/// set. Same output as `run_monte_carlo` when it runs to completion.
pub fn run_monte_carlo_with(
    plan: &Plan,
    figures: &TaxFigures,
    config: &MonteCarloConfig,
    control: &RunControl,
) -> Result<MonteCarloResult, Cancelled> {
    let returns = stochastic_returns(plan, config);
    run_monte_carlo_sim_with(
        plan,
        figures,
        &returns,
        &tax_model(plan, figures),
        &*drawdown(plan),
        config,
        control,
    )
}

fn stochastic_returns(plan: &Plan, config: &MonteCarloConfig) -> StochasticReturns {
    StochasticReturns::new(
        &plan.assumptions.strategy_returns,
        &plan.assumptions.strategy_volatility,
        MONTHS_PER_PERIOD,
        config.seed as u64,
    )
}

/// Engine version, surfaced to the frontend to prove the IPC pipeline.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presets::seed_plan;

    /// The age-65 additional deduction depends on whose return it is: both
    /// spouses' through the year of the first death, and only the one who
    /// outlives them after — the decedent's birth year must not follow the
    /// household onto the Single return.
    #[test]
    fn the_survivors_return_carries_only_the_survivor() {
        let mut plan = seed_plan();
        plan.assumptions.filing_status = FilingStatus::MarriedFilingJointly;
        // Alex (born 1983) is expected to die at 88, Jordan (born 1987) at 96.
        let tax = tax_model(&plan, &TaxFigures::built_in());
        assert_eq!(tax.household.filer_birth_years, vec![1983, 1987]);
        assert_eq!(tax.survivor.filer_birth_years, vec![1987]);
        assert!(tax.survivor_from.is_some());
    }

    /// With no death that leaves anyone behind there is no survivor return
    /// in use, and the household's own filers stand in for it.
    #[test]
    fn a_plan_with_no_survivor_transition_keeps_its_filers() {
        let mut plan = seed_plan();
        plan.people.truncate(1);
        let tax = tax_model(&plan, &TaxFigures::built_in());
        assert_eq!(tax.household.filer_birth_years, vec![1983]);
        assert_eq!(tax.survivor.filer_birth_years, vec![1983]);
        assert!(tax.survivor_from.is_none());
    }
}
