use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Account, Assumptions, CashFlowStream, Person, SocialSecurityBenefit, YearMonth};

/// Bump when the Plan JSON layout changes incompatibly; the storage layer
/// migrates or rejects on mismatch.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[ts(export)]
pub enum PeriodLength {
    Year,
    /// V2: same loop at monthly resolution.
    Month,
}

impl PeriodLength {
    pub fn months(self) -> i64 {
        match self {
            PeriodLength::Year => 12,
            PeriodLength::Month => 1,
        }
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct SimConfig {
    /// First month of the simulation.
    pub start: YearMonth,
    pub period: PeriodLength,
    /// UI hint only: whether charts default to today's-dollars display. The
    /// engine always outputs nominal values plus a per-period deflator.
    pub display_real_dollars: bool,
}

pub type PlanId = String;

/// The complete user plan — the single JSON document that is persisted, sent
/// over IPC, and fed to `simulate`.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Plan {
    /// Stable identity, independent of the (editable, non-unique) `name` —
    /// this is what a plan file is keyed by on disk, so renaming a plan is
    /// an in-place edit rather than a file move. `#[serde(default)]` so
    /// plans saved before scenario support (#6) load with an empty id; the
    /// storage layer backfills it once from the pre-#6 filename slug.
    #[serde(default)]
    pub id: PlanId,
    pub schema_version: u32,
    pub name: String,
    pub people: Vec<Person>,
    pub accounts: Vec<Account>,
    pub streams: Vec<CashFlowStream>,
    /// `#[serde(default)]` so plans saved before this field existed load as
    /// empty, same migration precedent as
    /// `Assumptions::sweep_surplus_to_taxable`.
    #[serde(default)]
    pub social_security: Vec<SocialSecurityBenefit>,
    pub assumptions: Assumptions,
    pub sim_config: SimConfig,
}

impl Plan {
    /// The month after the last simulated period: every person has reached
    /// `assumptions.plan_end_age`.
    pub fn end_month(&self) -> YearMonth {
        self.people
            .iter()
            .map(|p| p.month_at_age(self.assumptions.plan_end_age))
            .max()
            .unwrap_or(self.sim_config.start)
    }

    pub fn person(&self, id: &str) -> Option<&Person> {
        self.people.iter().find(|p| p.id == id)
    }
}
