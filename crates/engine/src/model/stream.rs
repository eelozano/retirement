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
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum StreamBoundary {
    PlanStart,
    PlanEnd,
    Date(YearMonth),
    AtRetirement(PersonId),
    AtDeath(PersonId),
}

/// How an amount grows over time — a stream's, or a flat contribution's.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub enum GrowthRule {
    /// Track the plan's inflation assumption (typical for spending, salary).
    Inflation,
    /// Fixed annual growth rate (decimal).
    Fixed(f64),
    /// Flat in nominal dollars.
    None,
}

/// `None` — no growth. The zero value, so `#[serde(default)]` on a field
/// that gained a growth rule (`ContributionRule::FlatAmount::growth`) reads
/// an older plan file as exactly the behaviour it had. A stream, which has
/// always required the key, is unaffected.
impl Default for GrowthRule {
    fn default() -> Self {
        GrowthRule::None
    }
}

/// A dated cash flow: salary, retirement spending, pensions, or one-offs.
/// Social Security is the one exception — it's a `SocialSecurityBenefit`
/// (PIA + claiming age) resolved into one of these at simulate time, so
/// claiming age stays interactively recomputable rather than a one-time
/// manually-computed dollar entry.
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
    /// Fraction of this stream that continues for the household after its
    /// **owner** dies — a pension's or annuity's survivor percentage (#34).
    /// `None` (the default, and the only sensible value for a stream with no
    /// owner) means the stream simply ends at `end`.
    ///
    /// When set, it overrides `end` at the owner's death in both directions:
    /// the full amount stops there even if `end` runs later, and
    /// `annual_amount * survivor_percentage` continues from there to the end
    /// of the plan — i.e. for as long as a survivor is alive — growing by
    /// the same `growth` rule. A stream whose owner is the last to die is
    /// unaffected, since there is no one for the continuation to run for.
    ///
    /// `#[serde(default)]` (→ `None`) so plans saved before this field
    /// existed load unchanged.
    #[serde(default)]
    pub survivor_percentage: Option<f64>,
}
