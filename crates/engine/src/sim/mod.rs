mod contributions;
mod monte_carlo;
mod period;
mod projection;
mod required_distributions;
mod survivor;

pub use monte_carlo::{run_monte_carlo, MonteCarloConfig, MonteCarloResult, PeriodPercentiles};
pub use projection::{PeriodSnapshot, Projection, SimWarning, StreamInfo};

use crate::model::{
    Account, AccountKind, CashFlowStream, Contribution, GrowthRule, Plan, StreamBoundary, YearMonth,
};
use crate::strategies::{DrawdownStrategy, ReturnModel, TaxModel};

use period::{PeriodContext, RunContext, RunState};

/// Where a resolved stream came from. Plan streams are what the user typed;
/// the other two are synthesized by `survivor` and are taxed (Social
/// Security) or scaled (a survivor continuation) differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamSource {
    Plan,
    SocialSecurity,
    SurvivorContinuation,
}

/// A plan stream with its boundaries resolved to concrete months, ready for
/// the period loop to prorate.
struct ResolvedStream<'a> {
    stream: &'a CashFlowStream,
    start: YearMonth,
    /// Exclusive.
    end: YearMonth,
    source: StreamSource,
}

/// A contribution entry with its boundaries resolved to concrete months,
/// ready for the period loop to prorate — the contribution analogue of
/// `ResolvedStream`.
struct ResolvedContribution<'a> {
    /// Index into `plan.accounts`.
    account: usize,
    entry: &'a Contribution,
    start: YearMonth,
    /// Exclusive.
    end: YearMonth,
}

/// Runs one deterministic-or-stochastic simulation path over the plan.
///
/// Pure function: no global state, `plan` is untouched, and all randomness
/// (V2) is derived from `path_id` — so Monte Carlo is N parallel calls.
///
/// Per-period order (documented so results are explainable):
/// 1. accrue stream income and expenses (prorated by months active)
/// 2. contribute to accounts: resolve each account's dated contribution
///    entries for the months they are active, clamp the account to the
///    owner's shared statutory limits for that year, then add the employer
///    match those deferrals earn — see `contributions`
/// 3. force out each pre-tax account owner's required minimum distribution,
///    once they are past their RMD age — see `required_distributions`
/// 4. tax ordinary income (gross income minus pre-tax deferrals, plus any
///    required distribution), in a single pass over the whole period
/// 5. reinvest the leftover in the taxable account — always for the forced
///    distribution, and for ordinary surplus once the sweep boundary has
///    been reached — or draw down the shortfall (grossed up through the tax
///    model)
/// 6. apply market growth to post-flow balances
/// 7. snapshot
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

    // Materialize Social Security benefits — including the survivor step-up
    // at the first death — and the reduced continuations of any stream with
    // a survivor percentage. Declared before `resolved_streams`: that Vec
    // borrows `&CashFlowStream`, so these owned streams must outlive it.
    let mut ss_warnings = Vec::new();
    let ss_streams = survivor::social_security_streams(plan, &mut ss_warnings);
    let continuations = survivor::stream_continuations(plan);

    let mut state = RunState::new(plan);
    for warning in ss_warnings {
        state.warnings.push(warning);
    }

    // Resolve stream boundaries to concrete months once, keeping track of
    // where each stream came from: Social Security income is tallied
    // separately in step 1 because the federal tax model applies the
    // partial-taxability rule to it rather than taxing it as plain ordinary
    // income, and a survivor continuation is exempt from the household
    // expense step-down below (its percentage is the step-down).
    let mut resolved_streams: Vec<ResolvedStream> = Vec::new();
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
                resolved_streams.push(ResolvedStream {
                    stream,
                    start: s,
                    end: e,
                    source,
                })
            }
            _ => state.warnings.push(SimWarning::UnknownPersonRef {
                stream: stream.id.clone(),
            }),
        }
    }

    // Contribution entries resolve the same way streams do, once, up front.
    // An entry pinned to a person who has since been deleted has no window
    // to resolve; it contributes nothing and says so, once per account.
    let mut resolved_contributions: Vec<ResolvedContribution> = Vec::new();
    for (idx, account) in plan.accounts.iter().enumerate() {
        for entry in &account.contributions {
            match (
                resolve_boundary(plan, &entry.start, start, end),
                resolve_boundary(plan, &entry.end, start, end),
            ) {
                (Some(s), Some(e)) => resolved_contributions.push(ResolvedContribution {
                    account: idx,
                    entry,
                    start: s,
                    end: e,
                }),
                _ => state
                    .warnings
                    .push(SimWarning::ContributionBoundaryUnresolved {
                        account: account.id.clone(),
                    }),
            }
        }
    }

    // When ordinary surplus starts being swept into the taxable account.
    // `None` means never — which is also what an unresolvable boundary
    // (a person deleted after it was chosen) falls back to, loudly: the
    // alternative is silently sweeping decades of working-phase cash the
    // household has already spent.
    let sweep_from = match &plan.assumptions.sweep_surplus_from {
        None => None,
        Some(boundary) => {
            let resolved = resolve_boundary(plan, boundary, start, end);
            if resolved.is_none() {
                state.warnings.push(SimWarning::SweepBoundaryUnresolved);
            }
            resolved
        }
    };

    // Household spending steps down at the first death. Resolved once here,
    // and `None` whenever it would be a no-op — no survivor transition, or
    // a factor of 1.0 — so plans without one are arithmetically untouched.
    let survivor_step_down = plan
        .first_death()
        .map(|(month, _)| (month, plan.assumptions.survivor_expense_factor))
        .filter(|(_, factor)| *factor != 1.0);

    // Which account receives the sweep and any forced-distribution
    // remainder. `Assumptions::reinvest_into` names one directly;
    // `Plan::validate` rejects it unless it names a `Taxable` or `Savings`
    // account — both carry after-tax cost-basis semantics, so either is a
    // valid destination — meaning a validated plan always resolves here
    // when it names one at all. A plan that skips validation (a test
    // fixture, a stale `reinvest_into`) falls back to the first such
    // account in plan order — today's behaviour — rather than dropping the
    // money.
    let is_reinvest_target =
        |a: &Account| matches!(a.kind, AccountKind::Taxable | AccountKind::Savings);
    let reinvest_into = plan
        .assumptions
        .reinvest_into
        .as_ref()
        .and_then(|id| {
            plan.accounts
                .iter()
                .position(|a| &a.id == id && is_reinvest_target(a))
        })
        .or_else(|| plan.accounts.iter().position(is_reinvest_target));

    let run = RunContext {
        plan,
        streams: &resolved_streams,
        contributions: &resolved_contributions,
        sweep_from,
        reinvest_into,
        survivor_step_down,
        returns,
        tax,
        drawdown,
        path_id,
    };

    let mut snapshots = Vec::with_capacity(n_periods);
    for period in 0..n_periods {
        let period_start = start.add_months(period as i64 * period_months);
        let ctx = PeriodContext {
            period,
            start: period_start,
            end: start.add_months((period as i64 + 1) * period_months),
            year: period_start.year,
            years_elapsed: (period as f64 * period_months as f64) / 12.0,
            fraction: period_months as f64 / 12.0,
            inflation: plan.assumptions.inflation,
        };
        snapshots.push(period::run(&run, &ctx, &mut state));
    }

    Projection {
        snapshots,
        warnings: state.warnings.into_vec(),
        streams: resolved_streams
            .iter()
            .map(|r| StreamInfo {
                id: r.stream.id.clone(),
                name: r.stream.name.clone(),
                direction: r.stream.direction,
            })
            .collect(),
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
