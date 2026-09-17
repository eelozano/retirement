use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::AllocationRef;

/// One number per investment strategy. Held twice by `Assumptions` — once as
/// expected nominal annual return, once as annualized standard deviation —
/// and returned per period by `ReturnModel`.
///
/// Three named fields rather than a `BTreeMap` keyed by strategy, because
/// the per-asset-class tables this replaced were maps and every reader had to
/// answer "what if this key is absent": `grow` priced a missing class at 0%,
/// `StochasticReturns` drew a missing sigma at 0.0, and `whatIf.ts`'s
/// `mapRates` carried a comment about the map being partial. There are
/// exactly three strategies and an account must be priced, so a struct is
/// the type that says so (#129).
///
/// There is deliberately no separate `Strategy` enum: `AllocationRef`'s
/// three unit variants already are that enum, and a second spelling of them
/// would need a conversion in both directions for no reader's benefit.
// `Default` is all zeros — no growth and no spread. A plan's real defaults
// come from `presets::default_strategy_returns`; this is for a fixture that
// wants a balance to be exactly the sum of what went into it.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq)]
#[ts(export)]
pub struct StrategyRates {
    pub aggressive: f64,
    pub moderate: f64,
    pub conservative: f64,
}

impl StrategyRates {
    /// The rate an account with this allocation is priced at.
    ///
    /// Total by construction: a `FixedRate` account prices itself and never
    /// consults the table, which is what let `grow` drop its special case
    /// for a cash allocation.
    pub fn rate_for(&self, allocation: AllocationRef) -> f64 {
        match allocation {
            AllocationRef::Aggressive => self.aggressive,
            AllocationRef::Moderate => self.moderate,
            AllocationRef::Conservative => self.conservative,
            AllocationRef::FixedRate(rate) => rate,
        }
    }

    /// The same three numbers under `f` — used to scale annual figures to a
    /// period length, and by the what-if sandbox to shift them together.
    pub fn map(self, f: impl Fn(f64) -> f64) -> Self {
        Self {
            aggressive: f(self.aggressive),
            moderate: f(self.moderate),
            conservative: f(self.conservative),
        }
    }
}
