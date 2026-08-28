//! One-shot, copy-forward migration between plan storage locations. Used
//! both to bring forward legacy pre-#13 JSON plans (from the old app-data
//! dir) into the new YAML-based, user-visible location, and to copy plans
//! along when the user relocates the storage folder from Settings.
//!
//! Never deletes or moves the source — always copies — so a migration can
//! never lose data, only duplicate it.

use std::fs;
use std::path::Path;

use engine::model::Plan;

use crate::storage;

/// Copy every `*.json` plan file from a legacy plans directory into
/// `to_base` (a storage base dir, as accepted by `storage::save_plan`),
/// converting each to YAML. Files that fail to parse are left in place and
/// simply skipped, matching `storage::list_plans`'s silent-skip policy.
/// Returns the number of plans migrated.
pub fn migrate_json_dir_to_yaml(legacy_plans_dir: &Path, to_base: &Path) -> Result<usize, String> {
    if !legacy_plans_dir.exists() {
        return Ok(0);
    }
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
        // Pre-#13 JSON plans predate the #6 `id` field too; storage now
        // requires one, so backfill it the same way `storage::load_plan`
        // does for legacy YAML.
        if plan.id.trim().is_empty() {
            plan.id = storage::generate_id(to_base, &plan.name);
        }
        if storage::save_plan(to_base, &plan).is_ok() {
            migrated += 1;
        }
    }
    Ok(migrated)
}

/// Copy every already-YAML plan file from one storage base dir to another
/// (used when the user relocates the storage folder in Settings). A plain
/// file copy — same format on both ends, no reparse needed.
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

#[cfg(test)]
mod tests {
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

    #[test]
    fn migrate_json_dir_to_yaml_converts_and_preserves_originals() {
        let legacy_base = TempDir::new("legacy");
        let legacy_plans = legacy_base.0.join("plans");
        fs::create_dir_all(&legacy_plans).unwrap();

        let plan = engine::presets::seed_plan();
        let json = serde_json::to_string_pretty(&plan).unwrap();
        let legacy_path = legacy_plans.join("base-plan.json");
        fs::write(&legacy_path, &json).unwrap();

        let to_base = TempDir::new("new");
        let migrated = migrate_json_dir_to_yaml(&legacy_plans, &to_base.0).unwrap();
        assert_eq!(migrated, 1);

        // Lands at to_base/plans/<slug>.yaml, not doubly-nested.
        let migrated_path = storage::plans_dir(&to_base.0).join("base-plan.yaml");
        assert!(migrated_path.exists());
        let reloaded = storage::load_plan_file(&migrated_path).unwrap();
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
        let mut value = serde_json::to_value(&plan).unwrap();
        value.as_object_mut().unwrap().remove("id");
        fs::write(
            legacy_plans.join("base-plan.json"),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();

        let to_base = TempDir::new("new-no-id");
        let migrated = migrate_json_dir_to_yaml(&legacy_plans, &to_base.0).unwrap();
        assert_eq!(migrated, 1);

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
        let plan = engine::presets::seed_plan();
        storage::save_plan(&from_base.0, &plan).unwrap();

        let to_base = TempDir::new("to");
        let copied = copy_yaml_dir(&from_base.0, &to_base.0).unwrap();
        assert_eq!(copied, 1);

        let copied_path = storage::plans_dir(&to_base.0).join("base-plan.yaml");
        assert!(copied_path.exists());
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
}
