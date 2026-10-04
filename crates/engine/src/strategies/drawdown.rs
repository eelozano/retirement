use std::collections::BTreeMap;

use crate::model::{AccountId, AccountKind, YearMonth};
use crate::sim::MagiOverrun;
use crate::strategies::{IncomeBreakdown, PeriodIndex, TaxModel};

/// Mutable mid-simulation view of one account, owned by the engine loop.
#[derive(Clone, Debug)]
pub struct AccountState {
    pub id: AccountId,
    pub kind: AccountKind,
    pub balance: f64,
    /// After-tax dollars in the balance: a taxable account's cost basis, a
    /// Roth's contributions; 0 elsewhere. A taxable withdrawal recovers it
    /// proportionally (gains fraction = 1 - basis/balance), and so does a
    /// Roth employer plan; a Roth IRA pays it out first (`basis_first`).
    pub cost_basis: f64,
    /// A Roth IRA: withdrawals come out of contributions before earnings.
    pub basis_first: bool,
    /// When this account's withdrawals stop being early. Fixed for the run.
    pub early: EarlyAccess,
    /// Share of this period's withdrawals from this account that fall
    /// before its owner's 59½, when a Roth's earnings are ordinary income:
    /// `early`, over the months being drawn for. Set every period by the
    /// simulation; a strategy drawing for only part of a period may narrow
    /// it to those months. 0 outside the simulation.
    pub nonqualified: f64,
    /// Share of this period's withdrawals that carry the 10% additional
    /// tax — `nonqualified`'s months, less any the Rule of 55 or a 457(b)
    /// exempts. On a pre-tax account it applies to the whole draw; on a
    /// Roth, to the earnings only.
    pub penalized: f64,
}

/// One account's early-withdrawal rules, as the months they stop applying —
/// resolved once per run by `sim::early_access`. `None` means the rule never
/// applies to this account.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EarlyAccess {
    /// Until this month, a Roth's earnings are ordinary income when drawn.
    pub nonqualified_until: Option<YearMonth>,
    /// Until this month, a draw carries the 10% additional tax.
    pub penalized_until: Option<YearMonth>,
}

impl EarlyAccess {
    /// The shares of the months `[start, end)` that fall before each date:
    /// `(nonqualified, penalized)`.
    pub fn shares(&self, start: YearMonth, end: YearMonth) -> (f64, f64) {
        let before = |until: Option<YearMonth>| {
            let months = start.months_until(end);
            match until {
                Some(until) if months > 0 => {
                    start.months_until(until.min(end)).max(0) as f64 / months as f64
                }
                _ => 0.0,
            }
        };
        (
            before(self.nonqualified_until),
            before(self.penalized_until),
        )
    }
}

/// The rate of the additional tax on an early distribution, IRC §72(t).
/// Statute with no annual publication, so a constant rather than a
/// `TaxFigures` entry.
pub const EARLY_WITHDRAWAL_PENALTY_RATE: f64 = 0.10;

impl AccountState {
    pub(super) fn gains_fraction(&self) -> f64 {
        if self.balance <= 0.0 {
            return 0.0;
        }
        (1.0 - self.cost_basis / self.balance).clamp(0.0, 1.0)
    }

    /// The earnings in a Roth withdrawal of `amount` — the part that is not
    /// a return of contributions.
    fn roth_earnings(&self, amount: f64) -> f64 {
        if self.basis_first {
            (amount - self.cost_basis.max(0.0)).max(0.0)
        } else {
            amount * self.gains_fraction()
        }
    }

    /// Basis a withdrawal of `amount` returns, under the account's ordering.
    fn basis_recovered(&self, amount: f64) -> f64 {
        if self.basis_first {
            amount.min(self.cost_basis.max(0.0))
        } else if self.balance > 0.0 {
            self.cost_basis * (amount / self.balance)
        } else {
            0.0
        }
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
    /// The part of `tax` that is the early-withdrawal penalty.
    pub penalty: f64,
    /// Accounts whose held-back floor this withdrawal had to dip into, in
    /// the order they were released. Always empty for a strategy with no
    /// floors.
    pub floors_released: Vec<AccountId>,
    /// Net cash delivered after tax. May fall short of the request when the
    /// portfolio is depleted — the engine emits a warning in that case.
    pub net: f64,
    /// The period's income with this withdrawal stacked on `base`: what the
    /// tax was assessed on, and what a second withdrawal in the same period
    /// stacks on in turn. `base` itself when nothing was drawn, so the
    /// snapshot's MAGI reads it without asking whether a draw happened.
    pub income: IncomeBreakdown,
    /// A MAGI-target phase drew this period and the year's MAGI still ended
    /// above its target. Always `None` for a strategy with no targets.
    pub magi_target_missed: Option<MagiTargetMiss>,
}

/// A year a MAGI-target phase could not stay under its target, in nominal
/// dollars — what `SimWarning::MagiTargetExceeded` reports.
#[derive(Clone, Debug, PartialEq)]
pub struct MagiTargetMiss {
    pub phase: String,
    pub target: f64,
    pub magi: f64,
    pub reason: MagiOverrun,
}

impl WithdrawalResult {
    /// A withdrawal of nothing: the period's income is still `base`.
    pub fn none(base: &IncomeBreakdown) -> Self {
        Self {
            income: *base,
            ..Default::default()
        }
    }
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

    /// The id of the drawdown phase in force at the start of `period`, for
    /// a strategy that has phases — what `PeriodSnapshot::drawdown_phase`
    /// reports.
    fn phase(&self, _period: PeriodIndex) -> Option<&str> {
        None
    }
}

/// Income character of a set of withdrawals, stacked on the income the
/// household already has, and the part of them that carries the
/// early-withdrawal penalty. `amounts` is parallel to `accounts`.
///
/// The one place a withdrawn dollar is classified, so a drawdown impl decides
/// only *which* accounts a gross amount comes from and never how it is
/// taxed.
///
/// The penalty is not income and is kept out of `IncomeBreakdown`: it is a
/// flat 10% of a known amount, so it never interacts with the brackets, and
/// keeping it outside the `TaxModel` is what lets the snapshot report it as
/// an exact share of the bill rather than an estimate.
pub(super) fn income_with(
    base: &IncomeBreakdown,
    accounts: &[AccountState],
    amounts: &[f64],
) -> (IncomeBreakdown, f64) {
    let mut income = *base;
    let mut penalized = 0.0;
    for (account, &amount) in accounts.iter().zip(amounts) {
        match account.kind {
            AccountKind::TraditionalPreTax => {
                income.ordinary += amount;
                penalized += amount * account.penalized;
            }
            // Contributions come back untaxed at any age. Earnings are
            // untaxed once qualified; before 59½ they are ordinary income,
            // and carry the penalty unless an exemption covers them.
            AccountKind::Roth => {
                let earnings = account.roth_earnings(amount);
                let taxed = earnings * account.nonqualified;
                income.ordinary += taxed;
                income.untaxed += amount - taxed;
                penalized += earnings * account.penalized;
            }
            AccountKind::Taxable => {
                let gains = amount * account.gains_fraction();
                income.capital_gains += gains;
                income.untaxed += amount - gains;
            }
            // A savings account's interest is already taxed as it
            // accrues (`sim::period::accrue_interest`), not deferred
            // to withdrawal — see `AccountKind::Savings`. Assumes
            // qualified medical spending for HSA — see `AccountKind::Hsa`.
            AccountKind::Hsa | AccountKind::Savings => income.untaxed += amount,
        }
    }
    (income, penalized)
}

/// The gross withdrawal whose net covers `net_needed`: the `gross` with
/// `gross - cost(gross) = net_needed`, capped at `available`.
///
/// First the fixed-point iteration `gross = net_needed + cost(gross)`, which
/// is what every drawdown before #187 converged under, and still does: its
/// answer is returned exactly as it always was. It converges when the cost
/// rises slower than the gross. A MAGI-target phase breaks that: in the band
/// where MAGI is pinned at the target, each extra dollar turns pre-tax
/// income into capital gains, so the cost *falls*, and against a brokerage
/// that is mostly gain it falls faster than a dollar per dollar and the
/// iteration oscillates.
///
/// What holds for every strategy is that `gross - cost(gross)` is
/// continuous and increasing — no marginal rate reaches 100%, and in the
/// pinned band the cost is falling — so when the iteration exhausts its
/// rounds, bisection on `[net_needed, available]` finds the one answer. It
/// returns the upper end of its bracket: the smallest gross found whose net
/// covers the need, which is also the defined answer at a discontinuity
/// (ARCHITECTURE.md, "Where the current design pushes back" #3).
pub(super) fn solve(net_needed: f64, available: f64, mut cost: impl FnMut(f64) -> f64) -> f64 {
    let tolerance = 1e-12 * net_needed.max(1.0);
    let mut gross = net_needed;
    for _ in 0..100 {
        let next = (net_needed + cost(gross)).min(available);
        if (next - gross).abs() < tolerance {
            return next;
        }
        gross = next;
    }

    let mut lo = net_needed.min(available);
    let mut hi = available;
    if hi - cost(hi) < net_needed {
        // Even everything the strategy can supply falls short: depletion.
        return hi;
    }
    for _ in 0..200 {
        if hi - lo <= tolerance {
            break;
        }
        let mid = 0.5 * (lo + hi);
        if mid - cost(mid) < net_needed {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    hi
}

/// The gross-up every `DrawdownStrategy` shares: find the gross withdrawal
/// whose net, after the tax it *adds* over `base`, covers `net_needed`, then
/// take it out of `accounts`.
///
/// `allocate(gross, accounts, out)` is the strategy: it writes into `out`,
/// parallel to `accounts`, how much of `gross` each account supplies. It is
/// called once per round with the balances as they stood on entry, so it
/// must be a pure function of its arguments, never draw an account below
/// zero, and be continuous in `gross` such that the net it leaves,
/// `gross - marginal(gross)`, rises with `gross` — [`solve`] relies on
/// that. A waterfall that only ever adds to each account meets it; so does
/// a MAGI-target phase, whose pre-tax draw *falls* as the gross rises
/// through the band pinned at the target.
///
/// `available` caps `gross` and is what depletion means: the most the
/// strategy can supply. Callers return early when either `net_needed` or
/// `available` is not positive.
///
/// The result's `income` is the period's income with the withdrawal stacked
/// on `base`.
pub(super) fn gross_up(
    net_needed: f64,
    available: f64,
    accounts: &mut [AccountState],
    tax: &dyn TaxModel,
    base: &IncomeBreakdown,
    period: PeriodIndex,
    allocate: impl Fn(f64, &[AccountState], &mut [f64]),
) -> WithdrawalResult {
    let mut amounts = vec![0.0; accounts.len()];

    // Find gross so that gross minus the tax that gross *adds* covers the
    // net need. The base bill is already paid, so what has to be covered
    // here is the marginal cost; cap at what the strategy can supply
    // (depletion).
    let base_tax = tax.tax(base, period).tax;
    // The marginal cost of `gross`, and the penalty's share of it. The
    // penalty is linear in the draw, so it never stops the net rising.
    let mut marginal = |gross: f64| {
        allocate(gross, accounts, &mut amounts);
        let (income, penalized) = income_with(base, accounts, &amounts);
        let penalty = penalized * EARLY_WITHDRAWAL_PENALTY_RATE;
        (
            tax.tax(&income, period).tax - base_tax + penalty,
            penalty,
            income,
        )
    };

    let gross = solve(net_needed, available, |gross| marginal(gross).0);

    let (owed, penalty, income) = marginal(gross);
    // `marginal` has just allocated `gross` itself, so `amounts` now holds
    // exactly what is withdrawn.
    let mut result = WithdrawalResult {
        gross_by_account: BTreeMap::new(),
        tax: owed,
        penalty,
        net: gross - owed,
        floors_released: Vec::new(),
        income,
        magi_target_missed: None,
    };

    for (account, &amount) in accounts.iter_mut().zip(&amounts) {
        if amount <= 0.0 {
            continue;
        }
        let basis_recovered = account.basis_recovered(amount);
        account.cost_basis = (account.cost_basis - basis_recovered).max(0.0);
        // Full depletion caps `gross` at what is available, so this
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

/// Withdraw from every funded account in proportion to its balance — the
/// default policy, `DrawdownPolicy::Proportional`. `PhasedDrawdown` is the
/// ordered alternative.
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
            return WithdrawalResult::none(base);
        }
        gross_up(
            net_needed,
            total,
            accounts,
            tax,
            base,
            period,
            |gross, accounts, out| {
                for (account, amount) in accounts.iter().zip(out.iter_mut()) {
                    *amount = gross * (account.balance.max(0.0) / total);
                }
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FilingStatus, PriceLevel, StateTaxProfile};
    use crate::strategies::BracketTax;

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{label}: expected {expected}, got {actual}"
        );
    }

    fn joint() -> BracketTax {
        {
            let figures = crate::model::TaxFigures::tax_year_2026();
            BracketTax::new(
                &figures,
                FilingStatus::MarriedFilingJointly,
                StateTaxProfile::none(),
                PriceLevel::Constant(0.0),
                figures.tax_year,
                vec![],
            )
        }
    }

    fn account(id: &str, kind: AccountKind, balance: f64, cost_basis: f64) -> AccountState {
        AccountState {
            id: id.to_string(),
            kind,
            balance,
            cost_basis,
            basis_first: false,
            early: EarlyAccess::default(),
            nonqualified: 0.0,
            penalized: 0.0,
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
    /// (60,000 - 6,920), which makes every figure here hand-checkable
    /// against `BracketTax`.
    #[test]
    fn a_withdrawal_stacks_on_the_households_income_instead_of_restarting_the_brackets() {
        let tax = joint();
        let base = IncomeBreakdown {
            social_security: 40_000.0,
            ..Default::default()
        };
        let mut accounts = pretax_only();
        let result = ProportionalDrawdown.withdraw(53_080.0, &mut accounts, &tax, &base, 0);

        assert_close(accounts[0].balance, 940_000.0, "gross withdrawn");
        assert_close(result.net, 53_080.0, "net delivered");
        assert_close(result.tax, 6_920.0, "marginal cost of the withdrawal");

        // Taxed on its own — the two-pass model this replaced — the same
        // $60,000 costs $2,840: its own climb from the 10% bracket, its own
        // standard deduction, and no effect on the benefit's taxability.
        // That is 59% of the real bill missing.
        let standalone = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: 60_000.0,
                    ..Default::default()
                },
                0,
            )
            .tax;
        assert_close(standalone, 2_840.0, "standalone bill on the same dollars");
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
        let result = ProportionalDrawdown.withdraw(53_080.0, &mut accounts, &tax, &base, 0);

        // Of the $6,920, the part that no separate pass could ever produce
        // is the tax on the $34,000 of benefit the withdrawal made taxable.
        assert!(
            result.tax > 2_840.0,
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
            53_080.0,
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

    /// An HSA behaves like a Roth at withdrawal time (untaxed), even though
    /// its contributions were pre-tax — the one combination neither `Roth`
    /// nor `TraditionalPreTax` alone captures.
    #[test]
    fn an_hsa_withdrawal_is_untaxed_like_a_roth() {
        let tax = joint();
        let mut hsa = vec![account("hsa", AccountKind::Hsa, 100_000.0, 0.0)];
        let mut roth = vec![account("roth", AccountKind::Roth, 100_000.0, 0.0)];
        let base = IncomeBreakdown::default();

        let hsa_result = ProportionalDrawdown.withdraw(50_000.0, &mut hsa, &tax, &base, 0);
        let roth_result = ProportionalDrawdown.withdraw(50_000.0, &mut roth, &tax, &base, 0);

        assert_close(hsa_result.tax, 0.0, "no tax on the HSA withdrawal");
        assert_close(
            hsa_result.net,
            roth_result.net,
            "same net as an equivalent Roth",
        );
    }

    /// A savings account's interest is already taxed as it accrues
    /// (`sim::period::accrue_interest`), so a withdrawal is a movement of
    /// already-taxed dollars — untaxed here, same as a Roth or an HSA.
    #[test]
    fn a_savings_withdrawal_is_untaxed_its_interest_was_taxed_when_earned() {
        let tax = joint();
        let mut savings = vec![account("savings", AccountKind::Savings, 100_000.0, 0.0)];
        let mut roth = vec![account("roth", AccountKind::Roth, 100_000.0, 0.0)];
        let base = IncomeBreakdown::default();

        let savings_result = ProportionalDrawdown.withdraw(50_000.0, &mut savings, &tax, &base, 0);
        let roth_result = ProportionalDrawdown.withdraw(50_000.0, &mut roth, &tax, &base, 0);

        assert_close(savings_result.tax, 0.0, "no tax on the savings withdrawal");
        assert_close(
            savings_result.net,
            roth_result.net,
            "same net as an equivalent Roth",
        );
    }

    /// A cost that falls faster than a dollar per dollar sends the fixed
    /// point round a cycle — 100 → 160 → 100 — where the MAGI-target band
    /// can send it. The net `gross - cost` still rises (4 per dollar here),
    /// so the bracketed search finds the one gross that covers the need:
    /// 4·G − 360 = 100 at G = 115.
    #[test]
    fn a_cost_falling_faster_than_the_gross_is_solved_by_bisection() {
        let cost = |gross: f64| (3.0 * (120.0 - gross)).max(0.0);
        let mut gross = 100.0;
        for _ in 0..100 {
            gross = 100.0 + cost(gross);
        }
        assert!(
            gross == 100.0 || gross == 160.0,
            "the fixed point alone cycles: {gross}"
        );

        let solved = solve(100.0, 1_000.0, cost);
        assert!((solved - 115.0).abs() < 1e-9, "solved at {solved}");
        assert!(solved - cost(solved) >= 100.0, "the answer covers the need");
        // And depletion still caps it.
        assert_eq!(solve(100.0, 110.0, cost), 110.0);
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
