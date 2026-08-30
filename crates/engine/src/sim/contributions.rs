//! Statutory contribution-limit enforcement.
//!
//! Elective deferral limits are granted **per person per year**, shared
//! across every employer plan that person participates in — not per account.
//! IRA limits are a genuinely separate bucket, shared across that person's
//! traditional and Roth IRAs. Clamping per account (as the loop used to)
//! let one person defer the limit twice over, overstating both the ending
//! balance and the pre-tax deduction.
//!
//! ### Which bucket an account lands in
//!
//! `AccountKind` is `Taxable | TraditionalPreTax | Roth` — it does not say
//! whether a pre-tax account is a 401(k) or a traditional IRA, and adding a
//! plan-type field is deferred to the contribution-modes work. So the
//! bucket is inferred from the limit the account carries: an account whose
//! `contribution_limit` is nearer the IRA limit than the elective-deferral
//! limit is an IRA, and everything else is an employer plan. That lands the
//! seeded and UI-default limits where they belong, and keeps working when a
//! user raises a limit for age-50 catch-up (a catch-up 401(k) limit is
//! still far nearer the deferral limit than the IRA one).
//!
//! An account with `contribution_limit: None` is uncapped and joins no
//! bucket — that is what a taxable brokerage is.
//!
//! ### Allocation order
//!
//! When a person's accounts collectively ask for more than the shared cap,
//! room is handed out **in plan account order**: the first account listed
//! fills first, and later accounts get whatever is left. This is
//! deterministic, matches the order the user sees under Inputs (so
//! reordering accounts is the control), and is stable from period to
//! period. Each account is still additionally held to its own
//! `contribution_limit`, so a per-account limit below the bucket cap is
//! respected rather than being overridden by a sibling's higher one.
//!
//! The result is period-invariant, so `simulate` computes it once: every
//! account a person owns starts and stops contributing on that person's
//! single retirement date, so the same split holds in every period.

use std::collections::BTreeMap;

use crate::model::{PersonId, Plan};
use crate::presets::{ELECTIVE_DEFERRAL_LIMIT, IRA_CONTRIBUTION_LIMIT};

use super::SimWarning;

/// The two independent statutory buckets a capped account can belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum LimitBucket {
    /// 401(k)/403(b)/457-style elective deferrals.
    EmployerPlan,
    /// Traditional and Roth IRAs, which share one cap with each other.
    Ira,
}

fn bucket_for(limit: f64) -> LimitBucket {
    if (limit - IRA_CONTRIBUTION_LIMIT).abs() <= (limit - ELECTIVE_DEFERRAL_LIMIT).abs() {
        LimitBucket::Ira
    } else {
        LimitBucket::EmployerPlan
    }
}

/// Planned annual contribution per account after limit enforcement, indexed
/// parallel to `plan.accounts`. Pushes one `ContributionClamped` warning per
/// account that had to give something up.
pub(super) fn allowed_contributions(plan: &Plan, warnings: &mut Vec<SimWarning>) -> Vec<f64> {
    // Bucket capacity: the highest limit any of the person's accounts in the
    // bucket declares. Catch-up eligibility is a property of the person, so
    // one account declaring the raised limit raises the shared cap — while
    // each account stays individually bound by its own limit below.
    let mut remaining: BTreeMap<(PersonId, LimitBucket), f64> = BTreeMap::new();
    for account in &plan.accounts {
        let Some(limit) = account.contribution_limit else {
            continue;
        };
        let key = (account.owner.clone(), bucket_for(limit));
        let room = remaining.entry(key).or_insert(limit);
        if limit > *room {
            *room = limit;
        }
    }

    let mut allowed = Vec::with_capacity(plan.accounts.len());
    for account in &plan.accounts {
        let requested = account.annual_contribution.max(0.0);
        let granted = match account.contribution_limit {
            None => requested,
            Some(limit) => {
                let room = remaining
                    .get_mut(&(account.owner.clone(), bucket_for(limit)))
                    .expect("every capped account seeded its bucket above");
                let granted = requested.min(limit).min(*room);
                *room -= granted;
                granted
            }
        };
        if granted < requested - 1e-6 {
            warnings.push(SimWarning::ContributionClamped {
                account: account.id.clone(),
                requested,
                allowed: granted,
            });
        }
        allowed.push(granted);
    }
    allowed
}
