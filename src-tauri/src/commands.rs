//! Tauri IPC surface — a thin adapter over the engine and storage layers.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use engine::model::Plan;
use engine::presets::Presets;
use engine::{MonteCarloConfig, MonteCarloResult, Projection, RunControl};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::{migrate, settings, storage};

/// Plan ids already snapshotted into history this session, so the
/// once-per-session pre-edit snapshot (see `save_plan`) fires on the first
/// save of a launch, not on every debounced autosave after that.
#[derive(Default)]
pub struct SnapshotState(pub Mutex<HashSet<String>>);

/// The Monte Carlo run currently in flight, if any: its id and the handle
/// that stops it. One slot, not a map — the app has one window and one
/// headline, and starting a run supersedes whatever was running. The id is
/// what lets `cancel_monte_carlo` ignore a stale Cancel click aimed at a run
/// that has already been replaced.
#[derive(Default)]
pub struct MonteCarloState(pub Mutex<Option<(u32, Arc<RunControl>)>>);

/// Where settings.json lives — fixed, not user-configurable (it's what
/// makes the plans directory itself relocatable without a bootstrapping
/// chicken-and-egg problem).
fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = settings::data_root_override() {
        return Ok(root.join("config"));
    }
    app.path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))
}

/// The computed default plans dir (Documents/Retirement Planner, or the
/// Linux home-dir fallback), independent of any user override.
fn default_plans_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = settings::data_root_override() {
        return Ok(root);
    }
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
    // Under an override, point at a path inside the root that will not
    // exist, so a demo run never migrates the real legacy plans into itself.
    if let Some(root) = settings::data_root_override() {
        return Ok(root.join("legacy"));
    }
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

/// One progress report from an in-flight Monte Carlo run. `run_id` is echoed
/// so a report from a superseded run can be told apart from the current one;
/// `total` is the clamped path count the run is actually doing.
#[derive(Serialize, Clone, Copy)]
pub struct MonteCarloProgress {
    run_id: u32,
    completed: u32,
    total: u32,
}

/// How often the progress channel is fed. Coarse on purpose: the frontend
/// paints a count, not an animation, and at the default path count the whole
/// run is only a couple of ticks long.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// Takes the single run slot for `run_id`, cancelling whatever held it. One
/// slot for both Monte Carlo commands, deliberately: a comparison batch and
/// the Plan screen's own run would otherwise compete for the same rayon pool,
/// each making the other look slow. The cost is that opening Scenarios
/// supersedes the active plan's run, which the store then shows as stale.
fn claim_slot(state: &tauri::State<'_, MonteCarloState>, run_id: u32) -> Arc<RunControl> {
    let control = Arc::new(RunControl::new());
    if let Some((_, previous)) = state.0.lock().unwrap().replace((run_id, control.clone())) {
        previous.cancel();
    }
    control
}

/// Releases the slot, but only if it is still ours: a newer run may already
/// have replaced it, and that one's handle must stay reachable.
fn release_slot(state: &tauri::State<'_, MonteCarloState>, run_id: u32) {
    let mut slot = state.0.lock().unwrap();
    if matches!(&*slot, Some((id, _)) if *id == run_id) {
        *slot = None;
    }
}

/// Runs `work` on this thread while a scoped ticker samples `control` and
/// feeds `on_progress`. The engine itself never sees the channel — it only
/// increments its own counter, which is what lets a batch of scenarios share
/// one climbing number (see `run_monte_carlos`).
///
/// A scoped thread rather than a tokio timer: the runtime's `time` feature is
/// not otherwise needed, and a ticker that ends with the scope cannot outlive
/// the run it reports on.
fn with_progress<T>(
    control: &RunControl,
    run_id: u32,
    total: u32,
    on_progress: Channel<MonteCarloProgress>,
    work: impl FnOnce() -> T,
) -> T {
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(PROGRESS_INTERVAL);
                if done.load(Ordering::Relaxed) {
                    break;
                }
                let _ = on_progress.send(MonteCarloProgress {
                    run_id,
                    completed: control.completed(),
                    total,
                });
            }
        });
        let result = work();
        done.store(true, Ordering::Relaxed);
        result
    })
}

/// Monte Carlo run: N stochastic paths in parallel, returning a success rate
/// and per-period net-worth percentiles — or `None` if the run was cancelled,
/// which is not an error: the caller asked for it and keeps its last result.
///
/// Async, with the engine on a blocking thread, so rayon's work never sits
/// on the IPC thread and the window stays live for the duration. Starting a
/// run cancels the one before it.
///
/// The path count arrives from the frontend, so it is clamped here as well as
/// in `settings::set_monte_carlo_paths` — this command is stateless and will
/// run whatever it is handed.
#[tauri::command]
pub async fn run_monte_carlo(
    state: tauri::State<'_, MonteCarloState>,
    plan: Plan,
    config: MonteCarloConfig,
    run_id: u32,
    on_progress: Channel<MonteCarloProgress>,
) -> Result<Option<MonteCarloResult>, String> {
    require_valid(&plan)?;
    let config = MonteCarloConfig {
        n_paths: settings::clamp_monte_carlo_paths(config.n_paths),
        ..config
    };

    let worker = claim_slot(&state, run_id);
    let control = worker.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let total = config.n_paths;
        with_progress(&control, run_id, total, on_progress, || {
            engine::run_monte_carlo_with(&plan, &config, &control)
        })
    })
    .await
    .map_err(|e| format!("Monte Carlo worker failed: {e}"))?;

    release_slot(&state, run_id);
    Ok(outcome.ok())
}

/// Monte Carlo across several scenarios in one round-trip — the comparison
/// view's counterpart to `run_projections`, and the reason the Scenarios
/// table can show probability of success at all.
///
/// Per-scenario `Result`, like `run_projections`: one invalid scenario gets
/// its own error and the rest of the table still fills in. The outer `Option`
/// is the batch's cancellation, exactly as in `run_monte_carlo` — a cancel
/// abandons the whole batch, since a table half-measured against a superseded
/// selection is worse than the previous one.
///
/// Every scenario runs at the same `config`, seed included. That is the point:
/// common random numbers mean two scenarios are measured against the same
/// draws, so the *difference* between their success rates is far less noisy
/// than either rate's own sampling margin.
///
/// Scenarios run one after another rather than in parallel — each already
/// saturates rayon across its own paths — and share one `RunControl`, whose
/// counter never resets. That is what makes batch progress a single climbing
/// number rather than a bar that restarts per scenario.
#[tauri::command]
pub async fn run_monte_carlos(
    state: tauri::State<'_, MonteCarloState>,
    plans: Vec<Plan>,
    config: MonteCarloConfig,
    run_id: u32,
    on_progress: Channel<MonteCarloProgress>,
) -> Result<Option<Vec<Result<MonteCarloResult, String>>>, String> {
    let config = MonteCarloConfig {
        n_paths: settings::clamp_monte_carlo_paths(config.n_paths),
        ..config
    };

    // Validated up front so the path total can exclude the scenarios that
    // will never run: a progress bar whose ceiling counts work nobody is
    // doing would stop short of it and look stuck.
    let validated: Vec<Result<Plan, String>> = plans
        .into_iter()
        .map(|plan| require_valid(&plan).map(|()| plan))
        .collect();
    let total = config
        .n_paths
        .saturating_mul(validated.iter().filter(|p| p.is_ok()).count() as u32);

    let worker = claim_slot(&state, run_id);
    let control = worker.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        with_progress(&control, run_id, total, on_progress, || {
            validated
                .into_iter()
                .map(|plan| match plan {
                    // An invalid scenario is this scenario's error, not the
                    // batch's: `Ok(Err(_))` keeps its row and its message.
                    Err(message) => Ok(Err(message)),
                    Ok(plan) => engine::run_monte_carlo_with(&plan, &config, &control).map(Ok),
                })
                // Short-circuits on the first `Cancelled`, which is the whole
                // batch giving up rather than one scenario failing.
                .collect::<Result<Vec<_>, _>>()
        })
    })
    .await
    .map_err(|e| format!("Monte Carlo worker failed: {e}"))?;

    release_slot(&state, run_id);
    Ok(outcome.ok())
}

/// Stops the in-flight run if it is still the one the caller means. A Cancel
/// aimed at a run that has since been replaced is a no-op rather than a
/// cancel of its successor.
#[tauri::command]
pub fn cancel_monte_carlo(state: tauri::State<'_, MonteCarloState>, run_id: u32) {
    if let Some((id, control)) = &*state.0.lock().unwrap() {
        if *id == run_id {
            control.cancel();
        }
    }
}

/// The path-count limits, defined once here and read by the frontend rather
/// than duplicated: the clamp range, and the count above which runs are on
/// demand instead of automatic.
#[derive(Serialize, Clone, Copy)]
pub struct MonteCarloLimits {
    min_paths: u32,
    max_paths: u32,
    auto_run_max_paths: u32,
}

#[tauri::command]
pub fn get_monte_carlo_limits() -> MonteCarloLimits {
    MonteCarloLimits {
        min_paths: settings::MIN_MONTE_CARLO_PATHS,
        max_paths: settings::MAX_MONTE_CARLO_PATHS,
        auto_run_max_paths: settings::AUTO_RUN_MAX_MONTE_CARLO_PATHS,
    }
}

/// Paths per Monte Carlo run. Always a concrete number — the "unset means
/// default" resolution happens in `settings`, so the frontend never carries a
/// second copy of the default.
#[tauri::command]
pub fn get_monte_carlo_paths(app: tauri::AppHandle) -> Result<u32, String> {
    Ok(settings::monte_carlo_paths(&config_dir(&app)?))
}

#[tauri::command]
pub fn set_monte_carlo_paths(app: tauri::AppHandle, paths: u32) -> Result<(), String> {
    settings::set_monte_carlo_paths(&config_dir(&app)?, paths)
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
