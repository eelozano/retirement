//! Which accounts pay for a shortfall, and in what order: the drawdown
//! policy a scenario chooses.
//!
//! Policy, not fact — the same household can bridge to 59½ out of its
//! brokerage in one scenario and out of a 403(b) in another — so it lives on
//! [`super::Assumptions`], which every [`super::Scenario`] already owns.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{AccountId, AccountKind, PersonId, StreamBoundary};

/// How a period's shortfall is spread across the accounts.
#[derive(Serialize, Deserialize, TS, Clone, Debug, Default, PartialEq)]
#[ts(export)]
pub enum DrawdownPolicy {
    /// Every funded account pays in proportion to its balance — what the
    /// engine has always done, and so the default: a plan saved before
    /// drawdown order existed keeps its order.
    #[default]
    Proportional,
    /// An ordered stack per phase of the plan. Each phase runs from its
    /// start to the next phase's; the first starts at plan start.
    Phased(Vec<DrawdownPhase>),
}

/// One stretch of the plan — "bridge to 59½", "standard" — and the order
/// the accounts are drawn in during it.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct DrawdownPhase {
    pub id: String,
    pub name: String,
    pub start: PhaseStart,
    /// Drawn top to bottom: each entry is emptied down to its floor before
    /// the next is touched. Accounts no entry names are drawn after the
    /// whole stack, in the engine's fallback order — see
    /// `strategies::PhasedDrawdown`.
    pub stack: Vec<StackEntry>,
}

/// When a phase begins.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub enum PhaseStart {
    /// Any date a stream or contribution can start at.
    Boundary(StreamBoundary),
    /// The month this person reaches 59½ — when their withdrawals stop
    /// carrying the early-withdrawal penalty. Its own variant rather than an
    /// age, because the age is statute the engine already holds and a user
    /// should not have to type it.
    PenaltyFree(PersonId),
}

/// One rung of a phase's stack.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct StackEntry {
    pub source: StackSource,
    /// Held back until everything else — the rest of the stack and the
    /// fallback — is spent, in today's dollars, grown with inflation. A
    /// soft floor: it is released rather than letting the plan report
    /// running out while money remains. `0` holds nothing back.
    #[serde(default)]
    pub floor: f64,
}

/// What a stack entry draws from.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub enum StackSource {
    /// One account.
    Account(AccountId),
    /// Every account of this kind that no earlier entry already names,
    /// drawn together in proportion to their balances.
    Kind(AccountKind),
}
