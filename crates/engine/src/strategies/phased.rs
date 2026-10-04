//! `DrawdownPolicy::Phased`: a shortfall paid down an ordered stack of
//! accounts, instead of by every account in proportion to its balance.
//!
//! A withdrawal is a **waterfall over tranches**. A tranche is a slice of
//! one or more accounts' balances with a capacity; a gross amount fills the
//! first tranche to capacity, then the second, and so on. Within a tranche
//! the draw is split across its accounts in proportion to their share of
//! it. The tranches, in order:
//!
//! 1. **The stack**, entry by entry, down to each entry's floor.
//! 2. **The fallback** — every funded account the stack does not name — so
//!    a stack that runs dry never reports the plan as failing while money
//!    remains. Penalty-free money first, then penalized money, and within
//!    each by kind: savings, taxable, pre-tax, Roth, HSA. A Roth IRA's
//!    contributions are penalty-free at any age, so before 59½ that one
//!    account is split, contributions into the first half and earnings into
//!    the second.
//! 3. **The floors**, in stack order. A floor holds until everything else
//!    is spent and is then released rather than kept: a hard floor would
//!    report the plan as out of money with money in the bank, and pull the
//!    success rate down with it.
//!
//! A waterfall is continuous and non-decreasing in the gross, which is what
//! `gross_up` needs, and it never draws an account past its balance, since
//! the tranches of any one account sum to at most that balance.
//!
//! **A MAGI target** (#187) replaces the stack with one number, and the
//! order is the engine's, fixed and stated here. The headroom is the target,
//! grown with inflation like a floor, less the MAGI the calendar year
//! already holds — base income, and whatever an earlier part of the year
//! drew. Accounts are classed by the period's early-access shares, the
//! same test the fallback makes:
//!
//! 1. **Fill to the target** with penalty-free pre-tax and taxable money
//!    together. A pre-tax dollar adds a dollar of MAGI; a taxable dollar
//!    only its gain. The draw takes as much pre-tax as the headroom allows
//!    once the brokerage sales covering the rest have counted their gains:
//!    all pre-tax while the need is under the headroom, and then, as the
//!    need grows, less pre-tax and more brokerage, with MAGI held on the
//!    target. That uses the low brackets and leaves the Roth growing. See
//!    [`Fill`].
//! 2. **Money that adds no MAGI**: savings, then Roth that comes out untaxed
//!    (all of it once qualified, a Roth IRA's contributions before), then
//!    HSA.
//! 3. **Over the target**: the rest of the brokerage, then the rest of the
//!    penalty-free pre-tax, then Roth earnings that are taxed but not
//!    penalized.
//! 4. **Penalized money**, last, in the fallback's kind order.
//!
//! The target is soft for the reason a floor is: a year that cannot stay
//! under it goes over, and says so through `WithdrawalResult::
//! magi_target_missed`. Stage 1's split is not non-decreasing — the pre-tax
//! draw falls as the gross rises through it — but the net a gross leaves
//! still rises, since moving a dollar from ordinary income to capital gains
//! at the same MAGI never raises the tax; `drawdown::solve` needs no more.
//!
//! **Phases.** Each phase runs from its start month to the next phase's. A
//! period a phase boundary falls inside is split at the month, as every
//! boundary splits a period: the need is divided by the months each phase
//! covers, and each part is drawn down its own phase's stack, the second
//! stacked on the income of the first so the period still meets the tax
//! schedule once. Each part is also judged early or not over its own
//! months — a draw from the phase that starts at 59½ is never penalized,
//! even in the year of the birthday. A MAGI-target part draws **last**, so
//! the MAGI it steers by is the calendar year's: the other part's draws
//! are headroom already used.

use crate::model::{
    AccountKind, DrawdownPolicy, PhaseRule, PhaseStart, Plan, PriceLevel, StackSource, YearMonth,
};
use crate::sim::{calendar_period, resolve_boundary, MagiOverrun};

use super::drawdown::gross_up;
use super::{AccountState, DrawdownStrategy, IncomeBreakdown, PeriodIndex, TaxModel};
use super::{MagiTargetMiss, WithdrawalResult};

/// The fallback's kind order: cash that is already taxed, then the account
/// whose draws are taxed at capital-gains rates, then ordinary income, then
/// the tax-free accounts last so they keep compounding the longest.
const FALLBACK_ORDER: [AccountKind; 5] = [
    AccountKind::Savings,
    AccountKind::Taxable,
    AccountKind::TraditionalPreTax,
    AccountKind::Roth,
    AccountKind::Hsa,
];

/// One stack entry, resolved to the accounts it draws from.
#[derive(Debug)]
struct Rung {
    /// Indices into the account list, parallel to `plan.accounts`.
    members: Vec<usize>,
    /// In today's dollars; grown with inflation to the period it applies in.
    floor: f64,
}

/// A phase's order, resolved.
#[derive(Debug)]
enum Rule {
    Stack {
        rungs: Vec<Rung>,
        /// Accounts no rung names, in plan order: the fallback's members.
        unlisted: Vec<usize>,
    },
    /// In today's dollars; grown with inflation like a floor.
    MagiTarget { target: f64 },
}

#[derive(Debug)]
struct Phase {
    id: String,
    /// The month it takes over from the phase before.
    start: YearMonth,
    rule: Rule,
}

/// A slice of balances drawn together.
struct Tranche {
    /// `(account index, share)` — the draw is split by share.
    members: Vec<(usize, f64)>,
    capacity: f64,
    /// The rung whose floor this is, for a floor-release tranche.
    releases: Option<usize>,
}

impl Tranche {
    fn of(members: Vec<(usize, f64)>) -> Self {
        let capacity = members.iter().map(|(_, share)| share).sum();
        Tranche {
            members,
            capacity,
            releases: None,
        }
    }
}

pub struct PhasedDrawdown {
    /// In start order.
    phases: Vec<Phase>,
    start: YearMonth,
    /// What a today's-dollar floor or target grows by: the run's price
    /// level.
    prices: PriceLevel,
}

impl PhasedDrawdown {
    /// `None` for a plan whose policy is not `Phased`.
    ///
    /// Everything is resolved here, once. A phase's start becomes a month,
    /// the way a stream's boundary does; phases then run in the order of
    /// those months, and two that start in the same month leave the one
    /// listed later in force. A stack's `Account` entry becomes an index, a
    /// `Kind` entry every account of that kind no earlier entry named, and
    /// an account named twice is drawn where it is first named. A MAGI
    /// target ignores the stack.
    ///
    /// A start that cannot be resolved — a person no longer in the plan —
    /// or an entry naming a missing account drops out: validation refuses
    /// both, so only an unvalidated plan reaches either.
    ///
    /// Floors and targets are in today's dollars and grow by `prices`, which
    /// must be the price level the run itself uses.
    pub fn new(plan: &Plan, prices: PriceLevel) -> Option<Self> {
        let DrawdownPolicy::Phased(phases) = &plan.assumptions.drawdown else {
            return None;
        };
        let (plan_start, plan_end) = (plan.sim_config.start, plan.end_month());
        let mut phases: Vec<Phase> = phases
            .iter()
            .filter_map(|phase| {
                let start = match &phase.start {
                    PhaseStart::Boundary(boundary) => {
                        resolve_boundary(plan, boundary, plan_start, plan_end)?
                    }
                    PhaseStart::PenaltyFree(person) => plan.person(person)?.penalty_free_month(),
                };
                let rule = match phase.rule {
                    PhaseRule::MagiTarget { target } => Rule::MagiTarget {
                        target: target.max(0.0),
                    },
                    PhaseRule::Stack => {
                        let mut claimed = vec![false; plan.accounts.len()];
                        let rungs = phase
                            .stack
                            .iter()
                            .map(|entry| {
                                let members: Vec<usize> = plan
                                    .accounts
                                    .iter()
                                    .enumerate()
                                    .filter(|(i, account)| {
                                        !claimed[*i]
                                            && match &entry.source {
                                                StackSource::Account(id) => &account.id == id,
                                                StackSource::Kind(kind) => account.kind == *kind,
                                            }
                                    })
                                    .map(|(i, _)| i)
                                    .collect();
                                for &i in &members {
                                    claimed[i] = true;
                                }
                                Rung {
                                    members,
                                    floor: entry.floor.max(0.0),
                                }
                            })
                            .collect();
                        let unlisted = (0..plan.accounts.len()).filter(|&i| !claimed[i]).collect();
                        Rule::Stack { rungs, unlisted }
                    }
                };
                Some(Phase {
                    id: phase.id.clone(),
                    start,
                    rule,
                })
            })
            .collect();
        phases.sort_by_key(|phase| phase.start);
        Some(PhasedDrawdown {
            phases,
            start: plan.sim_config.start,
            prices,
        })
    }

    /// The phase in force in `month`: the last to start on or before it.
    /// The first phase starts at plan start, so it also covers anything
    /// earlier.
    fn phase_at(&self, month: YearMonth) -> Option<usize> {
        match self.phases.iter().rposition(|phase| phase.start <= month) {
            Some(i) => Some(i),
            None if self.phases.is_empty() => None,
            None => Some(0),
        }
    }

    /// The phases `[start, end)` falls in, each with the months of it that
    /// phase covers.
    fn segments(&self, start: YearMonth, end: YearMonth) -> Vec<(usize, YearMonth, YearMonth)> {
        let mut out = Vec::new();
        let mut from = start;
        while from < end {
            let Some(i) = self.phase_at(from) else {
                break;
            };
            let to = self
                .phases
                .get(i + 1)
                .map_or(end, |next| next.start.min(end));
            out.push((i, from, to));
            from = to;
        }
        out
    }

    /// What a today's-dollar floor or target is worth in `period`: grown by
    /// inflation to the period's start, the same exponent every
    /// inflation-grown figure and the deflator use.
    fn floor_factor(&self, period: PeriodIndex) -> f64 {
        let (period_start, _) = calendar_period(self.start, period);
        let years = self.start.months_until(period_start) as f64 / 12.0;
        self.prices.growth(0.0, years)
    }
}

/// The tranches of one period's withdrawal down a stack, from the balances
/// as they stand when it starts.
fn tranches(
    rungs: &[Rung],
    unlisted: &[usize],
    accounts: &[AccountState],
    floor_factor: f64,
) -> Vec<Tranche> {
    let funded = |i: &usize| accounts[*i].balance > 0.0;
    let by_balance = |members: &[usize]| -> Vec<(usize, f64)> {
        members
            .iter()
            .filter(|i| funded(i))
            .map(|&i| (i, accounts[i].balance))
            .collect()
    };

    let mut out = Vec::new();
    let mut floors = Vec::new();
    for (rung_index, rung) in rungs.iter().enumerate() {
        let members = by_balance(&rung.members);
        let total: f64 = members.iter().map(|(_, b)| b).sum();
        let floor = (rung.floor * floor_factor).min(total);
        out.push(Tranche {
            members: members.clone(),
            capacity: total - floor,
            releases: None,
        });
        floors.push(Tranche {
            members,
            capacity: floor,
            releases: Some(rung_index),
        });
    }

    // The fallback, as (penalized?, kind) groups. A Roth IRA before 59½
    // splits: contributions are free at any age.
    let mut groups: Vec<Vec<(usize, f64)>> = vec![Vec::new(); 2 * FALLBACK_ORDER.len()];
    let group = |penalized: bool, kind: AccountKind| {
        let position = FALLBACK_ORDER.iter().position(|k| *k == kind).unwrap_or(0);
        usize::from(penalized) * FALLBACK_ORDER.len() + position
    };
    for &i in unlisted.iter().filter(|i| funded(i)) {
        let account = &accounts[i];
        if account.penalized <= 0.0 {
            groups[group(false, account.kind)].push((i, account.balance));
        } else if account.basis_first {
            let basis = account.cost_basis.clamp(0.0, account.balance);
            if basis > 0.0 {
                groups[group(false, account.kind)].push((i, basis));
            }
            if account.balance > basis {
                groups[group(true, account.kind)].push((i, account.balance - basis));
            }
        } else {
            groups[group(true, account.kind)].push((i, account.balance));
        }
    }
    out.extend(
        groups
            .into_iter()
            .filter(|g| !g.is_empty())
            .map(Tranche::of),
    );

    out.extend(floors);
    out.retain(|t| t.capacity > 0.0);
    out
}

/// Fills `out` (parallel to the accounts) with the draw that `gross` makes
/// down the waterfall.
fn pour(tranches: &[Tranche], gross: f64, out: &mut [f64]) {
    out.fill(0.0);
    let mut remaining = gross;
    for tranche in tranches {
        if remaining <= 0.0 {
            break;
        }
        let take = remaining.min(tranche.capacity);
        let shares: f64 = tranche.members.iter().map(|(_, s)| s).sum();
        for &(i, share) in &tranche.members {
            out[i] += take * share / shares;
        }
        remaining -= take;
    }
}

/// Stage 1 of a MAGI-target phase: penalty-free pre-tax and taxable money,
/// filled together to the target.
///
/// For a gross `x` drawn here, pre-tax `P` and brokerage `B = x − P` add
/// `P + g·B` of MAGI, `g` being the brokerage's gain fraction. The split
/// takes the largest `P` that keeps that within the headroom `H`:
///
/// `P = min(x, pre-tax balance, (H − g·x) / (1 − g))`
///
/// — the last term being the `P` that lands MAGI exactly on `H`. While the
/// need is under the headroom that is all of `x`; past it the term binds
/// and falls as `x` rises, each brokerage dollar using only `g` of the
/// room. The stage ends at [`Fill::capacity`]: the most it can supply
/// without passing `H`, the brokerage taken first because it is the
/// cheaper of the two in MAGI.
#[derive(Clone, Copy, Debug)]
struct Fill {
    /// The MAGI the year can still take. Not positive: the stage is empty.
    headroom: f64,
    /// The brokerage's gain fraction, across its accounts by balance.
    gains: f64,
    pretax: f64,
    brokerage: f64,
}

/// A gain fraction this close to 1 makes the brokerage count the same as
/// pre-tax, and the split's denominator meaningless.
const ALL_GAIN: f64 = 1.0 - 1e-9;

impl Fill {
    /// The most stage 1 supplies without passing the target.
    fn capacity(&self) -> f64 {
        if self.headroom <= 0.0 {
            return 0.0;
        }
        if self.gains >= ALL_GAIN {
            return (self.pretax + self.brokerage).min(self.headroom);
        }
        let brokerage = if self.gains > 0.0 {
            self.brokerage.min(self.headroom / self.gains)
        } else {
            self.brokerage
        };
        let pretax = self
            .pretax
            .min((self.headroom - self.gains * brokerage).max(0.0));
        brokerage + pretax
    }

    /// `(pre-tax, brokerage)` for a gross of `x`, clamped to the stage's
    /// capacity.
    fn split(&self, x: f64) -> (f64, f64) {
        let x = x.clamp(0.0, self.capacity());
        let pretax = if self.gains >= ALL_GAIN {
            x.min(self.pretax)
        } else {
            x.min(self.pretax)
                .min((self.headroom - self.gains * x) / (1.0 - self.gains))
                .max(0.0)
        };
        (pretax, (x - pretax).clamp(0.0, self.brokerage))
    }
}

/// One period's withdrawal under a MAGI target: stage 1's fill, then the
/// rest of the order as a waterfall.
struct TargetPlan {
    fill: Fill,
    /// `(account, balance)` for each penalty-free pre-tax account.
    pretax: Vec<(usize, f64)>,
    /// `(account, balance)` for each taxable account.
    brokerage: Vec<(usize, f64)>,
    /// Stages 2–4.
    rest: Vec<Tranche>,
}

impl TargetPlan {
    fn new(accounts: &[AccountState], headroom: f64) -> Self {
        let mut pretax = Vec::new();
        let mut brokerage = Vec::new();
        let (mut savings, mut roth_free, mut hsa) = (Vec::new(), Vec::new(), Vec::new());
        let (mut roth_taxed, mut penalized_pretax, mut penalized_roth) =
            (Vec::new(), Vec::new(), Vec::new());
        for (i, account) in accounts.iter().enumerate() {
            let balance = account.balance;
            if balance <= 0.0 {
                continue;
            }
            match account.kind {
                AccountKind::Taxable => brokerage.push((i, balance)),
                AccountKind::TraditionalPreTax if account.penalized <= 0.0 => {
                    pretax.push((i, balance))
                }
                AccountKind::TraditionalPreTax => penalized_pretax.push((i, balance)),
                AccountKind::Savings => savings.push((i, balance)),
                AccountKind::Hsa => hsa.push((i, balance)),
                AccountKind::Roth if account.nonqualified <= 0.0 => roth_free.push((i, balance)),
                // Earnings still taxed: a Roth IRA's contributions come out
                // first and add nothing, so that slice is MAGI-free.
                AccountKind::Roth => {
                    let taxed = if account.basis_first {
                        let basis = account.cost_basis.clamp(0.0, balance);
                        if basis > 0.0 {
                            roth_free.push((i, basis));
                        }
                        balance - basis
                    } else {
                        balance
                    };
                    if taxed > 0.0 {
                        if account.penalized > 0.0 {
                            penalized_roth.push((i, taxed));
                        } else {
                            roth_taxed.push((i, taxed));
                        }
                    }
                }
            }
        }

        let total = |members: &[(usize, f64)]| members.iter().map(|(_, b)| b).sum::<f64>();
        let (pretax_total, brokerage_total) = (total(&pretax), total(&brokerage));
        let gains = if brokerage_total > 0.0 {
            brokerage
                .iter()
                .map(|&(i, b)| b * accounts[i].gains_fraction())
                .sum::<f64>()
                / brokerage_total
        } else {
            0.0
        };
        let fill = Fill {
            headroom,
            gains,
            pretax: pretax_total,
            brokerage: brokerage_total,
        };

        // What stage 1 leaves of the two it fills from, for stage 3. The
        // draw is split by balance both times, so each account's two parts
        // never sum past its balance.
        let (pretax_used, brokerage_used) = fill.split(fill.capacity());
        let remainder = |members: &[(usize, f64)], left: f64, total: f64| -> Vec<(usize, f64)> {
            if left <= 0.0 || total <= 0.0 {
                return Vec::new();
            }
            members
                .iter()
                .map(|&(i, b)| (i, left * b / total))
                .collect()
        };

        let rest = [
            savings,
            roth_free,
            hsa,
            remainder(
                &brokerage,
                brokerage_total - brokerage_used,
                brokerage_total,
            ),
            remainder(&pretax, pretax_total - pretax_used, pretax_total),
            roth_taxed,
            penalized_pretax,
            penalized_roth,
        ]
        .into_iter()
        .filter(|members| !members.is_empty())
        .map(Tranche::of)
        .filter(|t| t.capacity > 0.0)
        .collect();

        TargetPlan {
            fill,
            pretax,
            brokerage,
            rest,
        }
    }

    fn available(&self) -> f64 {
        self.fill.capacity() + self.rest.iter().map(|t| t.capacity).sum::<f64>()
    }

    /// Fills `out` (parallel to the accounts) with the draw `gross` makes.
    fn allocate(&self, gross: f64, out: &mut [f64]) {
        let first = gross.min(self.fill.capacity());
        pour(&self.rest, gross - first, out);
        let (pretax, brokerage) = self.fill.split(first);
        for (members, amount) in [(&self.pretax, pretax), (&self.brokerage, brokerage)] {
            let total: f64 = members.iter().map(|(_, b)| b).sum();
            if amount > 0.0 && total > 0.0 {
                for &(i, b) in members {
                    out[i] += amount * b / total;
                }
            }
        }
    }
}

impl PhasedDrawdown {
    /// Draws `net_needed` down one phase's order, stacked on `base`. The
    /// result's `income` is what it leaves the period with.
    fn withdraw_in(
        &self,
        phase: &Phase,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        base: &IncomeBreakdown,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        match &phase.rule {
            Rule::Stack { rungs, unlisted } => {
                self.withdraw_stack(rungs, unlisted, net_needed, accounts, tax, base, period)
            }
            Rule::MagiTarget { target } => {
                let target = target * self.floor_factor(period);
                let headroom = target - base.aca_magi();
                let plan = TargetPlan::new(accounts, headroom);
                let available = plan.available();
                if net_needed <= 0.0 || available <= 0.0 {
                    return WithdrawalResult::none(base);
                }
                let mut result = gross_up(
                    net_needed,
                    available,
                    accounts,
                    tax,
                    base,
                    period,
                    |gross, _, out| plan.allocate(gross, out),
                );
                let magi = result.income.aca_magi();
                // Stage 1 lands on the target to rounding; anything past a
                // cent in a million is a real overrun.
                if magi > target + 1e-6 * target.max(1.0) {
                    result.magi_target_missed = Some(MagiTargetMiss {
                        phase: phase.id.clone(),
                        target,
                        magi,
                        reason: if headroom < 0.0 {
                            MagiOverrun::OtherIncome
                        } else {
                            MagiOverrun::RanOut
                        },
                    });
                }
                result
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn withdraw_stack(
        &self,
        rungs: &[Rung],
        unlisted: &[usize],
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        base: &IncomeBreakdown,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        let tranches = tranches(rungs, unlisted, accounts, self.floor_factor(period));
        let available: f64 = tranches.iter().map(|t| t.capacity).sum();
        if net_needed <= 0.0 || available <= 0.0 {
            return WithdrawalResult::none(base);
        }

        let ids: Vec<_> = accounts.iter().map(|a| a.id.clone()).collect();
        let mut result = gross_up(
            net_needed,
            available,
            accounts,
            tax,
            base,
            period,
            |gross, _, out| pour(&tranches, gross, out),
        );

        // Which floors the final gross reached: every release tranche the
        // waterfall got to.
        let gross: f64 = result.gross_by_account.values().sum();
        let mut poured = 0.0;
        for tranche in &tranches {
            if poured >= gross - available * 1e-12 {
                break;
            }
            if let Some(rung) = tranche.releases {
                for &i in &rungs[rung].members {
                    if tranche.members.iter().any(|(m, _)| *m == i)
                        && !result.floors_released.contains(&ids[i])
                    {
                        result.floors_released.push(ids[i].clone());
                    }
                }
            }
            poured += tranche.capacity;
        }
        result
    }
}

impl DrawdownStrategy for PhasedDrawdown {
    fn withdraw(
        &self,
        net_needed: f64,
        accounts: &mut [AccountState],
        tax: &dyn TaxModel,
        base: &IncomeBreakdown,
        period: PeriodIndex,
    ) -> WithdrawalResult {
        let (start, end) = calendar_period(self.start, period);
        let mut segments = self.segments(start, end);
        if let [(phase, _, _)] = segments[..] {
            return self.withdraw_in(&self.phases[phase], net_needed, accounts, tax, base, period);
        }

        // A MAGI target steers by the calendar year's MAGI, so its part of
        // the year draws after the rest. A stable sort: a year with no
        // target keeps its order.
        segments.sort_by_key(|&(phase, _, _)| {
            matches!(self.phases[phase].rule, Rule::MagiTarget { .. })
        });

        // A phase boundary inside the period: each phase draws for its own
        // months, judged early or not over those months alone.
        let months = start.months_until(end) as f64;
        let mut total = WithdrawalResult::none(base);
        for (phase, from, to) in segments {
            for account in accounts.iter_mut() {
                (account.nonqualified, account.penalized) = account.early.shares(from, to);
            }
            let share = from.months_until(to) as f64 / months;
            let result = self.withdraw_in(
                &self.phases[phase],
                net_needed * share,
                accounts,
                tax,
                &total.income,
                period,
            );
            total.income = result.income;
            for (id, amount) in result.gross_by_account {
                *total.gross_by_account.entry(id).or_insert(0.0) += amount;
            }
            total.tax += result.tax;
            total.penalty += result.penalty;
            total.net += result.net;
            for id in result.floors_released {
                if !total.floors_released.contains(&id) {
                    total.floors_released.push(id);
                }
            }
            // A later part saw more of the year's MAGI, so its verdict wins.
            if result.magi_target_missed.is_some() {
                total.magi_target_missed = result.magi_target_missed;
            }
        }
        // Leave the period's own shares as the simulation marked them.
        for account in accounts.iter_mut() {
            (account.nonqualified, account.penalized) = account.early.shares(start, end);
        }
        total
    }

    fn phase(&self, period: PeriodIndex) -> Option<&str> {
        let (start, _) = calendar_period(self.start, period);
        self.phase_at(start).map(|i| self.phases[i].id.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        DrawdownPhase, FilingStatus, PhaseRule, PhaseStart, StackEntry, StateTaxProfile,
        StreamBoundary,
    };
    use crate::presets::seed_plan;
    use crate::strategies::{BracketTax, EarlyAccess};

    fn assert_close(actual: f64, expected: f64, label: &str) {
        assert!(
            (actual - expected).abs() < 1e-6,
            "{label}: expected {expected}, got {actual}"
        );
    }

    fn joint() -> BracketTax {
        let figures = crate::model::TaxFigures::tax_year_2026();
        BracketTax::new(
            &figures,
            FilingStatus::MarriedFilingJointly,
            StateTaxProfile::none(),
            PriceLevel::Constant(0.0),
            figures.tax_year,
            vec![],
        )
    }

    fn state(id: &str, kind: AccountKind, balance: f64, cost_basis: f64) -> AccountState {
        AccountState {
            id: id.to_string(),
            kind,
            balance,
            cost_basis,
            basis_first: false,
            early: EarlyAccess::default(),
            nonqualified: 0.0,
            penalized: 0.0,
        }
    }

    /// The seed plan's three accounts — brokerage, Alex's 401(k), Jordan's
    /// Roth IRA — under a one-phase stack, with zero inflation so floors are
    /// the figures typed.
    fn phased(stack: Vec<StackEntry>) -> PhasedDrawdown {
        let mut plan = seed_plan();
        plan.assumptions.inflation = 0.0;
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            rule: PhaseRule::Stack,
            stack,
        }]);
        PhasedDrawdown::new(&plan, PriceLevel::Constant(plan.assumptions.inflation))
            .expect("a phased policy")
    }

    fn entry(source: StackSource, floor: f64) -> StackEntry {
        StackEntry { source, floor }
    }

    fn accounts() -> Vec<AccountState> {
        vec![
            state(
                "taxable-brokerage",
                AccountKind::Taxable,
                100_000.0,
                100_000.0,
            ),
            state("alex-401k", AccountKind::TraditionalPreTax, 500_000.0, 0.0),
            state("jordan-roth", AccountKind::Roth, 200_000.0, 0.0),
        ]
    }

    /// A draw the first entry can cover never touches the second.
    #[test]
    fn the_stack_is_drawn_strictly_in_order() {
        let drawdown = phased(vec![
            entry(StackSource::Account("jordan-roth".to_string()), 0.0),
            entry(StackSource::Account("alex-401k".to_string()), 0.0),
        ]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            150_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["jordan-roth"],
            150_000.0,
            "Roth first",
        );
        assert_eq!(result.gross_by_account.len(), 1, "nothing else touched");
        assert_close(result.tax, 0.0, "a qualified Roth draw is untaxed");

        // Past the first entry, the second picks up the rest.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            250_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[2].balance, 0.0, "Roth emptied");
        assert!(
            result.gross_by_account["alex-401k"] > 50_000.0,
            "then the 401(k), grossed up"
        );
        assert_close(result.net, 250_000.0, "the need is still met");
        assert!(!result.gross_by_account.contains_key("taxable-brokerage"));
    }

    /// Accounts the stack does not name are drawn after it, in the fallback
    /// order: taxable before pre-tax before Roth.
    #[test]
    fn unlisted_accounts_fall_back_in_tax_order() {
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            120_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["taxable-brokerage"],
            100_000.0,
            "taxable first",
        );
        // $20,000 of ordinary income sits under the joint standard
        // deduction, so it is drawn untaxed.
        assert_close(
            result.gross_by_account["alex-401k"],
            20_000.0,
            "then pre-tax",
        );
        assert!(
            !result.gross_by_account.contains_key("jordan-roth"),
            "Roth last"
        );
    }

    /// Before 59½ the fallback takes penalty-free money first — even a Roth,
    /// which otherwise comes last — and a Roth IRA's contributions count as
    /// penalty-free while its earnings do not.
    #[test]
    fn the_fallback_takes_penalized_money_last() {
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        accounts[0].balance = 0.0;
        accounts[1].penalized = 1.0;
        accounts[2].penalized = 1.0;
        accounts[2].nonqualified = 1.0;
        accounts[2].basis_first = true;
        accounts[2].cost_basis = 30_000.0;

        let result = drawdown.withdraw(
            50_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        // $30,000 of Roth contributions, then penalized pre-tax — which the
        // order puts ahead of penalized Roth earnings.
        assert_close(
            result.gross_by_account["jordan-roth"],
            30_000.0,
            "contributions only",
        );
        assert!(result.gross_by_account["alex-401k"] > 20_000.0);
        assert!(result.penalty > 0.0);
    }

    /// A `Kind` entry draws every account of that kind together, in
    /// proportion to balance.
    #[test]
    fn a_kind_entry_splits_by_balance() {
        let mut plan = seed_plan();
        let mut second = plan.accounts[2].clone();
        second.id = "second-roth".to_string();
        plan.accounts.push(second);
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            rule: PhaseRule::Stack,
            stack: vec![entry(StackSource::Kind(AccountKind::Roth), 0.0)],
        }]);
        let drawdown =
            PhasedDrawdown::new(&plan, PriceLevel::Constant(plan.assumptions.inflation)).unwrap();
        let mut accounts = accounts();
        accounts.push(state("second-roth", AccountKind::Roth, 600_000.0, 0.0));

        let result = drawdown.withdraw(
            80_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(
            result.gross_by_account["jordan-roth"],
            20_000.0,
            "a quarter",
        );
        assert_close(
            result.gross_by_account["second-roth"],
            60_000.0,
            "three quarters",
        );
    }

    /// A floor holds until everything else — the rest of the stack and the
    /// fallback — is spent, then gives way rather than failing the plan, and
    /// says which account it came from.
    #[test]
    fn a_floor_is_released_last_and_reported() {
        let drawdown = phased(vec![entry(
            StackSource::Account("taxable-brokerage".to_string()),
            40_000.0,
        )]);

        // Within what is above the floor: no release.
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            60_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[0].balance, 40_000.0, "stops at the floor");
        assert!(result.floors_released.is_empty());

        // Past it: the fallback pays before the floor does.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            100_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert_close(accounts[0].balance, 40_000.0, "the floor still holds");
        assert!(result.gross_by_account["alex-401k"] > 40_000.0);
        assert!(result.floors_released.is_empty());

        // Only when everything else is gone.
        let mut accounts = self::accounts();
        let result = drawdown.withdraw(
            790_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        assert!(accounts[0].balance < 40_000.0, "released");
        assert_eq!(
            result.floors_released,
            vec!["taxable-brokerage".to_string()]
        );
        for account in &accounts {
            assert!(account.balance >= 0.0, "{} went negative", account.id);
        }
    }

    /// Everything the household holds is reachable, and no further: a need
    /// beyond the portfolio empties every account to exactly zero and
    /// reports the shortfall.
    #[test]
    fn depletion_empties_every_account_and_no_more() {
        let drawdown = phased(vec![entry(
            StackSource::Account("jordan-roth".to_string()),
            50_000.0,
        )]);
        let mut accounts = accounts();
        let result = drawdown.withdraw(
            5_000_000.0,
            &mut accounts,
            &joint(),
            &IncomeBreakdown::default(),
            0,
        );
        for account in &accounts {
            assert_eq!(account.balance, 0.0, "{} not emptied", account.id);
        }
        assert_close(
            result.gross_by_account.values().sum(),
            800_000.0,
            "the whole portfolio",
        );
        assert!(result.net < 5_000_000.0);
    }

    /// The one-tax-stack invariant holds through the waterfall: the base
    /// bill plus the reported marginal cost is the bill on everything.
    #[test]
    fn the_reported_tax_is_the_marginal_cost_over_the_base_income() {
        let tax = joint();
        let base = IncomeBreakdown {
            ordinary: 30_000.0,
            social_security: 45_000.0,
            ..Default::default()
        };
        let drawdown = phased(vec![]);
        let mut accounts = accounts();
        // Half gains, so the taxable tranche realizes some.
        accounts[0].cost_basis = 50_000.0;
        let result = drawdown.withdraw(150_000.0, &mut accounts, &tax, &base, 0);

        let taxable = result.gross_by_account["taxable-brokerage"];
        let pretax = result.gross_by_account["alex-401k"];
        let combined = IncomeBreakdown {
            ordinary: base.ordinary + pretax,
            capital_gains: 0.5 * taxable,
            untaxed: 0.5 * taxable,
            social_security: base.social_security,
        };
        assert_close(
            tax.tax(&base, 0).tax + result.tax,
            tax.tax(&combined, 0).tax,
            "base bill plus marginal cost is the whole period's bill",
        );
        assert_close(result.net, 150_000.0, "the gross-up covers the need");
    }

    /// Phases take over at their start month, in date order whatever order
    /// they are listed in, and a year a start falls inside is split there.
    #[test]
    fn a_year_is_split_at_each_phase_start() {
        let mut plan = seed_plan();
        let phase = |id: &str, start: PhaseStart| DrawdownPhase {
            id: id.to_string(),
            name: id.to_string(),
            start,
            rule: PhaseRule::Stack,
            stack: vec![],
        };
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![
            phase("first", PhaseStart::Boundary(StreamBoundary::PlanStart)),
            // Listed out of order on purpose.
            phase(
                "third",
                PhaseStart::Boundary(StreamBoundary::Date(YearMonth::new(2041, 1))),
            ),
            // Alex, born August 1983, reaches 59½ in February 2043.
            phase("second", PhaseStart::PenaltyFree("alex".to_string())),
        ]);
        let drawdown =
            PhasedDrawdown::new(&plan, PriceLevel::Constant(plan.assumptions.inflation)).unwrap();
        let ids = |segments: Vec<(usize, YearMonth, YearMonth)>| -> Vec<(&str, i64)> {
            segments
                .into_iter()
                .map(|(i, from, to)| (drawdown.phases[i].id.as_str(), from.months_until(to)))
                .collect()
        };
        let year = |y: i32| (YearMonth::new(y, 1), YearMonth::new(y + 1, 1));

        let (s, e) = year(2030);
        assert_eq!(ids(drawdown.segments(s, e)), vec![("first", 12)]);
        let (s, e) = year(2041);
        assert_eq!(ids(drawdown.segments(s, e)), vec![("third", 12)]);
        let (s, e) = year(2043);
        assert_eq!(
            ids(drawdown.segments(s, e)),
            vec![("third", 1), ("second", 11)]
        );
        let (s, e) = year(2044);
        assert_eq!(ids(drawdown.segments(s, e)), vec![("second", 12)]);
    }

    /// Floors are today's dollars: at 3% inflation a $10,000 floor holds
    /// back $10,000 × 1.03¹⁰ ten years in.
    #[test]
    fn a_floor_grows_with_inflation() {
        let mut plan = seed_plan();
        plan.assumptions.inflation = 0.03;
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "only".to_string(),
            name: "Only".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            rule: PhaseRule::Stack,
            stack: vec![entry(
                StackSource::Account("taxable-brokerage".to_string()),
                10_000.0,
            )],
        }]);
        let drawdown =
            PhasedDrawdown::new(&plan, PriceLevel::Constant(plan.assumptions.inflation)).unwrap();
        // The seed plan starts in January, so period 10 is ten whole years on.
        assert_close(
            drawdown.floor_factor(10),
            1.03f64.powf(10.0),
            "ten years of inflation",
        );
    }

    // ---- MAGI target (#187) ----

    fn zero_tax() -> crate::strategies::FlatTax {
        crate::strategies::FlatTax { rate: 0.0 }
    }

    /// The seed plan under one MAGI-target phase, at zero inflation so the
    /// target is the figure typed.
    fn target_phase(target: f64) -> PhasedDrawdown {
        let mut plan = seed_plan();
        plan.assumptions.inflation = 0.0;
        plan.assumptions.drawdown = DrawdownPolicy::Phased(vec![DrawdownPhase {
            id: "target".to_string(),
            name: "Target".to_string(),
            start: PhaseStart::Boundary(StreamBoundary::PlanStart),
            rule: PhaseRule::MagiTarget { target },
            stack: vec![],
        }]);
        PhasedDrawdown::new(&plan, PriceLevel::Constant(0.0)).expect("a phased policy")
    }

    /// A brokerage that is half gain, a large 401(k), a qualified Roth.
    fn bridge_accounts() -> Vec<AccountState> {
        vec![
            state("brokerage", AccountKind::Taxable, 1_000_000.0, 500_000.0),
            state("401k", AccountKind::TraditionalPreTax, 1_000_000.0, 0.0),
            state("roth", AccountKind::Roth, 200_000.0, 0.0),
        ]
    }

    fn fill(headroom: f64, gains: f64, pretax: f64, brokerage: f64) -> Fill {
        Fill {
            headroom,
            gains,
            pretax,
            brokerage,
        }
    }

    /// The split, by hand. Headroom $50,000, a brokerage half gain.
    #[test]
    fn stage_one_fills_pre_tax_then_trades_it_for_brokerage_at_the_target() {
        let f = fill(50_000.0, 0.5, 1_000_000.0, 1_000_000.0);
        // Under the headroom: all pre-tax.
        let (p, b) = f.split(30_000.0);
        assert_close(p, 30_000.0, "pre-tax");
        assert_close(b, 0.0, "brokerage");
        // $80,000: P + B = 80,000 and P + B/2 = 50,000, so B = 60,000.
        let (p, b) = f.split(80_000.0);
        assert_close(p, 20_000.0, "pre-tax");
        assert_close(b, 60_000.0, "brokerage");
        // The stage ends where the brokerage's gains alone fill the room:
        // $100,000 of sales, $50,000 of gain, no pre-tax.
        assert_close(f.capacity(), 100_000.0, "capacity");
        let (p, b) = f.split(f.capacity());
        assert_close(p, 0.0, "pre-tax at the end");
        assert_close(b, 100_000.0, "brokerage at the end");
    }

    /// When the brokerage runs out first, the rest of the room is pre-tax:
    /// $20,000 of sales use $10,000 of it and $40,000 of pre-tax the rest.
    /// When pre-tax runs out first, the brokerage covers more of the need.
    #[test]
    fn stage_one_respects_both_balances() {
        let short_brokerage = fill(50_000.0, 0.5, 1_000_000.0, 20_000.0);
        assert_close(short_brokerage.capacity(), 60_000.0, "capacity");
        let (p, b) = short_brokerage.split(60_000.0);
        assert_close(p, 40_000.0, "pre-tax");
        assert_close(b, 20_000.0, "brokerage");

        let short_pretax = fill(50_000.0, 0.5, 10_000.0, 1_000_000.0);
        let (p, b) = short_pretax.split(30_000.0);
        assert_close(p, 10_000.0, "all the pre-tax there is");
        assert_close(b, 20_000.0, "the rest from the brokerage");
        // $95,000: P = (50,000 − 47,500) / 0.5 = 5,000.
        let (p, b) = short_pretax.split(95_000.0);
        assert_close(p, 5_000.0, "pre-tax");
        assert_close(b, 90_000.0, "brokerage");
    }

    /// The edges: a brokerage of pure basis adds nothing, so all of it is
    /// in the stage; one of pure gain counts as pre-tax does; and no
    /// headroom means no stage at all.
    #[test]
    fn stage_one_at_its_edges() {
        let basis = fill(50_000.0, 0.0, 1_000_000.0, 300_000.0);
        assert_close(
            basis.capacity(),
            350_000.0,
            "the brokerage plus $50k of pre-tax",
        );
        let (p, b) = basis.split(200_000.0);
        assert_close(p, 50_000.0, "pre-tax up to the room");
        assert_close(b, 150_000.0, "brokerage for the rest");

        let gain = fill(50_000.0, 1.0, 1_000_000.0, 300_000.0);
        assert_close(gain.capacity(), 50_000.0, "the room, and no more");
        let (p, b) = gain.split(50_000.0);
        assert_close(p, 50_000.0, "pre-tax first");
        assert_close(b, 0.0, "brokerage");

        for headroom in [0.0, -10_000.0] {
            let none = fill(headroom, 0.5, 1_000_000.0, 300_000.0);
            assert_close(none.capacity(), 0.0, "no room");
            let (p, b) = none.split(10_000.0);
            assert_close(p + b, 0.0, "nothing drawn");
        }
    }

    /// Over a sweep of the stage: never past either balance or the room,
    /// on the target wherever the need is past it, and continuous — a step
    /// of a dollar in the gross moves no account by more than 1/(1 − g).
    #[test]
    fn stage_one_never_overshoots_and_has_no_jumps() {
        for gains in [0.0, 0.1, 0.5, 0.9, 0.99] {
            for (pretax, brokerage) in [(1e6, 1e6), (30_000.0, 1e6), (1e6, 30_000.0)] {
                let f = fill(50_000.0, gains, pretax, brokerage);
                let mut prev = f.split(0.0);
                let mut x = 0.0;
                while x <= f.capacity() {
                    let (p, b) = f.split(x);
                    let magi = p + gains * b;
                    assert!(p <= pretax + 1e-6 && b <= brokerage + 1e-6);
                    assert_close(p + b, x, "the split is the whole gross");
                    assert!(magi <= 50_000.0 + 1e-6, "past the room at {x}: {magi}");
                    if x >= 50_000.0 && pretax >= 50_000.0 {
                        assert_close(magi, 50_000.0, "on the target");
                    }
                    let bound = 1.0 / (1.0 - gains) + 1e-6;
                    assert!((p - prev.0).abs() <= bound && (b - prev.1).abs() <= bound);
                    prev = (p, b);
                    x += 1.0;
                }
            }
        }
    }

    /// $80,000 at a $50,000 target, untaxed so gross is need: the year
    /// lands on the target with $20,000 of pre-tax and $60,000 of
    /// brokerage, and the Roth is not touched.
    #[test]
    fn a_target_lands_the_years_magi_on_it() {
        let mut accounts = bridge_accounts();
        let base = IncomeBreakdown::default();
        let result =
            target_phase(50_000.0).withdraw(80_000.0, &mut accounts, &zero_tax(), &base, 0);
        assert_close(result.gross_by_account["401k"], 20_000.0, "pre-tax");
        assert_close(result.gross_by_account["brokerage"], 60_000.0, "brokerage");
        assert!(!result.gross_by_account.contains_key("roth"));
        assert_close(result.income.aca_magi(), 50_000.0, "MAGI");
        assert_eq!(result.magi_target_missed, None);
    }

    /// A target is not a quota: a year needing less than it stays below it.
    #[test]
    fn a_need_below_the_target_stays_below_it() {
        let mut accounts = bridge_accounts();
        let base = IncomeBreakdown::default();
        let result =
            target_phase(50_000.0).withdraw(30_000.0, &mut accounts, &zero_tax(), &base, 0);
        assert_close(result.gross_by_account["401k"], 30_000.0, "all pre-tax");
        assert_close(result.income.aca_magi(), 30_000.0, "MAGI");
    }

    /// Other income already over the target: the draw takes money that
    /// adds no MAGI — savings, then Roth — and the year is reported.
    #[test]
    fn income_over_the_target_draws_magi_free_money_and_reports_it() {
        let mut accounts = bridge_accounts();
        accounts.push(state("savings", AccountKind::Savings, 10_000.0, 0.0));
        let base = IncomeBreakdown {
            ordinary: 60_000.0,
            ..Default::default()
        };
        let result =
            target_phase(50_000.0).withdraw(40_000.0, &mut accounts, &zero_tax(), &base, 0);
        assert_close(
            result.gross_by_account["savings"],
            10_000.0,
            "savings first",
        );
        assert_close(result.gross_by_account["roth"], 30_000.0, "then Roth");
        assert_eq!(result.gross_by_account.len(), 2, "nothing that adds MAGI");
        assert_eq!(
            result.magi_target_missed,
            Some(MagiTargetMiss {
                phase: "target".to_string(),
                target: 50_000.0,
                magi: 60_000.0,
                reason: MagiOverrun::OtherIncome,
            })
        );
    }

    /// Past what keeps MAGI down, the target gives way: the brokerage's
    /// stage-1 share was all of it, so the next $50,000 is pre-tax over
    /// the target.
    #[test]
    fn past_the_magi_free_money_the_target_is_soft() {
        let mut accounts = vec![
            state("brokerage", AccountKind::Taxable, 100_000.0, 50_000.0),
            state("401k", AccountKind::TraditionalPreTax, 1_000_000.0, 0.0),
        ];
        let base = IncomeBreakdown::default();
        let result =
            target_phase(50_000.0).withdraw(150_000.0, &mut accounts, &zero_tax(), &base, 0);
        assert_close(result.gross_by_account["brokerage"], 100_000.0, "brokerage");
        assert_close(
            result.gross_by_account["401k"],
            50_000.0,
            "pre-tax over the target",
        );
        assert_close(result.income.aca_magi(), 100_000.0, "MAGI");
        assert_eq!(
            result.magi_target_missed.map(|miss| miss.reason),
            Some(MagiOverrun::RanOut)
        );
    }

    /// A penalized account waits for everything else, the Roth included.
    /// Untaxed but for the penalty, the last $50,000 costs $50,000 / 0.9.
    #[test]
    fn penalized_money_is_drawn_last() {
        let mut accounts = vec![
            state("brokerage", AccountKind::Taxable, 100_000.0, 100_000.0),
            state("401k", AccountKind::TraditionalPreTax, 1_000_000.0, 0.0),
            state("roth", AccountKind::Roth, 50_000.0, 0.0),
        ];
        accounts[1].penalized = 1.0;
        let base = IncomeBreakdown::default();
        let drawdown = target_phase(50_000.0);

        let mut before = accounts.clone();
        let result = drawdown.withdraw(150_000.0, &mut before, &zero_tax(), &base, 0);
        assert!(!result.gross_by_account.contains_key("401k"), "not yet");
        assert_close(result.penalty, 0.0, "no penalty");

        let result = drawdown.withdraw(200_000.0, &mut accounts, &zero_tax(), &base, 0);
        assert_close(result.gross_by_account["brokerage"], 100_000.0, "brokerage");
        assert_close(result.gross_by_account["roth"], 50_000.0, "Roth");
        assert_close(
            result.gross_by_account["401k"],
            50_000.0 / 0.9,
            "the penalized 401(k), grossed up for its 10%",
        );
    }

    /// Against a brokerage that is 90% gain the band pinned at the target
    /// is steep: each dollar of need trades $9 of pre-tax for brokerage,
    /// and in the 12% bracket that cuts the tax faster than the gross
    /// rises, so the fixed point never settles. The bracketed search does,
    /// on the target, with the need met.
    #[test]
    fn a_steep_band_is_solved_where_the_fixed_point_would_not_be() {
        let tax = joint();
        let base = IncomeBreakdown::default();
        let target = 90_000.0;
        let need = 88_000.0;
        let accounts = vec![
            state("brokerage", AccountKind::Taxable, 1_000_000.0, 100_000.0),
            state("401k", AccountKind::TraditionalPreTax, 1_000_000.0, 0.0),
        ];

        // The plain iteration, over the same allocation and cost.
        let plan = TargetPlan::new(&accounts, target);
        let base_tax = tax.tax(&base, 0).tax;
        let mut amounts = vec![0.0; accounts.len()];
        let mut cost = |gross: f64| {
            plan.allocate(gross, &mut amounts);
            let (income, _) = super::super::drawdown::income_with(&base, &accounts, &amounts);
            tax.tax(&income, 0).tax - base_tax
        };
        let mut gross = need;
        let mut settled = false;
        for _ in 0..100 {
            let next = need + cost(gross);
            if (next - gross).abs() < 1e-12 * need {
                settled = true;
                break;
            }
            gross = next;
        }
        assert!(!settled, "the fixed point alone settles at {gross}");

        let mut accounts = accounts;
        let result = target_phase(target).withdraw(need, &mut accounts, &tax, &base, 0);
        assert!(
            (result.net - need).abs() < 1e-6,
            "the need is met: {}",
            result.net
        );
        assert!(
            (result.income.aca_magi() - target).abs() < 1.0,
            "on the target: {}",
            result.income.aca_magi()
        );
        assert_eq!(result.magi_target_missed, None);
    }

    /// A phase saved before the choice existed is a stack.
    #[test]
    fn a_phase_without_a_rule_loads_as_a_stack() {
        let phase: DrawdownPhase = serde_yaml_ng::from_str(
            "id: bridge\nname: Bridge\nstart: !Boundary PlanStart\nstack: []\n",
        )
        .expect("an old phase parses");
        assert_eq!(phase.rule, PhaseRule::Stack);
    }
}
