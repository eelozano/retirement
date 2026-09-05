use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::person::PersonWire;
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

impl SimConfig {
    /// Index of the first simulated period that begins *strictly after*
    /// `month`, clamped to 0 for a month at or before the plan start.
    ///
    /// The strictness is the point for the survivor transition: the period a
    /// death falls inside keeps the pre-death rules — the IRS lets a
    /// survivor file jointly for the whole year of the death — and the next
    /// one is the first that does not.
    pub fn first_period_after(&self, month: YearMonth) -> usize {
        let months = self.start.months_until(month);
        if months < 0 {
            return 0;
        }
        (months / self.period.months()) as usize + 1
    }

    /// Index of the first simulated period that begins *at or after*
    /// `month` — the first period a change dated `month` covers in full,
    /// with no proration stub — clamped to 0 for a month at or before the
    /// plan start. Not bounded by the plan's length: a month past the end
    /// maps to an index past the last period, and the caller checks.
    ///
    /// Differs from `first_period_after` exactly when `month` falls on a
    /// period start, which for an annual plan is any January date: that
    /// period *is* the first full one, and the strict form would skip it.
    /// The frontend's `firstFullPeriodAtOrAfter` mirrors this definition, so
    /// anything measured "at retirement" on both sides names the same year.
    pub fn first_full_period_at_or_after(&self, month: YearMonth) -> usize {
        let months = self.start.months_until(month);
        if months <= 0 {
            return 0;
        }
        let per = self.period.months();
        ((months + per - 1) / per) as usize
    }
}

pub type PlanId = String;

/// The complete user plan — the single JSON document that is persisted, sent
/// over IPC, and fed to `simulate`.
#[derive(Serialize, TS, Clone, Debug)]
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
    /// `Assumptions::sweep_surplus_from`.
    #[serde(default)]
    pub social_security: Vec<SocialSecurityBenefit>,
    pub assumptions: Assumptions,
    pub sim_config: SimConfig,
}

impl Plan {
    /// The month after the last simulated period: the max over every
    /// person's own `life_expectancy_age` — the projection runs to the last
    /// survivor rather than a single household age.
    pub fn end_month(&self) -> YearMonth {
        self.people
            .iter()
            .map(|p| p.month_at_age(p.life_expectancy_age))
            .max()
            .unwrap_or(self.sim_config.start)
    }

    pub fn person(&self, id: &str) -> Option<&Person> {
        self.people.iter().find(|p| p.id == id)
    }

    /// The first death that leaves someone behind: the month it happens and
    /// the person it happens to.
    ///
    /// This is the household's survivor transition — the point at which
    /// Social Security drops to one benefit, filing status can change, and
    /// spending steps down (#34). `None` for a one-person plan, and also
    /// when everyone's expectancy lands in the same month: there is no
    /// survivor in either case, so nothing transitions.
    ///
    /// Deterministic, because mortality in this engine is an assumption
    /// (`Person::life_expectancy_age`) rather than a draw — which is what
    /// lets the tax model precompute when filing status changes instead of
    /// tracking household state through the loop.
    pub fn first_death(&self) -> Option<(YearMonth, &Person)> {
        let (month, decedent) = self
            .people
            .iter()
            .map(|p| (p.month_at_age(p.life_expectancy_age), p))
            .min_by_key(|(m, _)| *m)?;
        let outlived_by_someone = self
            .people
            .iter()
            .any(|p| p.month_at_age(p.life_expectancy_age) > month);
        outlived_by_someone.then_some((month, decedent))
    }

    /// Everyone still alive after `month` — the people a survivor benefit,
    /// pension continuation, or stepped-down household budget is for.
    pub fn survivors_after(&self, month: YearMonth) -> impl Iterator<Item = &Person> {
        self.people
            .iter()
            .filter(move |p| p.month_at_age(p.life_expectancy_age) > month)
    }
}

/// Deserialization shape for `Plan`, carrying people whose
/// `life_expectancy_age` may still be unresolved (see `PersonWire`). A wire
/// struct rather than `#[serde(from = "PlanWire")]` only because ts-rs cannot
/// parse that container attribute and warns on every build — same rationale
/// as `Account`'s hand-written `Deserialize`.
#[derive(Deserialize)]
struct PlanWire {
    #[serde(default)]
    id: PlanId,
    schema_version: u32,
    name: String,
    people: Vec<PersonWire>,
    accounts: Vec<Account>,
    streams: Vec<CashFlowStream>,
    #[serde(default)]
    social_security: Vec<SocialSecurityBenefit>,
    assumptions: Assumptions,
    sim_config: SimConfig,
}

impl<'de> Deserialize<'de> for Plan {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let w = PlanWire::deserialize(deserializer)?;
        let fallback = w.assumptions.plan_end_age;
        Ok(Plan {
            id: w.id,
            schema_version: w.schema_version,
            name: w.name,
            people: w.people.into_iter().map(|p| p.resolve(fallback)).collect(),
            accounts: w.accounts,
            streams: w.streams,
            social_security: w.social_security,
            assumptions: w.assumptions,
            sim_config: w.sim_config,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{PeriodLength, SimConfig, YearMonth};
    use crate::presets::seed_plan;

    #[test]
    fn first_full_period_at_or_after_is_inclusive_on_a_period_start() {
        let config = SimConfig {
            start: YearMonth::new(2026, 1),
            period: PeriodLength::Year,
            display_real_dollars: false,
        };
        // A month at or before the start clamps to period 0.
        assert_eq!(
            config.first_full_period_at_or_after(YearMonth::new(2020, 6)),
            0
        );
        assert_eq!(
            config.first_full_period_at_or_after(YearMonth::new(2026, 1)),
            0
        );
        // Mid-period: that period is a stub, the next is the first full one.
        assert_eq!(
            config.first_full_period_at_or_after(YearMonth::new(2038, 8)),
            13
        );
        assert_eq!(config.first_period_after(YearMonth::new(2038, 8)), 13);
        // On a period start the two helpers part ways: inclusive here,
        // strict there.
        assert_eq!(
            config.first_full_period_at_or_after(YearMonth::new(2039, 1)),
            13
        );
        assert_eq!(config.first_period_after(YearMonth::new(2039, 1)), 14);
    }

    /// A plan file written before #28 has no `life_expectancy_age` on any
    /// person — only the household-wide `assumptions.plan_end_age`.
    #[test]
    fn legacy_person_falls_back_to_household_plan_end_age() {
        let mut plan = seed_plan();
        plan.assumptions.plan_end_age = 91;
        let mut value = serde_json::to_value(&plan).expect("plan serializes");
        for person in value["people"].as_array_mut().unwrap() {
            person
                .as_object_mut()
                .unwrap()
                .remove("life_expectancy_age");
        }

        let reloaded: super::Plan =
            serde_json::from_value(value).expect("legacy plan (sans life_expectancy_age) parses");

        assert!(!reloaded.people.is_empty());
        for person in &reloaded.people {
            assert_eq!(person.life_expectancy_age, 91);
        }
    }

    /// A person with an explicit `life_expectancy_age` keeps it rather than
    /// being overridden by the household fallback.
    #[test]
    fn explicit_life_expectancy_age_is_not_overridden() {
        let plan = seed_plan();
        let original: Vec<u8> = plan.people.iter().map(|p| p.life_expectancy_age).collect();
        let value = serde_json::to_value(&plan).expect("plan serializes");

        let reloaded: super::Plan = serde_json::from_value(value).expect("plan round-trips");

        let resolved: Vec<u8> = reloaded
            .people
            .iter()
            .map(|p| p.life_expectancy_age)
            .collect();
        assert_eq!(resolved, original);
    }
}
