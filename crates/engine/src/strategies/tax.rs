use crate::strategies::PeriodIndex;

/// Income for one period, split by character. V1's flat tax collapses the
/// split, but `BracketTax` (V2) needs ordinary vs capital gains separated,
/// so the interface carries the distinction from day 1.
#[derive(Clone, Copy, Debug, Default)]
pub struct IncomeBreakdown {
    /// Wages, pre-tax account withdrawals, (V2) interest.
    pub ordinary: f64,
    /// Realized capital gains from taxable-account withdrawals.
    pub capital_gains: f64,
    /// Roth withdrawals and returned principal — never taxed, carried for
    /// reporting.
    pub untaxed: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TaxResult {
    pub tax: f64,
}

/// Computes tax owed on a period's income. `period` lets V2 models index
/// inflation-adjusted brackets; V1 ignores it.
pub trait TaxModel {
    fn tax(&self, income: &IncomeBreakdown, period: PeriodIndex) -> TaxResult;
}

/// V1: one flat rate on ordinary income and realized gains alike.
pub struct FlatTax {
    pub rate: f64,
}

impl TaxModel for FlatTax {
    fn tax(&self, income: &IncomeBreakdown, _period: PeriodIndex) -> TaxResult {
        TaxResult {
            tax: (income.ordinary + income.capital_gains).max(0.0) * self.rate,
        }
    }
}
