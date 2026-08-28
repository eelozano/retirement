//! YAML persistence for plans, chosen over JSON so a plan file is readable
//! and hand-editable outside the app. PRIVACY: everything here writes only
//! to the local plans directory; nothing leaves the machine.
//!
//! Functions take an explicit base directory so they are unit-testable
//! without a Tauri runtime; commands.rs resolves the real, user-configurable
//! base path (see settings.rs).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use engine::model::{Plan, PlanId, SCHEMA_VERSION};

/// One plan file per plan — a scenario is just another file, keyed by the
/// plan's stable `id` (not its editable `name`) so renaming never moves the
/// file.
pub fn plans_dir(base: &Path) -> PathBuf {
    base.join("plans")
}

fn plan_path(base: &Path, id: &str) -> PathBuf {
    plans_dir(base).join(format!("{id}.yaml"))
}

/// Filesystem-safe slug from a plan name ("Base plan" → "base-plan"). Used
/// both to derive a stable `id` for pre-#6 plans that predate the `id`
/// field, and as the human-readable starting point for a new plan's id.
fn slugify(name: &str) -> String {
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

/// A fresh, unique plan id derived from a name: the plain slug if that file
/// doesn't already exist, else the slug disambiguated with a timestamp.
/// Keeping the slug as the common case is deliberate — plan files are meant
/// to stay human-readable and hand-editable outside the app.
pub fn generate_id(base: &Path, name: &str) -> String {
    let slug = slugify(name);
    if !plan_path(base, &slug).exists() {
        return slug;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{slug}-{nanos}")
}

/// Atomic save: write a temp file, keep the previous version as `.bak`,
/// then rename into place so a crash never leaves a torn file.
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
    let dir = plans_dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let path = plan_path(base, &plan.id);
    let yaml = serde_yaml_ng::to_string(plan).map_err(|e| format!("serializing plan: {e}"))?;

    let tmp = path.with_extension("yaml.tmp");
    fs::write(&tmp, &yaml).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    if path.exists() {
        let bak = path.with_extension("yaml.bak");
        fs::copy(&path, &bak).map_err(|e| format!("backing up {}: {e}", path.display()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("replacing {}: {e}", path.display()))?;
    Ok(())
}

pub fn load_plan_file(path: &Path) -> Result<Plan, String> {
    let yaml = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let plan: Plan =
        serde_yaml_ng::from_str(&yaml).map_err(|e| format!("parsing {}: {e}", path.display()))?;
    if plan.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "{} has schema version {}, this app supports {} — migration needed",
            path.display(),
            plan.schema_version,
            SCHEMA_VERSION
        ));
    }
    Ok(plan)
}

/// Loads a plan file, backfilling a missing `id` (pre-#6 plans) from the
/// filename slug — the same value `plan_path` used to key files by name
/// before ids existed, so this never moves the file, only persists the id
/// into it. One-shot per file: subsequent loads see `id` already set.
fn load_and_backfill_id(base: &Path, path: &Path) -> Result<Plan, String> {
    let mut plan = load_plan_file(path)?;
    if plan.id.trim().is_empty() {
        plan.id = slugify(&plan.name);
        save_plan(base, &plan)?;
    }
    Ok(plan)
}

fn plan_file_paths(base: &Path) -> Result<Vec<PathBuf>, String> {
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

/// Id and display name of every stored plan, alphabetical by name.
pub struct PlanSummary {
    pub id: PlanId,
    pub name: String,
}

pub fn list_plans(base: &Path) -> Result<Vec<PlanSummary>, String> {
    let mut summaries = Vec::new();
    for path in plan_file_paths(base)? {
        if let Ok(plan) = load_and_backfill_id(base, &path) {
            summaries.push(PlanSummary {
                id: plan.id,
                name: plan.name,
            });
        }
    }
    summaries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(summaries)
}

/// Loads a specific plan by id.
pub fn load_plan(base: &Path, id: &str) -> Result<Plan, String> {
    load_and_backfill_id(base, &plan_path(base, id))
}

/// Load the single V1 plan: the first stored plan, or bootstrap and persist
/// the seed plan on first run.
pub fn load_or_bootstrap(base: &Path) -> Result<Plan, String> {
    if let Some(path) = plan_file_paths(base)?.first() {
        return load_and_backfill_id(base, path);
    }
    let seed = engine::presets::seed_plan();
    save_plan(base, &seed)?;
    Ok(seed)
}

/// Deep-copies a stored plan under a new name and a freshly generated id.
pub fn duplicate_plan(base: &Path, id: &str, new_name: &str) -> Result<Plan, String> {
    let mut copy = load_plan(base, id)?;
    copy.id = generate_id(base, new_name);
    copy.name = new_name.to_string();
    save_plan(base, &copy)?;
    Ok(copy)
}

/// Removes a plan by moving its file aside rather than deleting it — the
/// same never-actually-delete posture as the storage-relocation migration
/// in `migrate.rs`.
pub fn delete_plan(base: &Path, id: &str) -> Result<(), String> {
    let path = plan_path(base, id);
    if !path.exists() {
        return Ok(());
    }
    let removed = path.with_extension("yaml.deleted");
    fs::rename(&path, &removed).map_err(|e| format!("removing {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn bootstrap_then_roundtrip() {
        let base = TempBase::new("roundtrip");
        let plan = load_or_bootstrap(&base.0).unwrap();
        assert_eq!(plan.name, "Base plan");
        assert_eq!(plan.id, "base-plan");
        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "base-plan");
        assert_eq!(summaries[0].name, "Base plan");

        let mut edited = plan.clone();
        edited.assumptions.inflation = 0.03;
        save_plan(&base.0, &edited).unwrap();

        let reloaded = load_or_bootstrap(&base.0).unwrap();
        assert_eq!(reloaded.assumptions.inflation, 0.03);
        // Previous version preserved as .bak.
        assert!(plans_dir(&base.0).join("base-plan.yaml.bak").exists());
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let base = TempBase::new("schema");
        let mut plan = engine::presets::seed_plan();
        save_plan(&base.0, &plan).unwrap();
        plan.schema_version = 999;
        assert!(save_plan(&base.0, &plan).is_err());

        let path = plan_path(&base.0, &plan.id);
        let mangled = fs::read_to_string(&path)
            .unwrap()
            .replace("schema_version: 1", "schema_version: 999");
        fs::write(&path, mangled).unwrap();
        assert!(load_plan_file(&path).is_err());
    }

    #[test]
    fn rejects_plan_without_id() {
        let base = TempBase::new("no-id");
        let mut plan = engine::presets::seed_plan();
        plan.id = String::new();
        assert!(save_plan(&base.0, &plan).is_err());
    }

    #[test]
    fn slugify_sanitizes_names() {
        assert_eq!(slugify("Base plan"), "base-plan");
        assert_eq!(slugify("  Retire Early!! (v2)  "), "retire-early-v2");
        assert_eq!(slugify("///"), "plan");
    }

    #[test]
    fn backfills_id_for_legacy_plan_missing_it() {
        let base = TempBase::new("legacy-id");
        let mut plan = engine::presets::seed_plan();
        plan.id = String::new();
        // Legacy files were named after the slugified plan name.
        let dir = plans_dir(&base.0);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("base-plan.yaml");
        fs::write(&path, serde_yaml_ng::to_string(&plan).unwrap()).unwrap();

        let loaded = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(loaded.id, "base-plan");
        // Backfill persisted, not just returned in memory.
        let reloaded = load_plan_file(&path).unwrap();
        assert_eq!(reloaded.id, "base-plan");

        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "base-plan");
    }

    #[test]
    fn duplicate_plan_gets_new_id_and_name() {
        let base = TempBase::new("duplicate");
        load_or_bootstrap(&base.0).unwrap();

        let copy = duplicate_plan(&base.0, "base-plan", "Sell the home").unwrap();
        assert_eq!(copy.name, "Sell the home");
        assert_eq!(copy.id, "sell-the-home");
        assert_ne!(copy.id, "base-plan");

        // Original plan is untouched.
        let original = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(original.name, "Base plan");

        let summaries = list_plans(&base.0).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn duplicate_plan_disambiguates_colliding_slug() {
        let base = TempBase::new("duplicate-collision");
        load_or_bootstrap(&base.0).unwrap();

        // Duplicating under a name that slugifies to an existing id must not
        // collide with (and overwrite) that plan's file.
        let copy = duplicate_plan(&base.0, "base-plan", "Base plan").unwrap();
        assert_ne!(copy.id, "base-plan");
        assert!(copy.id.starts_with("base-plan-"));

        let original = load_plan(&base.0, "base-plan").unwrap();
        assert_eq!(original.name, "Base plan");
    }

    #[test]
    fn delete_plan_moves_file_aside_without_removing_it() {
        let base = TempBase::new("delete");
        load_or_bootstrap(&base.0).unwrap();

        delete_plan(&base.0, "base-plan").unwrap();
        assert!(list_plans(&base.0).unwrap().is_empty());
        assert!(plans_dir(&base.0).join("base-plan.yaml.deleted").exists());

        // Deleting an already-gone plan is a no-op, not an error.
        delete_plan(&base.0, "base-plan").unwrap();
    }
}
