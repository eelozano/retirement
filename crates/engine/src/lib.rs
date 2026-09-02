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
    run_monte_carlo as run_monte_carlo_sim, simulate, MonteCarloConfig, MonteCarloResult,
    PeriodPercentiles, PeriodSnapshot, Projection, SimWarning, StreamInfo,
};

use model::FilingStatus;
use strategies::{BracketTax, FixedReturns, ProportionalDrawdown, StochasticReturns, SurvivorTax};

/// The plan's tax model, with the household's filing status switching to
/// Single after the first death (#34).
///
/// Only a joint filer has anything to lose, so a plan already filing Single
/// gets no transition. The state schedule carries over unchanged: a
/// `StateTaxProfile` is a single editable bracket table with no filing-status
/// dimension, and inventing a survivor variant of the user's own brackets
/// would be worse than leaving them alone.
fn tax_model(plan: &Plan) -> SurvivorTax {
    let household = BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
    };
    let survivor_from = match (plan.assumptions.filing_status, plan.first_death()) {
        (FilingStatus::MarriedFilingJointly, Some((month, _))) => {
            Some(plan.sim_config.first_period_after(month))
        }
        _ => None,
    };
    SurvivorTax {
        survivor: BracketTax {
            filing_status: FilingStatus::Single,
            state_tax: household.state_tax.clone(),
        },
        household,
        survivor_from,
    }
}

/// The V1 configuration: deterministic fixed returns, federal + state
/// bracket tax, proportional drawdown — all read from the plan's
/// assumptions.
pub fn run_deterministic(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    simulate(plan, &returns, &tax_model(plan), &ProportionalDrawdown, 0)
}

/// V2: Monte Carlo over `StochasticReturns`, reading both the mean
/// (`asset_returns`) and the spread (`asset_volatility`) from the plan — same
/// tax/drawdown strategies as `run_deterministic`.
pub fn run_monte_carlo(plan: &Plan, config: &MonteCarloConfig) -> MonteCarloResult {
    let returns = StochasticReturns::new(
        &plan.assumptions.asset_returns,
        &plan.assumptions.asset_volatility,
        plan.sim_config.period.months(),
        config.seed as u64,
    );
    run_monte_carlo_sim(
        plan,
        &returns,
        &tax_model(plan),
        &ProportionalDrawdown,
        config,
    )
}

/// Engine version, surfaced to the frontend to prove the IPC pipeline.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
