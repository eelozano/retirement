use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Federal filing status. Drives which bracket/standard-deduction table and
/// Social Security provisional-income thresholds apply.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[ts(export)]
pub enum FilingStatus {
    #[default]
    Single,
    MarriedFilingJointly,
}

/// One rung of a progressive bracket schedule: the marginal `rate` applies to
/// taxable income up to (and excluding) `up_to`. `up_to: None` marks the
/// final, unbounded bracket. A schedule is a `Vec<TaxBracket>` ordered
/// ascending by `up_to`, with `None` only ever last.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq)]
#[ts(export)]
pub struct TaxBracket {
    pub up_to: Option<f64>,
    pub rate: f64,
}

/// Applies a progressive bracket schedule to `taxable_income` (already net
/// of any deduction). Shared by federal and state computation.
pub fn bracket_tax(taxable_income: f64, brackets: &[TaxBracket]) -> f64 {
    if taxable_income <= 0.0 {
        return 0.0;
    }
    let mut tax = 0.0;
    let mut lower = 0.0;
    for bracket in brackets {
        let upper = bracket.up_to.unwrap_or(f64::INFINITY);
        if taxable_income <= lower {
            break;
        }
        let taxed_in_bracket = taxable_income.min(upper) - lower;
        tax += taxed_in_bracket.max(0.0) * bracket.rate;
        lower = upper;
    }
    tax
}

/// A label for which state's published brackets a `StateTaxProfile` was last
/// prefilled from. Purely a UI convenience (drives the dropdown and lets a
/// plan round-trip its selection) — `StateTaxProfile::brackets` is always
/// what the engine actually taxes with, so a user's edits after prefill are
/// never overwritten or ignored.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[ts(export)]
pub enum StateCode {
    Alabama,
    Alaska,
    Arizona,
    Arkansas,
    California,
    Colorado,
    Connecticut,
    Delaware,
    Florida,
    Georgia,
    Hawaii,
    Idaho,
    Illinois,
    Indiana,
    Iowa,
    Kansas,
    Kentucky,
    Louisiana,
    Maine,
    Maryland,
    Massachusetts,
    Michigan,
    Minnesota,
    Mississippi,
    Missouri,
    Montana,
    Nebraska,
    Nevada,
    NewHampshire,
    NewJersey,
    NewMexico,
    NewYork,
    NorthCarolina,
    NorthDakota,
    Ohio,
    Oklahoma,
    Oregon,
    Pennsylvania,
    RhodeIsland,
    SouthCarolina,
    SouthDakota,
    Tennessee,
    Texas,
    Utah,
    Vermont,
    Virginia,
    Washington,
    WashingtonDc,
    WestVirginia,
    Wisconsin,
    Wyoming,
    /// No state selected, or a fully custom (hand-entered) schedule.
    Other,
}

/// State income tax as a bracket schedule plus its own standard deduction.
/// `state` is a UI label only (see [`StateCode`]) — `brackets` and
/// `standard_deduction` are what `BracketTax` evaluates, so this struct
/// stays self-contained and correct even for a hand-edited or `Other`
/// profile with no matching preset.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct StateTaxProfile {
    pub state: StateCode,
    pub brackets: Vec<TaxBracket>,
    pub standard_deduction: f64,
}

impl StateTaxProfile {
    /// No state income tax — the safe default when we don't know the user's
    /// state.
    pub fn none() -> Self {
        StateTaxProfile {
            state: StateCode::Other,
            brackets: vec![TaxBracket {
                up_to: None,
                rate: 0.0,
            }],
            standard_deduction: 0.0,
        }
    }
}

impl Default for StateTaxProfile {
    fn default() -> Self {
        Self::none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bracket_tax_is_progressive_not_flat() {
        let brackets = vec![
            TaxBracket {
                up_to: Some(10_000.0),
                rate: 0.10,
            },
            TaxBracket {
                up_to: Some(40_000.0),
                rate: 0.20,
            },
            TaxBracket {
                up_to: None,
                rate: 0.30,
            },
        ];
        // 10k * 10% + 30k * 20% + 20k * 30% = 1000 + 6000 + 6000 = 13000
        assert!((bracket_tax(60_000.0, &brackets) - 13_000.0).abs() < 1e-9);
        // Entirely within the first bracket.
        assert!((bracket_tax(5_000.0, &brackets) - 500.0).abs() < 1e-9);
        assert_eq!(bracket_tax(0.0, &brackets), 0.0);
        assert_eq!(bracket_tax(-100.0, &brackets), 0.0);
    }
}
