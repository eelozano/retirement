//! Default state income tax brackets, used only to *prefill*
//! `Assumptions::state_tax` when a plan's state picker changes (see
//! `Presets::state_tax_profiles` and `presets::default_assumptions`).
//!
//! `StateTaxProfile.brackets`/`standard_deduction` are what `BracketTax`
//! actually computes with — these tables are a starting point, not a source
//! of truth the engine consults at simulate time. Figures below are
//! approximate 2025 single-filer schedules, simplified (fewer rungs than
//! some states' real published tables) for a reasonable default rather than
//! exact transcription; users should verify their own state's current rates
//! and are free to edit every value in-app. Treat this file as "good enough
//! to start from," not tax advice — and expect it to drift as states change
//! their brackets, since nothing here is re-validated against a live source.

use std::collections::BTreeMap;

use crate::model::{StateCode, StateTaxProfile, TaxBracket};

fn flat(state: StateCode, rate: f64) -> StateTaxProfile {
    StateTaxProfile {
        state,
        brackets: vec![TaxBracket { up_to: None, rate }],
        standard_deduction: 0.0,
    }
}

fn no_tax(state: StateCode) -> StateTaxProfile {
    flat(state, 0.0)
}

/// `rungs` are ascending `(upper_bound, rate)` pairs; `top_rate` applies
/// above the last rung's bound.
fn progressive(
    state: StateCode,
    standard_deduction: f64,
    rungs: &[(f64, f64)],
    top_rate: f64,
) -> StateTaxProfile {
    let mut brackets: Vec<TaxBracket> = rungs
        .iter()
        .map(|(up_to, rate)| TaxBracket {
            up_to: Some(*up_to),
            rate: *rate,
        })
        .collect();
    brackets.push(TaxBracket {
        up_to: None,
        rate: top_rate,
    });
    StateTaxProfile {
        state,
        brackets,
        standard_deduction,
    }
}

pub fn state_tax_profiles() -> BTreeMap<StateCode, StateTaxProfile> {
    use StateCode::*;

    let mut profiles = BTreeMap::new();

    // The 9 states with no individual income tax.
    for state in [
        Alaska,
        Florida,
        Nevada,
        NewHampshire,
        SouthDakota,
        Tennessee,
        Texas,
        Washington,
        Wyoming,
    ] {
        profiles.insert(state, no_tax(state));
    }

    // Flat-rate states — current single-bracket rate, approximate.
    for (state, rate) in [
        (Arizona, 0.025),
        (Colorado, 0.044),
        (Georgia, 0.0539),
        (Idaho, 0.057),
        (Illinois, 0.0495),
        (Indiana, 0.030),
        (Iowa, 0.038),
        (Kentucky, 0.040),
        (Louisiana, 0.030),
        (Michigan, 0.0425),
        (Mississippi, 0.044),
        (NorthCarolina, 0.0425),
        (Pennsylvania, 0.0307),
        (Utah, 0.0455),
    ] {
        profiles.insert(state, flat(state, rate));
    }

    // States with only a rough top-marginal-rate approximation on hand
    // (real tables have more rungs at the bottom) — least-precise tier,
    // most in need of user correction.
    for (state, rate) in [
        (Alabama, 0.05),
        (Arkansas, 0.039),
        (Delaware, 0.066),
        (Kansas, 0.057),
        (Maine, 0.0715),
        (Missouri, 0.047),
        (Montana, 0.059),
        (Nebraska, 0.052),
        (NewMexico, 0.059),
        (NorthDakota, 0.025),
        (Ohio, 0.035),
        (Oklahoma, 0.0475),
        (RhodeIsland, 0.0599),
        (SouthCarolina, 0.062),
        (Vermont, 0.0875),
        (WestVirginia, 0.0482),
    ] {
        profiles.insert(state, flat(state, rate));
    }

    // Massachusetts: flat 5%, plus a 4% surtax above $1M ("Fair Share
    // Amendment").
    profiles.insert(
        Massachusetts,
        progressive(Massachusetts, 0.0, &[(1_000_000.0, 0.05)], 0.09),
    );

    // Real multi-bracket schedules for the higher-population / more
    // progressive states.
    profiles.insert(
        California,
        progressive(
            California,
            5_706.0,
            &[
                (11_079.0, 0.01),
                (26_264.0, 0.02),
                (41_452.0, 0.04),
                (57_542.0, 0.06),
                (72_724.0, 0.08),
                (371_479.0, 0.093),
                (445_771.0, 0.103),
                (1_000_000.0, 0.123),
            ],
            0.133, // includes the 1% Mental Health Services surtax above $1M
        ),
    );

    profiles.insert(
        NewYork,
        progressive(
            NewYork,
            8_000.0,
            &[
                (8_500.0, 0.04),
                (11_700.0, 0.045),
                (13_900.0, 0.0525),
                (80_650.0, 0.055),
                (215_400.0, 0.06),
                (1_077_550.0, 0.0685),
                (5_000_000.0, 0.0965),
                (25_000_000.0, 0.103),
            ],
            0.109,
        ),
    );

    profiles.insert(
        NewJersey,
        progressive(
            NewJersey,
            1_000.0,
            &[
                (20_000.0, 0.014),
                (35_000.0, 0.0175),
                (40_000.0, 0.035),
                (75_000.0, 0.05525),
                (500_000.0, 0.0637),
                (1_000_000.0, 0.0897),
            ],
            0.1075,
        ),
    );

    profiles.insert(
        Oregon,
        progressive(
            Oregon,
            0.0,
            &[(4_300.0, 0.0475), (10_750.0, 0.0675), (125_000.0, 0.0875)],
            0.099,
        ),
    );

    profiles.insert(
        Hawaii,
        progressive(
            Hawaii,
            0.0,
            &[
                (9_600.0, 0.014),
                (14_400.0, 0.032),
                (19_200.0, 0.055),
                (24_000.0, 0.064),
                (36_000.0, 0.068),
                (48_000.0, 0.072),
                (125_000.0, 0.076),
                (175_000.0, 0.079),
                (225_000.0, 0.0825),
                (275_000.0, 0.09),
                (325_000.0, 0.10),
            ],
            0.11,
        ),
    );

    profiles.insert(
        Minnesota,
        progressive(
            Minnesota,
            0.0,
            &[(31_690.0, 0.0535), (104_090.0, 0.068), (198_630.0, 0.0785)],
            0.0985,
        ),
    );

    profiles.insert(
        Wisconsin,
        progressive(
            Wisconsin,
            0.0,
            &[(14_320.0, 0.035), (28_640.0, 0.044), (315_310.0, 0.053)],
            0.0765,
        ),
    );

    profiles.insert(
        Virginia,
        progressive(
            Virginia,
            8_500.0,
            &[(3_000.0, 0.02), (5_000.0, 0.03), (17_000.0, 0.05)],
            0.0575,
        ),
    );

    profiles.insert(
        Maryland,
        progressive(
            Maryland,
            0.0,
            &[
                (1_000.0, 0.02),
                (2_000.0, 0.03),
                (3_000.0, 0.04),
                (100_000.0, 0.0475),
                (125_000.0, 0.05),
                (150_000.0, 0.0525),
                (250_000.0, 0.055),
            ],
            0.0575,
        ),
    );

    profiles.insert(
        Connecticut,
        progressive(
            Connecticut,
            0.0,
            &[
                (10_000.0, 0.03),
                (50_000.0, 0.05),
                (100_000.0, 0.055),
                (200_000.0, 0.06),
                (250_000.0, 0.065),
                (500_000.0, 0.069),
            ],
            0.0699,
        ),
    );

    profiles.insert(
        WashingtonDc,
        progressive(
            WashingtonDc,
            0.0,
            &[
                (10_000.0, 0.04),
                (40_000.0, 0.06),
                (60_000.0, 0.065),
                (250_000.0, 0.085),
                (500_000.0, 0.0925),
            ],
            0.0975,
        ),
    );

    profiles.insert(Other, StateTaxProfile::none());

    profiles
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `StateCode` variant lists an explicit branch here, so adding a
    /// new one without covering it fails to *compile* — catches the gap
    /// statically rather than falling back to a missing-key default at
    /// runtime. (Caught a real omission — Vermont — while writing this.)
    fn assert_every_variant_named(state: StateCode) {
        match state {
            StateCode::Alabama
            | StateCode::Alaska
            | StateCode::Arizona
            | StateCode::Arkansas
            | StateCode::California
            | StateCode::Colorado
            | StateCode::Connecticut
            | StateCode::Delaware
            | StateCode::Florida
            | StateCode::Georgia
            | StateCode::Hawaii
            | StateCode::Idaho
            | StateCode::Illinois
            | StateCode::Indiana
            | StateCode::Iowa
            | StateCode::Kansas
            | StateCode::Kentucky
            | StateCode::Louisiana
            | StateCode::Maine
            | StateCode::Maryland
            | StateCode::Massachusetts
            | StateCode::Michigan
            | StateCode::Minnesota
            | StateCode::Mississippi
            | StateCode::Missouri
            | StateCode::Montana
            | StateCode::Nebraska
            | StateCode::Nevada
            | StateCode::NewHampshire
            | StateCode::NewJersey
            | StateCode::NewMexico
            | StateCode::NewYork
            | StateCode::NorthCarolina
            | StateCode::NorthDakota
            | StateCode::Ohio
            | StateCode::Oklahoma
            | StateCode::Oregon
            | StateCode::Pennsylvania
            | StateCode::RhodeIsland
            | StateCode::SouthCarolina
            | StateCode::SouthDakota
            | StateCode::Tennessee
            | StateCode::Texas
            | StateCode::Utah
            | StateCode::Vermont
            | StateCode::Virginia
            | StateCode::Washington
            | StateCode::WashingtonDc
            | StateCode::WestVirginia
            | StateCode::Wisconsin
            | StateCode::Wyoming
            | StateCode::Other => {}
        }
    }

    #[test]
    fn every_state_code_has_a_preset_profile() {
        let profiles = state_tax_profiles();
        for state in [
            StateCode::Alabama,
            StateCode::Alaska,
            StateCode::Arizona,
            StateCode::Arkansas,
            StateCode::California,
            StateCode::Colorado,
            StateCode::Connecticut,
            StateCode::Delaware,
            StateCode::Florida,
            StateCode::Georgia,
            StateCode::Hawaii,
            StateCode::Idaho,
            StateCode::Illinois,
            StateCode::Indiana,
            StateCode::Iowa,
            StateCode::Kansas,
            StateCode::Kentucky,
            StateCode::Louisiana,
            StateCode::Maine,
            StateCode::Maryland,
            StateCode::Massachusetts,
            StateCode::Michigan,
            StateCode::Minnesota,
            StateCode::Mississippi,
            StateCode::Missouri,
            StateCode::Montana,
            StateCode::Nebraska,
            StateCode::Nevada,
            StateCode::NewHampshire,
            StateCode::NewJersey,
            StateCode::NewMexico,
            StateCode::NewYork,
            StateCode::NorthCarolina,
            StateCode::NorthDakota,
            StateCode::Ohio,
            StateCode::Oklahoma,
            StateCode::Oregon,
            StateCode::Pennsylvania,
            StateCode::RhodeIsland,
            StateCode::SouthCarolina,
            StateCode::SouthDakota,
            StateCode::Tennessee,
            StateCode::Texas,
            StateCode::Utah,
            StateCode::Vermont,
            StateCode::Virginia,
            StateCode::Washington,
            StateCode::WashingtonDc,
            StateCode::WestVirginia,
            StateCode::Wisconsin,
            StateCode::Wyoming,
            StateCode::Other,
        ] {
            assert_every_variant_named(state);
            assert!(
                profiles.contains_key(&state),
                "{state:?} has no preset profile"
            );
        }
    }

    #[test]
    fn every_profile_brackets_are_ascending_with_unbounded_last_rung() {
        for (state, profile) in state_tax_profiles() {
            let brackets = &profile.brackets;
            assert!(!brackets.is_empty(), "{state:?} has no brackets");
            assert!(
                brackets.last().unwrap().up_to.is_none(),
                "{state:?}'s last bracket must be unbounded"
            );
            let mut prev = 0.0;
            for bracket in &brackets[..brackets.len() - 1] {
                let up_to = bracket.up_to.expect("only the last bracket is unbounded");
                assert!(
                    up_to > prev,
                    "{state:?} brackets must be strictly ascending"
                );
                prev = up_to;
            }
        }
    }
}
