//! JSON persistence for plans. PRIVACY: everything here writes only to the
//! local plans directory (OS app-data dir); nothing leaves the machine.
//!
//! Functions take an explicit base directory so they are unit-testable
//! without a Tauri runtime; commands.rs supplies the real app-data path.

use std::fs;
use std::path::{Path, PathBuf};

use engine::model::{Plan, SCHEMA_VERSION};

/// One plan file per plan (a V2 scenario is just another file).
pub fn plans_dir(base: &Path) -> PathBuf {
    base.join("plans")
}

fn plan_path(base: &Path, name: &str) -> PathBuf {
    plans_dir(base).join(format!("{}.json", slugify(name)))
}

/// Filesystem-safe file name from a plan name ("Base plan" → "base-plan").
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

/// Atomic save: write a temp file, keep the previous version as `.bak`,
/// then rename into place so a crash never leaves a torn file.
pub fn save_plan(base: &Path, plan: &Plan) -> Result<(), String> {
    if plan.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "plan schema version {} does not match supported version {}",
            plan.schema_version, SCHEMA_VERSION
        ));
    }
    let dir = plans_dir(base);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let path = plan_path(base, &plan.name);
    let json = serde_json::to_string_pretty(plan).map_err(|e| format!("serializing plan: {e}"))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    if path.exists() {
        let bak = path.with_extension("json.bak");
        fs::copy(&path, &bak).map_err(|e| format!("backing up {}: {e}", path.display()))?;
    }
    fs::rename(&tmp, &path).map_err(|e| format!("replacing {}: {e}", path.display()))?;
    Ok(())
}

pub fn load_plan_file(path: &Path) -> Result<Plan, String> {
    let json = fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let plan: Plan =
        serde_json::from_str(&json).map_err(|e| format!("parsing {}: {e}", path.display()))?;
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

/// Names of all stored plans, alphabetical.
pub fn list_plans(base: &Path) -> Result<Vec<String>, String> {
    let dir = plans_dir(base);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("reading {}: {e}", dir.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(plan) = load_plan_file(&path) {
                names.push(plan.name);
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Load the single V1 plan: the first stored plan, or bootstrap and persist
/// the seed plan on first run.
pub fn load_or_bootstrap(base: &Path) -> Result<Plan, String> {
    let dir = plans_dir(base);
    if dir.exists() {
        let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
            .map_err(|e| format!("reading {}: {e}", dir.display()))?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        paths.sort();
        if let Some(path) = paths.first() {
            return load_plan_file(path);
        }
    }
    let seed = engine::presets::seed_plan();
    save_plan(base, &seed)?;
    Ok(seed)
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
        assert_eq!(list_plans(&base.0).unwrap(), vec!["Base plan".to_string()]);

        let mut edited = plan.clone();
        edited.assumptions.inflation = 0.03;
        save_plan(&base.0, &edited).unwrap();

        let reloaded = load_or_bootstrap(&base.0).unwrap();
        assert_eq!(reloaded.assumptions.inflation, 0.03);
        // Previous version preserved as .bak.
        assert!(plans_dir(&base.0).join("base-plan.json.bak").exists());
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let base = TempBase::new("schema");
        let mut plan = engine::presets::seed_plan();
        save_plan(&base.0, &plan).unwrap();
        plan.schema_version = 999;
        assert!(save_plan(&base.0, &plan).is_err());

        let path = plan_path(&base.0, &plan.name);
        let mangled = fs::read_to_string(&path)
            .unwrap()
            .replace("\"schema_version\": 1", "\"schema_version\": 999");
        fs::write(&path, mangled).unwrap();
        assert!(load_plan_file(&path).is_err());
    }

    #[test]
    fn slugify_sanitizes_names() {
        assert_eq!(slugify("Base plan"), "base-plan");
        assert_eq!(slugify("  Retire Early!! (v2)  "), "retire-early-v2");
        assert_eq!(slugify("///"), "plan");
    }
}
