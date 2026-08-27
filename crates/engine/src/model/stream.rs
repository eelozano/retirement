use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{PersonId, YearMonth};

pub type StreamId = String;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum StreamDirection {
    Income,
    Expense,
}

/// When a stream turns on or off. Person-relative boundaries mean editing a
/// retirement date moves every stream tied to it — no manual re-dating.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub enum StreamBoundary {
    PlanStart,
    PlanEnd,
    Date(YearMonth),
    AtRetirement(PersonId),
    AtDeath(PersonId),
}

/// How the stream's annual amount grows over time.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug)]
#[ts(export)]
pub enum GrowthRule {
    /// Track the plan's inflation assumption (typical for spending, salary).
    Inflation,
    /// Fixed annual growth rate (decimal).
    Fixed(f64),
    /// Flat in nominal dollars.
    None,
}

/// A dated cash flow: salary, retirement spending — and in V2, Social
/// Security, pensions, or one-offs, with no schema change.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct CashFlowStream {
    pub id: StreamId,
    pub name: String,
    /// Person this stream belongs to (drives person-relative boundaries and,
    /// for income, whose working years it represents). None = household.
    pub owner: Option<PersonId>,
    pub direction: StreamDirection,
    /// Annual amount in simulation-start dollars; scaled by `growth` over
    /// time and prorated for partial-period activity.
    pub annual_amount: f64,
    pub start: StreamBoundary,
    pub end: StreamBoundary,
    pub growth: GrowthRule,
}
