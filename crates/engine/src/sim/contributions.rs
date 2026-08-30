//! Resolving what actually goes into each account in a period, and holding
//! it to the statutory limits.
//!
//! ### The three contribution modes
//!
//! `ContributionRule` says what the owner *intends*; this module turns that
//! into dollars for a concrete period:
//!
//! - `PercentOfSalary` resolves against the owner's gross salary for the
//!   period, so it rises with the salary and holds its real value.
//! - `FlatAmount` is nominal by design — the same dollars every year, which
//!   is what a fixed standing transfer actually does.
//! - `FederalMaximum` resolves against the indexed limit table, including
//!   the owner's catch-up tier. Stored as intent, so it stays correct as
//!   limits index and the owner ages.
//!
//! ### Which bucket an account lands in
//!
//! `Account::plan_type` says so directly. Before #32 the bucket was inferred
//! from whichever statutory figure the account's typed limit sat nearer,
//! which mis-bucketed a 457(b) and any hand-typed limit near neither figure.
//! The engine now owns the limits outright and reads the bucket from a
//! field.
//!
//! Limits are granted **per person per year**, shared across every account
//! in the same bucket — not per account. IRA limits are a genuinely separate
//! bucket, shared across that person's traditional and Roth IRAs. Clamping
//! per account would let one person defer the limit twice over, overstating
//! both the ending balance and the pre-tax deduction. An account with
//! `PlanType::None` is uncapped and joins no bucket — that is what a taxable
//! brokerage is.
//!
//! ### Allocation order
//!
//! When a person's accounts collectively ask for more than the shared cap,
//! room is handed out **in plan account order**: the first account listed
//! fills first, and later accounts get whatever is left. This is
//! deterministic, matches the order the user sees under Inputs (so
//! reordering accounts is the control), and is stable from period to period.
//!
//! ### Why this runs per period
//!
//! It used to be resolved once for the whole run, because a flat nominal
//! contribution against a flat nominal limit gives the same answer every
//! year. Neither is flat any more — salaries grow, limits index, and
//! catch-up tiers turn on with age — so the split is genuinely a function of
//! the period. Clamp warnings are therefore deduplicated by account: only
//! the first period in which an account is held back is reported.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{AccountId, ContributionRule, PersonId, Plan, PlanType};
use crate::presets::CONTRIBUTION_LIMITS;

use super::SimWarning;

/// Everything about one period that contribution resolution depends on.
pub(super) struct PeriodContext<'a> {
    pub period: usize,
    /// Calendar year the period starts in — what statutory limits are
    /// indexed and catch-up tiers are tested against.
    pub year: i32,
    pub inflation: f64,
    /// Share of a year this period covers (1.0 for annual periods).
    pub period_fraction: f64,
    /// Gross salary accrued this period per person: their income streams,
    /// already grown and prorated, excluding Social Security.
    pub salary: &'a BTreeMap<PersonId, f64>,
    /// Share of this period each person is still working.
    pub working: &'a BTreeMap<PersonId, f64>,
}

impl PeriodContext<'_> {
    /// This period's share of an annual figure for `owner`, zero once they
    /// have retired.
    fn prorate(&self, owner: &PersonId) -> f64 {
        self.period_fraction * self.working.get(owner).copied().unwrap_or(0.0)
    }
}

/// Nominal dollars each account receives this period, indexed parallel to
/// `plan.accounts`. Pushes one `ContributionClamped` warning per account
/// that had to give something up, the first time it happens.
pub(super) fn allowed_contributions(
    plan: &Plan,
    ctx: &PeriodContext,
    reported: &mut BTreeSet<AccountId>,
    warnings: &mut Vec<SimWarning>,
) -> Vec<f64> {
    // Bucket capacity for this period, per person. The statutory figure is
    // annual, so it is prorated the same way the contributions are.
    let mut remaining: BTreeMap<(PersonId, PlanType), f64> = BTreeMap::new();
    let limit_for = |plan: &Plan, owner: &PersonId, plan_type: PlanType| -> Option<f64> {
        let person = plan.person(owner)?;
        CONTRIBUTION_LIMITS.annual_limit(
            plan_type,
            ctx.year - person.birth.year,
            ctx.year,
            ctx.inflation,
        )
    };

    let mut requested = Vec::with_capacity(plan.accounts.len());
    for account in &plan.accounts {
        // Nobody contributes out of a period they spend retired, whatever
        // the mode says — so a zero share short-circuits before any of the
        // modes resolve, and before anything can be reported as clamped.
        let share = ctx.prorate(&account.owner);
        let amount = if share <= 0.0 {
            0.0
        } else {
            match account.contribution {
                ContributionRule::FlatAmount(a) => a.max(0.0) * share,
                // The salary is already grown and prorated for the period,
                // so it carries its own share — applying `prorate` again
                // would double-count a partial working year.
                ContributionRule::PercentOfSalary(p) => {
                    p.max(0.0) * ctx.salary.get(&account.owner).copied().unwrap_or(0.0)
                }
                // A taxable account has no federal maximum; validation
                // rejects that combination, so the fallback only guards a
                // hand-edited plan file.
                ContributionRule::FederalMaximum => {
                    limit_for(plan, &account.owner, account.plan_type).unwrap_or(0.0) * share
                }
            }
        };
        requested.push(amount);

        if account.plan_type != PlanType::None {
            let key = (account.owner.clone(), account.plan_type);
            if let std::collections::btree_map::Entry::Vacant(slot) = remaining.entry(key) {
                let cap = limit_for(plan, &account.owner, account.plan_type).unwrap_or(0.0) * share;
                slot.insert(cap);
            }
        }
    }

    let mut allowed = Vec::with_capacity(plan.accounts.len());
    for (account, requested) in plan.accounts.iter().zip(requested) {
        let granted = match remaining.get_mut(&(account.owner.clone(), account.plan_type)) {
            None => requested,
            Some(room) => {
                let granted = requested.min(*room);
                *room -= granted;
                granted
            }
        };
        if granted < requested - 1e-6 && reported.insert(account.id.clone()) {
            warnings.push(SimWarning::ContributionClamped {
                account: account.id.clone(),
                period: ctx.period,
                requested,
                allowed: granted,
            });
        }
        allowed.push(granted);
    }
    allowed
}
