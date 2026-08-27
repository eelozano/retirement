use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::YearMonth;

pub type PersonId = String;

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Person {
    pub id: PersonId,
    pub name: String,
    pub birth: YearMonth,
    pub retirement: YearMonth,
}

impl Person {
    /// The month this person reaches `age` years.
    pub fn month_at_age(&self, age: u8) -> YearMonth {
        self.birth.add_years(age as i32)
    }
}
