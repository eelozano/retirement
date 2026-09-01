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
    /// The **marginal** tax the withdrawal costs: the period's bill with
    /// the withdrawal stacked on `base`, minus its bill on `base` alone.
    /// Not a standalone bill — the caller has already paid the tax on
    /// `base` and adds this on top (#54).
    pub tax: f64,
    /// Net cash delivered after tax. May fall short of the request when the
    /// portfolio is depleted — the engine emits a warning in that case.
    pub net: f64,
}

/// Decides which accounts fund a spending shortfall. Implementations gross
/// up through the provided `TaxModel` so the *net* covers the need, and
/// mutate `accounts` (balances and basis) to record the withdrawal.
///
/// `base` is the period's income before the withdrawal — the same income the
/// caller has already taxed. The gross-up stacks on top of it rather than
/// re-entering the brackets at $0, so a withdrawal is taxed at the
/// household's real marginal rate and can drag more of a Social Security
/// benefit into taxability (#54).
///
/// This does not hand the drawdown the household's mortality schedule, which
/// is the boundary `strategies::tax::SurvivorTax` protects: filing status
/// still arrives via `period`, and `base` says only what the household
/// earned.
pub trait DrawdownStrategy {
    fn withdraw(
        &self,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        base: &IncomeBreakdown,
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
        base: &IncomeBreakdown,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        let total: f64 = accounts.iter().map(|a| a.balance.max(0.0)).sum();
        if net_needed <= 0.0 || total <= 0.0 {
            return WithdrawalResult::default();
        }

        // Income character of one gross dollar withdrawn proportionally,
        // stacked on the income the household already has.
        let breakdown_for = |gross: f64| {
            let mut income = *base;
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

        // Fixed-point gross-up: find gross so that gross minus the tax that
        // gross *adds* covers the net need. The base bill is already paid,
        // so what has to be covered here is the marginal cost. With `base`
        // held fixed the marginal cost is still monotone in gross, so this
        // converges exactly as it did before; cap at the portfolio total
        // (depletion).
        let base_tax = tax.tax(base, period).tax;
        let marginal = |gross: f64| tax.tax(&breakdown_for(gross), period).tax - base_tax;

        let tolerance = 1e-12 * net_needed.max(1.0);
        let mut gross = net_needed;
        for _ in 0..100 {
            let next = (net_needed + marginal(gross)).min(total);
            if (next - gross).abs() < tolerance {
                gross = next;
                break;
            }
            gross = next;
        }

        let owed = marginal(gross);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FilingStatus, StateTaxProfile};
    use crate::strategies::BracketTax;

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{label}: expected {expected}, got {actual}"
        );
    }

    fn joint() -> BracketTax {
        BracketTax {
            filing_status: FilingStatus::MarriedFilingJointly,
            state_tax: StateTaxProfile::none(),
        }
    }

    fn account(id: &str, kind: AccountKind, balance: f64, cost_basis: f64) -> AccountState {
        AccountState {
            id: id.to_string(),
            kind,
            balance,
            cost_basis,
        }
    }

    fn pretax_only() -> Vec<AccountState> {
        vec![account(
            "401k",
            AccountKind::TraditionalPreTax,
            1_000_000.0,
            0.0,
        )]
    }

    /// The worked example from #54, married filing jointly with no state
    /// tax: $40,000 of Social Security and a $60,000 pre-tax withdrawal.
    ///
    /// The net need is picked so the gross-up lands on exactly $60,000
    /// (60,000 - 7,023), which makes every figure here hand-checkable
    /// against `BracketTax`.
    #[test]
    fn a_withdrawal_stacks_on_the_households_income_instead_of_restarting_the_brackets() {
        let tax = joint();
        let base = IncomeBreakdown {
            social_security: 40_000.0,
            ..Default::default()
        };
        let mut accounts = pretax_only();
        let result = ProportionalDrawdown.withdraw(52_977.0, &mut accounts, &tax, &base, 0);

        assert_close(accounts[0].balance, 940_000.0, "gross withdrawn");
        assert_close(result.net, 52_977.0, "net delivered");
        assert_close(result.tax, 7_023.0, "marginal cost of the withdrawal");

        // Taxed on its own — the two-pass model this replaced — the same
        // $60,000 costs $2,943: its own climb from the 10% bracket, its own
        // standard deduction, and no effect on the benefit's taxability.
        // That is 58% of the real bill missing.
        let standalone = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: 60_000.0,
                    ..Default::default()
                },
                0,
            )
            .tax;
        assert_close(standalone, 2_943.0, "standalone bill on the same dollars");
    }

    /// $40,000 of Social Security is federally untaxed on its own —
    /// provisional income is $20,000, under the $32,000 joint base. The
    /// withdrawal is what drags it into taxability, which a gross-up
    /// starting from `IncomeBreakdown::default()` could never see.
    #[test]
    fn a_withdrawal_can_make_social_security_taxable() {
        let tax = joint();
        let base = IncomeBreakdown {
            social_security: 40_000.0,
            ..Default::default()
        };
        assert_close(tax.tax(&base, 0).tax, 0.0, "the benefit alone is untaxed");

        let mut accounts = pretax_only();
        let result = ProportionalDrawdown.withdraw(52_977.0, &mut accounts, &tax, &base, 0);

        // Of the $7,023, the part that no separate pass could ever produce
        // is the tax on the $34,000 of benefit the withdrawal made taxable.
        assert!(
            result.tax > 2_943.0,
            "the withdrawal must cost more than its own standalone bill: {}",
            result.tax
        );
    }

    /// `WithdrawalResult::tax` is defined as the period's bill *with* the
    /// withdrawal minus its bill on `base` alone. Pinned over a mixed
    /// portfolio, so the capital-gains and untaxed characters are in play
    /// too, not just ordinary income.
    #[test]
    fn the_reported_tax_is_the_marginal_cost_over_the_base_income() {
        let tax = joint();
        let base = IncomeBreakdown {
            ordinary: 30_000.0,
            social_security: 45_000.0,
            ..Default::default()
        };
        let mut accounts = vec![
            account("401k", AccountKind::TraditionalPreTax, 600_000.0, 0.0),
            // Half gains: withdrawals realize $0.50 of gain per dollar.
            account("brokerage", AccountKind::Taxable, 300_000.0, 150_000.0),
            account("roth", AccountKind::Roth, 100_000.0, 0.0),
        ];
        let result = ProportionalDrawdown.withdraw(80_000.0, &mut accounts, &tax, &base, 0);

        let gross: f64 = result.gross_by_account.values().sum();
        let combined = IncomeBreakdown {
            ordinary: base.ordinary + 0.60 * gross,
            capital_gains: 0.15 * gross,
            untaxed: 0.25 * gross,
            social_security: base.social_security,
        };
        assert_close(
            tax.tax(&base, 0).tax + result.tax,
            tax.tax(&combined, 0).tax,
            "base bill plus marginal cost is the whole period's bill",
        );
        assert_close(result.net, 80_000.0, "the gross-up still covers the need");
    }

    /// A household with no other income is the one case the two models
    /// agreed on, and it has to stay agreed on: with an empty `base` the
    /// marginal cost *is* the standalone bill.
    #[test]
    fn with_no_other_income_the_marginal_cost_is_the_standalone_bill() {
        let tax = joint();
        let mut accounts = pretax_only();
        let result = ProportionalDrawdown.withdraw(
            52_977.0,
            &mut accounts,
            &tax,
            &IncomeBreakdown::default(),
            0,
        );

        let gross: f64 = result.gross_by_account.values().sum();
        assert_close(
            result.tax,
            tax.tax(
                &IncomeBreakdown {
                    ordinary: gross,
                    ..Default::default()
                },
                0,
            )
            .tax,
            "no base income, no difference",
        );
    }

    /// Depletion still caps the gross at the portfolio total and reports a
    /// short `net`, which is what the engine's `DepletedFunds` warning keys
    /// off.
    #[test]
    fn a_need_beyond_the_portfolio_is_capped_and_reported_short() {
        let tax = joint();
        let mut accounts = vec![account(
            "401k",
            AccountKind::TraditionalPreTax,
            50_000.0,
            0.0,
        )];
        let base = IncomeBreakdown {
            social_security: 40_000.0,
            ..Default::default()
        };
        let result = ProportionalDrawdown.withdraw(200_000.0, &mut accounts, &tax, &base, 0);

        assert_close(accounts[0].balance, 0.0, "portfolio fully drained");
        assert_close(
            result.gross_by_account["401k"],
            50_000.0,
            "gross capped at the balance",
        );
        assert!(
            result.net < 200_000.0,
            "a capped withdrawal must fall short: {}",
            result.net
        );
    }
}
