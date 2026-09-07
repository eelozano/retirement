//! The household/scenario split: what a household observes, and what a
//! scenario decides.
//!
//! A balance is not a scenario variable. It is a fact about the world —
//! identical across every scenario a household keeps, read off a statement,
//! and going stale from the day it is written down. What varies between
//! scenarios is forward policy: retirement dates, contribution rules,
//! spending, claiming ages. So the split runs *through* the model structs:
//! `Account::balance` is an observation while `Account::contributions` is
//! policy; `Person::birth` is a fact while `Person::retirement` is a choice;
//! `SimConfig::start` is the date the balances are as of, which is one date
//! for the household rather than one per scenario.
//!
//! [`Household`] and [`Scenario`] are the two halves, and [`compose`] and
//! [`decompose`] are the only way between them and a [`Plan`]. Everything
//! downstream of `compose` — validation, `simulate`, the projection, every
//! chart — still sees a plain `Plan` and knows nothing about this module.
//!
//! Model code only: no I/O, no clock, and nothing under `sim/` imports it.
//! It lives in the engine rather than in `src-tauri` for three reasons: the
//! ts-rs export that gives the frontend the as-of dates, the fixtures test
//! that round-trips the committed demo household, and the exhaustive
//! `let Plan { .. }` destructure in `decompose`, which makes a new `Plan`
//! field a compile error until someone has decided which side it falls on.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    Account, AccountId, AccountKind, AllocationRef, Assumptions, CashFlowStream, Contribution,
    EmployerMatch, PeriodLength, Person, PersonId, Plan, PlanId, PlanType, SimConfig,
    SocialSecurityBenefit, SocialSecurityBenefitId, YearMonth, SCHEMA_VERSION,
};

pub type HouseholdId = String;

/// A balance as it stood on a date — the thing you read off a statement.
///
/// Dated because the number is only true on the day it was written down,
/// and kept as a list because the previous figure beside the new one is
/// what makes a refresh checkable (#111). The simulation reads only the
/// last one.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Observation {
    pub as_of: YearMonth,
    pub balance: f64,
    /// Taxable accounts only; `None` everywhere else, exactly as on
    /// [`Account::cost_basis`].
    pub cost_basis: Option<f64>,
}

/// A person, as the household knows them rather than as a scenario plans
/// for them: who they are and when they were born. `retirement` and
/// `life_expectancy_age` are in [`PersonPolicy`].
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct HouseholdPerson {
    pub id: PersonId,
    pub name: String,
    pub birth: YearMonth,
}

/// An account the household holds: its identity, its tax treatment, how it
/// is invested, and the balances it has been observed at. What goes *into*
/// it is [`AccountPolicy`].
///
/// `allocation` is a fact and not policy: it is how the money is invested
/// today, not a plan for investing it. Putting it on the scenario would
/// mean a newly opened account appearing in the household's other scenarios
/// at some default nobody chose, and "what if we de-risk" is already the
/// What-if sandbox's returns knob rather than a per-account edit.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct HouseholdAccount {
    pub id: AccountId,
    pub owner: PersonId,
    pub kind: AccountKind,
    pub plan_type: PlanType,
    pub name: String,
    pub allocation: AllocationRef,
    /// Newest last. Never empty for an account that came through
    /// [`decompose`], and the simulation reads only the last entry.
    pub observations: Vec<Observation>,
}

impl HouseholdAccount {
    /// The balance the simulation starts from: the newest observation.
    pub fn current(&self) -> Option<&Observation> {
        self.observations.last()
    }
}

/// A Social Security benefit as the statement reports it. When to claim it
/// is [`BenefitPolicy`].
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct HouseholdBenefit {
    pub id: SocialSecurityBenefitId,
    pub owner: PersonId,
    pub benefit_at_fra: f64,
    pub full_retirement_age: u8,
}

/// Everything true of a household regardless of which scenario is open:
/// who they are, what they hold, and when those balances were last read.
///
/// Written once and refreshed, never per scenario. The one file under
/// `plans/` holds this plus every [`Scenario`] branched from it.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Household {
    pub id: HouseholdId,
    pub name: String,
    /// True for the bundled example household — invented balances, never
    /// the user's own. Carried here rather than per scenario because it is
    /// a fact about where the numbers came from, and every scenario of one
    /// household shares them. See `Plan::sample` and CLAUDE.md's privacy
    /// rule.
    pub sample: bool,
    /// The month the balances below are as of, and therefore the month
    /// every scenario's projection starts (#106).
    pub as_of: YearMonth,
    pub people: Vec<HouseholdPerson>,
    pub accounts: Vec<HouseholdAccount>,
    pub social_security: Vec<HouseholdBenefit>,
}

/// What a scenario decides about a person.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PersonPolicy {
    pub retirement: YearMonth,
    pub life_expectancy_age: u8,
}

/// What a scenario decides about an account: what goes into it, and what
/// the employer adds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AccountPolicy {
    pub contributions: Vec<Contribution>,
    pub employer_match: Option<EmployerMatch>,
}

/// What a scenario decides about a benefit: when to claim it, and whether
/// to override the household COLA assumption for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BenefitPolicy {
    pub claiming_age: u8,
    pub cola_override: Option<f64>,
}

/// One branch of a household: everything that varies between "what if we
/// retire two years early" and "what if we claim at 62".
///
/// No `TS` derive, here or on the three policy structs: a scenario reaches
/// the frontend as the `Plan` [`compose`] builds from it, never in this
/// shape. Only [`Household`] is exported, because the as-of dates it
/// carries are the one thing a `Plan` does not (#110).
///
/// The three maps are keyed by the household entity's id, so a scenario
/// names the accounts and people it decides about without copying them.
/// `BTreeMap` rather than `HashMap` so the YAML a scenario writes is
/// ordered and diffable.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Scenario {
    /// The id the rest of the app calls a plan id: it is what
    /// `settings.json` records as active, and what the scenario switcher
    /// passes back.
    pub id: PlanId,
    pub name: String,
    pub display_real_dollars: bool,
    pub people: BTreeMap<PersonId, PersonPolicy>,
    pub accounts: BTreeMap<AccountId, AccountPolicy>,
    pub social_security: BTreeMap<SocialSecurityBenefitId, BenefitPolicy>,
    pub streams: Vec<CashFlowStream>,
    pub assumptions: Assumptions,
}

/// What one `plans/<household-id>.yaml` holds: the household's facts and
/// every scenario branched from them.
///
/// The household fields are spelled out rather than nested under a
/// `household:` key so the file reads as one document about one household,
/// and rather than `#[serde(flatten)]` because flattening routes the whole
/// document through serde's buffering layer for no gain here.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HouseholdFile {
    pub schema_version: u32,
    pub id: HouseholdId,
    pub name: String,
    #[serde(default)]
    pub sample: bool,
    pub as_of: YearMonth,
    pub people: Vec<HouseholdPerson>,
    pub accounts: Vec<HouseholdAccount>,
    #[serde(default)]
    pub social_security: Vec<HouseholdBenefit>,
    pub scenarios: Vec<Scenario>,
}

impl HouseholdFile {
    pub fn new(household: Household, scenarios: Vec<Scenario>) -> Self {
        HouseholdFile {
            schema_version: SCHEMA_VERSION,
            id: household.id,
            name: household.name,
            sample: household.sample,
            as_of: household.as_of,
            people: household.people,
            accounts: household.accounts,
            social_security: household.social_security,
            scenarios,
        }
    }

    /// The facts half, copied out. Cheap enough (a household is a handful
    /// of accounts) that a borrow-flavoured variant would only complicate
    /// the callers.
    pub fn household(&self) -> Household {
        Household {
            id: self.id.clone(),
            name: self.name.clone(),
            sample: self.sample,
            as_of: self.as_of,
            people: self.people.clone(),
            accounts: self.accounts.clone(),
            social_security: self.social_security.clone(),
        }
    }

    pub fn scenario(&self, id: &str) -> Option<&Scenario> {
        self.scenarios.iter().find(|s| s.id == id)
    }
}

/// Why a scenario and its household do not fit together. Only reachable
/// from a hand-edited file: [`decompose`] derives the household from the
/// plan, and the storage layer fills siblings in on save, so a scenario the
/// app wrote always names every entity its household has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposeError {
    pub message: String,
}

impl std::fmt::Display for ComposeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn missing(kind: &str, id: &str, scenario: &str) -> ComposeError {
    ComposeError {
        message: format!("scenario {scenario:?} has no policy for {kind} {id:?}"),
    }
}

/// Builds the [`Plan`] the engine simulates from a household's facts and
/// one scenario's policy.
///
/// Every household entity appears in the plan — a scenario cannot own a
/// subset of the accounts, because the household holds all of them
/// whichever branch you are looking at. Each account's `balance` and
/// `cost_basis` are its newest observation, and `sim_config.start` is the
/// household's `as_of`, so every scenario of one household projects from
/// the same balances on the same month and a comparison between them is
/// honest by construction.
///
/// Fallible rather than total, against the sketch in #109: a scenario that
/// names no policy for a person has no retirement date, and the only two
/// ways to return a `Plan` anyway would be to invent one or to drop the
/// person. Both are worse than an error the storage layer can report, and
/// neither can arise from a file the app wrote.
pub fn compose(household: &Household, scenario: &Scenario) -> Result<Plan, ComposeError> {
    let people = household
        .people
        .iter()
        .map(|p| {
            let policy = scenario
                .people
                .get(&p.id)
                .ok_or_else(|| missing("person", &p.id, &scenario.id))?;
            Ok(Person {
                id: p.id.clone(),
                name: p.name.clone(),
                birth: p.birth,
                retirement: policy.retirement,
                life_expectancy_age: policy.life_expectancy_age,
            })
        })
        .collect::<Result<Vec<_>, ComposeError>>()?;

    let accounts = household
        .accounts
        .iter()
        .map(|a| {
            let policy = scenario
                .accounts
                .get(&a.id)
                .ok_or_else(|| missing("account", &a.id, &scenario.id))?;
            // An account with no observations is a hand-edit too: it has no
            // balance to start from. Zero is the honest reading — the
            // account exists and holds nothing — and it is what a
            // not-yet-opened account (the demo's 2029 Roth) carries anyway.
            let current = a.current();
            Ok(Account {
                id: a.id.clone(),
                owner: a.owner.clone(),
                kind: a.kind,
                name: a.name.clone(),
                balance: current.map_or(0.0, |o| o.balance),
                cost_basis: current.and_then(|o| o.cost_basis),
                allocation: a.allocation.clone(),
                plan_type: a.plan_type,
                contributions: policy.contributions.clone(),
                employer_match: policy.employer_match.clone(),
            })
        })
        .collect::<Result<Vec<_>, ComposeError>>()?;

    let social_security = household
        .social_security
        .iter()
        .map(|b| {
            let policy = scenario
                .social_security
                .get(&b.id)
                .ok_or_else(|| missing("Social Security benefit", &b.id, &scenario.id))?;
            Ok(SocialSecurityBenefit {
                id: b.id.clone(),
                owner: b.owner.clone(),
                benefit_at_fra: b.benefit_at_fra,
                full_retirement_age: b.full_retirement_age,
                claiming_age: policy.claiming_age,
                cola_override: policy.cola_override,
            })
        })
        .collect::<Result<Vec<_>, ComposeError>>()?;

    Ok(Plan {
        id: scenario.id.clone(),
        schema_version: SCHEMA_VERSION,
        name: scenario.name.clone(),
        sample: household.sample,
        people,
        accounts,
        streams: scenario.streams.clone(),
        social_security,
        assumptions: scenario.assumptions.clone(),
        sim_config: SimConfig {
            start: household.as_of,
            // Always `Year`, and no longer written to any file: the loop
            // lays its grid on calendar-year boundaries and does not read
            // this field. See `PeriodLength::Month`.
            period: PeriodLength::Year,
            display_real_dollars: scenario.display_real_dollars,
        },
    })
}

/// Splits an edited [`Plan`] back into the household it describes and the
/// scenario it is.
///
/// `previous` is the household as stored, and supplies the two things a
/// plan does not carry: the household's own id and name. Everything else is
/// taken from the plan — the composed plan contains the whole household by
/// construction, so the facts replace the stored ones wholesale rather than
/// merging, which is what lets a deleted account actually disappear and a
/// reordered list stay reordered.
///
/// A changed balance **amends** the account's current observation instead of
/// appending a new one: an edit on the Accounts screen is a correction to
/// what was written down, not a new reading. Appending — the "I sat down and
/// refreshed everything" gesture, which also moves `as_of` — is #111's job.
pub fn decompose(plan: &Plan, previous: &Household) -> (Household, Scenario) {
    // Exhaustive on purpose: a new `Plan` field fails to compile here until
    // someone has decided whether it is a fact or a policy. That decision is
    // the whole point of this module, and a `..` would let it be skipped.
    let Plan {
        id,
        schema_version: _,
        name,
        sample,
        people,
        accounts,
        streams,
        social_security,
        assumptions,
        sim_config,
    } = plan;

    let as_of = sim_config.start;

    let household = Household {
        id: previous.id.clone(),
        name: previous.name.clone(),
        sample: *sample,
        as_of,
        people: people
            .iter()
            .map(|p| HouseholdPerson {
                id: p.id.clone(),
                name: p.name.clone(),
                birth: p.birth,
            })
            .collect(),
        accounts: accounts
            .iter()
            .map(|a| {
                let current = Observation {
                    as_of,
                    balance: a.balance,
                    cost_basis: a.cost_basis,
                };
                let mut observations = previous
                    .accounts
                    .iter()
                    .find(|prev| prev.id == a.id)
                    .map(|prev| prev.observations.clone())
                    .unwrap_or_default();
                // Amend the newest reading rather than append: the history
                // behind it is untouched, and an account the household has
                // never seen before starts with exactly one.
                match observations.last_mut() {
                    Some(last) => *last = current,
                    None => observations.push(current),
                }
                HouseholdAccount {
                    id: a.id.clone(),
                    owner: a.owner.clone(),
                    kind: a.kind,
                    plan_type: a.plan_type,
                    name: a.name.clone(),
                    allocation: a.allocation.clone(),
                    observations,
                }
            })
            .collect(),
        social_security: social_security
            .iter()
            .map(|b| HouseholdBenefit {
                id: b.id.clone(),
                owner: b.owner.clone(),
                benefit_at_fra: b.benefit_at_fra,
                full_retirement_age: b.full_retirement_age,
            })
            .collect(),
    };

    let scenario = Scenario {
        id: id.clone(),
        name: name.clone(),
        display_real_dollars: sim_config.display_real_dollars,
        people: people
            .iter()
            .map(|p| {
                (
                    p.id.clone(),
                    PersonPolicy {
                        retirement: p.retirement,
                        life_expectancy_age: p.life_expectancy_age,
                    },
                )
            })
            .collect(),
        accounts: accounts
            .iter()
            .map(|a| {
                (
                    a.id.clone(),
                    AccountPolicy {
                        contributions: a.contributions.clone(),
                        employer_match: a.employer_match.clone(),
                    },
                )
            })
            .collect(),
        social_security: social_security
            .iter()
            .map(|b| {
                (
                    b.id.clone(),
                    BenefitPolicy {
                        claiming_age: b.claiming_age,
                        cola_override: b.cola_override,
                    },
                )
            })
            .collect(),
        streams: streams.clone(),
        assumptions: assumptions.clone(),
    };

    (household, scenario)
}

/// An empty household to decompose the very first plan of one against —
/// the household has no facts yet, and no id or name until the caller
/// names it.
pub fn empty_household(id: HouseholdId, name: String, as_of: YearMonth) -> Household {
    Household {
        id,
        name,
        sample: false,
        as_of,
        people: Vec::new(),
        accounts: Vec::new(),
        social_security: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presets::seed_plan;

    fn split(plan: &Plan) -> (Household, Scenario) {
        let empty = empty_household(
            "house".to_string(),
            "House".to_string(),
            plan.sim_config.start,
        );
        decompose(plan, &empty)
    }

    #[test]
    fn a_plan_survives_the_round_trip() {
        let plan = seed_plan();
        let (household, scenario) = split(&plan);
        let back = compose(&household, &scenario).expect("every entity has a policy");

        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&plan).unwrap(),
            "compose ∘ decompose is the identity on a plan"
        );
    }

    #[test]
    fn balances_land_on_the_household_dated_as_of() {
        let plan = seed_plan();
        let (household, _) = split(&plan);
        assert_eq!(household.as_of, plan.sim_config.start);
        for (account, source) in household.accounts.iter().zip(&plan.accounts) {
            assert_eq!(account.observations.len(), 1);
            let current = account.current().unwrap();
            assert_eq!(current.as_of, plan.sim_config.start);
            assert_eq!(current.balance, source.balance);
            assert_eq!(current.cost_basis, source.cost_basis);
        }
    }

    #[test]
    fn editing_a_balance_amends_the_current_observation_rather_than_appending() {
        let plan = seed_plan();
        let (mut household, _) = split(&plan);
        // A reading from a year ago, so there is history to preserve.
        household.accounts[0].observations.insert(
            0,
            Observation {
                as_of: YearMonth::new(2025, 1),
                balance: 1.0,
                cost_basis: None,
            },
        );

        let mut edited = plan.clone();
        edited.accounts[0].balance = 999_000.0;
        let (after, _) = decompose(&edited, &household);

        assert_eq!(
            after.accounts[0].observations.len(),
            2,
            "an edit corrects the current reading, it does not add one (#111)"
        );
        assert_eq!(after.accounts[0].observations[0].balance, 1.0);
        assert_eq!(after.accounts[0].current().unwrap().balance, 999_000.0);
    }

    #[test]
    fn a_deleted_account_leaves_the_household() {
        let plan = seed_plan();
        let (household, _) = split(&plan);
        let mut edited = plan.clone();
        let removed = edited.accounts.remove(0).id;

        let (after, scenario) = decompose(&edited, &household);
        assert!(after.accounts.iter().all(|a| a.id != removed));
        assert!(!scenario.accounts.contains_key(&removed));
    }

    #[test]
    fn a_scenario_missing_a_policy_is_an_error_rather_than_an_invented_date() {
        let plan = seed_plan();
        let (household, mut scenario) = split(&plan);
        let person = household.people[0].id.clone();
        scenario.people.remove(&person);

        let error = compose(&household, &scenario).expect_err("no retirement date to compose");
        assert!(error.message.contains(&person), "{}", error.message);
    }

    #[test]
    fn the_household_file_round_trips_through_yaml() {
        let plan = seed_plan();
        let (household, scenario) = split(&plan);
        let file = HouseholdFile::new(household.clone(), vec![scenario]);

        let yaml = serde_yaml_ng::to_string(&file).expect("serializes");
        let reloaded: HouseholdFile = serde_yaml_ng::from_str(&yaml).expect("parses");

        assert_eq!(reloaded.household(), household);
        let back = compose(&reloaded.household(), &reloaded.scenarios[0]).unwrap();
        assert_eq!(
            serde_json::to_value(&back).unwrap(),
            serde_json::to_value(&plan).unwrap()
        );
    }
}
