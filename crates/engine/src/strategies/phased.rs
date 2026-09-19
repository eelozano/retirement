//! `DrawdownPolicy::Phased`: a shortfall paid down an ordered stack of
//! accounts, instead of by every account in proportion to its balance.
//!
//! A withdrawal is a **waterfall over tranches**. A tranche is a slice of
//! one or more accounts' balances with a capacity; a gross amount fills the
//! first tranche to capacity, then the second, and so on. Within a tranche
//! the draw is split across its accounts in proportion to their share of
//! it. The tranches, in order:
//!
//! 1. **The stack**, entry by entry, down to each entry's floor.
//! 2. **The fallback** — every funded account the stack does not name — so
//!    a stack that runs dry never reports the plan as failing while money
//!    remains. Penalty-free money first, then penalized money, and within
//!    each by kind: savings, taxable, pre-tax, Roth, HSA. A Roth IRA's
//!    contributions are penalty-free at any age, so before 59½ that one
//!    account is split, contributions into the first half and earnings into
//!    the second.
//! 3. **The floors**, in stack order. A floor holds until everything else
//!    is spent and is then released rather than kept: a hard floor would
//!    report the plan as out of money with money in the bank, and pull the
//!    success rate down with it.
//!
//! A waterfall is continuous and non-decreasing in the gross, which is what
//! `gross_up`'s fixed point needs, and it never draws an account past its
//! balance, since the tranches of any one account sum to at most that
//! balance.

use crate::model::{AccountKind, DrawdownPolicy, Plan, StackSource, YearMonth};
use crate::sim::calendar_period;

use super::drawdown::gross_up;
use super::WithdrawalResult;
use super::{AccountState, DrawdownStrategy, IncomeBreakdown, PeriodIndex, TaxModel};

/// The fallback's kind order: cash that is already taxed, then the account
/// whose draws are taxed at capital-gains rates, then ordinary income, then
/// the tax-free accounts last so they keep compounding the longest.
const FALLBACK_ORDER: [AccountKind; 5] = [
    AccountKind::Savings,
    AccountKind::Taxable,
    AccountKind::TraditionalPreTax,
    AccountKind::Roth,
    AccountKind::Hsa,
];

/// One stack entry, resolved to the accounts it draws from.
#[derive(Debug)]
struct Rung {
    /// Indices into the account list, parallel to `plan.accounts`.
    members: Vec<usize>,
    /// In today's dollars; grown with inflation to the period it applies in.
    floor: f64,
}

#[derive(Debug)]
struct Phase {
    rungs: Vec<Rung>,
    /// Accounts no rung names, in plan order: the fallback's members.
    unlisted: Vec<usize>,
}

/// A slice of balances drawn together.
struct Tranche {
    /// `(account index, share)` — the draw is split by share.
    members: Vec<(usize, f64)>,
    capacity: f64,
    /// The rung whose floor this is, for a floor-release tranche.
    releases: Option<usize>,
}

pub struct PhasedDrawdown {
    phases: Vec<Phase>,
    start: YearMonth,
    inflation: f64,
}

impl PhasedDrawdown {
    /// `None` for a plan whose policy is not `Phased`.
    ///
    /// Stack entries are resolved here, once: an `Account` entry to its
    /// index, a `Kind` entry to every account of that kind no earlier entry
    /// named. An account named twice is drawn where it is first named. An
    /// entry naming an account the plan does not have resolves to nothing —
    /// validation refuses one, so only an unvalidated plan reaches it.
    pub fn new(plan: &Plan) -> Option<Self> {
        let DrawdownPolicy::Phased(phases) = &plan.assumptions.drawdown else {
            return None;
        };
        let phases = phases
            .iter()
            .map(|phase| {
                let mut claimed = vec![false; plan.accounts.len()];
                let rungs = phase
                    .stack
                    .iter()
                    .map(|entry| {
                        let members: Vec<usize> = plan
                            .accounts
                            .iter()
                            .enumerate()
                            .filter(|(i, account)| {
                                !claimed[*i]
                                    && match &entry.source {
                                        StackSource::Account(id) => &account.id == id,
                                        StackSource::Kind(kind) => account.kind == *kind,
                                    }
                            })
                            .map(|(i, _)| i)
                            .collect();
                        for &i in &members {
                            claimed[i] = true;
                        }
                        Rung {
                            members,
                            floor: entry.floor.max(0.0),
                        }
                    })
                    .collect();
                let unlisted = (0..plan.accounts.len()).filter(|&i| !claimed[i]).collect();
                Phase { rungs, unlisted }
            })
            .collect();
        Some(PhasedDrawdown {
            phases,
            start: plan.sim_config.start,
            inflation: plan.assumptions.inflation,
        })
    }

    /// The phase in force in `period`. One phase for now: validation allows
    /// no more until phase boundaries are resolved.
    fn phase(&self, _period: PeriodIndex) -> Option<&Phase> {
        self.phases.first()
    }

    /// What a today's-dollar floor is worth in `period`: grown by inflation
    /// to the period's start, the same exponent every inflation-grown figure
    /// and the deflator use.
    fn floor_factor(&self, period: PeriodIndex) -> f64 {
        let (period_start, _) = calendar_period(self.start, period);
        let years = self.start.months_until(period_start) as f64 / 12.0;
        (1.0 + self.inflation).powf(years)
    }
}

/// The tranches of one period's withdrawal, from the balances as they
/// stand when it starts.
fn tranches(phase: &Phase, accounts: &[AccountState], floor_factor: f64) -> Vec<Tranche> {
    let funded = |i: &usize| accounts[*i].balance > 0.0;
    let by_balance = |members: &[usize]| -> Vec<(usize, f64)> {
        members
            .iter()
            .filter(|i| funded(i))
            .map(|&i| (i, accounts[i].balance))
            .collect()
    };

    let mut out = Vec::new();
    let mut floors = Vec::new();
    for (rung_index, rung) in phase.rungs.iter().enumerate() {
        let members = by_balance(&rung.members);
        let total: f64 = members.iter().map(|(_, b)| b).sum();
        let floor = (rung.floor * floor_factor).min(total);
        out.push(Tranche {
            members: members.clone(),
            capacity: total - floor,
            releases: None,
        });
        floors.push(Tranche {
            members,
            capacity: floor,
            releases: Some(rung_index),
        });
    }

    // The fallback, as (penalized?, kind) groups. A Roth IRA before 59½
    // splits: contributions are free at any age.
    let mut groups: Vec<Vec<(usize, f64)>> = vec![Vec::new(); 2 * FALLBACK_ORDER.len()];
    let group = |penalized: bool, kind: AccountKind| {
        let position = FALLBACK_ORDER.iter().position(|k| *k == kind).unwrap_or(0);
        usize::from(penalized) * FALLBACK_ORDER.len() + position
    };
    for &i in phase.unlisted.iter().filter(|i| funded(i)) {
        let account = &accounts[i];
        if account.penalized <= 0.0 {
            groups[group(false, account.kind)].push((i, account.balance));
        } else if account.basis_first {
            let basis = account.cost_basis.clamp(0.0, account.balance);
            if basis > 0.0 {
                groups[group(false, account.kind)].push((i, basis));
            }
            if account.balance > basis {
                groups[group(true, account.kind)].push((i, account.balance - basis));
            }
        } else {
            groups[group(true, account.kind)].push((i, account.balance));
        }
    }
    for members in groups.into_iter().filter(|g| !g.is_empty()) {
        let capacity = members.iter().map(|(_, share)| share).sum();
        out.push(Tranche {
            members,
            capacity,
            releases: None,
        });
    }

    out.extend(floors);
    out.retain(|t| t.capacity > 0.0);
    out
}

/// Fills `out` (parallel to the accounts) with the draw that `gross` makes
/// down the waterfall.
fn pour(tranches: &[Tranche], gross: f64, out: &mut [f64]) {
    out.fill(0.0);
    let mut remaining = gross;
    for tranche in tranches {
        if remaining <= 0.0 {
            break;
        }
        let take = remaining.min(tranche.capacity);
        let shares: f64 = tranche.members.iter().map(|(_, s)| s).sum();
        for &(i, share) in &tranche.members {
            out[i] += take * share / shares;
        }
        remaining -= take;
    }
}

impl DrawdownStrategy for PhasedDrawdown {
    fn withdraw(
        &self,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        base: &IncomeBreakdown,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        let Some(phase) = self.phase(period) else {
            return WithdrawalResult::default();
        };
        let tranches = tranches(phase, accounts, self.floor_factor(period));
        let available: f64 = tranches.iter().map(|t| t.capacity).sum();
        if net_needed <= 0.0 || available <= 0.0 {
            return WithdrawalResult::default();
        }

        let ids: Vec<_> = accounts.iter().map(|a| a.id.clone()).collect();
        let mut result = gross_up(
            net_needed,
            available,
            accounts,
            tax,
            base,
            period,
            |gross, _, out| pour(&tranches, gross, out),
        );

        // Which floors the final gross reached: every release tranche the
        // waterfall got to.
        let gross: f64 = result.gross_by_account.values().sum();
        let mut poured = 0.0;
        for tranche in &tranches {
            if poured >= gross - available * 1e-12 {
                break;
            }
            if let Some(rung) = tranche.releases {
                for &i in &phase.rungs[rung].members {
                    if tranche.members.iter().any(|(m, _)| *m == i)
                        && !result.floors_released.contains(&ids[i])
                    {
                        result.floors_released.push(ids[i].clone());
                    }
                }
            }
            poured += tranche.capacity;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        DrawdownPhase, FilingStatus, PhaseStart, StackEntry, StateTaxProfile, StreamBoundary,
    };
    use crate::presets::seed_plan;
    use crate::strategies::BracketTax;

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{label}: expected {expected}, got {actual}"
        );
    }

    fn joint() -> BracketTax {
        let figures = crate::model::TaxFigures::built_in();
        BracketTax::new(
            &figures,
            FilingStatus::MarriedFilingJointly,
            StateTaxProfile::none(),
            0.0,
            figures.tax_year,
        )
    }

    fn state(id: &str, kind: AccountKind, balance: f64, cost_basis: f64) -> AccountState {
        AccountState {
            id: id.to_string(),
            kind,
            balance,
            cost_basis,
            basis_first: false,
            nonqualified: 0.0,
            penalized: 0.0,
        }
    }

    /// The seed plan's three accounts — brokerage, Alex's 401(k), Jordan's
    /// Roth IRA — under a one-phase stack, with zero inflation so floors are
    /// the figures typed.
    fn phased(stack: Vec<StackEntry>) -> PhasedDrawdown {
        let mut plan = seed_plan();
        plan.assumptions.inflation = 0.0;
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            stack,
        }]);
        PhasedDrawdown::new(&plan).expect("a phased policy")
    }

    fn entry(source: StackSource, floor: f64) -> StackEntry {
        StackEntry { source, floor }
    }

    fn accounts() -> Vec<AccountState> {
        vec![
            state(
                "taxable-brokerage",
                AccountKind::Taxable,
                100_000.0,
                100_000.0,
            ),
            state("alex-401k", AccountKind::TraditionalPreTax, 500_000.0, 0.0),
            state("jordan-roth", AccountKind::Roth, 200_000.0, 0.0),
        ]
    }

    /// A draw the first entry can cover never touches the second.
    #[test]
    fn the_stack_is_drawn_strictly_in_order() {
        let drawdown = phased(vec![
            entry(StackSource::Account("jordan-roth".to_string()), 0.0),
            entry(StackSource::Account("alex-401k".to_string()), 0.0),
        ]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            150_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["jordan-roth"],
            150_000.0,
            "Roth first",
        );
        assert_eq!(result.gross_by_account.len(), 1, "nothing else touched");
        assert_close(result.tax, 0.0, "a qualified Roth draw is untaxed");

        // Past the first entry, the second picks up the rest.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            250_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[2].balance, 0.0, "Roth emptied");
        assert!(
            result.gross_by_account["alex-401k"] > 50_000.0,
            "then the 401(k), grossed up"
        );
        assert_close(result.net, 250_000.0, "the need is still met");
        assert!(!result.gross_by_account.contains_key("taxable-brokerage"));
    }

    /// Accounts the stack does not name are drawn after it, in the fallback
    /// order: taxable before pre-tax before Roth.
    #[test]
    fn unlisted_accounts_fall_back_in_tax_order() {
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            120_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["taxable-brokerage"],
            100_000.0,
            "taxable first",
        );
        // $20,000 of ordinary income sits under the joint standard
        // deduction, so it is drawn untaxed.
        assert_close(
            result.gross_by_account["alex-401k"],
            20_000.0,
            "then pre-tax",
        );
        assert!(
            !result.gross_by_account.contains_key("jordan-roth"),
            "Roth last"
        );
    }

    /// Before 59½ the fallback takes penalty-free money first — even a Roth,
    /// which otherwise comes last — and a Roth IRA's contributions count as
    /// penalty-free while its earnings do not.
    #[test]
    fn the_fallback_takes_penalized_money_last() {
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        accounts[0].balance = 0.0;
        accounts[1].penalized = 1.0;
        accounts[2].penalized = 1.0;
        accounts[2].nonqualified = 1.0;
        accounts[2].basis_first = true;
        accounts[2].cost_basis = 30_000.0;

        let result = drawdown.withdraw(
            50_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        // $30,000 of Roth contributions, then penalized pre-tax — which the
        // order puts ahead of penalized Roth earnings.
        assert_close(
            result.gross_by_account["jordan-roth"],
            30_000.0,
            "contributions only",
        );
        assert!(result.gross_by_account["alex-401k"] > 20_000.0);
        assert!(result.penalty > 0.0);
    }

    /// A `Kind` entry draws every account of that kind together, in
    /// proportion to balance.
    #[test]
    fn a_kind_entry_splits_by_balance() {
        let mut plan = seed_plan();
        let mut second = plan.accounts[2].clone();
        second.id = "second-roth".to_string();
        plan.accounts.push(second);
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            stack: vec![entry(StackSource::Kind(AccountKind::Roth), 0.0)],
        }]);
        let drawdown = PhasedDrawdown::new(&plan).unwrap();
        let mut accounts = accounts();
        accounts.push(state("second-roth", AccountKind::Roth, 600_000.0, 0.0));

        let result = drawdown.withdraw(
            80_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["jordan-roth"],
            20_000.0,
            "a quarter",
        );
        assert_close(
            result.gross_by_account["second-roth"],
            60_000.0,
            "three quarters",
        );
    }

    /// A floor holds until everything else — the rest of the stack and the
    /// fallback — is spent, then gives way rather than failing the plan, and
    /// says which account it came from.
    #[test]
    fn a_floor_is_released_last_and_reported() {
        let drawdown = phased(vec![entry(
            StackSource::Account("taxable-brokerage".to_string()),
            40_000.0,
        )]);

        // Within what is above the floor: no release.
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            60_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[0].balance, 40_000.0, "stops at the floor");
        assert!(result.floors_released.is_empty());

        // Past it: the fallback pays before the floor does.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            100_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[0].balance, 40_000.0, "the floor still holds");
        assert!(result.gross_by_account["alex-401k"] > 40_000.0);
        assert!(result.floors_released.is_empty());

        // Only when everything else is gone.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            790_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert!(accounts[0].balance < 40_000.0, "released");
        assert_eq!(
            result.floors_released,
            vec!["taxable-brokerage".to_string()]
        );
        for account in &accounts {
            assert!(account.balance >= 0.0, "{} went negative", account.id);
        }
    }

    /// Everything the household holds is reachable, and no further: a need
    /// beyond the portfolio empties every account to exactly zero and
    /// reports the shortfall.
    #[test]
    fn depletion_empties_every_account_and_no_more() {
        let drawdown = phased(vec![entry(
            StackSource::Account("jordan-roth".to_string()),
            50_000.0,
        )]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            5_000_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        for account in &accounts {
            assert_eq!(account.balance, 0.0, "{} not emptied", account.id);
        }
        assert_close(
            result.gross_by_account.values().sum(),
            800_000.0,
            "the whole portfolio",
        );
        assert!(result.net < 5_000_000.0);
    }

    /// The one-tax-stack invariant holds through the waterfall: the base
    /// bill plus the reported marginal cost is the bill on everything.
    #[test]
    fn the_reported_tax_is_the_marginal_cost_over_the_base_income() {
        let tax = joint();
        let base = IncomeBreakdown {
            ordinary: 30_000.0,
            social_security: 45_000.0,
            ..Default::default()
        };
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        // Half gains, so the taxable tranche realizes some.
        accounts[0].cost_basis = 50_000.0;
        let result = drawdown.withdraw(150_000.0, &mut accounts, &tax, &base, 0);

        let taxable = result.gross_by_account["taxable-brokerage"];
        let pretax = result.gross_by_account["alex-401k"];
        let combined = IncomeBreakdown {
            ordinary: base.ordinary + pretax,
            capital_gains: 0.5 * taxable,
            untaxed: 0.5 * taxable,
            social_security: base.social_security,
        };
        assert_close(
            tax.tax(&base, 0).tax + result.tax,
            tax.tax(&combined, 0).tax,
            "base bill plus marginal cost is the whole period's bill",
        );
        assert_close(result.net, 150_000.0, "the gross-up covers the need");
    }

    /// Floors are today's dollars: at 3% inflation a $10,000 floor holds
    /// back $10,000 × 1.03¹⁰ ten years in.
    #[test]
    fn a_floor_grows_with_inflation() {
        let mut plan = seed_plan();
        plan.assumptions.inflation = 0.03;
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            stack: vec![entry(
                StackSource::Account("taxable-brokerage".to_string()),
                10_000.0,
            )],
        }]);
        let drawdown = PhasedDrawdown::new(&plan).unwrap();
        // The seed plan starts in January, so period 10 is ten whole years on.
        assert_close(
            drawdown.floor_factor(10),
            1.03f64.powf(10.0),
            "ten years of inflation",
        );
    }
}
