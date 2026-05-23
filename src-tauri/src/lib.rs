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
            commands::scan_skill_package,
            commands::import_skills_from_package,
            commands::scan_builtin_preset_skills,
            commands::install_builtin_preset_skills,
            commands::delete_skill,
            commands::deploy_skill,
            commands::withdraw_skill,
            commands::adopt_skill_from_target,
            commands::add_project,
            commands::add_agent,
            commands::remove_project,
            commands::remove_agent,
            commands::update_agent_path,
            commands::upsert_preset,
            commands::delete_preset,
            commands::apply_preset,
            commands::withdraw_preset,
            commands::open_path,
            commands::get_onboarding_status,
            commands::detect_default_agents,
            commands::set_agent_enabled,
            commands::set_onboarding_completed,
            commands::list_unmanaged_for_onboarding,
            commands::bulk_adopt_skills,
            commands::ignore_issue_keys,
            commands::resolve_broken_issue_keys
        ])
        .run(tauri::generate_context!())
        .expect("failed to run skill hub");
}
