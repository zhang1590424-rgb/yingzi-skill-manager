use crate::models::{
    AppState, DeployTarget, OperationItem, OperationReport, PackageImportReport, PackageSkill,
    PathFingerprint, SkillContent, SkillPackageScan,
};
use crate::storage::{
    compute_skills_path, copy_dir_all, create_dir_symlink, fingerprint_of, is_link_to, remove_path,
    slugify, Store,
};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[tauri::command(async)]
pub fn get_app_state() -> Result<AppState, String> {
    run(|| Store::new()?.load_app_state())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn scan_skill_package(package_path: String) -> Result<SkillPackageScan, String> {
    run(|| {
        let store = Store::new()?;
        scan_skill_package_internal(&store, &package_path)
    })
}

#[tauri::command(async)]
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
        // 拒绝反斜杠分隔与任何形式的 `..` 回退（含 Windows 风格 ..\）。
        if entry.contains('\\') || entry.split(['/', '\\']).any(|part| part == "..") {
            return Err(anyhow!("压缩包包含不安全路径，已拒绝导入：{}", entry));
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
        if name == "__MACOSX" || name.starts_with('.') {
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

    // U16: 标签数据库为权威，导入即初始化（含空集合），删除后不从前置 frontmatter 复活。
    let tags = match target.join("SKILL.md").exists() {
        true => fs::read_to_string(target.join("SKILL.md"))
            .ok()
            .map(|c| parse_skill_md_tags(&c))
            .unwrap_or_default(),
        false => Vec::new(),
    };
    store.initialize_skill_tags(&skill_id, &tags)?;

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

#[tauri::command(async)]
pub fn delete_skill(skill_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        let state = store.load_app_state()?;
        let active_count = state
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.statuses.iter())
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
        store.forget_skill_tags(&skill_id)?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
pub fn get_skill_content(skill_id: String) -> Result<SkillContent, String> {
    run(|| {
        let store = Store::new()?;
        let md = store.skill_path(&skill_id).join("SKILL.md");
        let raw = fs::read_to_string(&md)
            .with_context(|| format!("无法读取 SKILL.md：{}", md.display()))?;
        Ok(SkillContent {
            content: render_skill_body(&raw),
        })
    })
}

#[tauri::command(async)]
pub fn get_target_fingerprint(
    skill_id: String,
    target_id: String,
) -> Result<PathFingerprint, String> {
    run(|| {
        let store = Store::new()?;
        let root = resolve_target_root(&store, &DeployTarget {
            target_id: target_id.clone(),
            expected: None,
        })?;
        Ok(fingerprint_of(&root.join(&skill_id)))
    })
}

#[tauri::command(async)]
pub fn deploy_skill(
    skill_id: String,
    targets: Vec<DeployTarget>,
    overwrite: bool,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        deploy_skill_internal(&store, &skill_id, &targets, overwrite)
    })
}

#[tauri::command(async)]
pub fn withdraw_skill(
    skill_id: String,
    targets: Vec<DeployTarget>,
) -> Result<OperationReport, String> {
    run(|| {
        let store = Store::new()?;
        withdraw_skill_internal(&store, &skill_id, &targets)
    })
}

#[tauri::command(async)]
pub fn add_target(path: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.add_target(Path::new(&path))?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
pub fn remove_target(target_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.remove_target(&target_id)?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
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

#[derive(PartialEq)]
enum Presence {
    Absent,
    Present,
    Unreadable,
}

fn presence(path: &Path) -> Presence {
    match fs::symlink_metadata(path) {
        Ok(_) => Presence::Present,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Presence::Absent,
        Err(_) => Presence::Unreadable,
    }
}

fn make_item(skill_id: &str, target_id: &str, outcome: &str, message: String) -> OperationItem {
    OperationItem {
        skill_id: skill_id.to_string(),
        target_id: target_id.to_string(),
        outcome: outcome.to_string(),
        message,
    }
}

fn finalize(items: Vec<OperationItem>) -> OperationReport {
    let mut report = OperationReport::empty();
    for item in &items {
        match item.outcome.as_str() {
            "changed" => report.changed += 1,
            "skipped" => report.skipped += 1,
            "conflict" => report.conflicts.push(item.message.clone()),
            "error" => report.errors.push(item.message.clone()),
            _ => {}
        }
    }
    report.items = items;
    report
}

fn deploy_skill_internal(
    store: &Store,
    skill_id: &str,
    targets: &[DeployTarget],
    overwrite: bool,
) -> Result<OperationReport> {
    let skill_path = store.skill_path(skill_id);
    if !skill_path.exists() {
        return Err(anyhow!("主库里不存在该技能：{}", skill_id));
    }
    let mut items = Vec::new();
    for target in targets {
        items.push(deploy_one_target(store, skill_id, &skill_path, target, overwrite));
    }
    Ok(finalize(items))
}

fn deploy_one_target(
    store: &Store,
    skill_id: &str,
    skill_path: &Path,
    target: &DeployTarget,
    overwrite: bool,
) -> OperationItem {
    let root = match resolve_target_root(store, target) {
        Ok(r) => r,
        Err(error) => return make_item(skill_id, &target.target_id, "error", format!("{:#}", error)),
    };
    if let Err(error) = fs::create_dir_all(&root) {
        return make_item(skill_id, &target.target_id, "error", format!("无法创建技能目录 {}：{:#}", root.display(), error));
    }
    let target_path = root.join(skill_id);

    if presence(&target_path) == Presence::Present && is_link_to(&target_path, skill_path) {
        return make_item(skill_id, &target.target_id, "skipped", format!("已应用：{}", target_path.display()));
    }
    match presence(&target_path) {
        Presence::Unreadable => make_item(skill_id, &target.target_id, "error", format!("无法读取目标位置，请检查权限：{}", target_path.display())),
        Presence::Absent => match create_dir_symlink(skill_path, &target_path) {
            Ok(_) => make_item(skill_id, &target.target_id, "changed", format!("已应用：{}", target_path.display())),
            Err(error) => make_item(skill_id, &target.target_id, "error", format!("{:#}", error.context(format!("无法创建软链接 {}", target_path.display())))),
        },
        Presence::Present => {
            if !overwrite {
                return make_item(skill_id, &target.target_id, "conflict", format!("{} 已存在同名内容，未覆盖", target_path.display()));
            }
            let current = fingerprint_of(&target_path);
            if current.kind == "unknown" {
                return make_item(skill_id, &target.target_id, "error", format!("{} 内容无法完整读取，拒绝覆盖", target_path.display()));
            }
            match &target.expected {
                None => return make_item(skill_id, &target.target_id, "conflict", format!("{} 存在同名内容，需明确确认后覆盖", target_path.display())),
                Some(expected) if *expected != current => return make_item(skill_id, &target.target_id, "error", format!("{} 内容已变化，请重新确认", target_path.display())),
                _ => {}
            }
            match remove_path(&target_path).with_context(|| format!("无法覆盖 {}", target_path.display())) {
                Ok(_) => {}
                Err(error) => return make_item(skill_id, &target.target_id, "error", format!("{:#}", error)),
            }
            match create_dir_symlink(skill_path, &target_path) {
                Ok(_) => make_item(skill_id, &target.target_id, "changed", format!("已覆盖：{}", target_path.display())),
                Err(error) => make_item(skill_id, &target.target_id, "error", format!("{:#}", error.context(format!("无法创建软链接 {}", target_path.display())))),
            }
        }
    }
}

fn withdraw_skill_internal(
    store: &Store,
    skill_id: &str,
    targets: &[DeployTarget],
) -> Result<OperationReport> {
    let skill_path = store.skill_path(skill_id);
    let mut items = Vec::new();
    for target in targets {
        items.push(withdraw_one_target(store, skill_id, &skill_path, target));
    }
    Ok(finalize(items))
}

fn withdraw_one_target(
    store: &Store,
    skill_id: &str,
    skill_path: &Path,
    target: &DeployTarget,
) -> OperationItem {
    let root = match resolve_target_root(store, target) {
        Ok(r) => r,
        Err(error) => return make_item(skill_id, &target.target_id, "error", format!("{:#}", error)),
    };
    let target_path = root.join(skill_id);
    match presence(&target_path) {
        Presence::Absent => return make_item(skill_id, &target.target_id, "skipped", format!("未应用：{}", target_path.display())),
        Presence::Unreadable => return make_item(skill_id, &target.target_id, "error", format!("无法读取目标位置，请检查权限：{}", target_path.display())),
        Presence::Present => {}
    }
    if is_link_to(&target_path, skill_path) {
        match fs::remove_file(&target_path) {
            Ok(_) => make_item(skill_id, &target.target_id, "changed", format!("已收回：{}", target_path.display())),
            Err(error) => make_item(skill_id, &target.target_id, "error", format!("{:#}", error)),
        }
    } else {
        make_item(skill_id, &target.target_id, "error", format!("{} 不是指向主库的软链接，未改动", target_path.display()))
    }
}

fn resolve_target_root(store: &Store, target: &DeployTarget) -> Result<PathBuf> {
    let target_model = store.find_target(&target.target_id)?;
    let target_path = Path::new(&target_model.path);
    if !target_path.exists() {
        // U07: 仅默认全局目标允许自动创建；项目根不存在必须报错。
        if target_model.is_default {
            fs::create_dir_all(target_path)
                .with_context(|| format!("无法创建全局技能目录：{}", target_model.path))?;
        } else {
            return Err(anyhow!("目标路径不存在：{}", target_model.path));
        }
    }
    if !target_path.is_dir() {
        return Err(anyhow!("目标路径不是文件夹：{}", target_model.path));
    }
    Ok(compute_skills_path(&target_model.path))
}

fn classify_skill_entry(entry: &str, archive_stem: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = entry.split('/').collect();
    // (a) 根目录 SKILL.md
    if parts.len() == 1 && parts[0] == "SKILL.md" {
        return Some(("".to_string(), archive_stem.to_string()));
    }
    // (b) 一级 <name>/SKILL.md
    if parts.len() == 2 && parts[1] == "SKILL.md" {
        return Some((parts[0].to_string(), parts[0].to_string()));
    }
    // (c) 包根/skills/<name>/SKILL.md
    if parts.len() == 4 && parts[1] == "skills" && parts[3] == "SKILL.md" {
        return Some((parts[0..3].join("/"), parts[2].to_string()));
    }
    None
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
    let archive_stem = package
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".to_string());
    let mut seen: HashSet<String> = HashSet::new();
    let mut skills = Vec::new();

    for entry in entries.iter().filter(|e| e.ends_with("/SKILL.md") || *e == "SKILL.md") {
        let Some((entry_prefix, name)) = classify_skill_entry(entry, &archive_stem) else {
            continue;
        };
        if name == "__MACOSX" || name.starts_with('.') {
            continue;
        }
        let id = slugify(&name);
        if !seen.insert(id.clone()) {
            continue;
        }
        let content = String::from_utf8_lossy(&read_zip_entry(&package, entry)?).to_string();
        let (display_name, description) = package_skill_metadata(&name, &content);
        skills.push(PackageSkill {
            id: id.clone(),
            name: name.clone(),
            display_name,
            description,
            category: package_skill_category(&name).to_string(),
            entry_prefix,
            exists: existing_ids.contains(&id),
            item_kind: "skill".to_string(),
            member_count: 1,
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
        && !relative.contains('\\')
        && !relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
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

/// 渲染 SKILL.md 正文（去 frontmatter + telemetry，不截断）。
fn render_skill_body(content: &str) -> String {
    let trimmed = content.trim_start();
    let body = if trimmed.starts_with("---") {
        let mut lines = trimmed.lines();
        lines.next(); // 跳过起始 ---
        let mut rest = Vec::new();
        let mut past_frontmatter = false;
        for line in lines {
            if !past_frontmatter && line.trim() == "---" {
                past_frontmatter = true;
                continue;
            }
            if past_frontmatter {
                rest.push(line);
            }
        }
        rest.join("\n")
    } else {
        content.to_string()
    };
    let body = body
        .replace("<!-- @telemetry:start -->", "")
        .replace("<!-- @telemetry:end -->", "");
    body.trim().to_string()
}

/// Extract tags from SKILL.md frontmatter for persisting to the database on import.
fn parse_skill_md_tags(content: &str) -> Vec<String> {
    let trimmed = content.trim_start();
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Vec::new();
    }
    let mut collecting_tags = false;
    let mut tag_lines: Vec<String> = Vec::new();
    let mut inline_tags: Vec<String> = Vec::new();

    for line in lines {
        let trimmed_line = line.trim();
        if trimmed_line == "---" {
            break;
        }
        let is_top_level = !line.starts_with(' ') && !line.starts_with('\t');
        if is_top_level {
            if let Some((key, value)) = trimmed_line.split_once(':') {
                let key = key.trim();
                let value = value.trim();
                collecting_tags = false;
                if key == "tags" {
                    if value.is_empty() {
                        collecting_tags = true;
                        tag_lines.clear();
                    } else {
                        inline_tags = parse_inline_tag_value(value);
                    }
                }
                continue;
            }
        }
        if collecting_tags {
            tag_lines.push(trimmed_line.to_string());
        }
    }

    if !inline_tags.is_empty() {
        return inline_tags;
    }
    tag_lines
        .iter()
        .filter_map(|line| {
            let value = line.trim().trim_start_matches('-').trim();
            let value = value.trim_matches('"').trim_matches('\'').trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .collect()
}

fn parse_inline_tag_value(value: &str) -> Vec<String> {
    let value = value.trim().trim_matches('"').trim_matches('\'').trim();
    let inner = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(value);
    inner
        .split(',')
        .map(|tag| tag.trim().trim_matches('"').trim_matches('\'').trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect()
}

#[tauri::command(async)]
pub fn set_skill_tags(skill_id: String, tags: Vec<String>) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.set_skill_tags(&skill_id, &tags)?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
pub fn get_all_tags() -> Result<Vec<String>, String> {
    run(|| Store::new()?.get_all_tags())
}

#[tauri::command(async)]
pub fn get_all_tags_info() -> Result<Vec<crate::models::TagInfo>, String> {
    run(|| Store::new()?.get_all_tags_info())
}

#[tauri::command(async)]
pub fn rename_tag(old_name: String, new_name: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.rename_tag(&old_name, &new_name)?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
pub fn set_tag_color(tag: String, color_index: i32) -> Result<Vec<crate::models::TagInfo>, String> {
    run(|| {
        let store = Store::new()?;
        store.set_tag_color(&tag, color_index)?;
        store.get_all_tags_info()
    })
}

#[tauri::command(async)]
pub fn delete_tag(tag: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.delete_tag(&tag)?;
        store.load_app_state()
    })
}

#[tauri::command(async)]
pub fn create_tag(tag: String) -> Result<Vec<crate::models::TagInfo>, String> {
    run(|| {
        let store = Store::new()?;
        store.create_tag(&tag)?;
        store.get_all_tags_info()
    })
}

#[tauri::command(async)]
pub fn reorder_tag(tag: String, direction: String) -> Result<Vec<crate::models::TagInfo>, String> {
    run(|| {
        let store = Store::new()?;
        store.reorder_tag(&tag, &direction)?;
        store.get_all_tags_info()
    })
}

#[tauri::command(async)]
pub fn reorder_tags(tags: Vec<String>) -> Result<Vec<crate::models::TagInfo>, String> {
    run(|| {
        let store = Store::new()?;
        store.reorder_tags(&tags)?;
        store.get_all_tags_info()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::classify_stat_error;

    fn temp_store(name: &str) -> Store {
        let root = std::env::temp_dir().join(format!(
            "skill-hub-{}-{}-{}",
            name,
            std::process::id(),
            std::thread::current().name().unwrap_or("t").replace(|c: char| !c.is_ascii_alphanumeric(), "")
        ));
        if root.exists() {
            let _ = fs::remove_dir_all(&root);
        }
        let store = Store {
            base_dir: root.clone(),
            skills_root: root.join("skills"),
            database_path: root.join("app.db"),
            config_path: root.join("config.json"),
            is_isolated: false,
            global_root: root.join(".agents").join("skills"),
        };
        fs::create_dir_all(&store.skills_root).unwrap();
        store.ensure_config().unwrap();
        store.ensure_database().unwrap();
        store
    }

    fn insert_target(store: &Store, id: &str, path: &Path, is_default: i64) {
        let conn = store.connection().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO targets (id, name, path, is_default) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, id, path.to_string_lossy().to_string(), is_default],
        )
        .unwrap();
    }

    fn project_target(store: &Store, id: &str, path: &Path) {
        insert_target(store, id, path, 0);
    }

    fn create_library_skill(store: &Store, skill_id: &str, md: &str) {
        let skill_path = store.skill_path(skill_id);
        fs::create_dir_all(&skill_path).unwrap();
        fs::write(skill_path.join("SKILL.md"), md).unwrap();
    }

    fn dt(target_id: &str) -> DeployTarget {
        DeployTarget { target_id: target_id.to_string(), expected: None }
    }

    fn skills_path_for(store: &Store, target_id: &str) -> PathBuf {
        let t = store.find_target(target_id).unwrap();
        compute_skills_path(&t.path)
    }

    fn zip_dir(src: &Path, out_zip: &Path) {
        let status = Command::new("zip")
            .arg("-q").arg("-r").arg(out_zip).arg(".").current_dir(src)
            .status().expect("zip CLI 不可用");
        assert!(status.success());
    }

    fn scanned_ids(store: &Store, zip: &Path) -> Vec<String> {
        scan_skill_package_internal(store, zip.to_str().unwrap())
            .unwrap().skills.into_iter().map(|s| s.id).collect()
    }

    #[test]
    fn deploy_does_not_create_missing_project_root() {
        let store = temp_store("missing-target-root");
        let missing_target = store.base_dir.join("missing-project");
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &missing_target);
        let report = deploy_skill_internal(&store, "demo", &[dt("target-1")], false).unwrap();
        assert_eq!(report.changed, 0);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.items[0].outcome, "error");
        assert!(!missing_target.exists());
    }

    #[test]
    fn deploy_creates_symlink_in_existing_project() {
        let store = temp_store("deploy-existing-target");
        let target_root = store.base_dir.join("my-project");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &target_root);
        let report = deploy_skill_internal(&store, "demo", &[dt("target-1")], false).unwrap();
        assert_eq!(report.changed, 1);
        assert_eq!(report.errors.len(), 0);
        let link = skills_path_for(&store, "target-1").join("demo");
        assert!(is_link_to(&link, &store.skill_path("demo")));
    }

    #[test]
    fn overwrite_false_does_not_delete_occupied_dir() {
        let store = temp_store("no-overwrite");
        let target_root = store.base_dir.join("proj");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &target_root);
        let link = skills_path_for(&store, "target-1").join("demo");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("keep.txt"), "real user content").unwrap();
        let report = deploy_skill_internal(&store, "demo", &[dt("target-1")], false).unwrap();
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.items[0].outcome, "conflict");
        assert!(link.join("keep.txt").exists());
    }

    #[test]
    fn overwrite_requires_expected_and_detects_internal_change() {
        let store = temp_store("overwrite-race");
        let target_root = store.base_dir.join("proj");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &target_root);
        let link = skills_path_for(&store, "target-1").join("demo");
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("a.txt"), "v1").unwrap();

        let report = deploy_skill_internal(&store, "demo", &[dt("target-1")], true).unwrap();
        assert_eq!(report.items[0].outcome, "conflict");
        assert!(link.join("a.txt").exists());

        let fp = fingerprint_of(&link);
        let mut t = dt("target-1");
        t.expected = Some(fp);
        let report = deploy_skill_internal(&store, "demo", &[t], true).unwrap();
        assert_eq!(report.items[0].outcome, "changed");
        assert!(is_link_to(&link, &store.skill_path("demo")));

        let _ = fs::remove_dir_all(&link);
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("b.txt"), "first").unwrap();
        let fp_before = fingerprint_of(&link);
        fs::write(link.join("b.txt"), "changed internally").unwrap();
        let fp_after = fingerprint_of(&link);
        assert_ne!(fp_before, fp_after);
        let mut t2 = dt("target-1");
        t2.expected = Some(fp_before);
        let report = deploy_skill_internal(&store, "demo", &[t2], true).unwrap();
        assert_eq!(report.items[0].outcome, "error");
        assert!(link.join("b.txt").exists());
    }

    #[test]
    fn withdraw_removes_own_link_and_rejects_foreign() {
        let store = temp_store("withdraw");
        let target_root = store.base_dir.join("proj");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &target_root);
        let link = skills_path_for(&store, "target-1").join("demo");
        deploy_skill_internal(&store, "demo", &[dt("target-1")], false).unwrap();
        assert!(link.exists());
        let report = withdraw_skill_internal(&store, "demo", &[dt("target-1")]).unwrap();
        assert_eq!(report.changed, 1);
        assert!(!link.exists());
        fs::create_dir_all(&link).unwrap();
        fs::write(link.join("real.txt"), "x").unwrap();
        let report = withdraw_skill_internal(&store, "demo", &[dt("target-1")]).unwrap();
        assert_eq!(report.items[0].outcome, "error");
        assert!(link.join("real.txt").exists());
    }

    #[test]
    fn remove_target_blocked_by_managed_links() {
        let store = temp_store("remove-protect");
        let target_root = store.base_dir.join("proj");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "target-1", &target_root);
        deploy_skill_internal(&store, "demo", &[dt("target-1")], false).unwrap();
        assert!(store.remove_target("target-1").is_err());
        withdraw_skill_internal(&store, "demo", &[dt("target-1")]).unwrap();
        assert!(store.remove_target("target-1").is_ok());
    }

    fn tgt(id: &str, path: &Path) -> crate::models::Target {
        crate::models::Target {
            id: id.into(),
            name: id.into(),
            path: path.to_string_lossy().to_string(),
            is_default: false,
            path_exists: true,
        }
    }

    #[test]
    fn scan_target_root_classifies_unmanaged_broken_invalid() {
        let store = temp_store("seven");
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        let skills = store.scan_library_skills().unwrap();
        let root = store.base_dir.join("targetskills");
        fs::create_dir_all(&root).unwrap();
        let target = tgt("t1", &store.base_dir.join("proj"));

        std::os::unix::fs::symlink(store.skill_path("demo"), root.join("demo")).unwrap();
        let foreign = store.base_dir.join("foreign-lib");
        fs::create_dir_all(foreign.join("cool")).unwrap();
        fs::write(foreign.join("cool/SKILL.md"), "# cool").unwrap();
        std::os::unix::fs::symlink(foreign.join("cool"), root.join("foreign")).unwrap();
        std::os::unix::fs::symlink(store.base_dir.join("no-such-target"), root.join("dangle")).unwrap();
        let nodoc = store.base_dir.join("nodoc");
        fs::create_dir_all(&nodoc).unwrap();
        std::os::unix::fs::symlink(&nodoc, root.join("nodoc")).unwrap();

        let statuses = store.scan_target_root(&skills, &root, &target).unwrap();
        let kinds: Vec<_> = statuses.iter().map(|s| &s.status).collect();
        assert!(kinds.contains(&&crate::models::SkillStatus::Enabled));
        assert!(kinds.contains(&&crate::models::SkillStatus::Unmanaged));
        assert!(kinds.contains(&&crate::models::SkillStatus::Broken));
        assert!(kinds.contains(&&crate::models::SkillStatus::Invalid));
    }

    #[test]
    fn remove_target_ok_when_only_unrelated_or_broken_links() {        let store = temp_store("remove-clean");
        let target_root = store.base_dir.join("proj");
        let sp = compute_skills_path(target_root.to_str().unwrap());
        fs::create_dir_all(&sp).unwrap();
        fs::write(sp.join("notes.txt"), "x").unwrap();
        std::os::unix::fs::symlink(store.base_dir.join("other"), sp.join("dangle")).unwrap();
        project_target(&store, "t1", &target_root);
        assert!(store.remove_target("t1").is_ok());
    }

    #[test]
    fn default_global_auto_creates_missing() {
        let store = temp_store("global-auto");
        let global = store.global_root.clone();
        assert!(!global.exists());
        insert_target(&store, "agents", &global, 1);
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        let report = deploy_skill_internal(&store, "demo", &[dt("agents")], false).unwrap();
        assert_eq!(report.changed, 1);
        assert!(global.exists());
        assert!(global.join("demo").exists());
    }

    #[test]
    fn tags_are_db_authoritative_no_resurrect() {
        let store = temp_store("tag-authority");
        create_library_skill(&store, "demo", "---\nname: demo\ntags: [旧标签]\n---\n");
        store.initialize_skill_tags("demo", &[]).unwrap();
        let state = store.load_app_state().unwrap();
        let skill = state.skills.iter().find(|s| s.id == "demo").unwrap();
        assert_eq!(skill.tags, Vec::<String>::new());
        store.set_skill_tags("demo", &[" 设计 ".into(), "设计".into(), "  ".into()]).unwrap();
        let info = store.get_all_tags_info().unwrap();
        assert!(info.iter().any(|t| t.name == "设计" && t.count == 1));
        assert!(store.rename_tag("设计", "设计").is_ok());
        store.create_tag("临时").unwrap();
        assert!(store.rename_tag("设计", "临时").is_err());
        store.forget_skill_tags("demo").unwrap();
        let tags = store.get_all_tags().unwrap();
        assert!(!tags.contains(&"设计".to_string()));
    }

    #[test]
    fn render_body_strips_frontmatter_and_telemetry() {
        let raw = "---\nname: X\ndescription: y\n---\n<!-- @telemetry:start -->noise<!-- @telemetry:end -->\n# 正文\n真实内容";
        let body = render_skill_body(raw);
        assert!(body.contains("# 正文"));
        assert!(body.contains("真实内容"));
        assert!(!body.contains("telemetry"));
        assert!(!body.contains("description:"));
    }

    #[test]
    fn classify_skill_entry_supports_three_layouts() {
        assert_eq!(classify_skill_entry("SKILL.md", "mypack"), Some(("".to_string(), "mypack".to_string())));
        assert_eq!(classify_skill_entry("brainstorming/SKILL.md", "mypack"), Some(("brainstorming".to_string(), "brainstorming".to_string())));
        assert_eq!(classify_skill_entry("pkg/skills/impeccable/SKILL.md", "mypack"), Some(("pkg/skills/impeccable".to_string(), "impeccable".to_string())));
        assert_eq!(classify_skill_entry("a/b/c/SKILL.md", "mypack"), None);
        assert_eq!(classify_skill_entry("pkg/plugins/x/SKILL.md", "mypack"), None);
    }

    #[test]
    fn safe_relative_path_rejects_traversal() {
        assert!(is_safe_relative_path("a/b.md"));
        assert!(!is_safe_relative_path("../evil.md"));
        assert!(!is_safe_relative_path("a/../../b"));
        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path("a\\..\\b.md"));
        assert!(!is_safe_relative_path("..\\evil"));
    }

    #[test]
    fn zip_scans_root_onelevel_and_multiskill() {
        let store = temp_store("zip-scan");
        let a = store.base_dir.join("fxa");
        fs::create_dir_all(&a).unwrap();
        fs::write(a.join("SKILL.md"), "# root").unwrap();
        let za = store.base_dir.join("root.zip");
        zip_dir(&a, &za);
        assert_eq!(scanned_ids(&store, &za), vec!["root".to_string()]);

        let b = store.base_dir.join("fxb");
        fs::create_dir_all(b.join("alpha")).unwrap();
        fs::write(b.join("alpha/SKILL.md"), "# a").unwrap();
        let zb = store.base_dir.join("one.zip");
        zip_dir(&b, &zb);
        assert_eq!(scanned_ids(&store, &zb), vec!["alpha".to_string()]);

        let c = store.base_dir.join("fxc");
        fs::create_dir_all(c.join("pkg/skills/s1")).unwrap();
        fs::create_dir_all(c.join("pkg/skills/s2")).unwrap();
        fs::write(c.join("pkg/skills/s1/SKILL.md"), "# 1").unwrap();
        fs::write(c.join("pkg/skills/s2/SKILL.md"), "# 2").unwrap();
        let zc = store.base_dir.join("multi.zip");
        zip_dir(&c, &zc);
        let mut ids = scanned_ids(&store, &zc);
        ids.sort();
        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn zip_scan_corrupted_and_duplicate_id() {
        let store = temp_store("zip-corrupt");
        let bad = store.base_dir.join("bad.zip");
        fs::write(&bad, "not a real zip").unwrap();
        assert!(scan_skill_package_internal(&store, bad.to_str().unwrap()).is_err());
        let d = store.base_dir.join("fxd");
        fs::create_dir_all(d.join("dup")).unwrap();
        fs::write(d.join("SKILL.md"), "# root dup").unwrap();
        fs::write(d.join("dup/SKILL.md"), "# nested").unwrap();
        let zd = store.base_dir.join("dup.zip");
        zip_dir(&d, &zd);
        let ids = scanned_ids(&store, &zd);
        assert_eq!(ids.len(), ids.iter().collect::<std::collections::HashSet<_>>().len());
    }

    fn python_zip_with_traversal(out: &Path) {
        std::process::Command::new("python3")
            .arg("-c")
            .arg("import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('../evil.txt','pwn')\nz.writestr('SKILL.md','# ok')\nz.close()")
            .arg(out).status().unwrap();
    }

    #[test]
    fn malicious_traversal_zip_is_rejected_on_import() {
        let store = temp_store("evil-zip");
        let z = store.base_dir.join("evil.zip");
        python_zip_with_traversal(&z);
        assert!(import_skill_zip(&store, &z).is_err());
    }

    #[test]
    fn uppercase_zip_extension_is_accepted() {
        let store = temp_store("upper-zip");
        let src = store.base_dir.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "---\nname: upper\n---\n").unwrap();
        let z = store.base_dir.join("PACKAGE.ZIP");
        zip_dir(&src, &z);
        let ids = import_skill_zip(&store, &z).unwrap();
        assert!(!ids.is_empty());
    }

    #[test]
    fn multi_target_partial_deploy_reports_changed_and_errors() {
        let store = temp_store("partial");
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        let ok_root = store.base_dir.join("proj-ok");
        fs::create_dir_all(&ok_root).unwrap();
        project_target(&store, "t-ok", &ok_root);
        let missing_root = store.base_dir.join("proj-missing");
        project_target(&store, "t-missing", &missing_root);
        let report = deploy_skill_internal(&store, "demo", &[dt("t-ok"), dt("t-missing")], false).unwrap();
        assert_eq!(report.changed, 1);
        assert_eq!(report.errors.len(), 1);
        let outcomes: Vec<&str> = report.items.iter().map(|i| i.outcome.as_str()).collect();
        assert!(outcomes.contains(&"changed"));
        assert!(outcomes.contains(&"error"));
    }

    #[test]
    fn can_overwrite_only_for_conflict_and_broken() {
        let store = temp_store("can-overwrite");
        let target_root = store.base_dir.join("proj");
        fs::create_dir_all(&target_root).unwrap();
        create_library_skill(&store, "conflicting", "---\nname: conflicting\n---\n");
        create_library_skill(&store, "dangling", "---\nname: dangling\n---\n");
        create_library_skill(&store, "applied", "---\nname: applied\n---\n");
        create_library_skill(&store, "fresh", "---\nname: fresh\n---\n");
        project_target(&store, "t1", &target_root);
        let sp = skills_path_for(&store, "t1");
        fs::create_dir_all(sp.join("conflicting")).unwrap();
        std::os::unix::fs::symlink(store.base_dir.join("gone"), sp.join("dangling")).unwrap();
        deploy_skill_internal(&store, "applied", &[dt("t1")], false).unwrap();

        let state = store.load_app_state().unwrap();
        let ws = state.workspaces.iter().find(|w| w.target_id == "t1").unwrap();
        let flag = |id: &str| ws.statuses.iter().find(|s| s.skill_id == id).unwrap().can_overwrite;
        assert!(flag("conflicting"), "同名内容应可覆盖");
        assert!(flag("dangling"), "失效软链接应可覆盖");
        assert!(!flag("applied"), "已应用不应出现覆盖");
        assert!(!flag("fresh"), "未应用不应出现覆盖");
    }

    #[test]
    fn path_missing_target_is_not_overwritable() {
        let store = temp_store("missing-not-overwritable");
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        project_target(&store, "gone", &store.base_dir.join("no-such-project"));
        let state = store.load_app_state().unwrap();
        let ws = state.workspaces.iter().find(|w| w.target_id == "gone").unwrap();
        let st = ws.statuses.iter().find(|s| s.skill_id == "demo").unwrap();
        assert_eq!(st.status, crate::models::SkillStatus::PathMissing);
        assert!(!st.can_overwrite);
        assert!(!ws.target_exists);
    }

    #[test]
    fn add_target_rejects_duplicate_path() {
        let store = temp_store("dup-target");
        let proj = store.base_dir.join("proj-dup");
        fs::create_dir_all(&proj).unwrap();
        store.add_target(&proj).unwrap();
        let err = store.add_target(&proj).unwrap_err();
        assert!(format!("{:#}", err).contains("已存在"));
        let count = store.load_targets().unwrap().iter().filter(|t| !t.is_default).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn add_target_rejects_file_path() {
        let store = temp_store("file-target");
        let file = store.base_dir.join("not-a-dir.txt");
        fs::write(&file, "x").unwrap();
        assert!(store.add_target(&file).is_err());
    }

    #[test]
    fn load_app_state_does_not_write_database() {
        let store = temp_store("read-only-load");
        create_library_skill(&store, "demo", "---\nname: demo\n---\n");
        let conn = store.connection().unwrap();
        // data_version 只在“其他连接”提交写入后变化；load_app_state 每次都开新连接。
        let before: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap();
        for _ in 0..3 {
            store.load_app_state().unwrap();
        }
        let after: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after, "读取状态不应提交任何数据库写入");
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM deployments", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn data_version_detects_foreign_write_sanity() {
        // 证明上一个测试的探针有效：其他连接写入时 data_version 确实会变。
        let store = temp_store("dv-sanity");
        let conn = store.connection().unwrap();
        let before: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap();
        store.create_tag("探针").unwrap();
        let after: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0)).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn classify_stat_error_injected_errors() {
        use std::io::ErrorKind;
        assert_eq!(classify_stat_error(&std::io::Error::from(ErrorKind::NotFound)), "missing");
        assert_eq!(classify_stat_error(&std::io::Error::from(ErrorKind::PermissionDenied)), "unknown");
        assert_eq!(classify_stat_error(&std::io::Error::from(ErrorKind::Other)), "unknown");
    }

    #[test]
    fn fingerprint_unreadable_dir_probe_or_explicit_skip() {
        use std::os::unix::fs::PermissionsExt;
        let store = temp_store("perm");
        let d = store.base_dir.join("secret");
        fs::create_dir_all(d.join("inner")).unwrap();
        fs::write(d.join("inner/f.txt"), "s").unwrap();
        fs::set_permissions(&d, fs::Permissions::from_mode(0o000)).unwrap();
        let probe = fs::read_dir(&d);
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755)).unwrap();
        let eacces = matches!(probe.as_ref().map_err(|e| e.kind()), Err(std::io::ErrorKind::PermissionDenied));
        if eacces {
            fs::set_permissions(&d, fs::Permissions::from_mode(0o000)).unwrap();
            let fp = fingerprint_of(&d);
            let _ = fs::set_permissions(&d, fs::Permissions::from_mode(0o755));
            assert_eq!(fp.kind, "unknown");
        } else {
            eprintln!("SKIP: chmod 000 未产生 EACCES（疑似 root）");
        }
    }
}
