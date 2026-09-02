//! App-level settings — distinct from plan data. Stored as a small JSON
//! file (not YAML: this is one internal field, not something the user is
//! meant to hand-edit) in the OS app-config dir, independent of wherever
//! the user has pointed the plans directory. This is what makes the plans
//! directory itself relocatable without a bootstrapping chicken-and-egg
//! problem: the app always knows where to look for this file first.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

/// Environment variable that relocates *all* app state — settings and plans
/// alike — under one throwaway root. Set it and the app never reads or
/// writes the real plans directory, which is what makes it safe to run
/// against demo data for screenshots, or to try the app without touching
/// your own finances.
///
/// It has to cover the config dir too, not just the plans dir: settings.json
/// is where a user's chosen plans location is recorded, so redirecting only
/// the plans dir would let a real settings.json point the run straight back
/// at real data.
pub const DATA_ROOT_ENV: &str = "RETIREMENT_DATA_DIR";

/// The data-root override in effect, if any.
pub fn data_root_override() -> Option<PathBuf> {
    data_root_from(std::env::var_os(DATA_ROOT_ENV))
}

/// Split from `data_root_override` so the parsing is testable without
/// mutating process environment, which races under a parallel test runner.
fn data_root_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    raw.filter(|v| !v.is_empty()).map(PathBuf::from)
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SettingsFile {
    /// Absolute path to the user-chosen plans directory. `None` means "use
    /// the computed default" (Documents/Retirement Planner, or the Linux
    /// fallback).
    plans_dir: Option<PathBuf>,
    /// Id of the scenario shown on launch. `None` means "use whichever plan
    /// `load_or_bootstrap` picks" (the first stored plan, or a fresh seed).
    #[serde(default)]
    active_plan_id: Option<String>,
}

fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

fn read(config_dir: &Path) -> SettingsFile {
    fs::read_to_string(settings_path(config_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(config_dir: &Path, settings: &SettingsFile) -> Result<(), String> {
    fs::create_dir_all(config_dir)
        .map_err(|e| format!("creating {}: {e}", config_dir.display()))?;
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("serializing settings: {e}"))?;
    fs::write(settings_path(config_dir), json)
        .map_err(|e| format!("writing {}: {e}", settings_path(config_dir).display()))
}

/// The default plans directory: `<Documents>/Retirement Planner`, or on
/// systems where Documents can't be resolved (e.g. Linux without XDG
/// user-dirs configured), `<home>/RetirementPlanner`.
pub fn default_plans_dir(
    document_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(docs) = document_dir {
        return Ok(docs.join("Retirement Planner"));
    }
    home_dir
        .map(|h| h.join("RetirementPlanner"))
        .ok_or_else(|| "could not resolve a Documents or home directory".to_string())
}

/// The plans directory actually in effect: the user's explicit choice if
/// one has been set, else `default`.
pub fn effective_plans_dir(config_dir: &Path, default: &Path) -> PathBuf {
    read(config_dir)
        .plans_dir
        .unwrap_or_else(|| default.to_path_buf())
}

pub fn set_plans_dir(config_dir: &Path, dir: &Path) -> Result<(), String> {
    let mut settings = read(config_dir);
    settings.plans_dir = Some(dir.to_path_buf());
    write(config_dir, &settings)
}

/// The scenario to show on launch, if one has been chosen; `None` defers to
/// `load_or_bootstrap`'s default (first stored plan, or a fresh seed).
pub fn active_plan_id(config_dir: &Path) -> Option<String> {
    read(config_dir).active_plan_id
}

pub fn set_active_plan_id(config_dir: &Path, id: &str) -> Result<(), String> {
    let mut settings = read(config_dir);
    settings.active_plan_id = Some(id.to_string());
    write(config_dir, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "retirement-settings-test-{tag}-{}",
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
    fn data_root_unset_is_none() {
        assert_eq!(data_root_from(None), None);
    }

    #[test]
    fn data_root_empty_is_none() {
        // An exported-but-empty var means "not set", not "use the cwd".
        assert_eq!(data_root_from(Some(std::ffi::OsString::from(""))), None);
    }

    #[test]
    fn data_root_set_is_used() {
        assert_eq!(
            data_root_from(Some(std::ffi::OsString::from("/tmp/demo"))),
            Some(PathBuf::from("/tmp/demo"))
        );
    }

    #[test]
    fn default_plans_dir_prefers_documents() {
        let docs = PathBuf::from("/Users/test/Documents");
        let home = PathBuf::from("/Users/test");
        assert_eq!(
            default_plans_dir(Some(docs), Some(home)).unwrap(),
            PathBuf::from("/Users/test/Documents/Retirement Planner")
        );
    }

    #[test]
    fn default_plans_dir_falls_back_to_home() {
        let home = PathBuf::from("/home/test");
        assert_eq!(
            default_plans_dir(None, Some(home)).unwrap(),
            PathBuf::from("/home/test/RetirementPlanner")
        );
    }

    #[test]
    fn default_plans_dir_errors_with_neither() {
        assert!(default_plans_dir(None, None).is_err());
    }

    #[test]
    fn effective_dir_falls_back_to_default_when_unset() {
        let config = TempDir::new("unset");
        let default = PathBuf::from("/default/plans");
        assert_eq!(effective_plans_dir(&config.0, &default), default);
    }

    #[test]
    fn set_plans_dir_persists_and_is_read_back() {
        let config = TempDir::new("roundtrip");
        let default = PathBuf::from("/default/plans");
        let chosen = PathBuf::from("/custom/plans");

        set_plans_dir(&config.0, &chosen).unwrap();
        assert_eq!(effective_plans_dir(&config.0, &default), chosen);
    }

    #[test]
    fn active_plan_id_unset_by_default() {
        let config = TempDir::new("active-unset");
        assert_eq!(active_plan_id(&config.0), None);
    }

    #[test]
    fn set_active_plan_id_persists_and_is_read_back() {
        let config = TempDir::new("active-roundtrip");
        set_active_plan_id(&config.0, "sell-the-home").unwrap();
        assert_eq!(active_plan_id(&config.0), Some("sell-the-home".to_string()));
    }

    #[test]
    fn set_plans_dir_preserves_active_plan_id() {
        let config = TempDir::new("independent-fields");
        set_active_plan_id(&config.0, "sell-the-home").unwrap();
        set_plans_dir(&config.0, &PathBuf::from("/custom/plans")).unwrap();
        assert_eq!(active_plan_id(&config.0), Some("sell-the-home".to_string()));
    }

    #[test]
    fn set_active_plan_id_preserves_plans_dir() {
        let config = TempDir::new("independent-fields-2");
        let chosen = PathBuf::from("/custom/plans");
        set_plans_dir(&config.0, &chosen).unwrap();
        set_active_plan_id(&config.0, "sell-the-home").unwrap();
        assert_eq!(
            effective_plans_dir(&config.0, &PathBuf::from("/default")),
            chosen
        );
    }
}
