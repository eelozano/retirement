mod commands;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::run_projection,
            commands::load_plan,
            commands::save_plan,
            commands::list_plans,
            commands::get_presets,
            commands::engine_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
