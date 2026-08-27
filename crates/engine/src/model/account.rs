use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{AssetClass, PersonId};

pub type AccountId = String;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum AccountKind {
    /// Brokerage: contributions form cost basis; withdrawals realize gains
    /// proportionally.
    Taxable,
    /// 401(k)/Traditional IRA: withdrawals are ordinary income.
    TraditionalPreTax,
    /// Roth IRA/401(k): qualified withdrawals are untaxed.
    Roth,
}

/// Portfolio allocation: a named preset or explicit weights summing to 1.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub enum AllocationRef {
    Aggressive,
    Moderate,
    Conservative,
    Custom(BTreeMap<AssetClass, f64>),
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Account {
    pub id: AccountId,
    pub owner: PersonId,
    pub kind: AccountKind,
    pub name: String,
    /// Starting balance in nominal dollars as of the simulation start.
    pub balance: f64,
    /// Taxable accounts only: cost basis of the starting balance. Tracked
    /// from day 1 so V2 capital-gains modeling needs no migration; the V1
    /// flat tax already uses it to split withdrawals into principal vs gains.
    pub cost_basis: Option<f64>,
    pub allocation: AllocationRef,
    /// Planned contribution per year (in simulation-start dollars) while the
    /// owner is still working.
    pub annual_contribution: f64,
    /// Statutory cap in simulation-start dollars; contributions above it are
    /// clamped with a warning. None = uncapped (taxable).
    pub contribution_limit: Option<f64>,
}
