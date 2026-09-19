mod drawdown;
mod phased;
mod returns;
mod tax;

pub use drawdown::{
    AccountState, DrawdownStrategy, ProportionalDrawdown, WithdrawalResult,
    EARLY_WITHDRAWAL_PENALTY_RATE,
};
pub use phased::PhasedDrawdown;
pub use returns::{FixedReturns, ReturnModel, StochasticReturns, StrategyReturns};
pub use tax::{BracketTax, FlatTax, IncomeBreakdown, SurvivorTax, TaxModel, TaxResult};

/// Zero-based simulation period number.
pub type PeriodIndex = usize;
