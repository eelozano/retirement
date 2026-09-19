use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{AccountId, ContributionId, StreamDirection, StreamId, YearMonth};

/// Non-fatal issues surfaced by a simulation run.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub enum SimWarning {
    /// The portfolio could not cover spending from this period on.
    DepletedFunds { period: usize },
    /// An account's planned contribution exceeded what its owner is allowed
    /// to contribute and was clamped. `allowed` can be zero when the owner's
    /// other accounts share the same statutory bucket and were filled first
    /// — see `sim::contributions`.
    ///
    /// Reported once per account, for the **first** period it happens in:
    /// with indexed limits and salary-linked contributions, whether a
    /// contribution fits is a function of the year, so the year is part of
    /// the finding rather than an implied "always".
    ContributionClamped {
        account: AccountId,
        /// First period the clamp bit. Index into `Projection::snapshots`.
        period: usize,
        /// Planned contribution for that period, in nominal dollars.
        requested: f64,
        /// Contribution the simulation actually made that period.
        allowed: f64,
    },
    /// An employer match is declared with a destination that has no account
    /// to land in — a pre-tax match with no pre-tax employer-plan account
    /// for the owner, or the Roth equivalent. Depositing it in the declared
    /// account anyway would tax the withdrawals wrongly for decades, so it
    /// is skipped and reported.
    MatchUnallocated { account: AccountId },
    /// Employee deferrals plus employer match exceeded the 415(c) annual
    /// additions cap. Only the match is trimmed — the deferrals were already
    /// allowed under the employee's own limit. Reported for the first period
    /// it happens in, like `ContributionClamped`.
    AnnualAdditionsClamped {
        account: AccountId,
        period: usize,
        requested: f64,
        allowed: f64,
    },
    /// Sweep is enabled but there is no taxable account for surplus cash to
    /// land in.
    SurplusUnallocated,
    /// `Assumptions::sweep_surplus_from` names a person who is no longer in
    /// the plan, so the month the sweep would start cannot be resolved. No
    /// surplus is swept — the same behaviour as leaving it off — and this
    /// says so, rather than quietly falling back to sweeping from plan start
    /// and pouring working-phase spending into the portfolio.
    SweepBoundaryUnresolved,
    /// A required minimum distribution was forced out of a pre-tax account
    /// and there is no taxable account for the after-tax remainder to land
    /// in. Louder than `SurplusUnallocated` and reported separately: surplus
    /// that goes uninvested is income that never entered an account, but
    /// these dollars have already left one, so nothing receiving them means
    /// household net worth falls by the remainder every year.
    ///
    /// Reported once, for the first period it happens in.
    RequiredDistributionUnallocated { period: usize },
    /// A stream references a person id that does not exist; it was skipped.
    UnknownPersonRef { stream: StreamId },
    /// A contribution entry on this account starts or ends at the
    /// retirement or death of a person who is no longer in the plan, so its
    /// window cannot be resolved. The entry contributes nothing — the
    /// contribution analogue of `UnknownPersonRef`. Reported once per
    /// account.
    ContributionBoundaryUnresolved { account: AccountId },
    /// The account elects the Rule of 55 but does not qualify, so its
    /// withdrawals before the owner's 59½ still carry the 10% additional
    /// tax. Checked rather than taken on trust: the election is a claim
    /// about dates the plan already holds, and a mistyped retirement date
    /// should not quietly waive a penalty. Reported once per account.
    Rule55Ineligible {
        account: AccountId,
        reason: Rule55Ineligibility,
    },
    /// A withdrawal was taken before its owner could take it freely and
    /// paid the 10% additional tax — see `sim::early_access`. Reported
    /// once, for the first period it happens in; the amount per period is
    /// `PeriodSnapshot::early_withdrawal_penalty`.
    EarlyWithdrawalPenalty { period: usize },
    /// A drawdown floor on this account was drawn into: everything else the
    /// household holds was already spent. Floors are soft on purpose — see
    /// `StackEntry::floor`. Reported once per account, for the first period.
    FloorReleased { account: AccountId, period: usize },
}

/// Why a Rule of 55 election does not hold.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum Rule55Ineligibility {
    /// Only a 401(k)/403(b)-style employer plan qualifies — never an IRA,
    /// a 457(b) (which needs no exemption), or a non-retirement account.
    NotAnEmployerPlan,
    /// The owner retires before the calendar year they turn 55.
    SeparatedBefore55,
}

/// One simulated period (a year in V1), in nominal dollars.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct PeriodSnapshot {
    pub period: usize,
    pub period_start: YearMonth,
    /// End-of-period balance per account.
    pub balances: BTreeMap<AccountId, f64>,
    /// Gross stream income accrued this period.
    pub income: f64,
    /// `income` attributed per stream (#67): the values sum to `income`.
    /// Keyed by the id of the stream as the engine ran it, so Social
    /// Security and survivor streams synthesized at simulate time appear
    /// under their own ids — `Projection::streams` names them. A stream
    /// absent here accrued nothing this period, as with `withdrawals`.
    pub income_by_stream: BTreeMap<StreamId, f64>,
    /// Stream expenses this period.
    pub expenses: f64,
    /// `expenses` attributed per stream; the values sum to `expenses`.
    pub expenses_by_stream: BTreeMap<StreamId, f64>,
    /// Total tax paid this period (on income and on withdrawals).
    pub taxes: f64,
    /// The part of `taxes` the withdrawal gross-up added — the drawdown's
    /// marginal cost over the bill on the period's base income (stream
    /// income, required distributions, savings interest). Always within
    /// `[0, taxes]`; `taxes - withdrawal_taxes` is the tax on income.
    ///
    /// This is a figure the engine computes separately, not an allocation
    /// of a pooled bill: the two halves meet the progressive schedule as one
    /// stack (#54), and this records what the second half added.
    pub withdrawal_taxes: f64,
    /// The part of `withdrawal_taxes` that is the 10% additional tax on
    /// early withdrawals, not income tax — see `sim::early_access`. A share
    /// of it, never an addition: `taxes` already counts it once.
    pub early_withdrawal_penalty: f64,
    /// The id of the drawdown phase in force at the start of this period —
    /// a `DrawdownPhase::id` — or `None` under the proportional drawdown.
    /// Reported whether or not anything was drawn, so a view can mark the
    /// phases across the whole projection.
    pub drawdown_phase: Option<String>,
    /// Contributions deposited into accounts this period, out of household
    /// income. Employer match is *not* included — it never passes through
    /// the household's cash, so folding it in here would break the
    /// income = outflow + surplus identity.
    pub contributions: f64,
    /// `contributions` per receiving account; the values sum to
    /// `contributions`. Employer match is excluded, as above.
    pub contributions_by_account: BTreeMap<AccountId, f64>,
    /// Employer matching contributions deposited this period. Employer
    /// money: it raises balances without reducing household cash.
    pub employer_match: f64,
    /// Money deposited this period from outside the plan — one-time
    /// contributions such as a home sale's proceeds. Like `employer_match`
    /// it raises balances without passing through household cash, so it is
    /// not part of `contributions` and sits outside the income = outflow +
    /// surplus identity. `Projection::one_time` names the entries.
    pub one_time_contributions: f64,
    /// Gross required minimum distributions forced out of pre-tax accounts
    /// this period (#49). Part of `withdrawals`, not an addition to them:
    /// the forced share of the period's gross draw.
    pub required_distributions: f64,
    /// Leftover household cash this period (income and required
    /// distributions, minus contributions, taxes, and expenses).
    ///
    /// How much of it is actually invested depends on where it came from.
    /// The `required_distributions` share is always reinvested in a taxable
    /// account — that money has already left a pre-tax balance, and dropping
    /// it would destroy real wealth. The rest is only invested from
    /// `assumptions.sweep_surplus_from` onward; before that it is
    /// informational — and while the household is still working, it is
    /// better read as current spending than as leftovers (#50).
    pub surplus: f64,
    /// Gross withdrawals per account this period.
    pub withdrawals: BTreeMap<AccountId, f64>,
    /// Market growth applied to post-flow balances this period, summed
    /// across accounts, in nominal dollars: the dollar amount `grow()`
    /// produced but that a balance-only snapshot would otherwise discard.
    pub growth: f64,
    pub net_worth: f64,
    /// Cumulative inflation factor at period **start**: divide any nominal
    /// value in this snapshot by it to get simulation-start (today's)
    /// dollars.
    ///
    /// Exact for the flows (`income`, `expenses`, and the rest), which are
    /// grown by the same exponent. `balances` and `net_worth` are
    /// end-of-period figures, so a real-dollar balance carries one year of
    /// inflation this does not remove — about 3% at the default
    /// assumption, uniformly across the projection. Scenario deltas,
    /// depletion years and success rates are unaffected. A documented
    /// convention rather than a second field; see "Time conventions" in
    /// `docs/ARCHITECTURE.md`.
    pub deflator: f64,
}

/// A stream as the engine actually ran it — what the per-stream maps on
/// `PeriodSnapshot` are keyed by. Plan streams appear under their own ids;
/// Social Security benefits and survivor continuations are synthesized at
/// simulate time with ids and names the plan never sees, and this is what
/// lets a view label them without mirroring the engine's id formats.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct StreamInfo {
    pub id: StreamId,
    pub name: String,
    pub direction: StreamDirection,
}

/// A one-time contribution as the engine actually deposited it: which entry,
/// in which period, and how many nominal dollars. What the year inspector,
/// the cash-flow notes and the CSV export label a lump sum with.
///
/// Listed by the engine rather than re-derived by each view, because "which
/// year does this land in" is exactly the kind of question the Time
/// conventions in `docs/ARCHITECTURE.md` keep in one place: a person-relative
/// date resolves against a retirement a view would otherwise have to look
/// up, and the amount has already been grown. An entry that never landed —
/// dated before the plan starts, at or after the horizon, or tied to a person
/// no longer in the plan — is not listed.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct OneTimeInfo {
    pub account: AccountId,
    /// The entry's id, distinct within `account`.
    pub id: ContributionId,
    pub name: String,
    /// Index into `Projection::snapshots`.
    pub period: usize,
    /// Nominal dollars deposited, already grown by the entry's growth rule.
    pub amount: f64,
}

/// Full result of one simulation path.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Projection {
    pub snapshots: Vec<PeriodSnapshot>,
    pub warnings: Vec<SimWarning>,
    /// Every stream the run accrued, in run order: the plan's own, then
    /// Social Security, then survivor continuations. A stream skipped with
    /// `UnknownPersonRef` is not listed, since it never accrued.
    pub streams: Vec<StreamInfo>,
    /// Every one-time contribution the run deposited, in the order they
    /// landed. Within a period their amounts sum to that snapshot's
    /// `one_time_contributions`.
    pub one_time: Vec<OneTimeInfo>,
}
