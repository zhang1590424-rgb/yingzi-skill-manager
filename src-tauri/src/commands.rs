use crate::models::{
    AppState, BulkAdoptItem, BulkAdoptReport, DeployTarget, DetectedAgent, OnboardingStatus,
    OperationReport, TargetStatus,
};
use crate::storage::{
    copy_dir_all, create_dir_symlink, is_link_to, remove_path, resolve_symlink_target, slugify,
    Store,
};
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[tauri::command]
pub fn get_app_state() -> Result<AppState, String> {
    run(|| Store::new()?.load_app_state())
}

#[tauri::command]
pub fn create_skill(name: String, description: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        let skill_id = slugify(&name);
        let skill_path = store.skill_path(&skill_id);
        if skill_path.exists() {
            return Err(anyhow!("主库里已经存在同名技能：{}", skill_id));
        }
        fs::create_dir_all(&skill_path)?;
        let description = if description.trim().is_empty() {
            "请补充这个技能适用的场景和触发条件。".to_string()
        } else {
            description.trim().to_string()
        };
        let content = format!(
            "---\nname: {}\ndescription: {}\n---\n\n# {}\n\n## 使用场景\n\n{}\n",
            name.trim(),
            description,
            name.trim(),
            description
        );
        fs::write(skill_path.join("SKILL.md"), content)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn import_skill(source_path: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        let source = PathBuf::from(source_path);
        if !source.is_dir() {
            return Err(anyhow!("请选择一个技能文件夹"));
        }
        if !source.join("SKILL.md").exists() {
            return Err(anyhow!("该文件夹缺少 SKILL.md，不能作为正式技能入库"));
        }
        let name = source
            .file_name()
            .ok_or_else(|| anyhow!("无法识别技能文件夹名称"))?
            .to_string_lossy()
            .to_string();
        let skill_id = slugify(&name);
        let target = store.skill_path(&skill_id);
        if target.exists() {
            return Err(anyhow!("主库里已经存在同名技能：{}", skill_id));
        }
        copy_dir_all(&source, &target)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn delete_skill(skill_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        let state = store.load_app_state()?;
        let active_count = state
            .global_workspaces
            .iter()
            .flat_map(|workspace| workspace.statuses.iter())
            .chain(
                state
                    .project_workspaces
                    .iter()
                    .flat_map(|workspace| workspace.statuses.iter()),
            )
            .filter(|status| {
                status.skill_id == skill_id
                    && matches!(status.status, crate::models::SkillStatus::Enabled)
            })
            .count();
        if active_count > 0 {
            return Err(anyhow!(
                "该技能仍有 {} 个启用位置，请先收回后再删除",
                active_count
            ));
        }
        let skill_path = store.skill_path(&skill_id);
        if skill_path.exists() {
            remove_path(&skill_path)?;
        }
        store.load_app_state()
    })
}

#[tauri::command]
pub fn deploy_skill(
    skill_id: String,
    targets: Vec<DeployTarget>,
    overwrite: bool,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        let mut report = OperationReport::empty();
        deploy_skill_internal(&store, &skill_id, &targets, overwrite, &mut report)?;
        Ok(report)
    })
}

#[tauri::command]
pub fn withdraw_skill(
    skill_id: String,
    targets: Vec<DeployTarget>,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        let mut report = OperationReport::empty();
        withdraw_skill_internal(&store, &skill_id, &targets, &mut report)?;
        Ok(report)
    })
}

#[tauri::command]
pub fn adopt_skill_from_target(
    agent_id: String,
    project_id: Option<String>,
    skill_name: String,
) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        adopt_skill_internal(&store, &agent_id, project_id.as_deref(), &skill_name)?;
        store.load_app_state()
    })
}

fn adopt_skill_internal(
    store: &Store,
    agent_id: &str,
    project_id: Option<&str>,
    skill_name: &str,
) -> Result<()> {
    let agent = store.find_agent(agent_id)?;
    let root = if let Some(project_id) = project_id {
        let project = store.find_project(project_id)?;
        PathBuf::from(project.path).join(agent.project_relative_path)
    } else {
        PathBuf::from(agent.global_path)
    };
    let source = root.join(skill_name);
    if !source.exists() && fs::symlink_metadata(&source).is_err() {
        return Err(anyhow!("目标技能不存在：{}", source.display()));
    }

    let source_for_copy = resolve_symlink_target(&source).unwrap_or_else(|| source.clone());
    if !source_for_copy.join("SKILL.md").exists() {
        return Err(anyhow!("该目标缺少 SKILL.md，暂不自动入库"));
    }

    let skill_id = slugify(skill_name);
    let library_target = store.skill_path(&skill_id);
    if !library_target.exists() {
        copy_dir_all(&source_for_copy, &library_target)?;
    }

    if fs::symlink_metadata(&source).is_ok() {
        remove_path(&source)?;
    }
    if let Some(parent) = source.parent() {
        fs::create_dir_all(parent)?;
    }
    create_dir_symlink(&library_target, &source)?;
    Ok(())
}

#[tauri::command]
pub fn add_project(path: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.add_project(Path::new(&path))?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn add_agent(global_path: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.add_agent(Path::new(&global_path))?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn remove_project(project_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.remove_project(&project_id)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn remove_agent(agent_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.remove_agent(&agent_id)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn update_agent_path(agent_id: String, path: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.update_agent_path(&agent_id, Path::new(&path))?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn upsert_preset(
    id: Option<String>,
    name: String,
    description: String,
    skill_ids: Vec<String>,
) -> Result<AppState, String> {
    run(|| {
        if name.trim().is_empty() {
            return Err(anyhow!("技能组合名称不能为空"));
        }
        let store = Store::new()?;
        store.upsert_preset(id, name, description, skill_ids)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn delete_preset(id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.delete_preset(&id)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn apply_preset(
    preset_id: String,
    targets: Vec<DeployTarget>,
    overwrite: bool,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        let preset = store.find_preset(&preset_id)?;
        let mut report = OperationReport::empty();
        for skill_id in preset.skill_ids {
            deploy_skill_internal(&store, &skill_id, &targets, overwrite, &mut report)?;
        }
        Ok(report)
    })
}

#[tauri::command]
pub fn withdraw_preset(
    preset_id: String,
    targets: Vec<DeployTarget>,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        let preset = store.find_preset(&preset_id)?;
        let mut report = OperationReport::empty();
        for skill_id in preset.skill_ids {
            withdraw_skill_internal(&store, &skill_id, &targets, &mut report)?;
        }
        Ok(report)
    })
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    run(|| {
        let path = PathBuf::from(path);
        if !path.exists() {
            return Err(anyhow!("路径不存在：{}", path.display()));
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(path).spawn()?;
        }
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer").arg(path).spawn()?;
        }
        #[cfg(target_os = "linux")]
        {
            Command::new("xdg-open").arg(path).spawn()?;
        }
        Ok(())
    })
}

fn deploy_skill_internal(
    store: &Store,
    skill_id: &str,
    targets: &[DeployTarget],
    overwrite: bool,
    report: &mut OperationReport,
) -> Result<()> {
    let skill_path = store.skill_path(skill_id);
    if !skill_path.exists() {
        return Err(anyhow!("主库里不存在该技能：{}", skill_id));
    }

    for target in targets {
        let target_path = target_skill_path(store, target, skill_id)?;
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if fs::symlink_metadata(&target_path).is_ok() {
            if is_link_to(&target_path, &skill_path) {
                report.skipped += 1;
                continue;
            }
            if !overwrite {
                report
                    .conflicts
                    .push(format!("{} 已存在同名内容", target_path.display()));
                continue;
            }
            remove_path(&target_path)
                .with_context(|| format!("无法覆盖 {}", target_path.display()))?;
        }

        create_dir_symlink(&skill_path, &target_path)
            .with_context(|| format!("无法创建软链接 {}", target_path.display()))?;
        report.changed += 1;
    }
    Ok(())
}

fn withdraw_skill_internal(
    store: &Store,
    skill_id: &str,
    targets: &[DeployTarget],
    report: &mut OperationReport,
) -> Result<()> {
    let skill_path = store.skill_path(skill_id);
    for target in targets {
        let target_path = target_skill_path(store, target, skill_id)?;
        if fs::symlink_metadata(&target_path).is_err() {
            report.skipped += 1;
            continue;
        }
        if is_link_to(&target_path, &skill_path) {
            fs::remove_file(&target_path)?;
            report.changed += 1;
        } else {
            report.errors.push(format!(
                "{} 不是指向主库的软链接，已跳过",
                target_path.display()
            ));
        }
    }
    Ok(())
}

fn target_skill_path(store: &Store, target: &DeployTarget, skill_id: &str) -> Result<PathBuf> {
    let agent = store.find_agent(&target.agent_id)?;
    let root = if let Some(project_id) = &target.project_id {
        let project = store.find_project(project_id)?;
        PathBuf::from(project.path).join(agent.project_relative_path)
    } else {
        PathBuf::from(agent.global_path)
    };
    Ok(root.join(skill_id))
}

fn run<T>(operation: impl FnOnce() -> Result<T>) -> Result<T, String> {
    operation().map_err(|error| format!("{:#}", error))
}

#[tauri::command]
pub fn get_onboarding_status() -> Result<OnboardingStatus, String> {
    run(|| Store::new()?.onboarding_status())
}

#[tauri::command]
pub fn detect_default_agents() -> Result<Vec<DetectedAgent>, String> {
    run(|| Store::new()?.detect_default_agents())
}

#[tauri::command]
pub fn set_agent_enabled(agent_id: String, enabled: bool) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.set_agent_enabled(&agent_id, enabled)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn set_onboarding_completed(value: bool) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.set_onboarding_completed(value)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn list_unmanaged_for_onboarding() -> Result<Vec<TargetStatus>, String> {
    run(|| Store::new()?.list_unmanaged_in_enabled_agents())
}

#[tauri::command]
pub fn bulk_adopt_skills(items: Vec<BulkAdoptItem>) -> Result<BulkAdoptReport, String> {
    run(|| {
        let store = Store::new()?;
        let mut changed = 0usize;
        let mut errors = Vec::new();
        for item in items {
            match adopt_skill_internal(
                &store,
                &item.agent_id,
                item.project_id.as_deref(),
                &item.skill_name,
            ) {
                Ok(()) => changed += 1,
                Err(error) => errors.push(format!("{}：{:#}", item.skill_name, error)),
            }
        }
        let state = store.load_app_state()?;
        Ok(BulkAdoptReport {
            state,
            changed,
            errors,
        })
    })
}
