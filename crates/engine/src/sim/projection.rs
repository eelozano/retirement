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
    /// to contribute this year and was clamped. `allowed` can be less than
    /// the account's own limit when the owner's other accounts share the
    /// same statutory bucket and were filled first — see `sim::contributions`.
    ContributionClamped {
        account: AccountId,
        /// Planned annual contribution, as entered.
        requested: f64,
        /// Annual contribution the simulation actually made.
        allowed: f64,
    },
    /// Sweep is enabled but there is no taxable account for surplus cash to
    /// land in.
    SurplusUnallocated,
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
    /// Contributions deposited into accounts this period.
    pub contributions: f64,
    /// Leftover household cash this period (income minus contributions,
    /// taxes, and expenses). Only actually invested when
    /// `assumptions.sweep_surplus_to_taxable` is set — otherwise this is
    /// informational only.
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
