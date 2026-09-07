//! One-shot, copy-forward migrations. Three of them share this module
//! because they share a posture: **nothing is ever deleted**, only copied or
//! set aside, so a migration can lose data only by duplicating it.
//!
//! - `migrate_json_dir_to_yaml` brings legacy pre-#13 JSON plans from the
//!   old app-data directory into the user-visible plans directory as YAML.
//!   They arrive as version-1 documents, and the next migration picks them
//!   up.
//! - `migrate_v1_plans` turns version-1 files — one self-contained `Plan`
//!   each, every scenario carrying its own copy of every balance — into
//!   version-2 households (#109).
//! - `copy_yaml_dir` copies plans along when the user relocates the storage
//!   folder from Settings.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use engine::model::{decompose, empty_household, Household, HouseholdFile, Plan};

use crate::storage;

/// Copy every `*.json` plan file from a legacy plans directory into
/// `to_base` (a storage base dir), converting each to YAML. Files that fail
/// to parse are left in place and simply skipped, matching
/// `storage::list_plans`'s silent-skip policy. Returns the number of plans
/// migrated.
///
/// The YAML it writes is a **version-1** document, exactly as the app wrote
/// them before #109: converting the format and splitting households are two
/// separate jobs, and `migrate_v1_plans` runs straight after this one.
pub fn migrate_json_dir_to_yaml(legacy_plans_dir: &Path, to_base: &Path) -> Result<usize, String> {
    if !legacy_plans_dir.exists() {
        return Ok(0);
    }
    let dir = storage::plans_dir(to_base);
    let mut migrated = 0;
    for entry in fs::read_dir(legacy_plans_dir)
        .map_err(|e| format!("reading {}: {e}", legacy_plans_dir.display()))?
    {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(json) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut plan) = serde_json::from_str::<Plan>(&json) else {
            continue;
        };
        // Pre-#13 JSON plans predate the #6 `id` field too; back it out of
        // the name, the way plan files were keyed before ids existed.
        if plan.id.trim().is_empty() {
            plan.id = storage::slugify(&plan.name);
        }
        let Ok(yaml) = serde_yaml_ng::to_string(&plan) else {
            continue;
        };
        fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        if fs::write(dir.join(format!("{}.yaml", plan.id)), yaml).is_ok() {
            migrated += 1;
        }
    }
    Ok(migrated)
}

/// Copy every already-YAML file from one storage base dir to another (used
/// when the user relocates the storage folder in Settings). A plain file
/// copy — same format on both ends, no reparse needed.
pub fn copy_yaml_dir(from_base: &Path, to_base: &Path) -> Result<usize, String> {
    let from_dir = storage::plans_dir(from_base);
    let to_dir = storage::plans_dir(to_base);
    if !from_dir.exists() {
        return Ok(0);
    }
    fs::create_dir_all(&to_dir).map_err(|e| format!("creating {}: {e}", to_dir.display()))?;
    let mut copied = 0;
    for entry in
        fs::read_dir(&from_dir).map_err(|e| format!("reading {}: {e}", from_dir.display()))?
    {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
            continue;
        }
        if let Some(name) = path.file_name() {
            fs::copy(&path, to_dir.join(name))
                .map_err(|e| format!("copying {}: {e}", path.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// What a non-sample household is called after the migration, and what the
/// example household is called. Both are renamable on the refresh screen
/// (#111) — these are the names the user has never been asked for.
const MIGRATED_HOUSEHOLD_NAME: &str = "My household";
const MIGRATED_SAMPLE_NAME: &str = "Example household";

/// A version-1 plan file, read and kept beside the path it came from.
struct V1 {
    path: PathBuf,
    plan: Plan,
    modified: SystemTime,
}

/// The grouping key: what makes two version-1 plans scenarios of the *same*
/// household rather than two households.
///
/// Whether the plan is the bundled example, and then who the people are —
/// their ids and birth months. That keeps a loaded example household apart
/// from the user's own, and separates real plans that describe genuinely
/// different people (someone modelling their own retirement and their
/// parents'). It deliberately ignores balances and names: those are exactly
/// the facts that drifted between copies, which is the problem being fixed.
type GroupKey = (bool, BTreeSet<(String, String)>);

fn group_key(plan: &Plan) -> GroupKey {
    (
        plan.sample,
        plan.people
            .iter()
            .map(|p| {
                (
                    p.id.clone(),
                    format!("{:04}-{:02}", p.birth.year, p.birth.month),
                )
            })
            .collect(),
    )
}

/// Turns every version-1 file under `plans/` into version-2 households.
///
/// One pass, all or nothing per run: half a migration would leave the app
/// with nothing loadable. `active` is the scenario id `settings.json`
/// records, which decides whose facts a group keeps — the plan the user was
/// last looking at is the one whose balances they most recently touched.
///
/// Returns the number of households written; 0 when there is nothing to do,
/// which is every launch after the first.
pub fn migrate_v1_plans(base: &Path, active: Option<&str>) -> Result<usize, String> {
    let v1 = read_v1_files(base)?;
    if v1.is_empty() {
        return Ok(0);
    }

    // Groups in a stable order (file order within the group), so a rerun on
    // the same directory would name the households the same way.
    let mut groups: BTreeMap<String, Vec<V1>> = BTreeMap::new();
    for file in v1 {
        let (sample, people) = group_key(&file.plan);
        let key = format!(
            "{}|{}",
            u8::from(sample),
            people
                .iter()
                .map(|(id, birth)| format!("{id}@{birth}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        groups.entry(key).or_default().push(file);
    }

    let mut taken: BTreeSet<String> = storage::taken_ids(base);
    // Scenario ids are the old plan ids, so reserve them before minting
    // household ids: a household must not take a name a scenario answers to.
    for members in groups.values() {
        taken.extend(members.iter().map(|m| m.plan.id.clone()));
    }

    let mut used_names: BTreeSet<String> = BTreeSet::new();
    let mut report = String::new();
    let mut written = 0;

    for members in groups.values() {
        let chosen = choose_facts_source(members, active);
        let name = household_name(chosen.plan.sample, &mut used_names);
        let id = storage::fresh_id(&taken, &name);
        taken.insert(id.clone());

        let skeleton = empty_household(id, name, chosen.plan.sim_config.start);
        let (household, chosen_scenario) = decompose(&chosen.plan, &skeleton);

        let mut scenarios = Vec::new();
        for member in members {
            if member.plan.id == chosen.plan.id {
                scenarios.push(chosen_scenario.clone());
                continue;
            }
            report += &disagreements(&household, member, chosen);
            let (_, mut scenario) = decompose(&member.plan, &household);
            // The member may have named accounts the household does not
            // have (or lacked ones it does): line its policy up with the
            // facts that were kept, exactly as a save does.
            storage::fill_in(&mut scenario, &chosen_scenario);
            scenarios.push(scenario);
        }

        storage::save_household_file(base, &HouseholdFile::new(household, scenarios))?;
        written += 1;
    }

    for members in groups.values() {
        for member in members {
            set_aside(base, &member.path)?;
        }
    }

    if !report.is_empty() {
        write_report(base, &report)?;
    }
    Ok(written)
}

fn read_v1_files(base: &Path) -> Result<Vec<V1>, String> {
    let dir = storage::plans_dir(base);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .collect();
    paths.sort();

    let mut files = Vec::new();
    for path in paths {
        let Ok(yaml) = fs::read_to_string(&path) else {
            continue;
        };
        // Read the version before the document: a version-2 household file
        // is not a `Plan` and must not be reported as an unreadable one.
        let Ok(value) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&yaml) else {
            continue;
        };
        if value.get("schema_version").and_then(|v| v.as_u64()) != Some(1) {
            continue;
        }
        let Ok(mut plan) = serde_yaml_ng::from_str::<Plan>(&yaml) else {
            continue;
        };
        // Plans written before #6 have no id; they were keyed by filename.
        if plan.id.trim().is_empty() {
            plan.id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(storage::slugify)
                .unwrap_or_else(|| storage::slugify(&plan.name));
        }
        let modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        files.push(V1 {
            path,
            plan,
            modified,
        });
    }
    Ok(files)
}

/// Whose balances the household keeps: the scenario the user had open if it
/// is in this group, else the file written most recently.
fn choose_facts_source<'a>(members: &'a [V1], active: Option<&str>) -> &'a V1 {
    active
        .and_then(|id| members.iter().find(|m| m.plan.id == id))
        .or_else(|| members.iter().max_by_key(|m| m.modified))
        .unwrap_or(&members[0])
}

fn household_name(sample: bool, used: &mut BTreeSet<String>) -> String {
    let base = if sample {
        MIGRATED_SAMPLE_NAME
    } else {
        MIGRATED_HOUSEHOLD_NAME
    };
    let name = (1..)
        .map(|n| {
            if n == 1 {
                base.to_string()
            } else {
                format!("{base} {n}")
            }
        })
        .find(|candidate| !used.contains(candidate))
        .expect("an unused household name");
    used.insert(name.clone());
    name
}

/// Every fact a household states, as text, keyed so two households can be
/// compared field by field. Text rather than the values themselves because
/// the only consumer is a report the user reads.
fn fact_lines(household: &Household) -> BTreeMap<String, String> {
    let mut facts = BTreeMap::new();
    let month = |m: engine::model::YearMonth| format!("{:04}-{:02}", m.year, m.month);
    let money = |v: f64| format!("{v:.2}");

    facts.insert("balances as of".to_string(), month(household.as_of));
    for p in &household.people {
        facts.insert(format!("person {} · name", p.id), p.name.clone());
        facts.insert(format!("person {} · birth", p.id), month(p.birth));
    }
    for a in &household.accounts {
        let key = |field: &str| format!("account {} · {field}", a.id);
        facts.insert(key("name"), a.name.clone());
        facts.insert(key("owner"), a.owner.clone());
        facts.insert(key("type"), format!("{:?}", a.kind));
        facts.insert(key("contribution bucket"), format!("{:?}", a.plan_type));
        facts.insert(key("allocation"), format!("{:?}", a.allocation));
        if let Some(current) = a.current() {
            facts.insert(key("balance"), money(current.balance));
            if let Some(basis) = current.cost_basis {
                facts.insert(key("cost basis"), money(basis));
            }
        }
    }
    for b in &household.social_security {
        let key = |field: &str| format!("Social Security {} · {field}", b.id);
        facts.insert(key("owner"), b.owner.clone());
        facts.insert(key("benefit at FRA"), money(b.benefit_at_fra));
        facts.insert(
            key("full retirement age"),
            b.full_retirement_age.to_string(),
        );
    }
    facts
}

/// The part of `member`'s facts that this migration drops, rendered for the
/// report. Empty when the two agree, which is the normal case: the user's
/// scenarios were all duplicated from one plan.
fn disagreements(kept: &Household, member: &V1, chosen: &V1) -> String {
    let skeleton = empty_household(
        kept.id.clone(),
        kept.name.clone(),
        member.plan.sim_config.start,
    );
    let (theirs, _) = decompose(&member.plan, &skeleton);

    let kept_facts = fact_lines(kept);
    let their_facts = fact_lines(&theirs);

    let mut lines = String::new();
    for (field, dropped) in &their_facts {
        let keeping = kept_facts.get(field);
        if keeping == Some(dropped) {
            continue;
        }
        let keeping = keeping.map_or("(not in the household)", |v| v.as_str());
        lines += &format!("    {field}: dropped {dropped}, kept {keeping}\n");
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "  Scenario \"{}\" ({}) — facts kept from \"{}\"\n{lines}",
        member.plan.name, member.plan.id, chosen.plan.name
    )
}

fn write_report(base: &Path, body: &str) -> Result<(), String> {
    let stamp = storage::iso_stamp_now();
    let path = storage::plans_dir(base).join(format!("migration-{stamp}.txt"));
    let text = format!(
        "Retirement Planner — household migration, {stamp}\n\
         \n\
         Your scenarios now share one set of balances: a balance is a fact\n\
         about the household, not something that varies between scenarios.\n\
         Where scenarios disagreed about a fact, one value was kept and the\n\
         others were dropped. They are listed below.\n\
         \n\
         Nothing was deleted. Your previous files are in plans/.v1/, exactly\n\
         as they were.\n\
         \n{body}"
    );
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// Moves a version-1 file into `plans/.v1/`, out of the way of the loader
/// but never deleted.
fn set_aside(base: &Path, path: &Path) -> Result<(), String> {
    let dir = storage::v1_dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let dest = dir.join(path.file_name().unwrap_or_default());
    fs::rename(path, &dest).map_err(|e| format!("setting aside {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use engine::model::YearMonth;

    use super::*;

    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "retirement-migrate-test-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `plan` as the version-1 JSON a pre-#13 install left behind.
    fn v1_json(plan: &Plan) -> String {
        let mut value = serde_json::to_value(plan).unwrap();
        value["schema_version"] = serde_json::Value::from(1u32);
        serde_json::to_string_pretty(&value).unwrap()
    }

    /// Writes `plan` as the version-1 document the app used to write: one
    /// self-contained plan per file, keyed by its id.
    fn write_v1(base: &Path, plan: &Plan) {
        let dir = storage::plans_dir(base);
        fs::create_dir_all(&dir).unwrap();
        let mut value = serde_yaml_ng::to_value(plan).unwrap();
        value["schema_version"] = serde_yaml_ng::Value::from(1u32);
        fs::write(
            dir.join(format!("{}.yaml", plan.id)),
            serde_yaml_ng::to_string(&value).unwrap(),
        )
        .unwrap();
    }

    fn v1_scenario(id: &str, name: &str) -> Plan {
        let mut plan = engine::presets::seed_plan();
        plan.id = id.to_string();
        plan.name = name.to_string();
        plan.sample = false;
        plan
    }

    #[test]
    fn migrate_json_dir_to_yaml_converts_and_preserves_originals() {
        let legacy_base = TempDir::new("legacy");
        let legacy_plans = legacy_base.0.join("plans");
        fs::create_dir_all(&legacy_plans).unwrap();

        let plan = engine::presets::seed_plan();
        let legacy_path = legacy_plans.join("base-plan.json");
        fs::write(&legacy_path, v1_json(&plan)).unwrap();

        let to_base = TempDir::new("new");
        let migrated = migrate_json_dir_to_yaml(&legacy_plans, &to_base.0).unwrap();
        assert_eq!(migrated, 1);

        // Lands at to_base/plans/<slug>.yaml, not doubly-nested, and the
        // household migration takes it from there.
        assert!(storage::plans_dir(&to_base.0)
            .join("base-plan.yaml")
            .exists());
        assert_eq!(migrate_v1_plans(&to_base.0, None).unwrap(), 1);
        let reloaded = storage::load_plan(&to_base.0, "base-plan").unwrap();
        assert_eq!(reloaded.name, plan.name);

        // Original untouched.
        assert!(legacy_path.exists());
    }

    #[test]
    fn migrate_json_dir_to_yaml_backfills_missing_id() {
        // Pre-#13 JSON plans predate the #6 `id` field entirely — simulate
        // one by stripping "id" from the serialized seed plan.
        let legacy_base = TempDir::new("legacy-no-id");
        let legacy_plans = legacy_base.0.join("plans");
        fs::create_dir_all(&legacy_plans).unwrap();

        let plan = engine::presets::seed_plan();
        let mut value: serde_json::Value = serde_json::from_str(&v1_json(&plan)).unwrap();
        value.as_object_mut().unwrap().remove("id");
        fs::write(
            legacy_plans.join("base-plan.json"),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let to_base = TempDir::new("new-no-id");
        assert_eq!(
            migrate_json_dir_to_yaml(&legacy_plans, &to_base.0).unwrap(),
            1
        );
        assert_eq!(migrate_v1_plans(&to_base.0, None).unwrap(), 1);

        let summaries = storage::list_plans(&to_base.0).unwrap();
        assert_eq!(summaries.len(), 1);
        assert!(!summaries[0].id.is_empty());
    }

    #[test]
    fn migrate_json_dir_to_yaml_missing_source_is_noop() {
        let to_base = TempDir::new("noop-target");
        let missing = TempDir::new("noop-source-parent").0.join("nonexistent");
        assert_eq!(migrate_json_dir_to_yaml(&missing, &to_base.0).unwrap(), 0);
        assert!(!to_base.0.join("plans").exists());
    }

    #[test]
    fn copy_yaml_dir_copies_and_preserves_source() {
        let from_base = TempDir::new("from");
        storage::create_plan(&from_base.0, engine::presets::seed_plan()).unwrap();

        let to_base = TempDir::new("to");
        let copied = copy_yaml_dir(&from_base.0, &to_base.0).unwrap();
        assert_eq!(copied, 1);

        assert!(storage::plans_dir(&to_base.0)
            .join("base-plan.yaml")
            .exists());
        assert!(storage::plans_dir(&from_base.0)
            .join("base-plan.yaml")
            .exists());
    }

    #[test]
    fn copy_yaml_dir_missing_source_is_noop() {
        let to_base = TempDir::new("copy-noop-target");
        let missing = TempDir::new("copy-noop-source-parent")
            .0
            .join("nonexistent");
        assert_eq!(copy_yaml_dir(&missing, &to_base.0).unwrap(), 0);
        assert!(!to_base.0.join("plans").exists());
    }

    #[test]
    fn v1_migration_is_a_noop_on_a_fresh_install_and_on_a_migrated_one() {
        let base = TempDir::new("v1-noop");
        assert_eq!(migrate_v1_plans(&base.0, None).unwrap(), 0);

        storage::create_plan(&base.0, engine::presets::seed_plan()).unwrap();
        assert_eq!(
            migrate_v1_plans(&base.0, None).unwrap(),
            0,
            "a version-2 household is not a version-1 plan"
        );
        assert_eq!(storage::list_plans(&base.0).unwrap().len(), 1);
    }

    /// The user's own case: scenarios all duplicated from one plan, so they
    /// describe the same people and become one household with one set of
    /// balances.
    #[test]
    fn scenarios_of_one_household_join_into_one_file() {
        let base = TempDir::new("v1-join");
        write_v1(&base.0, &v1_scenario("base-plan", "Base plan"));
        write_v1(
            &base.0,
            &v1_scenario("retire-early", "Retire two years early"),
        );
        write_v1(&base.0, &v1_scenario("claim-at-62", "Claim at 62"));

        assert_eq!(migrate_v1_plans(&base.0, Some("base-plan")).unwrap(), 1);

        let summaries = storage::list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 3, "every scenario survived");
        assert!(summaries.iter().all(|s| s.household_name == "My household"));
        // Scenario ids are the old plan ids, so `settings.json`'s
        // active_plan_id still names something.
        let mut ids: Vec<&str> = summaries.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["base-plan", "claim-at-62", "retire-early"]);

        // One file for the household, and the old ones set aside, not gone.
        assert_eq!(
            fs::read_dir(storage::plans_dir(&base.0))
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("yaml"))
                .count(),
            1
        );
        assert_eq!(fs::read_dir(storage::v1_dir(&base.0)).unwrap().count(), 3);
    }

    /// A loaded example household and two of the user's own plans are two
    /// households, not one — and the example keeps saying it is one.
    #[test]
    fn a_sample_plan_stays_a_household_of_its_own() {
        let base = TempDir::new("v1-sample");
        write_v1(&base.0, &v1_scenario("base-plan", "Base plan"));
        write_v1(&base.0, &v1_scenario("retire-early", "Retire early"));
        let mut sample = engine::presets::seed_plan();
        sample.id = "example-household".to_string();
        sample.name = "Example household".to_string();
        sample.sample = true;
        write_v1(&base.0, &sample);

        assert_eq!(migrate_v1_plans(&base.0, Some("base-plan")).unwrap(), 2);

        let summaries = storage::list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 3);
        let example = summaries
            .iter()
            .find(|s| s.id == "example-household")
            .expect("the example survived");
        assert_eq!(example.household_name, "Example household");
        assert!(example.sample);
        assert!(summaries
            .iter()
            .filter(|s| s.id != "example-household")
            .all(|s| s.household_name == "My household" && !s.sample));
    }

    /// Plans about different people are different households, however they
    /// were made.
    #[test]
    fn plans_describing_different_people_stay_apart() {
        let base = TempDir::new("v1-different-people");
        write_v1(&base.0, &v1_scenario("mine", "Mine"));
        let mut parents = v1_scenario("parents", "My parents");
        parents.people[0].id = "pat".to_string();
        parents.people[0].name = "Pat".to_string();
        parents.people[0].birth = YearMonth::new(1952, 3);
        parents.people.truncate(1);
        parents.accounts.retain(|a| a.owner == "pat");
        parents.streams.retain(|s| s.owner.is_none());
        parents.social_security.clear();
        write_v1(&base.0, &parents);

        assert_eq!(migrate_v1_plans(&base.0, None).unwrap(), 2);
        let summaries = storage::list_plans(&base.0).unwrap();
        let names: BTreeSet<&str> = summaries
            .iter()
            .map(|s| s.household_name.as_str())
            .collect();
        assert_eq!(
            names,
            BTreeSet::from(["My household", "My household 2"]),
            "two households, each named for the user to rename"
        );
    }

    /// Where copies had drifted, one value is kept and the rest are written
    /// down in a report rather than silently discarded.
    #[test]
    fn a_disagreement_between_copies_is_reported() {
        let base = TempDir::new("v1-report");
        let chosen = v1_scenario("base-plan", "Base plan");
        let mut stale = v1_scenario("retire-early", "Retire two years early");
        stale.accounts[0].balance = 99_000.0;
        write_v1(&base.0, &chosen);
        write_v1(&base.0, &stale);

        migrate_v1_plans(&base.0, Some("base-plan")).unwrap();

        // The active plan's balance is the one that survived, everywhere.
        for summary in storage::list_plans(&base.0).unwrap() {
            let plan = storage::load_plan(&base.0, &summary.id).unwrap();
            assert_eq!(plan.accounts[0].balance, chosen.accounts[0].balance);
        }

        let report = fs::read_dir(storage::plans_dir(&base.0))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("migration-"))
            })
            .expect("a report was written");
        let text = fs::read_to_string(report).unwrap();
        assert!(text.contains("Retire two years early"), "{text}");
        assert!(text.contains("dropped 99000.00"), "{text}");
        assert!(
            text.contains(&format!("kept {:.2}", chosen.accounts[0].balance)),
            "{text}"
        );
    }

    /// Nothing to report when the copies agreed, which is the normal case.
    #[test]
    fn no_report_when_every_copy_agreed() {
        let base = TempDir::new("v1-no-report");
        write_v1(&base.0, &v1_scenario("base-plan", "Base plan"));
        write_v1(&base.0, &v1_scenario("retire-early", "Retire early"));

        migrate_v1_plans(&base.0, Some("base-plan")).unwrap();

        assert!(!fs::read_dir(storage::plans_dir(&base.0))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("migration-")));
    }

    /// With no active scenario recorded, the most recently written file is
    /// the one whose balances the household keeps.
    #[test]
    fn without_an_active_scenario_the_newest_file_supplies_the_facts() {
        let base = TempDir::new("v1-newest");
        let mut older = v1_scenario("older", "Older");
        older.accounts[0].balance = 1_000.0;
        write_v1(&base.0, &older);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut newer = v1_scenario("newer", "Newer");
        newer.accounts[0].balance = 2_000.0;
        write_v1(&base.0, &newer);

        migrate_v1_plans(&base.0, None).unwrap();

        assert_eq!(
            storage::load_plan(&base.0, "older").unwrap().accounts[0].balance,
            2_000.0
        );
    }

    /// A scenario that had an account the chosen plan does not gets its
    /// stray policy pruned, so every scenario composes.
    #[test]
    fn a_scenario_with_an_extra_account_still_composes() {
        let base = TempDir::new("v1-extra-account");
        write_v1(&base.0, &v1_scenario("base-plan", "Base plan"));
        let mut extra = v1_scenario("with-extra", "With an extra account");
        let mut account = extra.accounts[0].clone();
        account.id = "mystery-account".to_string();
        account.name = "Mystery".to_string();
        extra.accounts.push(account);
        write_v1(&base.0, &extra);

        migrate_v1_plans(&base.0, Some("base-plan")).unwrap();

        let plan = storage::load_plan(&base.0, "with-extra").unwrap();
        assert!(plan.accounts.iter().all(|a| a.id != "mystery-account"));
        assert_eq!(
            plan.accounts.len(),
            storage::load_plan(&base.0, "base-plan")
                .unwrap()
                .accounts
                .len()
        );
    }
}
