use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Plan, StreamBoundary, YearMonth};

/// Bounds on any date in a plan. `YearMonth::new` asserts the month range,
/// but serde deserialization constructs the struct field-by-field and never
/// calls it — so a hand-edited plan file (or any future UI path) can carry a
/// nonsense date. An out-of-range month silently normalizes through
/// `month_index()` (month 85 reads as the next year), and an absurd year
/// makes `simulate()` allocate a period per year between plan start and end,
/// so a stray digit turns into hundreds of thousands of snapshots.
const MIN_YEAR: i32 = 1900;
const MAX_YEAR: i32 = 2200;

/// A single reason a plan cannot be simulated or saved. `field` is a
/// stable, dotted path (e.g. `"accounts[1].owner"`) the frontend can use to
/// highlight the offending input; `message` is shown to the user as-is.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
}

impl Plan {
    /// Structural and range checks a `Plan` must pass before it is simulated
    /// or persisted. Deliberately narrow: only conditions that would crash,
    /// produce nonsensical output, or corrupt storage — not financial-planning
    /// advice (e.g. an unaffordable spending rate is a `DepletedFunds`
    /// warning from `simulate()`, not a validation error).
    pub fn validate(&self) -> Vec<ValidationError> {
        validate(self)
    }
}

fn validate(plan: &Plan) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let err = |field: &str, message: &str| ValidationError {
        field: field.to_string(),
        message: message.to_string(),
    };

    /// Month in 1..=12 and year within [MIN_YEAR, MAX_YEAR]. `label` names the
    /// date the way the user sees it, e.g. "Enrique's birth date".
    fn check_date(errors: &mut Vec<ValidationError>, field: &str, label: &str, date: YearMonth) {
        if !(1..=12).contains(&date.month) {
            errors.push(ValidationError {
                field: field.to_string(),
                message: format!("{label} has an invalid month ({}).", date.month),
            });
        }
        if !(MIN_YEAR..=MAX_YEAR).contains(&date.year) {
            errors.push(ValidationError {
                field: field.to_string(),
                message: format!(
                    "{label} must be between {MIN_YEAR} and {MAX_YEAR} (got {}).",
                    date.year
                ),
            });
        }
    }

    check_date(
        &mut errors,
        "sim_config.start",
        "The plan start date",
        plan.sim_config.start,
    );

    if plan.people.is_empty() {
        errors.push(err("people", "A plan needs at least one person."));
    }

    let mut seen_person_ids = HashSet::new();
    for (i, person) in plan.people.iter().enumerate() {
        if !seen_person_ids.insert(person.id.as_str()) {
            errors.push(err(
                &format!("people[{i}].id"),
                &format!("Duplicate person id \"{}\".", person.id),
            ));
        }
        check_date(
            &mut errors,
            &format!("people[{i}].birth"),
            &format!("{}'s birth date", person.name),
            person.birth,
        );
        check_date(
            &mut errors,
            &format!("people[{i}].retirement"),
            &format!("{}'s retirement date", person.name),
            person.retirement,
        );
        if person.retirement.month_index() <= person.birth.month_index() {
            errors.push(err(
                &format!("people[{i}].retirement"),
                &format!(
                    "{}'s retirement date must be after their birth date.",
                    person.name
                ),
            ));
        }
    }

    let mut seen_account_ids = HashSet::new();
    for (i, account) in plan.accounts.iter().enumerate() {
        if !seen_account_ids.insert(account.id.as_str()) {
            errors.push(err(
                &format!("accounts[{i}].id"),
                &format!("Duplicate account id \"{}\".", account.id),
            ));
        }
        if plan.person(&account.owner).is_none() {
            errors.push(err(
                &format!("accounts[{i}].owner"),
                &format!(
                    "\"{}\" has no owner — pick one of the people on this plan.",
                    account.name
                ),
            ));
        }
        if account.balance < 0.0 {
            errors.push(err(
                &format!("accounts[{i}].balance"),
                &format!("\"{}\" balance can't be negative.", account.name),
            ));
        }
    }

    let mut seen_stream_ids = HashSet::new();
    for (i, stream) in plan.streams.iter().enumerate() {
        if !seen_stream_ids.insert(stream.id.as_str()) {
            errors.push(err(
                &format!("streams[{i}].id"),
                &format!("Duplicate stream id \"{}\".", stream.id),
            ));
        }
        for (boundary, edge) in [(&stream.start, "start"), (&stream.end, "end")] {
            if let StreamBoundary::Date(date) = boundary {
                check_date(
                    &mut errors,
                    &format!("streams[{i}].{edge}"),
                    &format!("\"{}\"'s {edge} date", stream.name),
                    *date,
                );
            }
        }
    }

    let mut seen_ss_ids = HashSet::new();
    for (i, ss) in plan.social_security.iter().enumerate() {
        if !seen_ss_ids.insert(ss.id.as_str()) {
            errors.push(err(
                &format!("social_security[{i}].id"),
                &format!("Duplicate Social Security benefit id \"{}\".", ss.id),
            ));
        }
        if plan.person(&ss.owner).is_none() {
            errors.push(err(
                &format!("social_security[{i}].owner"),
                "This benefit has no owner — pick one of the people on this plan.",
            ));
        }
        if !(62..=70).contains(&ss.claiming_age) {
            errors.push(err(
                &format!("social_security[{i}].claiming_age"),
                "Claiming age must be between 62 and 70.",
            ));
        }
        if !(60..=70).contains(&ss.full_retirement_age) {
            errors.push(err(
                &format!("social_security[{i}].full_retirement_age"),
                "Full retirement age must be between 60 and 70.",
            ));
        }
        if ss.benefit_at_fra < 0.0 {
            errors.push(err(
                &format!("social_security[{i}].benefit_at_fra"),
                "Benefit at full retirement age can't be negative.",
            ));
        }
        if let Some(rate) = ss.cola_override {
            if rate <= -1.0 {
                errors.push(err(
                    &format!("social_security[{i}].cola_override"),
                    "COLA override can't be -100% or lower.",
                ));
            }
        }
    }

    if !(0.0..=1.0).contains(&plan.assumptions.flat_tax_rate) {
        errors.push(err(
            "assumptions.flat_tax_rate",
            "Tax rate must be between 0% and 100%.",
        ));
    }
    if plan.assumptions.inflation <= -1.0 {
        errors.push(err(
            "assumptions.inflation",
            "Inflation can't be -100% or lower.",
        ));
    }
    if plan.assumptions.social_security_cola <= -1.0 {
        errors.push(err(
            "assumptions.social_security_cola",
            "Social Security COLA can't be -100% or lower.",
        ));
    }
    for (class, rate) in &plan.assumptions.asset_returns {
        if *rate <= -1.0 {
            errors.push(err(
                "assumptions.asset_returns",
                &format!("{class:?} return can't be -100% or lower."),
            ));
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use crate::presets::seed_plan;

    #[test]
    fn seed_plan_is_valid() {
        assert!(seed_plan().validate().is_empty());
    }

    #[test]
    fn catches_empty_people() {
        let mut plan = seed_plan();
        plan.people.clear();
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "people"));
    }

    #[test]
    fn catches_duplicate_person_id() {
        let mut plan = seed_plan();
        let dup = plan.people[0].clone();
        let dup_index = plan.people.len();
        plan.people.push(dup);
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == format!("people[{dup_index}].id")));
    }

    #[test]
    fn catches_retirement_before_birth() {
        let mut plan = seed_plan();
        plan.people[0].retirement = plan.people[0].birth;
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "people[0].retirement"));
    }

    #[test]
    fn catches_unknown_account_owner() {
        let mut plan = seed_plan();
        plan.accounts[0].owner = "nobody".to_string();
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "accounts[0].owner"));
    }

    #[test]
    fn catches_negative_balance() {
        let mut plan = seed_plan();
        plan.accounts[0].balance = -1.0;
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "accounts[0].balance"));
    }

    #[test]
    fn catches_duplicate_account_and_stream_ids() {
        let mut plan = seed_plan();
        let dup_account = plan.accounts[0].clone();
        let account_dup_index = plan.accounts.len();
        plan.accounts.push(dup_account);
        let dup_stream = plan.streams[0].clone();
        let stream_dup_index = plan.streams.len();
        plan.streams.push(dup_stream);
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == format!("accounts[{account_dup_index}].id")));
        assert!(errors
            .iter()
            .any(|e| e.field == format!("streams[{stream_dup_index}].id")));
    }

    #[test]
    fn catches_out_of_range_month() {
        // Reachable because serde builds YearMonth field-by-field and never
        // calls YearMonth::new, so its 1..=12 assert does not apply.
        let mut plan = seed_plan();
        plan.people[0].birth.month = 85;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "people[0].birth" && e.message.contains("invalid month")));
    }

    #[test]
    fn catches_absurd_year() {
        // A stray digit while typing a year previously reached the engine and
        // made simulate() allocate a period per year to the plan end.
        let mut plan = seed_plan();
        plan.people[0].birth.year = 198_308;
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "people[0].birth"));
    }

    #[test]
    fn catches_bad_dates_on_streams_and_sim_start() {
        let mut plan = seed_plan();
        plan.sim_config.start.month = 0;
        plan.streams[0].start = super::StreamBoundary::Date(super::YearMonth {
            year: 12,
            month: 13,
        });
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "sim_config.start"));
        assert!(errors.iter().any(|e| e.field == "streams[0].start"));
    }

    #[test]
    fn accepts_every_valid_month() {
        for month in 1..=12 {
            let mut plan = seed_plan();
            plan.people[0].birth.month = month;
            assert!(
                plan.validate().is_empty(),
                "month {month} should be valid: {:?}",
                plan.validate()
            );
        }
    }

    #[test]
    fn catches_out_of_range_tax_rate() {
        let mut plan = seed_plan();
        plan.assumptions.flat_tax_rate = 1.5;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "assumptions.flat_tax_rate"));
    }

    #[test]
    fn catches_duplicate_social_security_id() {
        let mut plan = seed_plan();
        let dup = plan.social_security[0].clone();
        let dup_index = plan.social_security.len();
        plan.social_security.push(dup);
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == format!("social_security[{dup_index}].id")));
    }

    #[test]
    fn catches_unknown_social_security_owner() {
        let mut plan = seed_plan();
        plan.social_security[0].owner = "nobody".to_string();
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "social_security[0].owner"));
    }

    #[test]
    fn catches_out_of_range_claiming_age() {
        let mut plan = seed_plan();
        plan.social_security[0].claiming_age = 61;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "social_security[0].claiming_age"));
    }

    #[test]
    fn catches_out_of_range_full_retirement_age() {
        let mut plan = seed_plan();
        plan.social_security[0].full_retirement_age = 71;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "social_security[0].full_retirement_age"));
    }

    #[test]
    fn catches_negative_benefit_at_fra() {
        let mut plan = seed_plan();
        plan.social_security[0].benefit_at_fra = -1.0;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "social_security[0].benefit_at_fra"));
    }

    #[test]
    fn catches_bad_cola_override() {
        let mut plan = seed_plan();
        plan.social_security[0].cola_override = Some(-1.5);
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "social_security[0].cola_override"));
    }

    #[test]
    fn catches_bad_social_security_cola_assumption() {
        let mut plan = seed_plan();
        plan.assumptions.social_security_cola = -1.5;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "assumptions.social_security_cola"));
    }

    #[test]
    fn catches_extreme_inflation_and_returns() {
        let mut plan = seed_plan();
        plan.assumptions.inflation = -1.5;
        for rate in plan.assumptions.asset_returns.values_mut() {
            *rate = -2.0;
        }
        let errors = plan.validate();
        assert!(errors.iter().any(|e| e.field == "assumptions.inflation"));
        assert!(errors
            .iter()
            .any(|e| e.field == "assumptions.asset_returns"));
    }
}
