use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    CashFlowStream, GrowthRule, Person, PersonId, StreamBoundary, StreamDirection, StreamKind,
};

pub type SocialSecurityBenefitId = String;

/// Full retirement age, as SSA publishes it: a number of years **and
/// months**. The months are not always zero. The 1983 amendments raised FRA
/// from 65 to 67 in two-month steps, so births in 1938–1942 and 1955–1959
/// land mid-year — someone born in 1957 reaches FRA at 66 years 6 months.
///
/// Before #149 this was a whole-year `u8`, which left those cohorts no way
/// to enter their own age: rounding to 66 overstated a benefit claimed at 62
/// by 3.4% and rounding to 67 understated it by 3.6%, for life.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct FullRetirementAge {
    pub years: u8,
    /// Months past `years`, 0..=11.
    pub months: u8,
}

/// Deserialization shape for [`FullRetirementAge`], carrying the whole-year
/// scalar plans written before #149 used. A wire enum rather than
/// `#[serde(from = ...)]` only because ts-rs cannot parse that container
/// attribute and warns on every build — the same rationale as `Plan`'s,
/// `Account`'s and `AllocationRef`'s hand-written `Deserialize`.
///
/// The migration lives on the type, so `SocialSecurityBenefit`,
/// `HouseholdBenefit` and any future holder of the field all migrate with no
/// change of their own.
#[derive(Deserialize)]
#[serde(untagged)]
enum FullRetirementAgeWire {
    /// Pre-#149, when the field was whole years. Read as N years and zero
    /// months, which is the age that plan was already projected with — so it
    /// projects identically after the upgrade.
    Years(u8),
    Parts {
        years: u8,
        #[serde(default)]
        months: u8,
    },
}

impl<'de> Deserialize<'de> for FullRetirementAge {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match FullRetirementAgeWire::deserialize(deserializer)? {
            FullRetirementAgeWire::Years(years) => FullRetirementAge { years, months: 0 },
            FullRetirementAgeWire::Parts { years, months } => FullRetirementAge { years, months },
        })
    }
}

impl FullRetirementAge {
    pub const fn new(years: u8, months: u8) -> Self {
        Self { years, months }
    }

    pub fn total_months(self) -> i32 {
        self.years as i32 * 12 + self.months as i32
    }

    /// SSA's published full-retirement-age table (Social Security Act
    /// §216(l), as amended in 1983). Fixed law with no annual publication,
    /// so it is compiled in rather than living in `TaxFigures` — the same
    /// call `presets::rmd_age` makes, and the same shape of lookup.
    pub fn for_birth_year(birth_year: i32) -> Self {
        match birth_year {
            ..=1937 => Self::new(65, 0),
            1938 => Self::new(65, 2),
            1939 => Self::new(65, 4),
            1940 => Self::new(65, 6),
            1941 => Self::new(65, 8),
            1942 => Self::new(65, 10),
            1943..=1954 => Self::new(66, 0),
            1955 => Self::new(66, 2),
            1956 => Self::new(66, 4),
            1957 => Self::new(66, 6),
            1958 => Self::new(66, 8),
            1959 => Self::new(66, 10),
            _ => Self::new(67, 0),
        }
    }
}

/// A Social Security retirement benefit: the user's own estimate of their
/// benefit at Full Retirement Age (from their SSA statement), plus the age
/// they plan to start claiming. `simulate()` resolves this into a plain
/// Income `CashFlowStream` — see `to_stream` — rather than special-casing it
/// in the sim loop.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct SocialSecurityBenefit {
    pub id: SocialSecurityBenefitId,
    pub owner: PersonId,
    /// Estimated annual benefit at full retirement age (the PIA), in
    /// today's dollars, as reported on the user's SSA statement.
    pub benefit_at_fra: f64,
    /// `None` takes SSA's published age for the owner's birth year, which is
    /// the normal case: the table is fixed law and the birth month is
    /// already on `Person`, so asking for a figure the app can derive is
    /// only a way for a wrong one to be typed. `Some` is an explicit
    /// override, for a user who knows their own and wants to say so — and is
    /// what every plan saved before #149 carries, since back then the field
    /// was always written out.
    #[serde(default)]
    pub full_retirement_age: Option<FullRetirementAge>,
    /// Age benefits start, whole years, 62..=70.
    pub claiming_age: u8,
    /// `None` uses `Assumptions.social_security_cola`; `Some(rate)`
    /// overrides it for this benefit only.
    pub cola_override: Option<f64>,
}

/// SSA's graduated early/delayed-claiming adjustment relative to full
/// retirement age, which is taken in months so a mid-year FRA is exact:
/// - Delayed past FRA (up to 70): +2/3 of 1% per month.
/// - Claimed early, first 36 months before FRA: -5/9 of 1% per month.
/// - Claimed early, beyond 36 months before FRA: an additional -5/12 of 1%
///   per month for those extra months.
pub fn adjustment_factor(full_retirement_age_months: i32, claiming_age: u8) -> f64 {
    let months = 12 * claiming_age as i32 - full_retirement_age_months;
    if months >= 0 {
        1.0 + months as f64 * (2.0 / 3.0 / 100.0)
    } else {
        let months_early = -months;
        let first_36 = months_early.min(36);
        let extra = months_early - first_36;
        1.0 - (first_36 as f64 * (5.0 / 9.0 / 100.0) + extra as f64 * (5.0 / 12.0 / 100.0))
    }
}

impl SocialSecurityBenefit {
    /// The override if the user set one, else SSA's age for the owner's
    /// birth year. Takes the `Person` because the birth year lives there.
    pub fn full_retirement_age_for(&self, person: &Person) -> FullRetirementAge {
        self.full_retirement_age
            .unwrap_or_else(|| FullRetirementAge::for_birth_year(person.birth.year))
    }

    pub fn adjustment_factor(&self, person: &Person) -> f64 {
        adjustment_factor(
            self.full_retirement_age_for(person).total_months(),
            self.claiming_age,
        )
    }

    /// The claiming-age-adjusted annual benefit, in today's dollars.
    pub fn annual_benefit(&self, person: &Person) -> f64 {
        self.benefit_at_fra * self.adjustment_factor(person)
    }

    /// Materializes this benefit into a plain Income stream so the sim loop
    /// never needs to know Social Security exists.
    pub fn to_stream(&self, person: &Person, plan_default_cola: f64) -> CashFlowStream {
        CashFlowStream {
            id: format!("ss-{}", self.id),
            name: format!("{}'s Social Security", person.name),
            owner: Some(self.owner.clone()),
            direction: StreamDirection::Income,
            annual_amount: self.annual_benefit(person),
            start: StreamBoundary::Date(person.month_at_age(self.claiming_age)),
            end: StreamBoundary::AtDeath(self.owner.clone()),
            growth: GrowthRule::Fixed(self.cola_override.unwrap_or(plan_default_cola)),
            survivor_percentage: None,
            kind: StreamKind::General,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{adjustment_factor, FullRetirementAge};

    /// Whole-year FRAs, in months, so the pre-#149 fixtures below read the
    /// way they always did.
    fn years(n: i32) -> i32 {
        n * 12
    }

    /// Fixtures verified against published SSA early/delayed retirement
    /// adjustment tables.
    #[test]
    fn claim_equals_fra_is_unadjusted() {
        assert_eq!(adjustment_factor(years(67), 67), 1.0);
    }

    #[test]
    fn fra_67_claim_62_is_070() {
        assert!((adjustment_factor(years(67), 62) - 0.70).abs() < 1e-9);
    }

    #[test]
    fn fra_66_claim_62_is_075() {
        assert!((adjustment_factor(years(66), 62) - 0.75).abs() < 1e-9);
    }

    /// FRA 65, claim 62 is exactly 36 months early — exercises the boundary
    /// where the second reduction tier hasn't kicked in yet.
    #[test]
    fn fra_65_claim_62_is_080() {
        assert!((adjustment_factor(years(65), 62) - 0.80).abs() < 1e-9);
    }

    #[test]
    fn fra_66_claim_70_is_132() {
        assert!((adjustment_factor(years(66), 70) - 1.32).abs() < 1e-9);
    }

    #[test]
    fn fra_67_claim_70_is_124() {
        assert!((adjustment_factor(years(67), 70) - 1.24).abs() < 1e-9);
    }

    /// The case the whole-year field could not express, worked on paper:
    /// FRA 66y6m (born 1957), claimed at 62, is 54 months early. The first
    /// 36 take 5/9 of 1% each (36 × 0.555…% = 20.0%) and the remaining 18
    /// take 5/12 of 1% each (18 × 0.41666…% = 7.5%), a 27.5% reduction —
    /// factor 0.725. Rounding FRA to 66 would have given 0.750 and to 67
    /// 0.700, which is the error #149 is about.
    #[test]
    fn fra_66y6m_claim_62_is_0725() {
        let fra = FullRetirementAge::new(66, 6);
        assert_eq!(fra.total_months(), 798);
        assert!((adjustment_factor(fra.total_months(), 62) - 0.725).abs() < 1e-9);
    }

    /// SSA's published table, typed in from the Social Security Act §216(l)
    /// schedule. The two-month steps are the whole point: every one of them
    /// was unreachable while the field was a `u8`.
    #[test]
    fn full_retirement_age_table_matches_ssa() {
        let expected = [
            (1930, 65, 0),
            (1937, 65, 0),
            (1938, 65, 2),
            (1939, 65, 4),
            (1940, 65, 6),
            (1941, 65, 8),
            (1942, 65, 10),
            (1943, 66, 0),
            (1950, 66, 0),
            (1954, 66, 0),
            (1955, 66, 2),
            (1956, 66, 4),
            (1957, 66, 6),
            (1958, 66, 8),
            (1959, 66, 10),
            (1960, 67, 0),
            (1985, 67, 0),
            (2005, 67, 0),
        ];
        for (birth_year, years, months) in expected {
            assert_eq!(
                FullRetirementAge::for_birth_year(birth_year),
                FullRetirementAge::new(years, months),
                "birth year {birth_year}"
            );
        }
    }

    /// A plan saved before #149 wrote FRA as a bare integer. It has to load,
    /// and it has to load as that many years and *zero* months, because that
    /// is the age it was already being projected with.
    #[test]
    fn a_whole_year_fra_from_an_older_plan_loads_unchanged() {
        let old: FullRetirementAge = serde_yaml_ng::from_str("67").unwrap();
        assert_eq!(old, FullRetirementAge::new(67, 0));
        assert_eq!(old.total_months(), years(67));

        let new: FullRetirementAge = serde_yaml_ng::from_str("years: 66\nmonths: 6").unwrap();
        assert_eq!(new, FullRetirementAge::new(66, 6));

        // Months are optional on the map form too.
        let bare: FullRetirementAge = serde_yaml_ng::from_str("years: 66").unwrap();
        assert_eq!(bare, FullRetirementAge::new(66, 0));
    }
}
