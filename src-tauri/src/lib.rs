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
            commands::import_skill,
            commands::scan_skill_package,
            commands::import_skills_from_package,
            commands::delete_skill,
            commands::deploy_skill,
            commands::withdraw_skill,
            commands::add_target,
            commands::remove_target,
            commands::open_path,
            commands::set_skill_tags,
            commands::get_all_tags,
            commands::get_all_tags_info,
            commands::rename_tag,
            commands::set_tag_color,
            commands::delete_tag,
            commands::create_tag,
            commands::reorder_tag,
            commands::reorder_tags
        ])
        .run(tauri::generate_context!())
        .expect("failed to run skill hub");
}
