use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{CashFlowStream, GrowthRule, Person, PersonId, StreamBoundary, StreamDirection};

pub type SocialSecurityBenefitId = String;

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
    /// Full retirement age in whole years, as reported on the user's SSA
    /// statement (varies by birth year — the user supplies their own rather
    /// than the engine looking it up).
    pub full_retirement_age: u8,
    /// Age benefits start, whole years, 62..=70.
    pub claiming_age: u8,
    /// `None` uses `Assumptions.social_security_cola`; `Some(rate)`
    /// overrides it for this benefit only.
    pub cola_override: Option<f64>,
}

/// SSA's graduated early/delayed-claiming adjustment relative to full
/// retirement age, applied to whole-year ages:
/// - Delayed past FRA (up to 70): +2/3 of 1% per month.
/// - Claimed early, first 36 months before FRA: -5/9 of 1% per month.
/// - Claimed early, beyond 36 months before FRA: an additional -5/12 of 1%
///   per month for those extra months.
pub fn adjustment_factor(full_retirement_age: u8, claiming_age: u8) -> f64 {
    let months = 12 * (claiming_age as i32 - full_retirement_age as i32);
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
    pub fn adjustment_factor(&self) -> f64 {
        adjustment_factor(self.full_retirement_age, self.claiming_age)
    }

    /// The claiming-age-adjusted annual benefit, in today's dollars.
    pub fn annual_benefit(&self) -> f64 {
        self.benefit_at_fra * self.adjustment_factor()
    }

    /// Materializes this benefit into a plain Income stream so the sim loop
    /// never needs to know Social Security exists.
    pub fn to_stream(&self, person: &Person, plan_default_cola: f64) -> CashFlowStream {
        CashFlowStream {
            id: format!("ss-{}", self.id),
            name: format!("{}'s Social Security", person.name),
            owner: Some(self.owner.clone()),
            direction: StreamDirection::Income,
            annual_amount: self.annual_benefit(),
            start: StreamBoundary::Date(person.month_at_age(self.claiming_age)),
            end: StreamBoundary::AtDeath(self.owner.clone()),
            growth: GrowthRule::Fixed(self.cola_override.unwrap_or(plan_default_cola)),
            survivor_percentage: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::adjustment_factor;

    /// Fixtures verified against published SSA early/delayed retirement
    /// adjustment tables.
    #[test]
    fn claim_equals_fra_is_unadjusted() {
        assert_eq!(adjustment_factor(67, 67), 1.0);
    }

    #[test]
    fn fra_67_claim_62_is_070() {
        assert!((adjustment_factor(67, 62) - 0.70).abs() < 1e-9);
    }

    #[test]
    fn fra_66_claim_62_is_075() {
        assert!((adjustment_factor(66, 62) - 0.75).abs() < 1e-9);
    }

    /// FRA 65, claim 62 is exactly 36 months early — exercises the boundary
    /// where the second reduction tier hasn't kicked in yet.
    #[test]
    fn fra_65_claim_62_is_080() {
        assert!((adjustment_factor(65, 62) - 0.80).abs() < 1e-9);
    }

    #[test]
    fn fra_66_claim_70_is_132() {
        assert!((adjustment_factor(66, 70) - 1.32).abs() < 1e-9);
    }

    #[test]
    fn fra_67_claim_70_is_124() {
        assert!((adjustment_factor(67, 70) - 1.24).abs() < 1e-9);
    }
}
