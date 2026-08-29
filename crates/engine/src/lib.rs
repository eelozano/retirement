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
    PeriodPercentiles, PeriodSnapshot, Projection, SimWarning,
};

use strategies::{BracketTax, FixedReturns, ProportionalDrawdown, StochasticReturns};

fn tax_model(plan: &Plan) -> BracketTax {
    BracketTax {
        filing_status: plan.assumptions.filing_status,
        state_tax: plan.assumptions.state_tax.clone(),
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

/// V2: Monte Carlo over `StochasticReturns` (fixed volatility defaults, see
/// `presets::asset_volatility`), same tax/drawdown strategies as
/// `run_deterministic`.
pub fn run_monte_carlo(plan: &Plan, config: &MonteCarloConfig) -> MonteCarloResult {
    let returns = StochasticReturns::new(
        &plan.assumptions.asset_returns,
        &presets::asset_volatility(),
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
