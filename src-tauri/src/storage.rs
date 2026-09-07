//! YAML persistence for households and the scenarios branched from them,
//! chosen over JSON so a file is readable and hand-editable outside the app.
//! PRIVACY: everything here writes only to the local plans directory;
//! nothing leaves the machine.
//!
//! One file per **household** (#109), not per scenario: `plans/<household
//! id>.yaml` holds the household's facts — people, accounts, balances as
//! dated observations, the month they are as of — plus every scenario, each
//! carrying only the policy that varies. The rest of the app still speaks
//! `Plan`: every function here composes one on the way out and decomposes
//! it on the way in, so a balance is written down once however many
//! scenarios a household keeps.
//!
//! Functions take an explicit base directory so they are unit-testable
//! without a Tauri runtime; commands.rs resolves the real, user-configurable
//! base path (see settings.rs).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use engine::model::{
    compose, decompose, empty_household, Household, HouseholdFile, HouseholdId, Plan, PlanId,
    Scenario, YearMonth, SCHEMA_VERSION,
};

/// One file per household — every scenario the household keeps lives inside
/// it, keyed by the household's stable `id` (not its editable `name`) so
/// renaming never moves the file.
pub fn plans_dir(base: &Path) -> PathBuf {
    base.join("plans")
}

fn household_path(base: &Path, id: &str) -> PathBuf {
    plans_dir(base).join(format!("{id}.yaml"))
}

/// Per-household bounded snapshot history:
/// `plans/.history/<household id>/<timestamp>.yaml`. A snapshot is the whole
/// file, so a restore brings back the balances and every scenario together.
fn history_dir(base: &Path, household_id: &str) -> PathBuf {
    plans_dir(base).join(".history").join(household_id)
}

/// Where deleted households and legacy `.yaml.deleted` files are relocated
/// to, instead of lingering in the plans directory forever.
fn trash_dir(base: &Path) -> PathBuf {
    plans_dir(base).join(".trash")
}

/// Where version-1 (one-plan-per-file) documents are set aside by the
/// household migration. Never deleted — see `migrate::migrate_v1_plans`.
pub fn v1_dir(base: &Path) -> PathBuf {
    plans_dir(base).join(".v1")
}

const MAX_SNAPSHOTS_PER_HOUSEHOLD: usize = 20;

/// Filesystem-safe, lexically sortable UTC timestamp, e.g.
/// `2026-09-01T14-23-45-123Z`. Millisecond resolution keeps rapid, automatic
/// calls (a pre-restore snapshot immediately followed by another) from
/// colliding on the same filename.
pub(crate) fn iso_stamp_now() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}Z",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// Filesystem-safe slug from a name ("Base plan" → "base-plan"). Used
/// for household file names and for person ids.
pub(crate) fn slugify(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "plan".to_string()
    } else {
        slug
    }
}

/// Every id already spoken for: household ids (which are file names) and
/// scenario ids (which `settings.json` records as the active plan, and
/// which the frontend passes back). One namespace, because a scenario id
/// has to identify a scenario across every household on disk.
pub(crate) fn taken_ids(base: &Path) -> BTreeSet<String> {
    let mut taken = BTreeSet::new();
    for path in household_file_paths(base).unwrap_or_default() {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            taken.insert(stem.to_string());
        }
        if let Ok(file) = load_household_file(&path) {
            taken.insert(file.id);
            taken.extend(file.scenarios.into_iter().map(|s| s.id));
        }
    }
    taken
}

/// A fresh id derived from a name: the plain slug if nothing has claimed it,
/// else the slug disambiguated with a timestamp. Keeping the slug as the
/// common case is deliberate — household files are meant to stay
/// human-readable and hand-editable outside the app.
pub fn generate_id(base: &Path, name: &str) -> String {
    fresh_id(&taken_ids(base), name)
}

/// `generate_id` against an explicit set, for callers minting several ids
/// before any of them is on disk (the household migration mints one per
/// group). The `-2` tail is a belt-and-braces third step: two calls in the
/// same nanosecond would otherwise agree.
pub(crate) fn fresh_id(taken: &BTreeSet<String>, name: &str) -> String {
    let slug = slugify(name);
    if !taken.contains(&slug) {
        return slug;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stamped = format!("{slug}-{nanos}");
    if !taken.contains(&stamped) {
        return stamped;
    }
    (2..)
        .map(|n| format!("{stamped}-{n}"))
        .find(|id| !taken.contains(id))
        .expect("an unused id")
}

/// Atomic write: a temp file, the previous version kept as `.bak`, then a
/// rename into place so a crash never leaves a torn file.
pub fn save_household_file(base: &Path, file: &HouseholdFile) -> Result<(), String> {
    if file.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "household schema version {} does not match supported version {}",
            file.schema_version, SCHEMA_VERSION
        ));
    }
    if file.id.trim().is_empty() {
        return Err("household is missing an id".to_string());
    }
    let dir = plans_dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let path = household_path(base, &file.id);
    let yaml = serde_yaml_ng::to_string(file).map_err(|e| format!("serializing household: {e}"))?;

    let tmp = path.with_extension("yaml.tmp");
    fs::write(&tmp, &yaml).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    if path.exists() {
        let bak = path.with_extension("yaml.bak");
        fs::copy(&path, &bak).map_err(|e| format!("backing up {}: {e}", path.display()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("replacing {}: {e}", path.display()))?;
    Ok(())
}

pub fn load_household_file(path: &Path) -> Result<HouseholdFile, String> {
    let yaml = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let file: HouseholdFile =
        serde_yaml_ng::from_str(&yaml).map_err(|e| format!("parsing {}: {e}", path.display()))?;
    if file.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "{} has schema version {}, this app supports {} — migration needed",
            path.display(),
            file.schema_version,
            SCHEMA_VERSION
        ));
    }
    Ok(file)
}

fn household_file_paths(base: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = plans_dir(base);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .collect();
    paths.sort();
    Ok(paths)
}

/// Every household on disk, in file order. Files that fail to parse are
/// skipped rather than failing the whole read — the same silent-skip policy
/// `list_plans` has always had.
fn households(base: &Path) -> Result<Vec<(PathBuf, HouseholdFile)>, String> {
    Ok(household_file_paths(base)?
        .into_iter()
        .filter_map(|path| load_household_file(&path).ok().map(|file| (path, file)))
        .collect())
}

/// The household holding scenario `id`.
fn household_of(base: &Path, id: &str) -> Result<HouseholdFile, String> {
    households(base)?
        .into_iter()
        .map(|(_, file)| file)
        .find(|file| file.scenario(id).is_some())
        .ok_or_else(|| format!("no scenario {id:?} in any household"))
}

fn compose_scenario(file: &HouseholdFile, id: &str) -> Result<Plan, String> {
    let scenario = file
        .scenario(id)
        .ok_or_else(|| format!("household {:?} has no scenario {id:?}", file.id))?;
    compose(&file.household(), scenario).map_err(|e| e.to_string())
}

/// Identity of one stored scenario, plus the household it belongs to.
pub struct PlanSummary {
    pub id: PlanId,
    pub name: String,
    pub household_id: HouseholdId,
    pub household_name: String,
    /// The household's `sample` flag, so the switcher can label an example
    /// household's scenarios without loading each one.
    pub sample: bool,
}

/// Every scenario of every household, households in file order and
/// scenarios alphabetical by name within each.
pub fn list_plans(base: &Path) -> Result<Vec<PlanSummary>, String> {
    let mut summaries = Vec::new();
    for (_, file) in households(base)? {
        let mut group: Vec<PlanSummary> = file
            .scenarios
            .iter()
            .map(|s| PlanSummary {
                id: s.id.clone(),
                name: s.name.clone(),
                household_id: file.id.clone(),
                household_name: file.name.clone(),
                sample: file.sample,
            })
            .collect();
        group.sort_by(|a, b| a.name.cmp(&b.name));
        summaries.append(&mut group);
    }
    Ok(summaries)
}

/// The household holding scenario `id` — the facts half, for the UI that
/// says how old the balances are (#110).
pub fn load_household(base: &Path, scenario_id: &str) -> Result<Household, String> {
    Ok(household_of(base, scenario_id)?.household())
}

/// Loads one scenario as a `Plan`: its household's facts composed with its
/// own policy.
pub fn load_plan(base: &Path, id: &str) -> Result<Plan, String> {
    let file = household_of(base, id)?;
    compose_scenario(&file, id)
}

/// The first stored scenario, or `None` when there are none.
///
/// `None` is a normal state, not a failure: it is what a fresh install looks
/// like, and what the plans directory looks like again once the user deletes
/// their last scenario. The frontend answers it with the welcome screen.
///
/// This used to bootstrap and persist [`engine::presets::seed_plan`] instead
/// of returning `None`, which meant a new user's first screen was a complete
/// projection for an invented household presented as their own (#103). An
/// example household is now something the user asks for by name — see
/// [`create_sample_plan`].
pub fn load_first(base: &Path) -> Result<Option<Plan>, String> {
    for (_, file) in households(base)? {
        if let Some(scenario) = file.scenarios.first() {
            return compose_scenario(&file, &scenario.id).map(Some);
        }
    }
    Ok(None)
}

/// Writes an edited plan back into its household.
///
/// The facts go to the household — one copy, shared by every scenario — and
/// the policy to this scenario. Siblings are then filled in: any scenario
/// with no policy for an entity this save has receives a copy of this
/// scenario's, and any policy for an entity this save does *not* have is
/// pruned. So an account opened "at the federal maximum" in one scenario is
/// at the federal maximum everywhere until someone edits it, an account
/// deleted here is gone everywhere, and `compose` stays total without ever
/// inventing a retirement date.
pub fn save_plan(base: &Path, plan: &Plan) -> Result<(), String> {
    if plan.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "plan schema version {} does not match supported version {}",
            plan.schema_version, SCHEMA_VERSION
        ));
    }
    if plan.id.trim().is_empty() {
        return Err("plan is missing an id".to_string());
    }
    let mut file = household_of(base, &plan.id)?;
    let (household, scenario) = decompose(plan, &file.household());

    for sibling in &mut file.scenarios {
        if sibling.id == scenario.id {
            continue;
        }
        fill_in(sibling, &scenario);
    }
    let slot = file
        .scenarios
        .iter_mut()
        .find(|s| s.id == scenario.id)
        .expect("household_of found this scenario");
    *slot = scenario;

    save_household_file(base, &HouseholdFile::new(household, file.scenarios))
}

/// Brings `sibling` into line with the household `saved` just described:
/// entities it has no opinion about are copied from `saved`, and entities
/// that no longer exist are dropped.
pub(crate) fn fill_in(sibling: &mut Scenario, saved: &Scenario) {
    sibling.people.retain(|id, _| saved.people.contains_key(id));
    sibling
        .accounts
        .retain(|id, _| saved.accounts.contains_key(id));
    sibling
        .social_security
        .retain(|id, _| saved.social_security.contains_key(id));

    for (id, policy) in &saved.people {
        sibling.people.entry(id.clone()).or_insert(policy.clone());
    }
    for (id, policy) in &saved.accounts {
        sibling.accounts.entry(id.clone()).or_insert(policy.clone());
    }
    for (id, policy) in &saved.social_security {
        sibling
            .social_security
            .entry(id.clone())
            .or_insert(policy.clone());
    }
}

/// Builds a brand-new plan for `people` — no accounts, no income, no
/// spending. `start` is the plan's first simulated month, which the caller
/// resolves from the clock.
///
/// Returned unsaved, so the caller validates before anything is written:
/// `people` comes from the frontend, and a plan the engine would reject must
/// not reach the plans directory.
pub fn new_plan(
    name: &str,
    start: engine::model::YearMonth,
    people: Vec<engine::model::Person>,
) -> Plan {
    engine::presets::new_plan(name, start, people)
}

/// Writes a validated plan as a new household with this one scenario in it.
///
/// The household takes the plan's own name, and its own id: a household
/// created from scratch has exactly one scenario, so there is one name
/// anyone has supplied and no reason for the file to be called something
/// else. Both are editable later (#111), and every scenario branched from
/// here gets its own id.
pub fn create_plan(base: &Path, plan: Plan) -> Result<Plan, String> {
    store_new_household(base, plan)
}

/// Writes a copy of the invented example household
/// ([`engine::presets::seed_plan`]), for a user who asked to load an example
/// to look around.
///
/// The stored household keeps `sample: true`, so the UI labels it as an
/// example for as long as it exists and it is never mistaken for the user's
/// own numbers. No validation step: this plan is a compile-time constant of
/// the engine's, and `seed_plan_is_valid` already pins it.
///
/// `as_of` is the month the (invented) balances are dated, resolved from the
/// clock by the caller. `seed_plan` hard-codes January 2026 because the
/// golden file pins it; shipping that date would give anyone loading the
/// example in a later year a household whose balances are already in the
/// past (#106).
pub fn create_sample_plan(base: &Path, as_of: YearMonth) -> Result<Plan, String> {
    let mut plan = engine::presets::seed_plan();
    plan.sim_config.start = as_of;
    // Renamed on the way out rather than in `seed_plan` itself, which is the
    // engine's test fixture and whose name the golden tests pin. The name
    // matters because it is what the scenario switcher and an exported
    // report show, where the `sample` badge does not reach.
    plan.name = SAMPLE_PLAN_NAME.to_string();
    plan.sample = true;
    store_new_household(base, plan)
}

/// What a loaded example household — and its first scenario — are called on
/// disk and in the switcher.
pub const SAMPLE_PLAN_NAME: &str = "Example household";

/// Wraps `plan` in a new household under a fresh id and writes it. The
/// household and its one scenario share that id: nothing has branched yet,
/// and a file named after something other than the household it holds would
/// only be harder to find by hand.
///
/// Validation is the caller's job and must happen *before* this: once it
/// returns, the household is on disk.
fn store_new_household(base: &Path, mut plan: Plan) -> Result<Plan, String> {
    let id = generate_id(base, &plan.name);
    plan.id = id.clone();
    plan.schema_version = SCHEMA_VERSION;

    let skeleton = empty_household(id, plan.name.clone(), plan.sim_config.start);
    let (household, scenario) = decompose(&plan, &skeleton);
    save_household_file(base, &HouseholdFile::new(household, vec![scenario]))?;
    Ok(plan)
}

/// Branches a scenario: the same household facts, a copy of this scenario's
/// policy, a new name and a fresh id. No balances are copied, because there
/// were never two copies of them to begin with.
pub fn duplicate_plan(base: &Path, id: &str, new_name: &str) -> Result<Plan, String> {
    let mut file = household_of(base, id)?;
    let mut copy = file
        .scenario(id)
        .ok_or_else(|| format!("no scenario {id:?}"))?
        .clone();
    copy.id = generate_id(base, new_name);
    copy.name = new_name.to_string();
    let plan = compose(&file.household(), &copy).map_err(|e| e.to_string())?;
    file.scenarios.push(copy);
    save_household_file(base, &file)?;
    Ok(plan)
}

/// Removes a scenario. When it was the household's last, the whole file
/// moves into `.trash` rather than being unlinked — the same
/// never-actually-delete posture as the storage-relocation migration in
/// `migrate.rs`, but landing outside the plans directory so deleted
/// households don't linger among the live ones.
pub fn delete_plan(base: &Path, id: &str) -> Result<(), String> {
    let Ok(mut file) = household_of(base, id) else {
        return Ok(());
    };
    file.scenarios.retain(|s| s.id != id);
    if !file.scenarios.is_empty() {
        return save_household_file(base, &file);
    }

    let path = household_path(base, &file.id);
    let dir = trash_dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let dest = dir.join(format!("{}-{}.yaml", file.id, iso_stamp_now()));
    fs::rename(&path, &dest).map_err(|e| format!("removing {}: {e}", path.display()))
}

/// Copies a household's current on-disk file into its bounded snapshot
/// history, timestamped to now, then prunes down to
/// `MAX_SNAPSHOTS_PER_HOUSEHOLD`, oldest first. Takes a *scenario* id,
/// because that is what the caller has; a no-op if that scenario has no
/// household on disk.
pub fn snapshot_plan(base: &Path, scenario_id: &str) -> Result<(), String> {
    let Ok(file) = household_of(base, scenario_id) else {
        return Ok(());
    };
    let path = household_path(base, &file.id);
    if !path.exists() {
        return Ok(());
    }
    let dir = history_dir(base, &file.id);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let dest = dir.join(format!("{}.yaml", iso_stamp_now()));
    fs::copy(&path, &dest).map_err(|e| format!("snapshotting {}: {e}", path.display()))?;
    prune_history(&dir)
}

fn prune_history(dir: &Path) -> Result<(), String> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .collect();
    entries.sort();
    while entries.len() > MAX_SNAPSHOTS_PER_HOUSEHOLD {
        let oldest = entries.remove(0);
        fs::remove_file(&oldest).map_err(|e| format!("pruning {}: {e}", oldest.display()))?;
    }
    Ok(())
}

/// The snapshot timestamps of the household holding `scenario_id`, newest
/// first — the stem of each `<timestamp>.yaml` file in its history folder.
pub fn list_snapshots(base: &Path, scenario_id: &str) -> Result<Vec<String>, String> {
    let Ok(file) = household_of(base, scenario_id) else {
        return Ok(Vec::new());
    };
    let dir = history_dir(base, &file.id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut stamps: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("yaml"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    stamps.sort_by(|a, b| b.cmp(a));
    Ok(stamps)
}

/// Restores a **household** to how it looked at `timestamp` — its balances
/// and every one of its scenarios together, since that is what one file
/// holds. Snapshots the current state first, into the same bounded history,
/// so restoring is itself undoable.
///
/// Returns the scenario the caller was on, or the restored household's first
/// if that scenario did not exist yet at `timestamp`.
pub fn restore_snapshot(base: &Path, scenario_id: &str, timestamp: &str) -> Result<Plan, String> {
    let current = household_of(base, scenario_id)?;
    let snapshot_path = history_dir(base, &current.id).join(format!("{timestamp}.yaml"));
    let restored = load_household_file(&snapshot_path)?;
    snapshot_plan(base, scenario_id)?;
    save_household_file(base, &restored)?;

    let id = match restored.scenario(scenario_id) {
        Some(_) => scenario_id.to_string(),
        None => restored
            .scenarios
            .first()
            .map(|s| s.id.clone())
            .ok_or_else(|| "snapshot holds no scenarios".to_string())?,
    };
    compose_scenario(&restored, &id)
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("creating {}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("reading {}: {e}", from.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let dest = to.join(path.file_name().unwrap_or_default());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            fs::copy(&path, &dest).map_err(|e| format!("copying {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Writes a timestamped copy of the whole plans directory (snapshot history
/// and trash included) into `dest_parent`. This is the off-machine backup
/// story: point it at an external drive or a sync folder, by explicit user
/// action — the app never syncs anything on its own. Returns the created
/// folder's path.
pub fn export_plans(base: &Path, dest_parent: &Path) -> Result<PathBuf, String> {
    let source = plans_dir(base);
    let dest = dest_parent.join(format!("Retirement Planner Backup {}", iso_stamp_now()));
    copy_dir_recursive(&source, &dest)?;
    Ok(dest)
}

/// One-shot-per-launch tidy of the plans directory: relocates any leftover
/// `<id>.yaml.deleted` files (from the pre-#19 `delete_plan`) into `.trash`,
/// and purges `.bak` files whose `.yaml` no longer exists. Safe to call on
/// every startup — a no-op once the directory is already tidy.
pub fn cleanup(base: &Path) -> Result<(), String> {
    let dir = plans_dir(base);
    if !dir.exists() {
        return Ok(());
    }
    let entries: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();

    for path in &entries {
        if path.extension().and_then(|e| e.to_str()) != Some("deleted") {
            continue;
        }
        let dir = trash_dir(base);
        fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        // "<id>.yaml.deleted" -> file_stem "<id>.yaml" -> strip ".yaml" -> id.
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("plan.yaml");
        let id = stem.strip_suffix(".yaml").unwrap_or(stem);
        let dest = dir.join(format!("{id}-{}.yaml", iso_stamp_now()));
        fs::rename(path, &dest).map_err(|e| format!("moving {}: {e}", path.display()))?;
    }

    for path in &entries {
        if path.extension().and_then(|e| e.to_str()) != Some("bak") {
            continue;
        }
        let yaml = path.with_extension("");
        if !yaml.exists() {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use engine::model::{ContributionRule, YearMonth};

    use super::*;

    struct TempBase(PathBuf);

    impl TempBase {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "retirement-storage-test-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempBase(dir)
        }
    }

    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Puts the example household on disk and returns the plan for its one
    /// scenario — what `load_or_bootstrap` used to do implicitly, before a
    /// fresh install stopped inventing one (#103). Tests below use it only
    /// to have *a* household to act on.
    fn seed(base: &Path) -> Plan {
        create_plan(base, engine::presets::seed_plan()).unwrap()
    }

    fn account<'a>(plan: &'a Plan, id: &str) -> &'a engine::model::Account {
        plan.accounts
            .iter()
            .find(|a| a.id == id)
            .expect("the seed plan has this account")
    }

    #[test]
    fn a_fresh_install_has_no_plan() {
        let base = TempBase::new("fresh");
        assert!(
            load_first(&base.0).unwrap().is_none(),
            "a fresh install must not invent a household (#103)"
        );
        assert!(list_plans(&base.0).unwrap().is_empty());
        // And reading it did not create one as a side effect.
        assert!(!plans_dir(&base.0).exists());
    }

    #[test]
    fn load_first_roundtrips_a_stored_plan() {
        let base = TempBase::new("roundtrip");
        let plan = seed(&base.0);
        let loaded = load_first(&base.0).unwrap().expect("a plan is stored");
        assert_eq!(loaded.name, "Base plan");
        assert_eq!(loaded.id, "base-plan");
        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "base-plan");
        assert_eq!(summaries[0].name, "Base plan");
        assert_eq!(summaries[0].household_id, "base-plan");
        assert_eq!(summaries[0].household_name, "Base plan");

        let mut edited = plan.clone();
        edited.assumptions.inflation = 0.03;
        save_plan(&base.0, &edited).unwrap();

        let reloaded = load_first(&base.0).unwrap().expect("a plan is stored");
        assert_eq!(reloaded.assumptions.inflation, 0.03);
        // Previous version preserved as .bak.
        assert!(plans_dir(&base.0).join("base-plan.yaml.bak").exists());
    }

    /// The point of the whole split: seven accounts and four scenarios are
    /// seven balances, not twenty-eight, and correcting one corrects it
    /// everywhere.
    #[test]
    fn a_balance_is_written_once_and_shared_by_every_scenario() {
        let base = TempBase::new("shared-balances");
        let plan = seed(&base.0);
        duplicate_plan(&base.0, &plan.id, "Retire early").unwrap();
        duplicate_plan(&base.0, &plan.id, "Claim at 62").unwrap();
        assert_eq!(
            household_file_paths(&base.0).unwrap().len(),
            1,
            "three scenarios of one household are one file"
        );

        let mut edited = plan.clone();
        edited
            .accounts
            .iter_mut()
            .find(|a| a.id == "alex-401k")
            .unwrap()
            .balance = 411_000.0;
        save_plan(&base.0, &edited).unwrap();

        for summary in list_plans(&base.0).unwrap() {
            let sibling = load_plan(&base.0, &summary.id).unwrap();
            assert_eq!(
                account(&sibling, "alex-401k").balance,
                411_000.0,
                "scenario {:?} still carries a stale copy",
                summary.id
            );
        }
    }

    /// Policy is the half that does vary: editing a retirement date in one
    /// scenario must not reach the others.
    #[test]
    fn policy_stays_in_the_scenario_that_changed_it() {
        let base = TempBase::new("policy-isolated");
        let plan = seed(&base.0);
        let branch = duplicate_plan(&base.0, &plan.id, "Retire early").unwrap();

        let mut edited = branch.clone();
        edited.people[0].retirement = YearMonth::new(2035, 4);
        save_plan(&base.0, &edited).unwrap();

        assert_eq!(
            load_plan(&base.0, &branch.id).unwrap().people[0].retirement,
            YearMonth::new(2035, 4)
        );
        assert_eq!(
            load_plan(&base.0, &plan.id).unwrap().people[0].retirement,
            plan.people[0].retirement,
            "the base scenario kept its own retirement date"
        );
    }

    /// A new account opened in one scenario is a household fact, so it
    /// appears in the siblings — and, having no policy of its own there
    /// yet, at the policy it was opened with rather than at some default
    /// nobody chose.
    #[test]
    fn a_new_account_fills_in_across_siblings_with_the_policy_it_was_opened_at() {
        let base = TempBase::new("fill-in");
        let plan = seed(&base.0);
        let sibling = duplicate_plan(&base.0, &plan.id, "Retire early").unwrap();

        let mut edited = plan.clone();
        let mut opened = account(&plan, "jordan-roth").clone();
        opened.id = "alex-roth-ira".to_string();
        opened.name = "Alex Roth IRA".to_string();
        opened.balance = 4_000.0;
        opened.contributions[0].rule = ContributionRule::FederalMaximum;
        edited.accounts.push(opened);
        save_plan(&base.0, &edited).unwrap();

        let reloaded = load_plan(&base.0, &sibling.id).unwrap();
        let filled = account(&reloaded, "alex-roth-ira");
        assert_eq!(filled.balance, 4_000.0);
        assert_eq!(
            filled.contributions[0].rule,
            ContributionRule::FederalMaximum
        );
    }

    /// The other half of fill-in: an account deleted in one scenario is
    /// pruned from every sibling's policy, so `compose` never has to skip
    /// an entity it has no facts for.
    #[test]
    fn a_deleted_account_is_pruned_from_every_sibling() {
        let base = TempBase::new("prune");
        let plan = seed(&base.0);
        let sibling = duplicate_plan(&base.0, &plan.id, "Retire early").unwrap();

        let mut edited = plan.clone();
        edited.accounts.retain(|a| a.id != "jordan-roth");
        save_plan(&base.0, &edited).unwrap();

        let reloaded = load_plan(&base.0, &sibling.id).unwrap();
        assert!(reloaded.accounts.iter().all(|a| a.id != "jordan-roth"));

        let file = household_of(&base.0, &sibling.id).unwrap();
        for scenario in &file.scenarios {
            assert!(
                !scenario.accounts.contains_key("jordan-roth"),
                "scenario {:?} kept policy for an account that no longer exists",
                scenario.id
            );
        }
    }

    /// The as-of month is one date for the household, so a scenario cannot
    /// hold its own.
    #[test]
    fn every_scenario_starts_on_the_households_as_of_month() {
        let base = TempBase::new("as-of");
        let plan = seed(&base.0);
        let sibling = duplicate_plan(&base.0, &plan.id, "Retire early").unwrap();

        let mut edited = plan.clone();
        edited.sim_config.start = YearMonth::new(2027, 9);
        save_plan(&base.0, &edited).unwrap();

        assert_eq!(
            load_plan(&base.0, &sibling.id).unwrap().sim_config.start,
            YearMonth::new(2027, 9)
        );
        assert_eq!(
            load_household(&base.0, &sibling.id).unwrap().as_of,
            YearMonth::new(2027, 9)
        );
    }

    #[test]
    fn balances_are_stored_as_dated_observations() {
        let base = TempBase::new("observations");
        let plan = seed(&base.0);
        let household = load_household(&base.0, &plan.id).unwrap();
        let stored = household
            .accounts
            .iter()
            .find(|a| a.id == "alex-401k")
            .unwrap();
        assert_eq!(stored.observations.len(), 1);
        assert_eq!(stored.current().unwrap().as_of, plan.sim_config.start);
        assert_eq!(
            stored.current().unwrap().balance,
            account(&plan, "alex-401k").balance
        );
    }

    #[test]
    fn deleting_the_last_plan_returns_to_having_none() {
        let base = TempBase::new("delete-last");
        seed(&base.0);
        delete_plan(&base.0, "base-plan").unwrap();
        assert!(
            load_first(&base.0).unwrap().is_none(),
            "deleting the last plan leaves none, rather than resurrecting one"
        );
    }

    #[test]
    fn create_plan_writes_a_household_and_nothing_else() {
        let base = TempBase::new("create");
        let people = vec![engine::model::Person {
            id: "sam".to_string(),
            name: "Sam".to_string(),
            birth: YearMonth::new(1990, 4),
            retirement: YearMonth::new(2055, 4),
            life_expectancy_age: 95,
        }];
        let plan = create_plan(
            &base.0,
            new_plan("My plan", YearMonth::new(2026, 1), people),
        )
        .unwrap();

        assert_eq!(plan.id, "my-plan");
        assert!(!plan.sample, "the user's own plan is not an example");
        assert_eq!(plan.people.len(), 1);
        assert!(plan.accounts.is_empty(), "no invented accounts");
        assert!(plan.streams.is_empty(), "no invented income or spending");
        assert!(plan.social_security.is_empty());
        assert!(plan.validate().is_empty(), "and it is savable as-is");

        // Persisted, not just returned.
        assert_eq!(load_plan(&base.0, "my-plan").unwrap().name, "My plan");
        let household = load_household(&base.0, "my-plan").unwrap();
        assert_eq!(household.name, "My plan");
        assert!(!household.sample);
        assert_eq!(household.as_of, YearMonth::new(2026, 1));
    }

    #[test]
    fn new_plan_writes_nothing_so_it_can_be_validated_first() {
        let base = TempBase::new("new-unsaved");
        // A person the engine rejects: retirement before birth. The command
        // layer validates between `new_plan` and `create_plan`, so this must
        // never reach the plans directory — a plan that fails validation
        // would fail to load on every launch after it.
        let people = vec![engine::model::Person {
            id: "sam".to_string(),
            name: "Sam".to_string(),
            birth: YearMonth::new(1990, 4),
            retirement: YearMonth::new(1980, 4),
            life_expectancy_age: 95,
        }];
        let plan = new_plan("Backwards", YearMonth::new(2026, 1), people);

        assert!(
            !plan.validate().is_empty(),
            "the caller has something to reject"
        );
        assert!(list_plans(&base.0).unwrap().is_empty());
        assert!(
            !plans_dir(&base.0).exists(),
            "building a plan touched no files"
        );
    }

    #[test]
    fn create_sample_plan_names_itself_an_example_and_says_so_in_the_file() {
        let base = TempBase::new("sample");
        let as_of = YearMonth::new(2031, 9);
        let plan = create_sample_plan(&base.0, as_of).unwrap();
        assert_eq!(plan.name, SAMPLE_PLAN_NAME);
        assert!(plan.sample);
        // The example is dated from the day it was loaded, not from
        // whichever January `seed_plan` was written against (#106).
        assert_eq!(plan.sim_config.start, as_of);
        // The flag survives the round trip, so the badge outlives this session.
        let reloaded = load_plan(&base.0, &plan.id).unwrap();
        assert!(reloaded.sample);
        assert_eq!(reloaded.name, SAMPLE_PLAN_NAME);
        // It is a fact about the household, and the switcher reads it from
        // the summary rather than loading every scenario.
        assert!(list_plans(&base.0).unwrap()[0].sample);
    }

    /// Two examples loaded in a row are two households, not one file
    /// overwriting the other.
    #[test]
    fn loading_the_example_twice_makes_two_households() {
        let base = TempBase::new("sample-twice");
        let first = create_sample_plan(&base.0, YearMonth::new(2026, 1)).unwrap();
        let second = create_sample_plan(&base.0, YearMonth::new(2026, 1)).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(household_file_paths(&base.0).unwrap().len(), 2);
        assert_eq!(list_plans(&base.0).unwrap().len(), 2);
    }

    #[test]
    fn a_scenario_branched_off_the_example_is_still_the_example() {
        let base = TempBase::new("sample-duplicate");
        let sample = create_sample_plan(&base.0, YearMonth::new(2026, 1)).unwrap();
        let copy = duplicate_plan(&base.0, &sample.id, "What if we move").unwrap();
        assert!(
            copy.sample,
            "a copy of invented balances is still invented balances"
        );
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let base = TempBase::new("schema");
        let mut plan = seed(&base.0);
        plan.schema_version = 999;
        assert!(save_plan(&base.0, &plan).is_err());

        let path = household_path(&base.0, "base-plan");
        let mangled = fs::read_to_string(&path)
            .unwrap()
            .replace("schema_version: 2", "schema_version: 999");
        fs::write(&path, mangled).unwrap();
        assert!(load_household_file(&path).is_err());
    }

    #[test]
    fn rejects_plan_without_id() {
        let base = TempBase::new("no-id");
        let mut plan = seed(&base.0);
        plan.id = String::new();
        assert!(save_plan(&base.0, &plan).is_err());
    }

    /// Saving a plan whose scenario is not in any household is an error
    /// rather than a silently created file: the id came from somewhere, and
    /// writing a second copy of the household under it is how balances
    /// diverged in the first place.
    #[test]
    fn rejects_a_plan_belonging_to_no_household() {
        let base = TempBase::new("orphan");
        let mut plan = seed(&base.0);
        plan.id = "not-a-scenario".to_string();
        assert!(save_plan(&base.0, &plan).is_err());
    }

    #[test]
    fn slugify_sanitizes_names() {
        assert_eq!(slugify("Base plan"), "base-plan");
        assert_eq!(slugify("  Retire Early!! (v2)  "), "retire-early-v2");
        assert_eq!(slugify("///"), "plan");
    }

    #[test]
    fn duplicate_plan_gets_new_id_and_name_inside_the_same_household() {
        let base = TempBase::new("duplicate");
        seed(&base.0);

        let copy = duplicate_plan(&base.0, "base-plan", "Sell the home").unwrap();
        assert_eq!(copy.name, "Sell the home");
        assert_eq!(copy.id, "sell-the-home");
        assert_ne!(copy.id, "base-plan");

        // Original scenario is untouched.
        let original = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(original.name, "Base plan");

        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 2);
        assert!(summaries.iter().all(|s| s.household_id == "base-plan"));
        assert_eq!(
            household_file_paths(&base.0).unwrap().len(),
            1,
            "branching a scenario writes no second file"
        );
    }

    #[test]
    fn duplicate_plan_disambiguates_colliding_slug() {
        let base = TempBase::new("duplicate-collision");
        seed(&base.0);

        // Duplicating under a name that slugifies to an existing id must not
        // collide with (and overwrite) that scenario.
        let copy = duplicate_plan(&base.0, "base-plan", "Base plan").unwrap();
        assert_ne!(copy.id, "base-plan");
        assert!(copy.id.starts_with("base-plan-"));

        let original = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(original.name, "Base plan");
    }

    #[test]
    fn deleting_one_of_several_scenarios_keeps_the_household() {
        let base = TempBase::new("delete-one");
        seed(&base.0);
        let copy = duplicate_plan(&base.0, "base-plan", "Retire early").unwrap();

        delete_plan(&base.0, &copy.id).unwrap();

        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "base-plan");
        assert!(household_path(&base.0, "base-plan").exists());
        assert!(!trash_dir(&base.0).exists(), "nothing was thrown away");
    }

    #[test]
    fn deleting_the_last_scenario_moves_the_household_to_trash() {
        let base = TempBase::new("delete");
        seed(&base.0);

        delete_plan(&base.0, "base-plan").unwrap();
        assert!(list_plans(&base.0).unwrap().is_empty());
        assert!(!household_path(&base.0, "base-plan").exists());
        // It landed in .trash instead, timestamp-suffixed.
        let trash: Vec<_> = fs::read_dir(trash_dir(&base.0)).unwrap().collect();
        assert_eq!(trash.len(), 1);
        let name = trash[0].as_ref().unwrap().file_name();
        assert!(name.to_str().unwrap().starts_with("base-plan-"));

        // Deleting an already-gone scenario is a no-op, not an error.
        delete_plan(&base.0, "base-plan").unwrap();
    }

    #[test]
    fn snapshot_plan_is_noop_without_an_existing_file() {
        let base = TempBase::new("snapshot-noop");
        snapshot_plan(&base.0, "nonexistent").unwrap();
        assert!(list_snapshots(&base.0, "nonexistent").unwrap().is_empty());
    }

    #[test]
    fn snapshot_plan_captures_current_file_and_lists_newest_first() {
        let base = TempBase::new("snapshot-list");
        seed(&base.0);

        snapshot_plan(&base.0, "base-plan").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        snapshot_plan(&base.0, "base-plan").unwrap();

        let stamps = list_snapshots(&base.0, "base-plan").unwrap();
        assert_eq!(stamps.len(), 2);
        // Newest first.
        assert!(stamps[0] > stamps[1]);
    }

    /// One history per household, so a snapshot taken from one scenario is
    /// listed from its siblings too — which is what makes "restore brings
    /// back every scenario" legible rather than surprising.
    #[test]
    fn snapshots_are_per_household_not_per_scenario() {
        let base = TempBase::new("snapshot-household");
        seed(&base.0);
        let copy = duplicate_plan(&base.0, "base-plan", "Retire early").unwrap();

        snapshot_plan(&base.0, "base-plan").unwrap();
        assert_eq!(list_snapshots(&base.0, &copy.id).unwrap().len(), 1);
    }

    #[test]
    fn snapshot_plan_prunes_beyond_the_cap() {
        let base = TempBase::new("snapshot-prune");
        seed(&base.0);

        for _ in 0..(MAX_SNAPSHOTS_PER_HOUSEHOLD + 5) {
            snapshot_plan(&base.0, "base-plan").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        assert_eq!(
            list_snapshots(&base.0, "base-plan").unwrap().len(),
            MAX_SNAPSHOTS_PER_HOUSEHOLD
        );
    }

    #[test]
    fn restore_snapshot_brings_back_prior_content_and_is_itself_undoable() {
        let base = TempBase::new("restore");
        let original = seed(&base.0);

        // Snapshot the original state, then edit and save.
        snapshot_plan(&base.0, "base-plan").unwrap();
        let stamps = list_snapshots(&base.0, "base-plan").unwrap();
        assert_eq!(stamps.len(), 1);

        let mut edited = original.clone();
        edited.assumptions.inflation = 0.09;
        save_plan(&base.0, &edited).unwrap();

        let restored = restore_snapshot(&base.0, "base-plan", &stamps[0]).unwrap();
        assert_eq!(
            restored.assumptions.inflation,
            original.assumptions.inflation
        );

        let reloaded = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(
            reloaded.assumptions.inflation,
            original.assumptions.inflation
        );

        // Restoring snapshotted the pre-restore (edited) state first, so
        // restoring is itself undoable.
        let stamps_after = list_snapshots(&base.0, "base-plan").unwrap();
        assert_eq!(stamps_after.len(), 2);
        let undo = restore_snapshot(&base.0, "base-plan", &stamps_after[0]).unwrap();
        assert_eq!(undo.assumptions.inflation, 0.09);
    }

    /// A restore is whole-household: the balances *and* every scenario come
    /// back as they were, so a scenario branched after the snapshot is gone
    /// again. The Storage settings copy says so.
    #[test]
    fn restore_snapshot_brings_back_every_scenario_of_the_household() {
        let base = TempBase::new("restore-household");
        seed(&base.0);
        snapshot_plan(&base.0, "base-plan").unwrap();
        let branched = duplicate_plan(&base.0, "base-plan", "Retire early").unwrap();
        assert_eq!(list_plans(&base.0).unwrap().len(), 2);

        let stamps = list_snapshots(&base.0, "base-plan").unwrap();
        let restored = restore_snapshot(&base.0, &branched.id, &stamps[0]).unwrap();

        assert_eq!(list_plans(&base.0).unwrap().len(), 1);
        assert_eq!(
            restored.id, "base-plan",
            "the scenario we were on did not exist yet, so the first one opens"
        );
    }

    #[test]
    fn cleanup_moves_legacy_deleted_files_into_trash() {
        let base = TempBase::new("cleanup-deleted");
        let dir = plans_dir(&base.0);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old-plan.yaml.deleted"), "id: old-plan\n").unwrap();

        cleanup(&base.0).unwrap();

        assert!(!dir.join("old-plan.yaml.deleted").exists());
        let trash: Vec<_> = fs::read_dir(trash_dir(&base.0)).unwrap().collect();
        assert_eq!(trash.len(), 1);
        let name = trash[0].as_ref().unwrap().file_name();
        assert!(name.to_str().unwrap().starts_with("old-plan-"));
    }

    #[test]
    fn cleanup_purges_bak_files_whose_yaml_is_gone() {
        let base = TempBase::new("cleanup-bak");
        let dir = plans_dir(&base.0);
        fs::create_dir_all(&dir).unwrap();
        // Orphan: a .bak with no corresponding .yaml.
        fs::write(dir.join("gone.yaml.bak"), "id: gone\n").unwrap();
        // Live: a .bak whose .yaml still exists must survive.
        fs::write(dir.join("kept.yaml"), "id: kept\n").unwrap();
        fs::write(dir.join("kept.yaml.bak"), "id: kept\n").unwrap();

        cleanup(&base.0).unwrap();

        assert!(!dir.join("gone.yaml.bak").exists());
        assert!(dir.join("kept.yaml.bak").exists());
    }

    #[test]
    fn export_plans_copies_the_whole_directory_timestamped() {
        let base = TempBase::new("export-source");
        seed(&base.0);
        snapshot_plan(&base.0, "base-plan").unwrap();

        let dest_parent = TempBase::new("export-dest");
        let dest = export_plans(&base.0, &dest_parent.0).unwrap();

        assert!(dest.starts_with(&dest_parent.0));
        assert!(dest.join("base-plan.yaml").exists());
        assert!(dest
            .join(".history")
            .join("base-plan")
            .read_dir()
            .unwrap()
            .next()
            .is_some());
    }
}
