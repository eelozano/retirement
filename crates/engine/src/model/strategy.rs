use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::AllocationRef;

/// One number per investment strategy. Held twice by `Assumptions` — once as
/// expected nominal annual return, once as annualized standard deviation —
/// and returned per period by `ReturnModel`.
///
/// Named fields rather than a `BTreeMap` keyed by strategy, because
/// the per-asset-class tables this replaced were maps and every reader had to
/// answer "what if this key is absent": `grow` priced a missing class at 0%,
/// `StochasticReturns` drew a missing sigma at 0.0, and `whatIf.ts`'s
/// `mapRates` carried a comment about the map being partial. There is a
/// fixed set of strategies and an account must be priced, so a struct is
/// the type that says so (#129).
///
/// Fields run in risk order, most aggressive first. The two `very_*` tiers
/// came later than the other three; a plan saved before them carries only
/// three keys, and `AssumptionsWire` fills the missing two from the shipped
/// defaults.
///
/// There is deliberately no separate `Strategy` enum: `AllocationRef`'s
/// unit variants already are that enum, and a second spelling of them
/// would need a conversion in both directions for no reader's benefit.
// `Default` is all zeros — no growth and no spread. A plan's real defaults
// come from `presets::default_strategy_returns`; this is for a fixture that
// wants a balance to be exactly the sum of what went into it.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq)]
#[ts(export)]
pub struct StrategyRates {
    pub very_aggressive: f64,
    pub aggressive: f64,
    pub moderate: f64,
    pub conservative: f64,
    pub very_conservative: f64,
}

impl StrategyRates {
    /// The rate an account with this allocation is priced at.
    ///
    /// Total by construction: a `FixedRate` account prices itself and never
    /// consults the table, which is what let `grow` drop its special case
    /// for a cash allocation.
    pub fn rate_for(&self, allocation: AllocationRef) -> f64 {
        match allocation {
            AllocationRef::VeryAggressive => self.very_aggressive,
            AllocationRef::Aggressive => self.aggressive,
            AllocationRef::Moderate => self.moderate,
            AllocationRef::Conservative => self.conservative,
            AllocationRef::VeryConservative => self.very_conservative,
            AllocationRef::FixedRate(rate) => rate,
        }
    }

    /// The same numbers under `f` — used to scale annual figures to a
    /// period length, and by the what-if sandbox to shift them together.
    pub fn map(self, f: impl Fn(f64) -> f64) -> Self {
        Self {
            very_aggressive: f(self.very_aggressive),
            aggressive: f(self.aggressive),
            moderate: f(self.moderate),
            conservative: f(self.conservative),
            very_conservative: f(self.very_conservative),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each named allocation reads its own field — a new tier wired to a
    /// neighbour's rate would price an account at the wrong return silently.
    #[test]
    fn rate_for_reads_each_tiers_own_field() {
        let rates = StrategyRates {
            very_aggressive: 0.01,
            aggressive: 0.02,
            moderate: 0.03,
            conservative: 0.04,
            very_conservative: 0.05,
        };
        assert_eq!(rates.rate_for(AllocationRef::VeryAggressive), 0.01);
        assert_eq!(rates.rate_for(AllocationRef::Aggressive), 0.02);
        assert_eq!(rates.rate_for(AllocationRef::Moderate), 0.03);
        assert_eq!(rates.rate_for(AllocationRef::Conservative), 0.04);
        assert_eq!(rates.rate_for(AllocationRef::VeryConservative), 0.05);
        assert_eq!(rates.rate_for(AllocationRef::FixedRate(0.06)), 0.06);
    }
}
