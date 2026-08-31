mod contributions;
mod monte_carlo;
mod projection;
mod survivor;

pub use monte_carlo::{run_monte_carlo, MonteCarloConfig, MonteCarloResult, PeriodPercentiles};
pub use projection::{PeriodSnapshot, Projection, SimWarning};

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    AccountId, AccountKind, CashFlowStream, GrowthRule, PersonId, Plan, StreamBoundary,
    StreamDirection, YearMonth,
};
use crate::presets::allocation_weights;
use crate::strategies::{AccountState, DrawdownStrategy, IncomeBreakdown, ReturnModel, TaxModel};

/// Where a resolved stream came from. Plan streams are what the user typed;
/// the other two are synthesized by `survivor` and are taxed (Social
/// Security) or scaled (a survivor continuation) differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamSource {
    Plan,
    SocialSecurity,
    SurvivorContinuation,
}

/// Runs one deterministic-or-stochastic simulation path over the plan.
///
/// Pure function: no global state, `plan` is untouched, and all randomness
/// (V2) is derived from `path_id` — so Monte Carlo is N parallel calls.
///
/// Per-period order (documented so results are explainable):
/// 1. accrue stream income and expenses (prorated by months active)
/// 2. contribute to accounts while their owner still works, resolving each
///    account's contribution mode and clamping to the owner's shared
///    statutory limits for that year, then add the employer match those
///    deferrals earn — see `contributions`
/// 3. tax ordinary income (gross income minus pre-tax deferrals)
/// 4. sweep surplus into the taxable account (if enabled), or draw down the
///    shortfall (grossed up through the tax model)
/// 5. apply market growth to post-flow balances
/// 6. snapshot
pub fn simulate(
    plan: &Plan,
    returns: &dyn ReturnModel,
    tax: &dyn TaxModel,
    drawdown: &dyn DrawdownStrategy,
    path_id: u64,
) -> Projection {
    let config = &plan.sim_config;
    let period_months = config.period.months();
    let start = config.start;
    let end = plan.end_month();
    let total_months = start.months_until(end).max(0);
    let n_periods = (total_months as f64 / period_months as f64).ceil() as usize;

    let mut warnings: Vec<SimWarning> = Vec::new();
    let push_warning = |warnings: &mut Vec<SimWarning>, w: SimWarning| {
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    };

    // Materialize Social Security benefits — including the survivor step-up
    // at the first death — and the reduced continuations of any stream with
    // a survivor percentage. Declared before `resolved_streams`: that Vec
    // borrows `&CashFlowStream`, so these owned streams must outlive it.
    let mut ss_warnings = Vec::new();
    let ss_streams = survivor::social_security_streams(plan, &mut ss_warnings);
    for warning in ss_warnings {
        push_warning(&mut warnings, warning);
    }
    let continuations = survivor::stream_continuations(plan);

    // Resolve stream boundaries to concrete months once, keeping track of
    // where each stream came from: Social Security income is tallied
    // separately in step 1 because the federal tax model applies the
    // partial-taxability rule to it rather than taxing it as plain ordinary
    // income, and a survivor continuation is exempt from the household
    // expense step-down below (its percentage is the step-down).
    let mut resolved_streams: Vec<(&CashFlowStream, YearMonth, YearMonth, StreamSource)> =
        Vec::new();
    let tagged_streams = plan
        .streams
        .iter()
        .map(|s| (s, StreamSource::Plan))
        .chain(ss_streams.iter().map(|s| (s, StreamSource::SocialSecurity)))
        .chain(
            continuations
                .iter()
                .map(|s| (s, StreamSource::SurvivorContinuation)),
        );
    for (stream, source) in tagged_streams {
        match (
            resolve_boundary(plan, &stream.start, start, end),
            resolve_boundary(plan, &stream.end, start, end),
        ) {
            (Some(s), Some(e)) => {
                // A survivor percentage overrides the stream's own end for
                // the owner's full-amount portion: it stops at their death
                // even if `end` runs past it, and `stream_continuations`
                // picks it up from there at the reduced rate.
                let e = match survivor::full_amount_ends_at(plan, stream) {
                    Some(death) => e.min(death),
                    None => e,
                };
                resolved_streams.push((stream, s, e, source))
            }
            _ => push_warning(
                &mut warnings,
                SimWarning::UnknownPersonRef {
                    stream: stream.id.clone(),
                },
            ),
        }
    }

    // Household spending steps down at the first death. Resolved once here,
    // and `None` whenever it would be a no-op — no survivor transition, or
    // a factor of 1.0 — so plans without one are arithmetically untouched.
    let survivor_step_down = plan
        .first_death()
        .map(|(month, _)| (month, plan.assumptions.survivor_expense_factor))
        .filter(|(_, factor)| *factor != 1.0);

    let mut accounts: Vec<AccountState> = plan
        .accounts
        .iter()
        .map(|a| AccountState {
            id: a.id.clone(),
            kind: a.kind,
            balance: a.balance,
            cost_basis: a.cost_basis.unwrap_or(0.0),
        })
        .collect();

    // Accounts whose contribution has already been reported as clamped, so
    // the per-period resolution below reports each one once. See
    // `contributions`.
    let mut clamps_reported: BTreeSet<AccountId> = BTreeSet::new();

    let mut snapshots = Vec::with_capacity(n_periods);
    let mut depleted = false;

    for period in 0..n_periods {
        let period_start = start.add_months(period as i64 * period_months);
        let period_end = start.add_months((period as i64 + 1) * period_months);
        let years_elapsed = (period as f64 * period_months as f64) / 12.0;

        // 1. Streams. Salary is tallied per person as well as in the
        // household total: `PercentOfSalary` contributions resolve against
        // the owner's own earned income, which excludes Social Security.
        let mut income = 0.0;
        let mut ss_income = 0.0;
        let mut expenses = 0.0;
        let mut salary: BTreeMap<PersonId, f64> = BTreeMap::new();
        for (stream, s, e, source) in &resolved_streams {
            let fraction = overlap_fraction(period_start, period_end, *s, *e);
            if fraction <= 0.0 {
                continue;
            }
            // Household spending — the expense streams no one owns — drops
            // to the survivor factor from the first death. The period's
            // active window is split at that month rather than the whole
            // period being scaled one way or the other, so the transition
            // period is exact rather than all-or-nothing.
            let active = match survivor_step_down {
                Some((death, factor))
                    if stream.direction == StreamDirection::Expense
                        && stream.owner.is_none()
                        && *source != StreamSource::SurvivorContinuation =>
                {
                    overlap_fraction(period_start, period_end, *s, (*e).min(death))
                        + factor * overlap_fraction(period_start, period_end, (*s).max(death), *e)
                }
                _ => fraction,
            };
            let growth = growth_factor(stream.growth, plan.assumptions.inflation, years_elapsed);
            let amount = stream.annual_amount * growth * active * (period_months as f64 / 12.0);
            match stream.direction {
                StreamDirection::Income => {
                    income += amount;
                    if *source == StreamSource::SocialSecurity {
                        ss_income += amount;
                    } else if let Some(owner) = &stream.owner {
                        *salary.entry(owner.clone()).or_insert(0.0) += amount;
                    }
                }
                StreamDirection::Expense => expenses += amount,
            }
        }

        // 2. Contributions. Modes and statutory limits both depend on the
        // year, so the split is resolved per period rather than once.
        let working: BTreeMap<PersonId, f64> = plan
            .people
            .iter()
            .map(|p| {
                (
                    p.id.clone(),
                    overlap_fraction(period_start, period_end, start, p.retirement),
                )
            })
            .collect();
        let period_context = contributions::PeriodContext {
            period,
            year: period_start.year,
            inflation: plan.assumptions.inflation,
            period_fraction: period_months as f64 / 12.0,
            salary: &salary,
            working: &working,
        };
        let allowed = contributions::allowed_contributions(
            plan,
            &period_context,
            &mut clamps_reported,
            &mut warnings,
        );
        // The match is gated on what the employee actually deferred, so it
        // is resolved from the post-clamp figures rather than alongside them.
        let matched = contributions::employer_match(
            plan,
            &period_context,
            &allowed,
            &mut clamps_reported,
            &mut warnings,
        );

        let mut contributions = 0.0;
        let mut employer_match = 0.0;
        let mut pretax_contributions = 0.0;
        for (idx, account) in plan.accounts.iter().enumerate() {
            // Matched dollars land in whichever account the destination
            // routed them to, so they are deposited alongside — and taxed
            // by — that account's own kind. A Roth match therefore never
            // reduces ordinary income, which is the point of the choice.
            let amount = allowed[idx] + matched[idx];
            if amount <= 0.0 {
                continue;
            }
            accounts[idx].balance += amount;
            if account.kind == AccountKind::Taxable {
                accounts[idx].cost_basis += amount;
            }
            if account.kind == AccountKind::TraditionalPreTax {
                pretax_contributions += amount;
            }
            contributions += allowed[idx];
            employer_match += matched[idx];
        }

        // 3. Tax on income (pre-tax deferrals reduce ordinary income; Social
        // Security is carried separately since it's only partially taxable).
        let income_tax = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: (income - ss_income - pretax_contributions).max(0.0),
                    social_security: ss_income,
                    ..Default::default()
                },
                period,
            )
            .tax;
        let mut taxes = income_tax;

        // 4. Surplus sweep (optional) or shortfall drawdown.
        let cash = income - contributions - income_tax - expenses;
        // Always the raw household leftover, invested or not — this keeps
        // cash-conservation checks (income = outflow + surplus) true
        // regardless of the sweep toggle below.
        let surplus = cash.max(0.0);
        let mut withdrawals = BTreeMap::new();
        if cash >= 0.0 {
            if surplus > 0.0 && plan.assumptions.sweep_surplus_to_taxable {
                if let Some(taxable) = accounts.iter_mut().find(|a| a.kind == AccountKind::Taxable)
                {
                    taxable.balance += surplus;
                    taxable.cost_basis += surplus;
                } else {
                    push_warning(&mut warnings, SimWarning::SurplusUnallocated);
                }
            }
        } else {
            let needed = -cash;
            let result = drawdown.withdraw(needed, &mut accounts, tax, period);
            taxes += result.tax;
            withdrawals = result.gross_by_account;
            // Relative epsilon: the gross-up iteration converges to within
            // ~1e-9 of the need, so anything meaningfully short is real.
            if !depleted && result.net < needed - needed.max(1.0) * 1e-6 {
                depleted = true;
                push_warning(&mut warnings, SimWarning::DepletedFunds { period });
            }
        }

        // 5. Growth on post-flow balances.
        let period_returns = returns.returns_for(period, path_id);
        for (idx, account) in plan.accounts.iter().enumerate() {
            let weights = allocation_weights(&account.allocation);
            let rate: f64 = weights
                .iter()
                .map(|(class, w)| w * period_returns.get(class).copied().unwrap_or(0.0))
                .sum();
            accounts[idx].balance *= 1.0 + rate;
        }

        // 6. Snapshot.
        let balances: BTreeMap<_, _> = accounts.iter().map(|a| (a.id.clone(), a.balance)).collect();
        let net_worth = accounts.iter().map(|a| a.balance).sum();
        snapshots.push(PeriodSnapshot {
            period,
            period_start,
            balances,
            income,
            expenses,
            taxes,
            contributions,
            employer_match,
            surplus,
            withdrawals,
            net_worth,
            deflator: (1.0 + plan.assumptions.inflation).powf(years_elapsed),
        });
    }

    Projection {
        snapshots,
        warnings,
    }
}

fn resolve_boundary(
    plan: &Plan,
    boundary: &StreamBoundary,
    start: YearMonth,
    end: YearMonth,
) -> Option<YearMonth> {
    match boundary {
        StreamBoundary::PlanStart => Some(start),
        StreamBoundary::PlanEnd => Some(end),
        StreamBoundary::Date(d) => Some(*d),
        StreamBoundary::AtRetirement(person) => Some(plan.person(person)?.retirement),
        StreamBoundary::AtDeath(person) => {
            let p = plan.person(person)?;
            Some(p.month_at_age(p.life_expectancy_age))
        }
    }
}

/// Fraction of the period [period_start, period_end) that overlaps the
/// active window [window_start, window_end).
fn overlap_fraction(
    period_start: YearMonth,
    period_end: YearMonth,
    window_start: YearMonth,
    window_end: YearMonth,
) -> f64 {
    let period_len = period_start.months_until(period_end);
    if period_len <= 0 {
        return 0.0;
    }
    let overlap_start = period_start.max(window_start);
    let overlap_end = period_end.min(window_end);
    let overlap = overlap_start.months_until(overlap_end).max(0);
    overlap as f64 / period_len as f64
}

fn growth_factor(rule: GrowthRule, inflation: f64, years_elapsed: f64) -> f64 {
    match rule {
        GrowthRule::Inflation => (1.0 + inflation).powf(years_elapsed),
        GrowthRule::Fixed(rate) => (1.0 + rate).powf(years_elapsed),
        GrowthRule::None => 1.0,
    }
}
