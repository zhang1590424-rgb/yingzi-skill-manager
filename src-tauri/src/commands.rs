use crate::models::{
    AppState, BulkAdoptItem, BulkAdoptReport, DeployTarget, DetectedAgent, OnboardingStatus,
    OperationReport, PackageImportReport, PackageSkill, SkillPackageScan, TargetStatus,
};
use crate::storage::{
    copy_dir_all, create_dir_symlink, is_link_to, remove_path, resolve_symlink_target, slugify,
    Store,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::Manager;

const BUILTIN_PRESET_RESOURCE_DIR: &str = "preset-skills";

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
            return Err(anyhow!("已存在同名技能：{}", skill_id));
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
        if source.is_dir() {
            import_skill_folder(&store, &source)?;
        } else if source.is_file() {
            import_skill_zip(&store, &source)?;
        } else {
            return Err(anyhow!("请选择一个技能文件夹或 .zip 压缩包"));
        }
        store.load_app_state()
    })
}

#[tauri::command]
pub fn scan_skill_package(package_path: String) -> Result<SkillPackageScan, String> {
    run(|| {
        let store = Store::new()?;
        scan_skill_package_internal(&store, &package_path)
    })
}

#[tauri::command]
pub fn import_skills_from_package(
    package_path: String,
    skill_ids: Vec<String>,
) -> Result<PackageImportReport, String> {
    run(|| {
        let store = Store::new()?;
        let scan = scan_skill_package_internal(&store, &package_path)?;
        let requested: HashSet<String> = skill_ids.into_iter().collect();
        let package = PathBuf::from(&package_path);
        let entries = list_zip_entries(&package)?;
        let mut changed = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();

        for skill in scan.skills {
            if !requested.contains(&skill.id) {
                continue;
            }
            let target = store.skill_path(&skill.id);
            if target.exists() {
                skipped += 1;
                continue;
            }
            match import_package_skill(&package, &entries, &skill, &target) {
                Ok(()) => changed += 1,
                Err(error) => {
                    if target.exists() {
                        let _ = remove_path(&target);
                    }
                    errors.push(format!("{}：{:#}", skill.display_name, error));
                }
            }
        }

        Ok(PackageImportReport {
            state: store.load_app_state()?,
            changed,
            skipped,
            errors,
        })
    })
}

#[tauri::command]
pub fn scan_builtin_preset_skills(app: tauri::AppHandle) -> Result<SkillPackageScan, String> {
    run(|| {
        let store = Store::new()?;
        let root = builtin_preset_skills_dir(&app)?;
        scan_builtin_preset_skills_internal(&store, &root)
    })
}

#[tauri::command]
pub fn install_builtin_preset_skills(
    app: tauri::AppHandle,
    skill_ids: Vec<String>,
) -> Result<PackageImportReport, String> {
    run(|| {
        let store = Store::new()?;
        let root = builtin_preset_skills_dir(&app)?;
        let scan = scan_builtin_preset_skills_internal(&store, &root)?;
        let requested: HashSet<String> = skill_ids.into_iter().collect();
        let mut changed = 0usize;
        let mut skipped = 0usize;
        let mut errors = Vec::new();

        for skill in scan.skills {
            if !requested.contains(&skill.id) {
                continue;
            }
            let source = root.join(&skill.name);
            let target = store.skill_path(&skill.id);
            if target.exists() {
                skipped += 1;
                continue;
            }
            match import_builtin_preset_skill(&source, &target) {
                Ok(()) => changed += 1,
                Err(error) => {
                    if target.exists() {
                        let _ = remove_path(&target);
                    }
                    errors.push(format!("{}：{:#}", skill.display_name, error));
                }
            }
        }

        Ok(PackageImportReport {
            state: store.load_app_state()?,
            changed,
            skipped,
            errors,
        })
    })
}

fn import_skill_folder(store: &Store, source: &Path) -> Result<String> {
    if !source.join("SKILL.md").exists() {
        return Err(anyhow!("这个文件夹缺少 SKILL.md"));
    }
    let name = source
        .file_name()
        .ok_or_else(|| anyhow!("无法识别技能文件夹名称"))?
        .to_string_lossy()
        .to_string();
    import_skill_source(store, source, &name)
}

fn import_skill_zip(store: &Store, archive: &Path) -> Result<Vec<String>> {
    let extension = archive
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase());
    if extension.as_deref() != Some("zip") {
        return Err(anyhow!("只支持导入 .zip 压缩包"));
    }

    validate_zip_entries(archive)?;

    let temp_root = store.base_dir.join(".import-temp");
    fs::create_dir_all(&temp_root).context("无法创建导入临时目录")?;
    let extract_root = temp_root.join(format!("zip-{}", Utc::now().timestamp_millis()));
    fs::create_dir_all(&extract_root).context("无法创建压缩包解压目录")?;

    let result = (|| {
        let output = Command::new("unzip")
            .arg("-qq")
            .arg(archive)
            .arg("-d")
            .arg(&extract_root)
            .output()
            .context("无法调用系统 unzip 解压压缩包")?;
        if !output.status.success() {
            return Err(anyhow!(
                "无法解压 .zip 压缩包，请确认文件未损坏：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let candidates = find_zip_skill_candidates(archive, &extract_root)?;
        validate_import_candidates(store, &candidates)?;

        let mut imported = Vec::new();
        for candidate in candidates {
            match import_skill_source(store, &candidate.source, &candidate.name) {
                Ok(skill_id) => imported.push(skill_id),
                Err(error) => {
                    rollback_imported_skills(store, &imported);
                    rollback_imported_skills(store, &[slugify(&candidate.name)]);
                    return Err(error.context("导入压缩包失败，已回滚已复制技能"));
                }
            }
        }
        Ok(imported)
    })();

    if extract_root.exists() {
        let _ = fs::remove_dir_all(&extract_root);
    }

    result
}

fn validate_zip_entries(archive: &Path) -> Result<()> {
    let output = Command::new("unzip")
        .arg("-Z1")
        .arg(archive)
        .output()
        .context("无法读取 .zip 压缩包目录")?;
    if !output.status.success() {
        return Err(anyhow!(
            "无法读取 .zip 压缩包，请确认文件未损坏：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    for entry in String::from_utf8_lossy(&output.stdout).lines() {
        if entry.trim().is_empty() {
            continue;
        }
        let path = Path::new(entry);
        for component in path.components() {
            if matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(anyhow!("压缩包包含不安全路径，已拒绝导入：{}", entry));
            }
        }
    }
    Ok(())
}

struct ImportCandidate {
    name: String,
    source: PathBuf,
}

fn find_zip_skill_candidates(archive: &Path, extract_root: &Path) -> Result<Vec<ImportCandidate>> {
    if extract_root.join("SKILL.md").exists() {
        let name = archive
            .file_stem()
            .ok_or_else(|| anyhow!("无法识别压缩包文件名"))?
            .to_string_lossy()
            .to_string();
        return Ok(vec![ImportCandidate {
            name,
            source: extract_root.to_path_buf(),
        }]);
    }

    let mut candidates = Vec::new();
    for entry in fs::read_dir(extract_root).context("无法读取压缩包解压目录")? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "__MACOSX" {
            continue;
        }
        candidates.push(ImportCandidate { name, source: path });
    }

    if candidates.is_empty() {
        return Err(anyhow!("压缩包里没有找到 SKILL.md"));
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(candidates)
}

fn validate_import_candidates(store: &Store, candidates: &[ImportCandidate]) -> Result<()> {
    let mut seen = HashSet::new();
    for candidate in candidates {
        let skill_id = slugify(&candidate.name);
        if !seen.insert(skill_id.clone()) {
            return Err(anyhow!("压缩包里存在导入后同名的技能：{}", skill_id));
        }
        if store.skill_path(&skill_id).exists() {
            return Err(anyhow!("已存在同名技能：{}", skill_id));
        }
    }
    Ok(())
}

fn import_skill_source(store: &Store, source: &Path, name: &str) -> Result<String> {
    let skill_id = slugify(name);
    let target = store.skill_path(&skill_id);
    if target.exists() {
        return Err(anyhow!("已存在同名技能：{}", skill_id));
    }
    copy_dir_all(source, &target)?;
    Ok(skill_id)
}

fn rollback_imported_skills(store: &Store, skill_ids: &[String]) {
    for skill_id in skill_ids {
        let target = store.skill_path(skill_id);
        if target.exists() {
            let _ = remove_path(&target);
        }
    }
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

fn scan_skill_package_internal(store: &Store, package_path: &str) -> Result<SkillPackageScan> {
    let package = PathBuf::from(package_path);
    if !package.is_file() {
        return Err(anyhow!("请选择一个 Skill 压缩包"));
    }

    let existing_ids: HashSet<String> = store
        .scan_library_skills()?
        .into_iter()
        .map(|skill| skill.id)
        .collect();
    let entries = list_zip_entries(&package)?;
    let ignored_plugin_skills = entries
        .iter()
        .filter(|entry| entry.contains("/plugins/") && entry.ends_with("/SKILL.md"))
        .count();
    let mut skills = Vec::new();

    for entry in entries.iter().filter(|entry| entry.ends_with("/SKILL.md")) {
        let parts: Vec<&str> = entry.split('/').collect();
        if parts.len() != 4 || parts[1] != "skills" || parts[3] != "SKILL.md" {
            continue;
        }
        let name = parts[2].to_string();
        let id = slugify(&name);
        let content = String::from_utf8_lossy(&read_zip_entry(&package, entry)?).to_string();
        let (display_name, description) = package_skill_metadata(&name, &content);
        skills.push(PackageSkill {
            id: id.clone(),
            name: name.clone(),
            display_name,
            description,
            category: package_skill_category(&name).to_string(),
            entry_prefix: format!("{}/{}/{}", parts[0], parts[1], parts[2]),
            exists: existing_ids.contains(&id),
        });
    }

    skills.sort_by(|a, b| {
        package_category_order(&a.category)
            .cmp(&package_category_order(&b.category))
            .then(package_skill_order(&a.name).cmp(&package_skill_order(&b.name)))
            .then(a.display_name.cmp(&b.display_name))
    });

    Ok(SkillPackageScan {
        package_path: package_path.to_string(),
        skills,
        ignored_plugin_skills,
    })
}

fn builtin_preset_skills_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUILTIN_PRESET_RESOURCE_DIR);
    if dev_dir.is_dir() {
        return Ok(dev_dir);
    }

    let resource_dir = app.path().resource_dir().context("无法定位应用资源目录")?;
    let bundled_dir = resource_dir.join(BUILTIN_PRESET_RESOURCE_DIR);
    if bundled_dir.is_dir() {
        return Ok(bundled_dir);
    }

    Err(anyhow!("预置 Skill 暂时不可用，可以先跳过。"))
}

fn scan_builtin_preset_skills_internal(store: &Store, root: &Path) -> Result<SkillPackageScan> {
    if !root.is_dir() {
        return Err(anyhow!("预置 Skill 暂时不可用，可以先跳过。"));
    }

    let existing_ids: HashSet<String> = store
        .scan_library_skills()?
        .into_iter()
        .map(|skill| skill.id)
        .collect();
    let mut skills = Vec::new();

    for entry in fs::read_dir(root).context("无法读取预置 Skill")? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let id = slugify(&name);
        let content = fs::read_to_string(path.join("SKILL.md"))
            .with_context(|| format!("无法读取预置 Skill：{}", name))?;
        let (display_name, description) = package_skill_metadata(&name, &content);
        skills.push(PackageSkill {
            id: id.clone(),
            name: name.clone(),
            display_name,
            description,
            category: package_skill_category(&name).to_string(),
            entry_prefix: name,
            exists: existing_ids.contains(&id),
        });
    }

    skills.sort_by(|a, b| {
        package_category_order(&a.category)
            .cmp(&package_category_order(&b.category))
            .then(package_skill_order(&a.name).cmp(&package_skill_order(&b.name)))
            .then(a.display_name.cmp(&b.display_name))
    });

    Ok(SkillPackageScan {
        package_path: "builtin".to_string(),
        skills,
        ignored_plugin_skills: 0,
    })
}

fn import_builtin_preset_skill(source: &Path, target: &Path) -> Result<()> {
    if !source.join("SKILL.md").exists() {
        return Err(anyhow!("预置 Skill 缺少 SKILL.md"));
    }
    copy_dir_all(source, target)?;
    if !target.join("SKILL.md").exists() {
        if target.exists() {
            remove_path(target)?;
        }
        return Err(anyhow!("安装后缺少 SKILL.md"));
    }
    Ok(())
}

fn list_zip_entries(package: &Path) -> Result<Vec<String>> {
    let output = Command::new("unzip")
        .arg("-Z1")
        .arg(package)
        .output()
        .with_context(|| format!("无法读取压缩包目录：{}", package.display()))?;
    if !output.status.success() {
        return Err(anyhow!(
            "无法读取压缩包目录：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn read_zip_entry(package: &Path, entry: &str) -> Result<Vec<u8>> {
    let output = Command::new("unzip")
        .arg("-p")
        .arg(package)
        .arg(entry)
        .output()
        .with_context(|| format!("无法读取压缩包文件：{}", entry))?;
    if !output.status.success() {
        return Err(anyhow!(
            "无法读取压缩包文件：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn import_package_skill(
    package: &Path,
    entries: &[String],
    skill: &PackageSkill,
    target: &Path,
) -> Result<()> {
    let entry_prefix = format!("{}/", skill.entry_prefix);
    for entry in entries
        .iter()
        .filter(|entry| entry.starts_with(&entry_prefix))
    {
        if entry.ends_with('/') || should_skip_package_entry(entry) {
            continue;
        }
        let relative = entry
            .strip_prefix(&skill.entry_prefix)
            .ok_or_else(|| anyhow!("无法计算压缩包相对路径"))?
            .trim_start_matches('/');
        if !is_safe_relative_path(relative) {
            continue;
        }
        let target_file = target.join(relative);
        if let Some(parent) = target_file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target_file, read_zip_entry(package, entry)?)?;
    }
    if !target.join("SKILL.md").exists() {
        if target.exists() {
            remove_path(target)?;
        }
        return Err(anyhow!("导入后缺少 SKILL.md"));
    }
    Ok(())
}

fn should_skip_package_entry(entry: &str) -> bool {
    entry
        .rsplit('/')
        .next()
        .is_some_and(|name| name == ".DS_Store" || name.starts_with("._"))
}

fn is_safe_relative_path(relative: &str) -> bool {
    !relative.is_empty()
        && !relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn package_skill_metadata(name: &str, content: &str) -> (String, String) {
    let title = content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .unwrap_or(name)
        .to_string();
    let description = frontmatter_description(content)
        .or_else(|| {
            content
                .lines()
                .find(|line| {
                    let trimmed = line.trim();
                    !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with("---")
                })
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_else(|| "暂无说明".to_string());
    (title, description)
}

fn frontmatter_description(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()? != "---" {
        return None;
    }
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if value == "|" || value == ">-" || value == ">" {
                let mut collected = Vec::new();
                for next in lines.by_ref() {
                    if next.trim() == "---" {
                        break;
                    }
                    if next.starts_with(' ') || next.starts_with('\t') || next.trim().is_empty() {
                        let cleaned = next.trim();
                        if !cleaned.is_empty() {
                            collected.push(cleaned.to_string());
                        }
                    } else {
                        break;
                    }
                }
                let joined = collected.join(" ");
                return (!joined.is_empty()).then_some(joined);
            }
            return (!value.is_empty()).then_some(value.to_string());
        }
    }
    None
}

fn package_skill_category(name: &str) -> &'static str {
    match name {
        "brainstorming" | "office-hours" | "plan-ceo-review" | "storyline" => "产品创意",
        "ug-num-strategy" | "ug-prd-review-jc-style" | "ab-test-setup" | "experiment-ux-guard" => {
            "需求编写"
        }
        "ui-ux-pro-max" | "design-taste-skill-pack" | "impeccable" => "UI 设计",
        _ => "其他工具",
    }
}

fn package_category_order(category: &str) -> usize {
    match category {
        "产品创意" => 0,
        "需求编写" => 1,
        "UI 设计" => 2,
        "其他工具" => 3,
        _ => 4,
    }
}

fn package_skill_order(name: &str) -> usize {
    match name {
        "brainstorming" => 0,
        "office-hours" => 1,
        "plan-ceo-review" => 2,
        "storyline" => 3,
        "ug-num-strategy" => 4,
        "ug-prd-review-jc-style" => 5,
        "ab-test-setup" => 6,
        "experiment-ux-guard" => 7,
        "ui-ux-pro-max" => 8,
        "design-taste-skill-pack" => 9,
        "impeccable" => 10,
        "agent-browser" => 11,
        "find-skills" => 12,
        "skill-creator" => 13,
        _ => 99,
    }
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

#[tauri::command]
pub fn ignore_issue_keys(issue_keys: Vec<String>) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.ignore_issue_keys(&issue_keys)?;
        store.load_app_state()
    })
}

#[tauri::command]
pub fn resolve_broken_issue_keys(issue_keys: Vec<String>) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        store.resolve_broken_issue_keys(&issue_keys)
    })
}
