//! The price level a run is measured against: how much a dollar's worth of
//! goods costs at any moment of the projection, relative to the plan start.
//!
//! Every inflation-driven figure in the engine reads it — the deflator, an
//! inflation-grown stream or contribution, a drawdown floor, the federal and
//! state tax schedules and the statutory contribution limits. It used to be
//! one scalar, `Assumptions::inflation`, raised to a power at each of those
//! places. A historical replay needs each year's own inflation instead, and
//! 1970s returns without 1970s inflation flatter a plan badly, so the scalar
//! became this: `Constant` is the old behaviour exactly, `Path` is a
//! sequence of annual rates.
//!
//! Two clocks read it, because the engine already had two:
//!
//! - `growth` measures from the plan start in fractional years — the
//!   deflator's exponent, and every figure grown "from plan start" by the
//!   stream convention. Period 0 may be a stub, so its rate applies to the
//!   stub's share of a year.
//! - `over_calendar_years` measures January to January between two calendar
//!   years — how the tax schedules and contribution limits index from the
//!   tax year their figures were published for.
//!
//! `Constant` computes `(1 + rate)^years` with the same exponent each caller
//! computed before, so a plan projects bit-for-bit as it did when the
//! scalar was read directly; the golden files hold that.

use super::YearMonth;

#[derive(Debug, Clone, PartialEq)]
pub enum PriceLevel {
    /// One rate, every year — `Assumptions::inflation`.
    Constant(f64),
    /// One rate per period, then the plan's own assumption past the end.
    Path(PricePath),
}

impl PriceLevel {
    /// How much prices rise over `years`, starting `from` years after the
    /// plan start. `Constant` ignores `from`: every stretch of the same
    /// length rises by the same factor.
    pub fn growth(&self, from: f64, years: f64) -> f64 {
        match self {
            PriceLevel::Constant(rate) => (1.0 + rate).powf(years),
            PriceLevel::Path(path) => path.level(from + years) / path.level(from),
        }
    }

    /// How much prices rise from January of `from_year` to January of
    /// `to_year`. Below 1 when `to_year` is the earlier.
    pub fn over_calendar_years(&self, from_year: i32, to_year: i32) -> f64 {
        match self {
            PriceLevel::Constant(rate) => (1.0 + rate).powf((to_year - from_year) as f64),
            PriceLevel::Path(path) => path.january(to_year) / path.january(from_year),
        }
    }
}

/// A sequence of annual inflation rates laid on the projection's periods:
/// `rates[n]` is the inflation of calendar year `start.year + n`, the year
/// period *n* falls in.
///
/// Outside the sequence — before the plan start, or past the last rate — it
/// rises at `assumed`, the plan's own inflation. Inside it, a stub period 0
/// takes its rate for the months it covers, as a stub takes its share of a
/// year's return.
#[derive(Debug, Clone, PartialEq)]
pub struct PricePath {
    start_year: i32,
    /// Share of a year period 0 covers: 1.0 for a January start.
    first_fraction: f64,
    assumed: f64,
    rates: Vec<f64>,
    /// Price level at each period's start relative to the plan start, one
    /// more entry than `rates`: the last is where the sequence ends.
    at_period: Vec<f64>,
    /// Price level at each January from `start_year` relative to January of
    /// `start_year`, one more entry than `rates`.
    at_january: Vec<f64>,
}

impl PricePath {
    /// The path for a plan starting in `start`, with `rates` for its periods
    /// in order and `assumed` outside them.
    pub fn new(start: YearMonth, rates: Vec<f64>, assumed: f64) -> Self {
        let first_fraction = start.months_until(YearMonth::new(start.year + 1, 1)) as f64 / 12.0;
        let mut at_period = Vec::with_capacity(rates.len() + 1);
        let mut at_january = Vec::with_capacity(rates.len() + 1);
        at_period.push(1.0);
        at_january.push(1.0);
        for (n, rate) in rates.iter().enumerate() {
            let length = if n == 0 { first_fraction } else { 1.0 };
            at_period.push(at_period[n] * (1.0 + rate).powf(length));
            at_january.push(at_january[n] * (1.0 + rate));
        }
        PricePath {
            start_year: start.year,
            first_fraction,
            assumed,
            rates,
            at_period,
            at_january,
        }
    }

    /// The annual rates, one per period.
    pub fn rates(&self) -> &[f64] {
        &self.rates
    }

    /// Years from the plan start to period `n`'s start.
    fn period_start(&self, n: usize) -> f64 {
        match n {
            0 => 0.0,
            n => self.first_fraction + (n - 1) as f64,
        }
    }

    /// Price level `t` years after the plan start, relative to it.
    fn level(&self, t: f64) -> f64 {
        let len = self.rates.len();
        if t <= 0.0 || len == 0 {
            return (1.0 + self.assumed).powf(t);
        }
        // The period `t` falls in. Period starts are month counts over 12,
        // which are not exact in binary, so a `t` that *is* a period start
        // must not floor into the period before it.
        let n = if t < self.first_fraction {
            0
        } else {
            ((t - self.first_fraction + 1e-9).floor() as usize + 1).min(len)
        };
        let rate = self.rates.get(n).copied().unwrap_or(self.assumed);
        self.at_period[n] * (1.0 + rate).powf(t - self.period_start(n))
    }

    /// Price level in January of `year`, relative to January of the start
    /// year.
    fn january(&self, year: i32) -> f64 {
        let k = year - self.start_year;
        let len = self.rates.len() as i32;
        if k < 0 {
            (1.0 + self.assumed).powi(k)
        } else if k > len {
            self.at_january[len as usize] * (1.0 + self.assumed).powi(k - len)
        } else {
            self.at_january[k as usize]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.0)
    }

    #[test]
    fn a_path_at_one_rate_is_the_constant() {
        let constant = PriceLevel::Constant(0.03);
        for start in [YearMonth::new(2026, 1), YearMonth::new(2026, 10)] {
            let path = PriceLevel::Path(PricePath::new(start, vec![0.03; 40], 0.03));
            for months in 0..600 {
                let t = months as f64 / 12.0;
                assert!(close(path.growth(0.0, t), constant.growth(0.0, t)), "{t}");
                assert!(close(path.growth(1.25, t), constant.growth(1.25, t)), "{t}");
            }
            for year in 2020..2080 {
                assert!(close(
                    path.over_calendar_years(2026, year),
                    constant.over_calendar_years(2026, year),
                ));
            }
        }
    }

    #[test]
    fn a_stub_period_takes_its_share_of_the_year() {
        // October start: period 0 is three months of a 10% year.
        let path = PricePath::new(YearMonth::new(2026, 10), vec![0.10, 0.20], 0.0);
        let level = PriceLevel::Path(path);
        assert!(close(level.growth(0.0, 0.25), 1.1f64.powf(0.25)));
        // Then a whole 20% year.
        assert!(close(level.growth(0.25, 1.0), 1.2));
        // Past the sequence, the assumed rate: zero.
        assert!(close(level.growth(1.25, 5.0), 1.0));
        // January to January counts whole calendar years, stub or not.
        assert!(close(level.over_calendar_years(2026, 2027), 1.1));
        assert!(close(level.over_calendar_years(2026, 2028), 1.1 * 1.2));
        assert!(close(level.over_calendar_years(2027, 2026), 1.0 / 1.1));
    }

    #[test]
    fn deflation_lowers_the_level() {
        let level = PriceLevel::Path(PricePath::new(
            YearMonth::new(1930, 1),
            vec![-0.06, -0.09],
            0.03,
        ));
        assert!(close(level.growth(0.0, 2.0), 0.94 * 0.91));
        assert!(close(level.over_calendar_years(1929, 1930), 1.03));
    }
}
