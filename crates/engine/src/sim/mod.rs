mod contributions;
mod monte_carlo;
mod projection;

pub use monte_carlo::{run_monte_carlo, MonteCarloConfig, MonteCarloResult, PeriodPercentiles};
pub use projection::{PeriodSnapshot, Projection, SimWarning};

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    AccountId, AccountKind, CashFlowStream, GrowthRule, PersonId, Plan, StreamBoundary,
    StreamDirection, YearMonth,
};
use crate::presets::allocation_weights;
use crate::strategies::{AccountState, DrawdownStrategy, IncomeBreakdown, ReturnModel, TaxModel};

/// Runs one deterministic-or-stochastic simulation path over the plan.
///
/// Pure function: no global state, `plan` is untouched, and all randomness
/// (V2) is derived from `path_id` — so Monte Carlo is N parallel calls.
///
/// Per-period order (documented so results are explainable):
/// 1. accrue stream income and expenses (prorated by months active)
/// 2. contribute to accounts while their owner still works, resolving each
///    account's contribution mode and clamping to the owner's shared
///    statutory limits for that year — see `contributions`
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

    // Materialize Social Security benefits into synthetic Income streams.
    // Declared before `resolved_streams` — that Vec borrows `&CashFlowStream`,
    // so these owned streams must outlive it.
    let mut derived_streams: Vec<CashFlowStream> = Vec::new();
    for ss in &plan.social_security {
        match plan.person(&ss.owner) {
            Some(person) => {
                derived_streams.push(ss.to_stream(person, plan.assumptions.social_security_cola))
            }
            None => push_warning(
                &mut warnings,
                SimWarning::UnknownPersonRef {
                    stream: ss.id.clone(),
                },
            ),
        }
    }

    // Resolve stream boundaries to concrete months once. `is_social_security`
    // marks streams materialized from `plan.social_security` so step 1 can
    // tally their income separately — the federal tax model applies the
    // partial-taxability rule to Social Security instead of taxing it as
    // plain ordinary income.
    let mut resolved_streams: Vec<(&CashFlowStream, YearMonth, YearMonth, bool)> = Vec::new();
    let tagged_streams = plan
        .streams
        .iter()
        .map(|s| (s, false))
        .chain(derived_streams.iter().map(|s| (s, true)));
    for (stream, is_social_security) in tagged_streams {
        match (
            resolve_boundary(plan, &stream.start, start, end),
            resolve_boundary(plan, &stream.end, start, end),
        ) {
            (Some(s), Some(e)) => resolved_streams.push((stream, s, e, is_social_security)),
            _ => push_warning(
                &mut warnings,
                SimWarning::UnknownPersonRef {
                    stream: stream.id.clone(),
                },
            ),
        }
    }

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
        for (stream, s, e, is_social_security) in &resolved_streams {
            let fraction = overlap_fraction(period_start, period_end, *s, *e);
            if fraction <= 0.0 {
                continue;
            }
            let growth = growth_factor(stream.growth, plan.assumptions.inflation, years_elapsed);
            let amount = stream.annual_amount * growth * fraction * (period_months as f64 / 12.0);
            match stream.direction {
                StreamDirection::Income => {
                    income += amount;
                    if *is_social_security {
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
        let allowed = contributions::allowed_contributions(
            plan,
            &contributions::PeriodContext {
                period,
                year: period_start.year,
                inflation: plan.assumptions.inflation,
                period_fraction: period_months as f64 / 12.0,
                salary: &salary,
                working: &working,
            },
            &mut clamps_reported,
            &mut warnings,
        );

        let mut contributions = 0.0;
        let mut pretax_contributions = 0.0;
        for (idx, account) in plan.accounts.iter().enumerate() {
            let amount = allowed[idx];
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
            contributions += amount;
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
        StreamBoundary::AtDeath(person) => Some(
            plan.person(person)?
                .month_at_age(plan.assumptions.plan_end_age),
        ),
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
