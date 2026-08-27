mod projection;

pub use projection::{PeriodSnapshot, Projection, SimWarning};

use std::collections::BTreeMap;

use crate::model::{
    AccountKind, CashFlowStream, GrowthRule, Plan, StreamBoundary, StreamDirection, YearMonth,
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
/// 2. contribute to accounts while their owner still works (clamped to limits)
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

    // Resolve stream boundaries to concrete months once.
    let mut resolved_streams: Vec<(&CashFlowStream, YearMonth, YearMonth)> = Vec::new();
    for stream in &plan.streams {
        match (
            resolve_boundary(plan, &stream.start, start, end),
            resolve_boundary(plan, &stream.end, start, end),
        ) {
            (Some(s), Some(e)) => resolved_streams.push((stream, s, e)),
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

    let mut snapshots = Vec::with_capacity(n_periods);
    let mut depleted = false;

    for period in 0..n_periods {
        let period_start = start.add_months(period as i64 * period_months);
        let period_end = start.add_months((period as i64 + 1) * period_months);
        let years_elapsed = (period as f64 * period_months as f64) / 12.0;

        // 1. Streams.
        let mut income = 0.0;
        let mut expenses = 0.0;
        for (stream, s, e) in &resolved_streams {
            let fraction = overlap_fraction(period_start, period_end, *s, *e);
            if fraction <= 0.0 {
                continue;
            }
            let growth = growth_factor(stream.growth, plan.assumptions.inflation, years_elapsed);
            let amount = stream.annual_amount * growth * fraction * (period_months as f64 / 12.0);
            match stream.direction {
                StreamDirection::Income => income += amount,
                StreamDirection::Expense => expenses += amount,
            }
        }

        // 2. Contributions (flat nominal in V1; limit indexing is V2).
        let mut contributions = 0.0;
        let mut pretax_contributions = 0.0;
        for (idx, account) in plan.accounts.iter().enumerate() {
            let Some(owner) = plan.person(&account.owner) else {
                continue;
            };
            let working = overlap_fraction(period_start, period_end, start, owner.retirement);
            if working <= 0.0 || account.annual_contribution <= 0.0 {
                continue;
            }
            let mut per_year = account.annual_contribution;
            if let Some(limit) = account.contribution_limit {
                if per_year > limit {
                    per_year = limit;
                    push_warning(
                        &mut warnings,
                        SimWarning::ContributionClamped {
                            account: account.id.clone(),
                        },
                    );
                }
            }
            let amount = per_year * working * (period_months as f64 / 12.0);
            accounts[idx].balance += amount;
            if account.kind == AccountKind::Taxable {
                accounts[idx].cost_basis += amount;
            }
            if account.kind == AccountKind::TraditionalPreTax {
                pretax_contributions += amount;
            }
            contributions += amount;
        }

        // 3. Tax on income (pre-tax deferrals reduce ordinary income).
        let income_tax = tax
            .tax(
                &IncomeBreakdown {
                    ordinary: (income - pretax_contributions).max(0.0),
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
