use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A calendar month, the engine's native time unit.
///
/// All plan dates (births, retirements, stream boundaries) are `YearMonth`s.
/// The simulation iterates over abstract periods (annual in V1, monthly in
/// V2), but because every date is already month-resolved, switching period
/// length is a config change rather than a schema migration.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[ts(export)]
pub struct YearMonth {
    pub year: i32,
    /// 1-based month (1 = January, 12 = December).
    pub month: u8,
}

impl YearMonth {
    pub fn new(year: i32, month: u8) -> Self {
        assert!((1..=12).contains(&month), "month must be in 1..=12");
        Self { year, month }
    }

    /// Total months since year 0, for ordering and duration arithmetic.
    pub fn month_index(self) -> i64 {
        self.year as i64 * 12 + (self.month as i64 - 1)
    }

    pub fn from_month_index(index: i64) -> Self {
        Self {
            year: index.div_euclid(12) as i32,
            month: (index.rem_euclid(12) + 1) as u8,
        }
    }

    pub fn add_months(self, months: i64) -> Self {
        Self::from_month_index(self.month_index() + months)
    }

    pub fn add_years(self, years: i32) -> Self {
        self.add_months(years as i64 * 12)
    }

    /// Whole months from `self` to `other` (negative if `other` is earlier).
    pub fn months_until(self, other: Self) -> i64 {
        other.month_index() - self.month_index()
    }
}

impl fmt::Display for YearMonth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_index_round_trips() {
        for (y, m) in [
            (1983, 8),
            (1987, 6),
            (2038, 8),
            (2042, 8),
            (2000, 1),
            (1999, 12),
        ] {
            let ym = YearMonth::new(y, m);
            assert_eq!(YearMonth::from_month_index(ym.month_index()), ym);
        }
    }

    #[test]
    fn arithmetic_crosses_year_boundaries() {
        let nov = YearMonth::new(2025, 11);
        assert_eq!(nov.add_months(3), YearMonth::new(2026, 2));
        assert_eq!(nov.add_months(-10), YearMonth::new(2025, 1));
        assert_eq!(nov.add_months(-11), YearMonth::new(2024, 12));
        assert_eq!(nov.add_months(-12), YearMonth::new(2024, 11));
        assert_eq!(nov.add_years(10), YearMonth::new(2035, 11));
    }

    #[test]
    fn months_until_is_signed() {
        let birth = YearMonth::new(1983, 8);
        let retirement = YearMonth::new(2038, 8);
        assert_eq!(birth.months_until(retirement), 55 * 12);
        assert_eq!(retirement.months_until(birth), -(55 * 12));
    }

    #[test]
    fn ordering_follows_calendar() {
        assert!(YearMonth::new(2038, 8) < YearMonth::new(2042, 8));
        assert!(YearMonth::new(2025, 12) < YearMonth::new(2026, 1));
    }

    #[test]
    #[should_panic(expected = "month must be in 1..=12")]
    fn rejects_invalid_month() {
        YearMonth::new(2025, 13);
    }
}
