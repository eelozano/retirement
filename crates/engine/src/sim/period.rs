//! One simulated period: what it knows about itself (`PeriodContext`), what
//! it accumulates (`PeriodState`), and the steps that fill it in.
//!
//! `simulate` used to carry all of this as ~10 mutable locals in a single
//! loop body. The cost was not only length: with no shared picture of the
//! period, the two places that reach for the tax model — the bill on stream
//! income and the withdrawal gross-up — could not see each other, and
//! drifted into taxing the same period twice (#54). `PeriodState` is that
//! shared picture.
//!
//! Each step is a function over the period's state, so a new behavior that
//! is a *step* rather than a strategy has somewhere to go other than a new
//! statement in `simulate`.
//!
//! The three contexts, by lifetime:
//!
//! - `RunContext` — fixed for the whole run: the plan, the resolved streams,
//!   and the strategies.
//! - `RunState` — carried from period to period: balances, the dedup sets
//!   behind the warnings, and the warnings themselves.
//! - `PeriodContext` / `PeriodState` — one period's coordinates and its
//!   accumulated dollars, both rebuilt every iteration.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{AccountId, AccountKind, PersonId, Plan, StreamDirection, YearMonth};
use crate::presets::allocation_weights;
use crate::strategies::{
    AccountState, DrawdownStrategy, IncomeBreakdown, PeriodIndex, ReturnModel, TaxModel,
};

use super::{
    contributions, growth_factor, overlap_fraction, required_distributions, PeriodSnapshot,
    ResolvedStream, SimWarning, StreamSource,
};

/// The warnings collected over a run, deduplicated on push.
///
/// A plain `Vec` plus a closure worked while every push happened inside the
/// loop body; a closure cannot cross a function boundary, and open-coding
/// the `contains` check in each extracted step is how the check gets
/// forgotten in the next one.
#[derive(Debug, Default)]
pub(super) struct Warnings(Vec<SimWarning>);

impl Warnings {
    pub(super) fn push(&mut self, warning: SimWarning) {
        if !self.0.contains(&warning) {
            self.0.push(warning);
        }
    }

    pub(super) fn into_vec(self) -> Vec<SimWarning> {
        self.0
    }
}

/// Everything fixed for the whole run. Read-only to every step.
pub(super) struct RunContext<'a> {
    pub plan: &'a Plan,
    /// Plan, Social Security and survivor-continuation streams, boundaries
    /// already resolved to concrete months.
    pub streams: &'a [ResolvedStream<'a>],
    /// The month household spending steps down, and by what factor. `None`
    /// whenever it would be a no-op.
    pub survivor_step_down: Option<(YearMonth, f64)>,
    pub returns: &'a dyn ReturnModel,
    pub tax: &'a dyn TaxModel,
    pub drawdown: &'a dyn DrawdownStrategy,
    pub path_id: u64,
}

/// What one period hands to the next.
pub(super) struct RunState {
    pub accounts: Vec<AccountState>,
    /// Accounts whose contribution has already been reported as clamped, so
    /// each is reported once across the run. See `contributions`.
    pub clamps_reported: BTreeSet<AccountId>,
    /// Whether the portfolio has already run dry — only the first period it
    /// happens in is reported.
    pub depleted: bool,
    /// Whether a forced distribution has already been reported as having
    /// nowhere to land. Same once-per-run shape as `depleted`.
    pub distribution_unallocated_reported: bool,
    /// Closing balances of the previous period, indexed parallel to
    /// `plan.accounts`. `None` in the first period, which is why no required
    /// distribution is taken there — see `required_distributions`.
    pub prior_balances: Option<Vec<f64>>,
    pub warnings: Warnings,
}

impl RunState {
    pub(super) fn new(plan: &Plan) -> Self {
        RunState {
            accounts: plan
                .accounts
                .iter()
                .map(|a| AccountState {
                    id: a.id.clone(),
                    kind: a.kind,
                    balance: a.balance,
                    cost_basis: a.cost_basis.unwrap_or(0.0),
                })
                .collect(),
            clamps_reported: BTreeSet::new(),
            depleted: false,
            distribution_unallocated_reported: false,
            prior_balances: None,
            warnings: Warnings::default(),
        }
    }
}

/// Where one period sits in time. Fixed before its steps run, and read-only
/// to all of them.
pub(super) struct PeriodContext {
    pub period: PeriodIndex,
    pub start: YearMonth,
    /// Exclusive: the next period's start.
    pub end: YearMonth,
    /// Calendar year the period starts in — what statutory limits are
    /// indexed and catch-up tiers are tested against.
    pub year: i32,
    /// Years from the simulation start to this period's start; the exponent
    /// every compounding assumption is raised to.
    pub years_elapsed: f64,
    /// Share of a year this period covers (1.0 for annual periods).
    pub fraction: f64,
    pub inflation: f64,
}

impl PeriodContext {
    /// Fraction of this period that overlaps `[start, end)`.
    pub(super) fn overlap(&self, start: YearMonth, end: YearMonth) -> f64 {
        overlap_fraction(self.start, self.end, start, end)
    }

    /// Cumulative inflation factor at period start: divide any nominal value
    /// by it to get simulation-start dollars.
    fn deflator(&self) -> f64 {
        (1.0 + self.inflation).powf(self.years_elapsed)
    }
}

/// What a period accumulates as its steps run. Every field is nominal
/// dollars for that period alone.
#[derive(Debug, Default)]
pub(super) struct PeriodState {
    /// Gross stream income, Social Security included.
    pub income: f64,
    /// The Social Security part of `income`, carried separately because the
    /// federal model taxes it under the provisional-income rule rather than
    /// as plain ordinary income.
    pub ss_income: f64,
    pub expenses: f64,
    /// Gross salary per person: their income streams, grown and prorated,
    /// excluding Social Security. `PercentOfSalary` contributions resolve
    /// against the owner's own earned income.
    pub salary: BTreeMap<PersonId, f64>,
    /// Employee contributions, out of household cash.
    pub contributions: f64,
    /// Employer match — never passes through household cash.
    pub employer_match: f64,
    /// Pre-tax dollars deposited this period, employee and match alike:
    /// what reduces the period's ordinary income.
    pub pretax_contributions: f64,
    /// Gross required minimum distributions forced out of pre-tax accounts
    /// this period. Already counted inside `withdrawals` — this is the
    /// forced share of them, not an addition to them.
    pub required_distributions: f64,
    /// Total tax for the period.
    pub taxes: f64,
    pub surplus: f64,
    pub withdrawals: BTreeMap<AccountId, f64>,
}

impl PeriodState {
    /// The period's income as the tax model sees it, before any
    /// discretionary drawdown. Pre-tax deferrals reduce ordinary income;
    /// Social Security is carried separately since it is only partially
    /// taxable.
    ///
    /// This is the *single* definition of the period's income. Step 4's
    /// gross-up stacks on top of it rather than re-entering the brackets at
    /// $0 (#54).
    fn base_income(&self) -> IncomeBreakdown {
        IncomeBreakdown {
            // A required distribution is ordinary income and is added after
            // the clamp, not inside it: pre-tax deferrals offset earned
            // income, and a household deferring more than it earns must not
            // shelter a forced distribution as a side effect.
            ordinary: (self.income - self.ss_income - self.pretax_contributions).max(0.0)
                + self.required_distributions,
            social_security: self.ss_income,
            ..Default::default()
        }
    }

    fn snapshot(self, ctx: &PeriodContext, accounts: &[AccountState]) -> PeriodSnapshot {
        PeriodSnapshot {
            period: ctx.period,
            period_start: ctx.start,
            balances: accounts.iter().map(|a| (a.id.clone(), a.balance)).collect(),
            net_worth: accounts.iter().map(|a| a.balance).sum(),
            income: self.income,
            expenses: self.expenses,
            taxes: self.taxes,
            contributions: self.contributions,
            employer_match: self.employer_match,
            required_distributions: self.required_distributions,
            surplus: self.surplus,
            withdrawals: self.withdrawals,
            deflator: ctx.deflator(),
        }
    }
}

/// Runs every step of one period against `state`, and snapshots the result.
pub(super) fn run(run: &RunContext, ctx: &PeriodContext, state: &mut RunState) -> PeriodSnapshot {
    let mut period = PeriodState::default();
    accrue_streams(run, ctx, &mut period);
    contribute(run, ctx, &mut period, state);
    distribute(run, ctx, &mut period, state);
    settle(run, ctx, &mut period, state);
    grow(run, ctx, state);
    state.prior_balances = Some(state.accounts.iter().map(|a| a.balance).collect());
    period.snapshot(ctx, &state.accounts)
}

/// Step 1 — accrue stream income and expenses, prorated by months active.
fn accrue_streams(run: &RunContext, ctx: &PeriodContext, period: &mut PeriodState) {
    for resolved in run.streams {
        let stream = resolved.stream;
        let fraction = ctx.overlap(resolved.start, resolved.end);
        if fraction <= 0.0 {
            continue;
        }
        // Household spending — the expense streams no one owns — drops to
        // the survivor factor from the first death. The period's active
        // window is split at that month rather than the whole period being
        // scaled one way or the other, so the transition period is exact
        // rather than all-or-nothing.
        let active = match run.survivor_step_down {
            Some((death, factor))
                if stream.direction == StreamDirection::Expense
                    && stream.owner.is_none()
                    && resolved.source != StreamSource::SurvivorContinuation =>
            {
                ctx.overlap(resolved.start, resolved.end.min(death))
                    + factor * ctx.overlap(resolved.start.max(death), resolved.end)
            }
            _ => fraction,
        };
        let growth = growth_factor(stream.growth, ctx.inflation, ctx.years_elapsed);
        let amount = stream.annual_amount * growth * active * ctx.fraction;
        match stream.direction {
            StreamDirection::Income => {
                period.income += amount;
                if resolved.source == StreamSource::SocialSecurity {
                    period.ss_income += amount;
                } else if let Some(owner) = &stream.owner {
                    *period.salary.entry(owner.clone()).or_insert(0.0) += amount;
                }
            }
            StreamDirection::Expense => period.expenses += amount,
        }
    }
}

/// Step 2 — contribute to accounts while their owner still works, resolving
/// each account's contribution mode and clamping to the owner's shared
/// statutory limits for that year, then add the employer match those
/// deferrals earn. See `contributions`.
fn contribute(
    run: &RunContext,
    ctx: &PeriodContext,
    period: &mut PeriodState,
    state: &mut RunState,
) {
    let plan = run.plan;
    // Modes and statutory limits both depend on the year, so the split is
    // resolved per period rather than once.
    let working: BTreeMap<PersonId, f64> = plan
        .people
        .iter()
        .map(|p| {
            (
                p.id.clone(),
                ctx.overlap(plan.sim_config.start, p.retirement),
            )
        })
        .collect();
    let inputs = contributions::Inputs {
        ctx,
        salary: &period.salary,
        working: &working,
    };
    let allowed = contributions::allowed_contributions(
        plan,
        &inputs,
        &mut state.clamps_reported,
        &mut state.warnings,
    );
    // The match is gated on what the employee actually deferred, so it is
    // resolved from the post-clamp figures rather than alongside them.
    let matched = contributions::employer_match(
        plan,
        &inputs,
        &allowed,
        &mut state.clamps_reported,
        &mut state.warnings,
    );

    for (idx, account) in plan.accounts.iter().enumerate() {
        // Matched dollars land in whichever account the destination routed
        // them to, so they are deposited alongside — and taxed by — that
        // account's own kind. A Roth match therefore never reduces ordinary
        // income, which is the point of the choice.
        let amount = allowed[idx] + matched[idx];
        if amount <= 0.0 {
            continue;
        }
        state.accounts[idx].balance += amount;
        if account.kind == AccountKind::Taxable {
            state.accounts[idx].cost_basis += amount;
        }
        if account.kind == AccountKind::TraditionalPreTax {
            period.pretax_contributions += amount;
        }
        period.contributions += allowed[idx];
        period.employer_match += matched[idx];
    }
}

/// Step 3 — force out each owner's required minimum distribution. See
/// `required_distributions` for the conventions; the gross lands in
/// `withdrawals` alongside discretionary draws and in `base_income` as
/// ordinary income, so `settle` taxes it with everything else in one pass.
fn distribute(
    run: &RunContext,
    ctx: &PeriodContext,
    period: &mut PeriodState,
    state: &mut RunState,
) {
    // No prior period, no prior year-end balance to divide.
    let Some(prior) = state.prior_balances.as_deref() else {
        return;
    };
    for (idx, required) in required_distributions::required(run.plan, ctx, prior)
        .into_iter()
        .enumerate()
    {
        // The requirement is computed on last period's closing balance; this
        // period's own flows may have left less than that in the account.
        let amount = required.min(state.accounts[idx].balance);
        if amount <= 0.0 {
            continue;
        }
        state.accounts[idx].balance -= amount;
        period.required_distributions += amount;
        *period
            .withdrawals
            .entry(state.accounts[idx].id.clone())
            .or_insert(0.0) += amount;
    }
}

/// Steps 4 and 5 — tax the period's income, then invest what is left over
/// or draw down the shortfall (grossed up through the tax model).
///
/// One tax pass, not two. The drawdown grosses itself up against the same
/// `base_income` taxed here and reports only what it *adds*, so a period's
/// dollars meet the progressive schedule once, in one stack.
fn settle(run: &RunContext, ctx: &PeriodContext, period: &mut PeriodState, state: &mut RunState) {
    let base = period.base_income();
    let income_tax = run.tax.tax(&base, ctx.period).tax;
    period.taxes = income_tax;

    // A required distribution is cash in hand: it has already left the
    // pre-tax account, so it funds this period's spending before anything
    // else has to be sold.
    let cash = period.income + period.required_distributions
        - period.contributions
        - income_tax
        - period.expenses;
    // Always the raw household leftover, invested or not — this keeps
    // cash-conservation checks (income = outflow + surplus) true regardless
    // of the sweep toggle below.
    period.surplus = cash.max(0.0);
    if cash >= 0.0 {
        // The surplus branch never reaches the tax model: reinvested dollars
        // are after-tax cash landing in a taxable account, and the gain they
        // go on to earn is taxed when it is withdrawn. There is no second
        // pass here to collapse.
        //
        // What gets reinvested is where the sweep toggle stops. Ordinary
        // surplus is income that never entered an account, so leaving it
        // uninvested costs the projection nothing it ever had. A required
        // distribution is the opposite case: the money is already out of the
        // pre-tax balance, and if nothing receives it net worth falls by the
        // full distribution every year — the engine would delete real wealth
        // and report the resulting shortfall as a failed plan. So the forced
        // share is reinvested unconditionally, and only the rest answers to
        // the toggle.
        //
        // The forced share is capped at the surplus rather than being the
        // whole distribution: RMD dollars fund spending like any other
        // income, and a household that spent theirs has nothing left to
        // redeposit.
        let forced = period.surplus.min(period.required_distributions);
        let reinvested = if run.plan.assumptions.sweep_surplus_to_taxable {
            period.surplus
        } else {
            forced
        };
        if reinvested > 0.0 {
            match state
                .accounts
                .iter_mut()
                .find(|a| a.kind == AccountKind::Taxable)
            {
                Some(taxable) => {
                    taxable.balance += reinvested;
                    // After-tax dollars: without the basis they would be
                    // taxed a second time as gain when they are withdrawn.
                    taxable.cost_basis += reinvested;
                }
                None if forced > 0.0 => {
                    if !state.distribution_unallocated_reported {
                        state.distribution_unallocated_reported = true;
                        state
                            .warnings
                            .push(SimWarning::RequiredDistributionUnallocated {
                                period: ctx.period,
                            });
                    }
                }
                None => state.warnings.push(SimWarning::SurplusUnallocated),
            }
        }
        return;
    }

    let needed = -cash;
    let result = run
        .drawdown
        .withdraw(needed, &mut state.accounts, run.tax, &base, ctx.period);
    // `result.tax` is the *marginal* cost of the withdrawal over `base`, so
    // this addition is the period's whole bill, counted once.
    period.taxes += result.tax;
    // Merged, not assigned: a forced distribution may already have taken
    // something from these same accounts this period.
    for (id, amount) in result.gross_by_account {
        *period.withdrawals.entry(id).or_insert(0.0) += amount;
    }
    // Relative epsilon: the gross-up iteration converges to within ~1e-9 of
    // the need, so anything meaningfully short is real.
    if !state.depleted && result.net < needed - needed.max(1.0) * 1e-6 {
        state.depleted = true;
        state
            .warnings
            .push(SimWarning::DepletedFunds { period: ctx.period });
    }
}

/// Step 6 — apply market growth to post-flow balances.
fn grow(run: &RunContext, ctx: &PeriodContext, state: &mut RunState) {
    let period_returns = run.returns.returns_for(ctx.period, run.path_id);
    for (idx, account) in run.plan.accounts.iter().enumerate() {
        let weights = allocation_weights(&account.allocation);
        let rate: f64 = weights
            .iter()
            .map(|(class, w)| w * period_returns.get(class).copied().unwrap_or(0.0))
            .sum();
        state.accounts[idx].balance *= 1.0 + rate;
    }
}
