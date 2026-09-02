mod commands;
mod migrate;
#[cfg(target_os = "macos")]
mod pdf;
mod settings;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::SnapshotState::default())
        .invoke_handler(tauri::generate_handler![
            commands::run_projection,
            commands::run_projections,
            commands::run_monte_carlo,
            commands::load_plan,
            commands::load_plan_named,
            commands::save_plan,
            commands::list_plans,
            commands::set_active_plan,
            commands::duplicate_plan,
            commands::delete_plan,
            commands::list_snapshots,
            commands::restore_snapshot,
            commands::get_presets,
            commands::engine_version,
            commands::get_storage_info,
            commands::choose_storage_dir,
            commands::set_storage_dir,
            commands::reveal_storage_dir,
            commands::export_plans,
            commands::export_text_file,
            commands::print_window,
            commands::export_report_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
