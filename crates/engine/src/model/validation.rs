use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Plan;

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
    fn catches_out_of_range_tax_rate() {
        let mut plan = seed_plan();
        plan.assumptions.flat_tax_rate = 1.5;
        let errors = plan.validate();
        assert!(errors
            .iter()
            .any(|e| e.field == "assumptions.flat_tax_rate"));
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
