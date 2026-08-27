mod drawdown;
mod returns;
mod tax;

pub use drawdown::{AccountState, DrawdownStrategy, ProportionalDrawdown, WithdrawalResult};
pub use returns::{AssetReturns, FixedReturns, ReturnModel};
pub use tax::{FlatTax, IncomeBreakdown, TaxModel, TaxResult};

/// Zero-based simulation period number.
pub type PeriodIndex = usize;
