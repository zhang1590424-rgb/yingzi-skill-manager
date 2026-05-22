use crate::models::{AppState, DeployTarget, OperationReport};
use crate::storage::{
    copy_dir_all, create_dir_symlink, is_link_to, remove_path, resolve_symlink_target, slugify,
    Store,
};
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
pub fn install_skill_from_market(
    market_url: String,
    version: Option<String>,
) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        let spec = parse_market_skill_url(&market_url)?;
        let skill_id = slugify(&spec.skill);
        let target = store.skill_path(&skill_id);
        if fs::symlink_metadata(&target).is_ok() {
            return Err(anyhow!("主库里已经存在同名技能：{}", skill_id));
        }

        let staging = create_market_staging_dir(&skill_id)?;
        let install_result = install_market_skill_into_staging(
            &staging,
            &spec,
            version
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        );
        if let Err(error) = install_result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }

        let installed_skill = find_installed_skill_dir(&staging, &spec.skill, &skill_id)?
            .ok_or_else(|| {
                anyhow!(
                    "市场安装命令已结束，但没有在临时项目里找到 {} 的 SKILL.md",
                    spec.skill
                )
            })?;

        if let Err(error) = copy_dir_all(&installed_skill, &target) {
            let _ = remove_path(&target);
            let _ = fs::remove_dir_all(&staging);
            return Err(error.context("无法复制市场技能到主库"));
        }

        let _ = fs::remove_dir_all(&staging);
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
        let agent = store.find_agent(&agent_id)?;
        let root = if let Some(project_id) = &project_id {
            let project = store.find_project(project_id)?;
            PathBuf::from(project.path).join(agent.project_relative_path)
        } else {
            PathBuf::from(agent.global_path)
        };
        let source = root.join(&skill_name);
        if !source.exists() && fs::symlink_metadata(&source).is_err() {
            return Err(anyhow!("目标技能不存在：{}", source.display()));
        }

        let source_for_copy = resolve_symlink_target(&source).unwrap_or_else(|| source.clone());
        if !source_for_copy.join("SKILL.md").exists() {
            return Err(anyhow!("该目标缺少 SKILL.md，暂不自动入库"));
        }

        let skill_id = slugify(&skill_name);
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
        store.load_app_state()
    })
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
pub fn remove_project(project_id: String) -> Result<AppState, String> {
    run(|| {
        let store = Store::new()?;
        store.remove_project(&project_id)?;
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
            return Err(anyhow!("技能套装名称不能为空"));
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

struct MarketSkillSpec {
    source: String,
    skill: String,
    version: Option<String>,
}

fn parse_market_skill_url(value: &str) -> Result<MarketSkillSpec> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("请粘贴 Skill 市场链接"));
    }

    let normalized = if trimmed.starts_with("skills.bytedance.net/") {
        format!("https://{}", trimmed)
    } else {
        trimmed.to_string()
    };
    if !normalized.starts_with("https://skills.bytedance.net/")
        && !normalized.starts_with("http://skills.bytedance.net/")
    {
        return Err(anyhow!("当前只支持 skills.bytedance.net 的技能详情链接"));
    }

    let marker = "/skill/skills:";
    let (_, tail) = normalized
        .split_once(marker)
        .ok_or_else(|| anyhow!("请使用 Skill 市场里的技能详情链接"))?;
    let path_part = tail
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .split("/-/")
        .next()
        .unwrap_or_default()
        .trim_matches('/');
    let mut parts = path_part
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(anyhow!("无法从市场链接识别技能来源和名称"));
    }

    let skill = parts.pop().unwrap_or_default().to_string();
    let source = parts.join("/");
    let version = query_value(&normalized, "version");
    Ok(MarketSkillSpec {
        source,
        skill,
        version,
    })
}

fn query_value(url: &str, key: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
    for pair in query.split('&') {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if name == key && !value.trim().is_empty() {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn create_market_staging_dir(skill_id: &str) -> Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("无法生成临时目录时间戳")?
        .as_millis();
    let staging = std::env::temp_dir().join(format!("skill-hub-market-{}-{}", skill_id, timestamp));
    fs::create_dir_all(&staging)?;
    fs::write(
        staging.join("AGENTS.md"),
        "# 临时 Skill 安装目录\n\n该目录由技能中枢临时创建，用于从公司 Skill 市场安装后导入主库。\n",
    )?;
    Ok(staging)
}

fn install_market_skill_into_staging(
    staging: &Path,
    spec: &MarketSkillSpec,
    requested_version: Option<&str>,
) -> Result<()> {
    let version = requested_version.or(spec.version.as_deref());
    let mut command = Command::new("npx");
    command
        .current_dir(staging)
        .env("npm_config_registry", "https://bnpm.byted.org")
        .env("NPM_CONFIG_REGISTRY", "https://bnpm.byted.org")
        .arg("-y")
        .arg("skills@latest")
        .arg("add")
        .arg(&spec.source)
        .arg("--skill")
        .arg(&spec.skill)
        .arg("--agent")
        .arg("codex")
        .arg("--copy")
        .arg("-y");
    if let Some(version) = version {
        command.arg("--version").arg(version);
    }

    let output = command
        .output()
        .context("无法启动官方 skills 安装器，请确认本机已安装 Node.js / npx")?;
    if !output.status.success() {
        return Err(anyhow!(
            "市场安装失败：{}",
            command_output_excerpt(&output.stdout, &output.stderr)
        ));
    }
    Ok(())
}

fn command_output_excerpt(stdout: &[u8], stderr: &[u8]) -> String {
    let mut content = String::new();
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    if !stdout.trim().is_empty() {
        content.push_str(stdout.trim());
    }
    if !stderr.trim().is_empty() {
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(stderr.trim());
    }
    if content.trim().is_empty() {
        return "官方安装器没有返回错误详情".to_string();
    }
    content
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn find_installed_skill_dir(
    staging: &Path,
    market_skill: &str,
    skill_id: &str,
) -> Result<Option<PathBuf>> {
    for candidate in [
        staging.join(".codex").join("skills").join(market_skill),
        staging.join(".codex").join("skills").join(skill_id),
    ] {
        if candidate.join("SKILL.md").exists() {
            return Ok(Some(candidate));
        }
    }
    find_skill_dir_recursive(staging, market_skill, skill_id, 0)
}

fn find_skill_dir_recursive(
    root: &Path,
    market_skill: &str,
    skill_id: &str,
    depth: usize,
) -> Result<Option<PathBuf>> {
    if depth > 6 {
        return Ok(None);
    }
    if root.join("SKILL.md").exists() {
        let name = root
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == market_skill || name == skill_id || slugify(&name) == skill_id {
            return Ok(Some(root.to_path_buf()));
        }
    }
    for entry in fs::read_dir(root).with_context(|| format!("无法读取 {}", root.display()))? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name == "node_modules" {
            continue;
        }
        if let Some(found) = find_skill_dir_recursive(&path, market_skill, skill_id, depth + 1)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn run<T>(operation: impl FnOnce() -> Result<T>) -> Result<T, String> {
    operation().map_err(|error| format!("{:#}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_market_skill_detail_url() {
        let spec = parse_market_skill_url(
            "https://skills.bytedance.net/skill/skills:code.byted.org/devinfra/market-skills/skill-creator",
        )
        .unwrap();

        assert_eq!(spec.source, "code.byted.org/devinfra/market-skills");
        assert_eq!(spec.skill, "skill-creator");
        assert_eq!(spec.version, None);
    }

    #[test]
    fn strips_market_check_suffix() {
        let spec = parse_market_skill_url(
            "https://skills.bytedance.net/skill/skills:skills.byted.org/default/public/bits-code-guard/-/check",
        )
        .unwrap();

        assert_eq!(spec.source, "skills.byted.org/default/public");
        assert_eq!(spec.skill, "bits-code-guard");
    }

    #[test]
    fn parses_optional_market_version() {
        let spec = parse_market_skill_url(
            "skills.bytedance.net/skill/skills:code.byted.org/devinfra/market-skills/skill-creator?version=1.0.14",
        )
        .unwrap();

        assert_eq!(spec.version, Some("1.0.14".to_string()));
    }
}
