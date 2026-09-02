//! Tauri IPC surface — a thin adapter over the engine and storage layers.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use engine::model::Plan;
use engine::presets::Presets;
use engine::{MonteCarloConfig, MonteCarloResult, Projection};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{migrate, settings, storage};

/// Plan ids already snapshotted into history this session, so the
/// once-per-session pre-edit snapshot (see `save_plan`) fires on the first
/// save of a launch, not on every debounced autosave after that.
#[derive(Default)]
pub struct SnapshotState(pub Mutex<HashSet<String>>);

/// Where settings.json lives — fixed, not user-configurable (it's what
/// makes the plans directory itself relocatable without a bootstrapping
/// chicken-and-egg problem).
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))
}

/// The computed default plans dir (Documents/Retirement Planner, or the
/// Linux home-dir fallback), independent of any user override.
fn default_plans_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    settings::default_plans_dir(app.path().document_dir().ok(), app.path().home_dir().ok())
}

/// Resolved effective plans base dir — the user's chosen location if one is
/// set in settings.json, else the computed default. Replaces the old,
/// hardcoded `app_data_dir`-only `data_dir`.
fn plans_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default = default_plans_dir(app)?;
    Ok(settings::effective_plans_dir(&config_dir(app)?, &default))
}

/// The pre-#13 storage location, used only to detect and migrate old plans
/// on first launch after this feature ships.
fn legacy_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolving legacy app data dir: {e}"))
}

/// A plan that fails validation is never simulated or written to disk; every
/// message is user-facing (see `engine::model::validate`), so callers can
/// join them straight into a banner.
fn require_valid(plan: &Plan) -> Result<(), String> {
    let errors = plan.validate();
    if errors.is_empty() {
        return Ok(());
    }
    Err(errors
        .into_iter()
        .map(|e| e.message)
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Stateless projection: the frontend sends the full plan (a few KB) and gets
/// the full deterministic projection back.
#[tauri::command]
pub fn run_projection(plan: Plan) -> Result<Projection, String> {
    require_valid(&plan)?;
    Ok(engine::run_deterministic(&plan))
}

/// Load the current plan, bootstrapping the seed plan on first run. Before
/// bootstrapping, checks for legacy pre-#13 JSON plans and migrates them
/// into the new location as YAML — a one-shot, copy-forward check, not
/// permanent dual-format support.
///
/// If a scenario was chosen as active in a previous session, it's loaded
/// directly; otherwise falls back to `load_or_bootstrap`'s default (first
/// stored plan, or a fresh seed).
#[tauri::command]
pub fn load_plan(app: tauri::AppHandle) -> Result<Plan, String> {
    let base = plans_base_dir(&app)?;
    if !storage::plans_dir(&base).exists() {
        let legacy_plans = legacy_data_dir(&app)?.join("plans");
        if legacy_plans.exists() {
            migrate::migrate_json_dir_to_yaml(&legacy_plans, &base)?;
        }
    }
    storage::cleanup(&base)?;
    if let Some(id) = settings::active_plan_id(&config_dir(&app)?) {
        if let Ok(plan) = storage::load_plan(&base, &id) {
            return Ok(plan);
        }
        // Active plan was deleted or moved out from under us — fall through
        // to the default rather than erroring the whole app out.
    }
    storage::load_or_bootstrap(&base)
}

/// Saves a plan, snapshotting its pre-edit state into history first — but
/// only on the first save of a given plan id since app launch. The store
/// autosaves on a debounce after every edit, so gating on session-once
/// keeps each history entry meaning "how the plan looked when I sat down"
/// rather than one entry per keystroke.
#[tauri::command]
pub fn save_plan(
    app: tauri::AppHandle,
    state: tauri::State<SnapshotState>,
    plan: Plan,
) -> Result<(), String> {
    require_valid(&plan)?;
    let base = plans_base_dir(&app)?;
    let first_save_this_session = state.0.lock().unwrap().insert(plan.id.clone());
    if first_save_this_session {
        storage::snapshot_plan(&base, &plan.id)?;
    }
    storage::save_plan(&base, &plan)
}

#[derive(Serialize)]
pub struct PlanSummary {
    id: String,
    name: String,
}

#[tauri::command]
pub fn list_plans(app: tauri::AppHandle) -> Result<Vec<PlanSummary>, String> {
    Ok(storage::list_plans(&plans_base_dir(&app)?)?
        .into_iter()
        .map(|s| PlanSummary {
            id: s.id,
            name: s.name,
        })
        .collect())
}

/// Loads a specific scenario by id, e.g. when switching in the scenario
/// picker.
#[tauri::command]
pub fn load_plan_named(app: tauri::AppHandle, id: String) -> Result<Plan, String> {
    storage::load_plan(&plans_base_dir(&app)?, &id)
}

/// Records which scenario should load on next launch.
#[tauri::command]
pub fn set_active_plan(app: tauri::AppHandle, id: String) -> Result<(), String> {
    settings::set_active_plan_id(&config_dir(&app)?, &id)
}

/// Creates a new scenario as a deep copy of an existing one under a new
/// name, so the user can branch off the base plan without losing it.
#[tauri::command]
pub fn duplicate_plan(app: tauri::AppHandle, id: String, new_name: String) -> Result<Plan, String> {
    storage::duplicate_plan(&plans_base_dir(&app)?, &id, &new_name)
}

/// Removes a scenario. Never the last one — a plan-less app has nothing to
/// show.
#[tauri::command]
pub fn delete_plan(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let base = plans_base_dir(&app)?;
    if storage::list_plans(&base)?.len() <= 1 {
        return Err("Can't delete the only scenario.".to_string());
    }
    storage::delete_plan(&base, &id)
}

/// A plan's snapshot history, newest first, for the restore UI in Storage
/// settings.
#[tauri::command]
pub fn list_snapshots(app: tauri::AppHandle, id: String) -> Result<Vec<String>, String> {
    storage::list_snapshots(&plans_base_dir(&app)?, &id)
}

/// Restores a plan to a prior snapshot, itself snapshotting the pre-restore
/// state first so restoring is undoable. Returns the restored plan so the
/// caller can re-activate it without a second round-trip.
#[tauri::command]
pub fn restore_snapshot(
    app: tauri::AppHandle,
    id: String,
    timestamp: String,
) -> Result<Plan, String> {
    storage::restore_snapshot(&plans_base_dir(&app)?, &id, &timestamp)
}

/// Projects several scenarios in one round-trip for the comparison view.
/// Each scenario's result is independent so one invalid or unsimulatable
/// plan doesn't blank out the rest of the comparison.
#[tauri::command]
pub fn run_projections(plans: Vec<Plan>) -> Vec<Result<Projection, String>> {
    plans
        .iter()
        .map(|plan| {
            require_valid(plan)?;
            Ok(engine::run_deterministic(plan))
        })
        .collect()
}

/// Monte Carlo run: N stochastic paths in parallel, returning a success rate
/// and per-period net-worth percentiles. Run on demand (not on every edit
/// like `run_projection`) since it's orders of magnitude more work.
#[tauri::command]
pub fn run_monte_carlo(plan: Plan, config: MonteCarloConfig) -> Result<MonteCarloResult, String> {
    require_valid(&plan)?;
    Ok(engine::run_monte_carlo(&plan, &config))
}

/// Where plans are currently stored, for display in the Storage settings
/// panel.
#[derive(Serialize)]
pub struct StorageInfo {
    effective_dir: PathBuf,
    is_default: bool,
    default_dir: PathBuf,
}

#[tauri::command]
pub fn get_storage_info(app: tauri::AppHandle) -> Result<StorageInfo, String> {
    let default_dir = default_plans_dir(&app)?;
    let effective_dir = plans_base_dir(&app)?;
    Ok(StorageInfo {
        is_default: effective_dir == default_dir,
        effective_dir,
        default_dir,
    })
}

/// Opens a native folder picker. Returns `None` if the user cancels.
#[tauri::command]
pub async fn choose_storage_dir(app: tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |folder| {
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(folder).await;
        });
    });
    let picked = rx.recv().await.flatten();
    Ok(picked.and_then(|fp| fp.into_path().ok()))
}

/// Points plan storage at a new folder, copying any existing plans forward
/// (never deleting the old copy — same copy-forward-only principle as the
/// legacy migration in `load_plan`).
#[tauri::command]
pub fn set_storage_dir(app: tauri::AppHandle, path: PathBuf) -> Result<(), String> {
    let old_base = plans_base_dir(&app)?;
    migrate::copy_yaml_dir(&old_base, &path)?;
    settings::set_plans_dir(&config_dir(&app)?, &path)
}

/// Opens a native folder picker and writes a timestamped copy of the whole
/// plans directory into the chosen folder — the off-machine backup story:
/// point it at an external drive or a sync folder, by explicit user action.
/// Returns the created folder's path, or `None` if the user cancels.
#[tauri::command]
pub async fn export_plans(app: tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog().file().pick_folder(move |folder| {
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(folder).await;
        });
    });
    let picked = rx.recv().await.flatten();
    let Some(dest_parent) = picked.and_then(|fp| fp.into_path().ok()) else {
        return Ok(None);
    };
    let base = plans_base_dir(&app)?;
    storage::export_plans(&base, &dest_parent).map(Some)
}

/// Opens a native save-file dialog and writes `contents` to wherever the
/// user picks — the projection CSV export's write side. Generic rather than
/// CSV-specific since "write this text to a user-chosen path" has no
/// export-specific logic in it; the basis-aware formatting lives entirely on
/// the frontend, which is what already knows the display basis and the
/// projection shape. Returns the written path, or `None` if the user cancels.
#[tauri::command]
pub async fn export_text_file(
    app: tauri::AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<Option<PathBuf>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("CSV", &["csv"])
        .save_file(move |path| {
            let tx = tx.clone();
            tauri::async_runtime::spawn(async move {
                let _ = tx.send(path).await;
            });
        });
    let picked = rx.recv().await.flatten();
    let Some(path) = picked.and_then(|fp| fp.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

/// Renders the calling window's contents to a paginated PDF at a
/// user-chosen path — the printable report's "Save as PDF…" button. macOS
/// only: it drives WKWebView's real print pipeline directly (see `pdf.rs`),
/// headless and pointed at a file instead of the interactive sheet, and
/// there is no cross-platform equivalent. `@media print` in `App.css`
/// controls what's isolated and how it paginates; this command itself only
/// picks the destination and hands it off.
#[tauri::command]
pub async fn export_report_pdf(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    suggested_name: String,
) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        app.dialog()
            .file()
            .set_file_name(&suggested_name)
            .add_filter("PDF", &["pdf"])
            .save_file(move |path| {
                let tx = tx.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tx.send(path).await;
                });
            });
        let picked = rx.recv().await.flatten();
        let Some(path) = picked.and_then(|fp| fp.into_path().ok()) else {
            return Ok(None);
        };
        crate::pdf::render(window, path.clone()).await?;
        Ok(Some(path))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, suggested_name);
        Err("PDF export is only available on macOS today.".to_string())
    }
}

/// Reveals the current plans folder in Finder/Explorer.
#[tauri::command]
pub fn reveal_storage_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = plans_base_dir(&app)?;
    app.opener()
        .reveal_item_in_dir(&dir)
        .map_err(|e| e.to_string())
}

/// Allocation presets and default assumptions — defined once, in Rust.
#[tauri::command]
pub fn get_presets() -> Presets {
    engine::presets::presets()
}

#[tauri::command]
pub fn engine_version() -> String {
    engine::version().to_string()
}
