mod commands;
mod models;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::create_skill,
            commands::import_skill,
            commands::install_skill_from_market,
            commands::delete_skill,
            commands::deploy_skill,
            commands::withdraw_skill,
            commands::adopt_skill_from_target,
            commands::add_project,
            commands::remove_project,
            commands::update_agent_path,
            commands::upsert_preset,
            commands::delete_preset,
            commands::apply_preset,
            commands::withdraw_preset,
            commands::open_path
        ])
        .run(tauri::generate_context!())
        .expect("failed to run skill hub");
}
