mod drawdown;
mod returns;
mod tax;

pub use drawdown::{AccountState, DrawdownStrategy, ProportionalDrawdown, WithdrawalResult};
pub use returns::{AssetReturns, FixedReturns, ReturnModel, StochasticReturns};
pub use tax::{BracketTax, FlatTax, IncomeBreakdown, TaxModel, TaxResult};

/// Zero-based simulation period number.
pub type PeriodIndex = usize;
