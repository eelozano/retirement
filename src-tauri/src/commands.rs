//! Tauri IPC surface — a thin adapter over the engine and storage layers.

use std::path::PathBuf;

use engine::model::Plan;
use engine::presets::Presets;
use engine::Projection;
use tauri::Manager;

use crate::storage;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolving app data dir: {e}"))
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

/// Load the current plan, bootstrapping the seed plan on first run.
#[tauri::command]
pub fn load_plan(app: tauri::AppHandle) -> Result<Plan, String> {
    storage::load_or_bootstrap(&data_dir(&app)?)
}

#[tauri::command]
pub fn save_plan(app: tauri::AppHandle, plan: Plan) -> Result<(), String> {
    require_valid(&plan)?;
    storage::save_plan(&data_dir(&app)?, &plan)
}

#[tauri::command]
pub fn list_plans(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    storage::list_plans(&data_dir(&app)?)
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
