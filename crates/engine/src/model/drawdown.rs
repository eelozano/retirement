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
    /// How the phase decides its order: the stack below, or a MAGI target
    /// the engine orders the draw around. Absent in a plan saved before the
    /// choice existed, which loads as the stack it always was.
    #[serde(default)]
    pub rule: PhaseRule,
    /// Drawn top to bottom: each entry is emptied down to its floor before
    /// the next is touched. Accounts no entry names are drawn after the
    /// whole stack, in the engine's fallback order — see
    /// `strategies::PhasedDrawdown`. Kept, unread, under a MAGI target, so
    /// switching back restores it.
    pub stack: Vec<StackEntry>,
}

/// What orders a phase's withdrawals.
#[derive(Serialize, Deserialize, TS, Clone, Debug, Default, PartialEq)]
#[ts(export)]
pub enum PhaseRule {
    /// The phase's own stack, top to bottom — "my order".
    #[default]
    Stack,
    /// "Keep MAGI near $X": the engine orders the draw itself so the
    /// calendar year's MAGI, on the ACA definition, lands as close to the
    /// target as the year's need allows, and never above it while money
    /// that keeps it down remains. In today's dollars, grown with inflation,
    /// like a floor. Soft: a year that cannot stay under it goes over and is
    /// reported, rather than failing with money in the bank. The order is
    /// fixed and written down in `strategies::phased`.
    MagiTarget { target: f64 },
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
