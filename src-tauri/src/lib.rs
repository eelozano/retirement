/// Placeholder command proving the frontend → Tauri → engine pipeline.
/// Replaced by real commands (run_projection, load/save_plan) in M2.
#[tauri::command]
fn engine_version() -> String {
    engine::version().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![engine_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
