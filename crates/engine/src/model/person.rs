use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::YearMonth;

pub type PersonId = String;

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Person {
    pub id: PersonId,
    pub name: String,
    pub birth: YearMonth,
    pub retirement: YearMonth,
    /// Mortality assumption for this person: `StreamBoundary::AtDeath`
    /// resolves against it directly, and `Plan::end_month` takes the max
    /// across everyone's, so the household horizon runs to the last
    /// survivor rather than assuming a single shared age.
    pub life_expectancy_age: u8,
}

impl Person {
    /// The month this person reaches `age` years.
    pub fn month_at_age(&self, age: u8) -> YearMonth {
        self.birth.add_years(age as i32)
    }
}

/// Deserialization shape for `Person`. Plans written before #28 have no
/// per-person `life_expectancy_age` — only the household-wide
/// `Assumptions::plan_end_age`. `Plan`'s custom `Deserialize` is the only
/// place both values are in scope, so this wire struct just holds the raw
/// optional field until `resolve` fills it in from there. Same migration
/// intent as the `#[serde(default)]` precedent documented on
/// `sweep_surplus_to_taxable`.
#[derive(Deserialize)]
pub(super) struct PersonWire {
    id: PersonId,
    name: String,
    birth: YearMonth,
    retirement: YearMonth,
    #[serde(default)]
    life_expectancy_age: Option<u8>,
}

impl PersonWire {
    pub(super) fn resolve(self, fallback_plan_end_age: u8) -> Person {
        Person {
            id: self.id,
            name: self.name,
            birth: self.birth,
            retirement: self.retirement,
            life_expectancy_age: self.life_expectancy_age.unwrap_or(fallback_plan_end_age),
        }
    }
}
