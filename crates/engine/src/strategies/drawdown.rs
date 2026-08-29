use std::collections::BTreeMap;

use crate::model::{AccountId, AccountKind};
use crate::strategies::{IncomeBreakdown, PeriodIndex, TaxModel};

/// Mutable mid-simulation view of one account, owned by the engine loop.
#[derive(Clone, Debug)]
pub struct AccountState {
    pub id: AccountId,
    pub kind: AccountKind,
    pub balance: f64,
    /// Cost basis (taxable accounts; 0 elsewhere). Withdrawals recover basis
    /// proportionally: gains fraction = 1 - basis/balance.
    pub cost_basis: f64,
}

impl AccountState {
    fn gains_fraction(&self) -> f64 {
        if self.balance <= 0.0 {
            return 0.0;
        }
        (1.0 - self.cost_basis / self.balance).clamp(0.0, 1.0)
    }
}

#[derive(Clone, Debug, Default)]
pub struct WithdrawalResult {
    /// Gross amount taken from each account.
    pub gross_by_account: BTreeMap<AccountId, f64>,
    /// Tax owed on the withdrawals (pre-tax → ordinary; taxable → gains).
    pub tax: f64,
    /// Net cash delivered after tax. May fall short of the request when the
    /// portfolio is depleted — the engine emits a warning in that case.
    pub net: f64,
}

/// Decides which accounts fund a spending shortfall. Implementations gross
/// up through the provided `TaxModel` so the *net* covers the need, and
/// mutate `accounts` (balances and basis) to record the withdrawal.
pub trait DrawdownStrategy {
    fn withdraw(
        &self,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        period: PeriodIndex,
    ) -> WithdrawalResult;
}

/// V1: withdraw from every funded account in proportion to its balance.
/// (V2 adds `OrderedDrawdown` — e.g. Taxable → Pre-Tax → Roth — behind the
/// same trait.)
pub struct ProportionalDrawdown;

impl DrawdownStrategy for ProportionalDrawdown {
    fn withdraw(
        &self,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        let total: f64 = accounts.iter().map(|a| a.balance.max(0.0)).sum();
        if net_needed <= 0.0 || total <= 0.0 {
            return WithdrawalResult::default();
        }

        // Income character of one gross dollar withdrawn proportionally.
        let breakdown_for = |gross: f64| {
            let mut income = IncomeBreakdown::default();
            for account in accounts.iter() {
                let share = account.balance.max(0.0) / total;
                let amount = gross * share;
                match account.kind {
                    AccountKind::TraditionalPreTax => income.ordinary += amount,
                    AccountKind::Taxable => {
                        let gains = amount * account.gains_fraction();
                        income.capital_gains += gains;
                        income.untaxed += amount - gains;
                    }
                    AccountKind::Roth => income.untaxed += amount,
                }
            }
            income
        };

        // Fixed-point gross-up: find gross so that gross - tax(gross) covers
        // the net need. Tax is monotone in gross, so this converges quickly
        // for any sane model; cap at the portfolio total (depletion).
        let tolerance = 1e-12 * net_needed.max(1.0);
        let mut gross = net_needed;
        for _ in 0..100 {
            let owed = tax.tax(&breakdown_for(gross), period).tax;
            let next = (net_needed + owed).min(total);
            if (next - gross).abs() < tolerance {
                gross = next;
                break;
            }
            gross = next;
        }

        let owed = tax.tax(&breakdown_for(gross), period).tax;
        let mut result = WithdrawalResult {
            gross_by_account: BTreeMap::new(),
            tax: owed,
            net: gross - owed,
        };

        for account in accounts.iter_mut() {
            let share = account.balance.max(0.0) / total;
            let amount = gross * share;
            if amount <= 0.0 {
                continue;
            }
            if account.balance > 0.0 {
                let basis_recovered = account.cost_basis * (amount / account.balance);
                account.cost_basis = (account.cost_basis - basis_recovered).max(0.0);
            }
            // Full depletion caps `gross` at the portfolio total, so this
            // subtraction lands on zero mathematically but can leave
            // floating-point residue (a tiny negative, or -0.0). Clamp
            // explicitly rather than with `max`, which is free to return
            // -0.0 for the -0.0/+0.0 pair.
            let remaining = account.balance - amount;
            account.balance = if remaining > 0.0 { remaining } else { 0.0 };
            result.gross_by_account.insert(account.id.clone(), amount);
        }
        result
    }
}
