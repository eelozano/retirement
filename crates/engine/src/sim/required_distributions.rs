//! Required minimum distributions: the pre-tax money the IRS makes a
//! household take out whether or not it needs the cash (#49).
//!
//! Every other outflow in this engine is demand-driven —
//! `DrawdownStrategy::withdraw` is only reached when a period's cash is
//! negative. A retiree whose Social Security and pension cover their
//! spending would therefore never touch a seven-figure 401(k), and the plan
//! would show a tax bill that never arrives. This step is the one that
//! moves money out of an account because the calendar says so.
//!
//! ### The conventions, stated because each of them is a choice
//!
//! - **Age convention.** The age *attained during* the calendar year
//!   (`year - birth.year`), which is the statutory rule and the precedent
//!   `sim::contributions` already uses for catch-up eligibility.
//! - **Which balance.** The prior 31 December balance, which the engine has
//!   exactly: the previous period's end-of-period, post-growth balance. The
//!   **first projection period has no prior period**, so no distribution is
//!   taken in it. A projection that starts the year someone turns 73
//!   therefore begins forcing distributions in its second year. Anything
//!   else would need a balance from before the simulation, which does not
//!   exist.
//! - **Eligible accounts.** `TraditionalPreTax` only. Roth accounts — IRA
//!   and 401(k) alike — have no lifetime RMD under SECURE 2.0.
//! - **Multiple pre-tax accounts.** The requirement is one figure per owner,
//!   computed on their aggregate pre-tax balance, then satisfied **pro rata**
//!   across those accounts. Statutorily IRAs may be aggregated and satisfied
//!   from any one of them while each 401(k) must distribute its own; the
//!   model has no such grouping, so either choice is a simplification.
//!   Pro rata is the one that leaves the portfolio's shape undisturbed and
//!   does not depend on the order accounts happen to be listed in.
//! - **A deceased owner still distributes.** The engine keeps a dead
//!   person's accounts (`sim::survivor`), and this step keeps applying their
//!   own age and divisor to them. That is wrong in detail — a surviving
//!   spouse would roll the account over and switch to their own schedule,
//!   and a non-spouse beneficiary is on the 10-year rule — but it is the
//!   less wrong of the two options, because the alternative is an inherited
//!   pre-tax balance that compounds untaxed to the end of the projection.
//!   Beneficiary RMDs are deliberately out of scope; see #49.
//! - **Sub-annual periods.** The divisor table is annual, so the figure is
//!   prorated by the period's share of a year and computed against the
//!   previous *period's* closing balance. For the annual periods V1 runs,
//!   that is the statutory rule exactly; for a monthly configuration it is
//!   an approximation of it.
//!
//! Where the money goes is not this module's business — it hands the gross
//! back to `period::settle`, which taxes it with the rest of the period's
//! income in one pass and reinvests what spending does not consume.

use std::collections::BTreeMap;

use crate::model::{AccountKind, Plan};
use crate::presets::{rmd_age, uniform_lifetime_divisor};

use super::period::PeriodContext;

/// Gross required distribution per account this period, indexed parallel to
/// `plan.accounts`. `prior_balances` is the previous period's closing
/// balance for each account, in the same order.
pub(super) fn required(plan: &Plan, ctx: &PeriodContext, prior_balances: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; plan.accounts.len()];

    // Aggregate each owner's pre-tax balance first: the requirement is one
    // figure per person, not per account.
    let mut pretax: BTreeMap<&str, f64> = BTreeMap::new();
    for (idx, account) in plan.accounts.iter().enumerate() {
        if account.kind != AccountKind::TraditionalPreTax {
            continue;
        }
        let prior = prior_balances.get(idx).copied().unwrap_or(0.0);
        if prior > 0.0 {
            *pretax.entry(account.owner.as_str()).or_insert(0.0) += prior;
        }
    }

    for (owner, aggregate) in pretax {
        let Some(person) = plan.person(owner) else {
            continue;
        };
        let age = ctx.year - person.birth.year;
        if age < rmd_age(person.birth.year) {
            continue;
        }
        let Some(divisor) = uniform_lifetime_divisor(age) else {
            continue;
        };
        let distribution = aggregate / divisor * ctx.fraction;

        for (idx, account) in plan.accounts.iter().enumerate() {
            if account.kind != AccountKind::TraditionalPreTax || account.owner != owner {
                continue;
            }
            let prior = prior_balances.get(idx).copied().unwrap_or(0.0);
            if prior > 0.0 {
                out[idx] = distribution * (prior / aggregate);
            }
        }
    }

    out
}
