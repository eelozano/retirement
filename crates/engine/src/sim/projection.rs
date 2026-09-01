use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{AccountId, StreamId, YearMonth};

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
    /// Stream expenses this period.
    pub expenses: f64,
    /// Total tax paid this period (on income and on withdrawals).
    pub taxes: f64,
    /// Contributions deposited into accounts this period, out of household
    /// income. Employer match is *not* included — it never passes through
    /// the household's cash, so folding it in here would break the
    /// income = outflow + surplus identity.
    pub contributions: f64,
    /// Employer matching contributions deposited this period. Employer
    /// money: it raises balances without reducing household cash.
    pub employer_match: f64,
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
    /// it would destroy real wealth. The rest is only invested when
    /// `assumptions.sweep_surplus_to_taxable` is set; otherwise it is
    /// informational.
    pub surplus: f64,
    /// Gross withdrawals per account this period.
    pub withdrawals: BTreeMap<AccountId, f64>,
    pub net_worth: f64,
    /// Cumulative inflation factor at period start: divide any nominal value
    /// in this snapshot by it to get simulation-start (today's) dollars.
    pub deflator: f64,
}

/// Full result of one simulation path.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Projection {
    pub snapshots: Vec<PeriodSnapshot>,
    pub warnings: Vec<SimWarning>,
}
