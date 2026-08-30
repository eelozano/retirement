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

use crate::model::{
    AccountId, AccountKind, ContributionRule, MatchDestination, PersonId, Plan, PlanType,
};
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

/// Where matched dollars land for the match declared on `source`.
///
/// The destination is a tax treatment, and in this model tax treatment is
/// `AccountKind` — so the money has to end up in an account of the matching
/// kind, not merely be labelled. Pre-tax dollars parked in a Roth account
/// would be withdrawn untaxed, and the error compounds for decades.
///
/// The declared account is preferred when its kind already agrees, which is
/// the ordinary case (a traditional 401(k) with a pre-tax match). Otherwise
/// the owner's first other employer-plan account of the right kind receives
/// it — plan order again, the same control the user already has over
/// contribution priority. A Roth deferral account plus a pre-tax match
/// account is exactly how a real statement splits the two sources.
fn match_target(plan: &Plan, source: usize, destination: MatchDestination) -> Option<usize> {
    let wanted = match destination {
        MatchDestination::PreTax => AccountKind::TraditionalPreTax,
        MatchDestination::Roth => AccountKind::Roth,
    };
    let account = &plan.accounts[source];
    if account.kind == wanted {
        return Some(source);
    }
    plan.accounts.iter().position(|a| {
        a.owner == account.owner && a.plan_type == PlanType::EmployerPlan && a.kind == wanted
    })
}

/// The fraction of salary the employer adds, given how much of their salary
/// the employee deferred. Tiers apply in order, each consuming deferral
/// percentage until it runs out.
fn matched_fraction(tiers: &[crate::model::MatchTier], deferral_percent: f64) -> f64 {
    let mut remaining = deferral_percent.max(0.0);
    let mut matched = 0.0;
    for tier in tiers {
        if remaining <= 0.0 {
            break;
        }
        let used = remaining.min(tier.employee_percent.max(0.0));
        matched += used * tier.match_percent.max(0.0);
        remaining -= used;
    }
    matched
}

/// Employer match per account for this period, indexed parallel to
/// `plan.accounts` — so entry `i` is what account `i` *receives*, which is
/// not necessarily the account the match was declared on.
///
/// `employee` is the post-clamp employee contribution for each account, from
/// `allowed_contributions`. The match is gated on the employee's own deferral
/// percentage, derived from what actually went in rather than from what the
/// account asked for — so a `FlatAmount` or `FederalMaximum` contribution
/// still produces an effective percentage for the tiers to bite on, and an
/// employee whose deferral was clamped is matched on the clamped figure.
///
/// Matched dollars are **not** subject to the elective-deferral limit — that
/// is the failure mode this exists to prevent. They are held to the 415(c)
/// annual-additions cap instead, shared with the employee's own deferrals.
pub(super) fn employer_match(
    plan: &Plan,
    ctx: &PeriodContext,
    employee: &[f64],
    reported: &mut BTreeSet<AccountId>,
    warnings: &mut Vec<SimWarning>,
) -> Vec<f64> {
    let mut matched = vec![0.0; plan.accounts.len()];
    if !plan.accounts.iter().any(|a| a.employer_match.is_some()) {
        return matched;
    }

    // Deferral percentage is a property of the person across all their
    // employer plans: splitting deferrals between a Roth and a traditional
    // 401(k) at one employer still earns one match on the combined figure.
    let mut deferrals: BTreeMap<PersonId, f64> = BTreeMap::new();
    for (account, amount) in plan.accounts.iter().zip(employee) {
        if account.plan_type == PlanType::EmployerPlan {
            *deferrals.entry(account.owner.clone()).or_insert(0.0) += amount;
        }
    }

    for (idx, account) in plan.accounts.iter().enumerate() {
        let Some(employer) = &account.employer_match else {
            continue;
        };
        let salary = ctx.salary.get(&account.owner).copied().unwrap_or(0.0);
        if salary <= 0.0 || ctx.prorate(&account.owner) <= 0.0 {
            continue;
        }
        let deferral_percent = deferrals.get(&account.owner).copied().unwrap_or(0.0) / salary;
        let amount = matched_fraction(&employer.tiers, deferral_percent) * salary;
        if amount <= 0.0 {
            continue;
        }
        match match_target(plan, idx, employer.destination) {
            Some(target) => matched[target] += amount,
            None if reported.insert(format!("match:{}", account.id)) => {
                warnings.push(SimWarning::MatchUnallocated {
                    account: account.id.clone(),
                });
            }
            None => {}
        }
    }

    clamp_to_annual_additions(plan, ctx, employee, &mut matched, reported, warnings);
    matched
}

/// Hold each person's total annual additions — their own deferrals plus the
/// match — to the 415(c) cap, trimming the match in plan order. Only the
/// match gives way: the employee's deferrals were already allowed under
/// their own limit.
fn clamp_to_annual_additions(
    plan: &Plan,
    ctx: &PeriodContext,
    employee: &[f64],
    matched: &mut [f64],
    reported: &mut BTreeSet<AccountId>,
    warnings: &mut Vec<SimWarning>,
) {
    let mut room: BTreeMap<PersonId, f64> = BTreeMap::new();
    for (idx, account) in plan.accounts.iter().enumerate() {
        if account.plan_type != PlanType::EmployerPlan {
            continue;
        }
        let Some(person) = plan.person(&account.owner) else {
            continue;
        };
        let entry = room.entry(account.owner.clone()).or_insert_with(|| {
            CONTRIBUTION_LIMITS.annual_additions_limit(
                ctx.year - person.birth.year,
                ctx.year,
                ctx.inflation,
            ) * ctx.prorate(&account.owner)
        });
        *entry -= employee[idx];
    }

    for (idx, account) in plan.accounts.iter().enumerate() {
        if matched[idx] <= 0.0 {
            continue;
        }
        let Some(available) = room.get_mut(&account.owner) else {
            continue;
        };
        let granted = matched[idx].min(available.max(0.0));
        *available -= granted;
        if granted < matched[idx] - 1e-6 && reported.insert(format!("415c:{}", account.id)) {
            warnings.push(SimWarning::AnnualAdditionsClamped {
                account: account.id.clone(),
                period: ctx.period,
                requested: matched[idx],
                allowed: granted,
            });
        }
        matched[idx] = granted;
    }
}
