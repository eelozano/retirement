//! Social Security claiming rules against the regulations SSA applies them
//! under: 20 CFR 404.409 (full retirement age), 404.410(a) (reduction for
//! claiming early) and 404.313 (delayed retirement credits).
//!
//! The expected factors are worked on paper from the regulation's rates and
//! written as exact fractions, so a reader can check the arithmetic in the
//! comment rather than trust a rounded decimal.

use engine::model::{adjustment_factor, FullRetirementAge};

/// 404.409(a): full retirement age for old-age benefits by birth date. The
/// regulation's cohorts run 1/2 to 1/1, so a person born on 1 January
/// belongs to the previous year's row; the plan records a birth month, not
/// a day, and the engine takes the calendar year.
#[test]
fn full_retirement_age_matches_20_cfr_404_409_a() {
    let table = [
        (1937, 65, 0),
        (1938, 65, 2),
        (1939, 65, 4),
        (1940, 65, 6),
        (1941, 65, 8),
        (1942, 65, 10),
        (1943, 66, 0),
        (1954, 66, 0),
        (1955, 66, 2),
        (1956, 66, 4),
        (1957, 66, 6),
        (1958, 66, 8),
        (1959, 66, 10),
        (1960, 67, 0),
        (1975, 67, 0),
    ];
    for (birth_year, years, months) in table {
        assert_eq!(
            FullRetirementAge::for_birth_year(birth_year),
            FullRetirementAge::new(years, months),
            "born {birth_year}"
        );
    }
}

/// 404.409(b): the widow(er)'s table, a separate schedule two birth years
/// behind.
#[test]
fn survivor_full_retirement_age_matches_20_cfr_404_409_b() {
    let table = [
        (1939, 65, 0),
        (1940, 65, 2),
        (1941, 65, 4),
        (1942, 65, 6),
        (1943, 65, 8),
        (1944, 65, 10),
        (1945, 66, 0),
        (1956, 66, 0),
        (1957, 66, 2),
        (1958, 66, 4),
        (1959, 66, 6),
        (1960, 66, 8),
        (1961, 66, 10),
        (1962, 67, 0),
    ];
    for (birth_year, years, months) in table {
        assert_eq!(
            FullRetirementAge::survivor_for_birth_year(birth_year),
            FullRetirementAge::new(years, months),
            "born {birth_year}"
        );
    }
}

fn assert_factor(fra_months: i32, claiming_age: u8, expected: f64) {
    let actual = adjustment_factor(fra_months, claiming_age);
    assert!(
        (actual - expected).abs() < 1e-12,
        "FRA {} months, claim at {claiming_age}: expected {expected}, got {actual}",
        fra_months
    );
}

/// Full retirement age 67 (born 1960 or later), claiming at every age from
/// 62 to 70.
///
/// Early (404.410(a)): 5/9 of 1% for each of the first 36 months before
/// FRA, 5/12 of 1% for each month beyond.
/// - 62: 60 months early = 36 x 5/9% + 24 x 5/12% = 20% + 10% -> 70%
/// - 63: 48 months = 20% + 12 x 5/12% = 20% + 5% -> 75%
/// - 64: 36 months = 20% -> 80%
/// - 65: 24 months = 24 x 5/9% = 13 1/3% -> 86 2/3% = 13/15
/// - 66: 12 months = 6 2/3% -> 93 1/3% = 14/15
///
/// Delayed (404.313(b)(2), born after 1/1/1943): 2/3 of 1% a month, so 8%
/// a year — 108%, 116%, 124% at 68, 69 and 70.
#[test]
fn claiming_factors_for_fra_67() {
    let fra = 67 * 12;
    assert_factor(fra, 62, 0.70);
    assert_factor(fra, 63, 0.75);
    assert_factor(fra, 64, 0.80);
    assert_factor(fra, 65, 13.0 / 15.0);
    assert_factor(fra, 66, 14.0 / 15.0);
    assert_factor(fra, 67, 1.00);
    assert_factor(fra, 68, 1.08);
    assert_factor(fra, 69, 1.16);
    assert_factor(fra, 70, 1.24);
}

/// Full retirement age 66 (born 1943–1954), on the same rates.
/// - 62: 48 months early = 20% + 5% -> 75%
/// - 63: 36 months = 20% -> 80%
/// - 64: 24 months -> 13/15; 65: 12 months -> 14/15
/// - 67 to 70: 8% a year -> 108%, 116%, 124%, 132%
#[test]
fn claiming_factors_for_fra_66() {
    let fra = 66 * 12;
    assert_factor(fra, 62, 0.75);
    assert_factor(fra, 63, 0.80);
    assert_factor(fra, 64, 13.0 / 15.0);
    assert_factor(fra, 65, 14.0 / 15.0);
    assert_factor(fra, 66, 1.00);
    assert_factor(fra, 67, 1.08);
    assert_factor(fra, 68, 1.16);
    assert_factor(fra, 69, 1.24);
    assert_factor(fra, 70, 1.32);
}

/// A mid-year FRA, where the month arithmetic matters. Born 1957: FRA 66
/// and 6 months (404.409(a)).
/// - 62: 54 months early = 36 x 5/9% + 18 x 5/12% = 20% + 7.5% -> 72.5%
/// - 70: 42 months late = 42 x 2/3% = 28% -> 128%
#[test]
fn claiming_factors_for_a_mid_year_fra() {
    let fra = FullRetirementAge::new(66, 6).total_months();
    assert_factor(fra, 62, 0.725);
    assert_factor(fra, 70, 1.28);
}
