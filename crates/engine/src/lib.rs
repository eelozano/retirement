//! Pure retirement projection engine.
//!
//! This crate must stay free of Tauri (and any UI/IPC) dependencies so it can
//! be unit-tested with `cargo test`, parallelized for Monte Carlo in V2, and
//! potentially compiled to WASM.

pub mod model;
pub mod presets;
pub mod sim;
pub mod strategies;

pub use model::{Plan, YearMonth};
pub use sim::{simulate, PeriodSnapshot, Projection, SimWarning};

use strategies::{FixedReturns, FlatTax, ProportionalDrawdown};

/// The V1 configuration: deterministic fixed returns, flat tax, proportional
/// drawdown — all read from the plan's assumptions.
pub fn run_deterministic(plan: &Plan) -> Projection {
    let returns = FixedReturns::new(
        &plan.assumptions.asset_returns,
        plan.sim_config.period.months(),
    );
    let tax = FlatTax {
        rate: plan.assumptions.flat_tax_rate,
    };
    simulate(plan, &returns, &tax, &ProportionalDrawdown, 0)
}

/// Engine version, surfaced to the frontend to prove the IPC pipeline.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
