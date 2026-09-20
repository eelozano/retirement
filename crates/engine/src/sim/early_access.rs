//! Early withdrawal: which of a period's withdrawn dollars are taken before
//! the owner may take them freely, and what that costs.
//!
//! Two different questions, because the statute asks them separately:
//!
//! - **Non-qualified** — a Roth's *earnings* withdrawn before 59½ are
//!   ordinary income. Nothing exempts them short of the age.
//! - **Penalized** — the 10% additional tax on a distribution before 59½.
//!   It falls on pre-tax dollars and on non-qualified Roth earnings, and it
//!   has exemptions the income tax does not: the Rule of 55 and a 457(b).
//!
//! Both are law with no annual publication, so they live in code rather
//! than in `TaxFigures` (CLAUDE.md). Each is resolved once per run to the
//! month it stops applying — an [`EarlyAccess`] on each account's state —
//! and turned into a share of each period by `EarlyAccess::shares`: a period
//! straddling the month is split at it, exactly as a stream's boundary
//! splits a period, on the assumption that a year's withdrawals are spread
//! evenly through it.
//!
//! Out of scope, and documented as such in ARCHITECTURE.md: 72(t)/SEPP, the
//! public-safety age-50 rule, the SIMPLE IRA's 25% first-two-years rule,
//! the Roth five-year clock, state additional taxes, and HSA non-medical
//! withdrawals — which `AccountKind::Hsa` already assumes do not happen.

use crate::model::{AccountKind, Plan, PlanType, YearMonth};
use crate::strategies::EarlyAccess;

use super::period::Warnings;
use super::{Rule55Ineligibility, SimWarning};

/// Resolves every account's rules, in plan account order, and reports each
/// Rule of 55 election that does not hold.
pub(super) fn resolve(plan: &Plan, warnings: &mut Warnings) -> Vec<EarlyAccess> {
    plan.accounts
        .iter()
        .map(|account| {
            let eligibility = account.rule_of_55.then(|| {
                rule_of_55(
                    plan,
                    account.owner.as_str(),
                    account.kind,
                    account.plan_type,
                )
            });
            if let Some(Err(reason)) = eligibility {
                warnings.push(SimWarning::Rule55Ineligible {
                    account: account.id.clone(),
                    reason,
                });
            }

            let Some(owner) = plan.person(&account.owner) else {
                // Validation refuses an unknown owner; there is no age to
                // test against, so no rule is invented.
                return EarlyAccess::default();
            };
            let age_59_half = owner.penalty_free_month();

            // 457(b) distributions carry no additional tax at any age: the
            // plan is exempt from §72(t) altogether.
            let penalized_until = match (account.plan_type, eligibility) {
                (PlanType::Plan457b, _) => None,
                (_, Some(Ok(separation))) => Some(separation.min(age_59_half)),
                _ => Some(age_59_half),
            };

            match account.kind {
                AccountKind::TraditionalPreTax => EarlyAccess {
                    nonqualified_until: None,
                    penalized_until,
                },
                AccountKind::Roth => EarlyAccess {
                    nonqualified_until: Some(age_59_half),
                    penalized_until,
                },
                // Taxable and savings dollars are already taxed; an HSA is
                // assumed to pay for qualified medical spending.
                AccountKind::Taxable | AccountKind::Savings | AccountKind::Hsa => {
                    EarlyAccess::default()
                }
            }
        })
        .collect()
}

/// Whether a Rule of 55 election holds, and from which month: separation
/// from service — the owner's retirement — in or after the calendar year
/// they turn 55, from an employer plan. The model cannot tell which
/// employer an account belongs to, so the separation is the owner's one
/// retirement date; an IRA never qualifies, even one rolled over from a
/// plan that would have.
fn rule_of_55(
    plan: &Plan,
    owner: &str,
    kind: AccountKind,
    plan_type: PlanType,
) -> Result<YearMonth, Rule55Ineligibility> {
    if plan_type != PlanType::EmployerPlan
        || !matches!(kind, AccountKind::TraditionalPreTax | AccountKind::Roth)
    {
        return Err(Rule55Ineligibility::NotAnEmployerPlan);
    }
    let Some(person) = plan.person(owner) else {
        return Err(Rule55Ineligibility::SeparatedBefore55);
    };
    if person.retirement.year < person.birth.year + 55 {
        return Err(Rule55Ineligibility::SeparatedBefore55);
    }
    Ok(person.retirement)
}
