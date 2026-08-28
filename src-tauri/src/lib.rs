mod commands;
mod migrate;
mod settings;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::run_projection,
            commands::run_projections,
            commands::load_plan,
            commands::load_plan_named,
            commands::save_plan,
            commands::list_plans,
            commands::set_active_plan,
            commands::duplicate_plan,
            commands::delete_plan,
            commands::get_presets,
            commands::engine_version,
            commands::get_storage_info,
            commands::choose_storage_dir,
            commands::set_storage_dir,
            commands::reveal_storage_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
