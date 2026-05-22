use crate::models::{
    Agent, AgentWorkspace, AppState, Preset, Project, ProjectAgentWorkspace, Skill, SkillStatus,
    TargetKind, TargetStatus,
};
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub struct Store {
    pub base_dir: PathBuf,
    pub skills_root: PathBuf,
    pub database_path: PathBuf,
    pub config_path: PathBuf,
}

impl Store {
    pub fn new() -> Result<Self> {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位用户主目录"))?;
        let base_dir = home.join(".skills-manager");
        let skills_root = base_dir.join("skills");
        let database_path = base_dir.join("app.db");
        let config_path = base_dir.join("config.json");

        fs::create_dir_all(&skills_root).context("无法创建技能主库目录")?;

        let store = Self {
            base_dir,
            skills_root,
            database_path,
            config_path,
        };
        store.ensure_config()?;
        store.ensure_database()?;
        Ok(store)
    }

    pub fn connection(&self) -> Result<Connection> {
        Connection::open(&self.database_path).context("无法打开本地状态数据库")
    }

    pub fn ensure_config(&self) -> Result<()> {
        if !self.config_path.exists() {
            let content = json!({
                "baseDir": self.base_dir.to_string_lossy(),
                "skillsRoot": self.skills_root.to_string_lossy(),
                "syncMode": "symlink",
                "conflictStrategy": "libraryFirst"
            });
            fs::write(&self.config_path, serde_json::to_string_pretty(&content)?)
                .context("无法写入配置文件")?;
        }
        Ok(())
    }

    pub fn ensure_database(&self) -> Result<()> {
        let conn = self.connection()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              global_path TEXT NOT NULL,
              project_relative_path TEXT NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS presets (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS preset_skills (
              preset_id TEXT NOT NULL,
              skill_id TEXT NOT NULL,
              PRIMARY KEY (preset_id, skill_id)
            );
            CREATE TABLE IF NOT EXISTS deployments (
              id TEXT PRIMARY KEY,
              skill_id TEXT NOT NULL,
              target_kind TEXT NOT NULL,
              agent_id TEXT NOT NULL,
              project_id TEXT,
              status TEXT NOT NULL,
              target_path TEXT NOT NULL,
              link_target TEXT
            );
            "#,
        )?;

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM agents", [], |row| row.get(0))?;
        if count == 0 {
            let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位用户主目录"))?;
            let defaults = vec![
                (
                    "trae",
                    "Trae",
                    home.join(".trae").join("skills"),
                    ".trae/skills",
                ),
                (
                    "codex",
                    "Codex",
                    home.join(".codex").join("skills"),
                    ".codex/skills",
                ),
                (
                    "claude-code",
                    "Claude Code",
                    home.join(".claude").join("skills"),
                    ".claude/skills",
                ),
            ];
            for (id, name, global_path, project_relative_path) in defaults {
                conn.execute(
                    "INSERT INTO agents (id, name, global_path, project_relative_path, enabled) VALUES (?1, ?2, ?3, ?4, 1)",
                    params![id, name, global_path.to_string_lossy(), project_relative_path],
                )?;
            }
        }

        Ok(())
    }

    pub fn load_app_state(&self) -> Result<AppState> {
        let agents = self.load_agents()?;
        let projects = self.load_projects()?;
        let mut skills = self.scan_library_skills()?;
        let presets = self.load_presets()?;

        let mut global_workspaces = Vec::new();
        let mut project_workspaces = Vec::new();
        let mut all_statuses = Vec::new();

        for agent in &agents {
            if !agent.enabled {
                continue;
            }
            let root = PathBuf::from(&agent.global_path);
            let statuses =
                self.scan_target_root(&skills, &root, TargetKind::Global, agent, None)?;
            all_statuses.extend(statuses.clone());
            global_workspaces.push(AgentWorkspace {
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                root_path: root.to_string_lossy().to_string(),
                root_exists: root.exists(),
                statuses,
            });
        }

        for project in &projects {
            for agent in &agents {
                if !agent.enabled {
                    continue;
                }
                let root = PathBuf::from(&project.path).join(&agent.project_relative_path);
                let statuses = self.scan_target_root(
                    &skills,
                    &root,
                    TargetKind::Project,
                    agent,
                    Some(project),
                )?;
                all_statuses.extend(statuses.clone());
                project_workspaces.push(ProjectAgentWorkspace {
                    project_id: project.id.clone(),
                    project_name: project.name.clone(),
                    project_path: project.path.clone(),
                    project_exists: Path::new(&project.path).exists(),
                    agent_id: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    root_path: root.to_string_lossy().to_string(),
                    root_exists: root.exists(),
                    statuses,
                });
            }
        }

        let mut enabled_counts: HashMap<String, usize> = HashMap::new();
        let mut issue_counts: HashMap<String, usize> = HashMap::new();
        for status in &all_statuses {
            if status.status == SkillStatus::Enabled {
                *enabled_counts.entry(status.skill_id.clone()).or_default() += 1;
            }
            if matches!(
                status.status,
                SkillStatus::Conflict | SkillStatus::Broken | SkillStatus::Invalid
            ) {
                *issue_counts.entry(status.skill_id.clone()).or_default() += 1;
            }
        }
        for skill in &mut skills {
            skill.enabled_count = *enabled_counts.get(&skill.id).unwrap_or(&0);
            skill.issue_count = *issue_counts.get(&skill.id).unwrap_or(&0);
        }

        self.persist_deployments(&all_statuses)?;

        let issues = all_statuses
            .iter()
            .filter_map(|status| {
                status.issue.as_ref().map(|issue| {
                    format!(
                        "{} / {} / {}：{}",
                        status.agent_name,
                        status
                            .project_name
                            .clone()
                            .unwrap_or_else(|| "全局".to_string()),
                        status.display_name,
                        issue
                    )
                })
            })
            .collect();

        Ok(AppState {
            base_dir: self.base_dir.to_string_lossy().to_string(),
            skills_root: self.skills_root.to_string_lossy().to_string(),
            database_path: self.database_path.to_string_lossy().to_string(),
            config_path: self.config_path.to_string_lossy().to_string(),
            agents,
            projects,
            skills,
            global_workspaces,
            project_workspaces,
            presets,
            issues,
        })
    }

    pub fn load_agents(&self) -> Result<Vec<Agent>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, global_path, project_relative_path, enabled FROM agents ORDER BY rowid",
        )?;
        let rows = stmt.query_map([], |row| {
            let global_path: String = row.get(2)?;
            Ok(Agent {
                id: row.get(0)?,
                name: row.get(1)?,
                path_exists: Path::new(&global_path).exists(),
                global_path,
                project_relative_path: row.get(3)?,
                enabled: row.get::<_, i64>(4)? == 1,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取智能体应用配置")
    }

    pub fn load_projects(&self) -> Result<Vec<Project>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT id, name, path FROM projects ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(2)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                exists: Path::new(&path).exists(),
                path,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取项目列表")
    }

    pub fn load_presets(&self) -> Result<Vec<Preset>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT id, name, description FROM presets ORDER BY name")?;
        let rows = stmt.query_map([], |row| {
            let preset_id: String = row.get(0)?;
            let skill_ids = load_preset_skills(&conn, &preset_id)?;
            Ok(Preset {
                id: preset_id,
                name: row.get(1)?,
                description: row.get(2)?,
                skill_ids,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取技能套装")
    }

    pub fn scan_library_skills(&self) -> Result<Vec<Skill>> {
        let mut skills = Vec::new();
        if !self.skills_root.exists() {
            return Ok(skills);
        }

        for entry in fs::read_dir(&self.skills_root).context("无法读取技能主库")? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let skill_md = path.join("SKILL.md");
            let has_skill_md = skill_md.exists();
            let content = if has_skill_md {
                fs::read_to_string(&skill_md).unwrap_or_default()
            } else {
                String::new()
            };
            let metadata = parse_skill_metadata(&id, &content);
            skills.push(Skill {
                id: id.clone(),
                name: id,
                display_name: metadata.display_name,
                description: metadata.description,
                path: path.to_string_lossy().to_string(),
                has_skill_md,
                tags: metadata.tags,
                enabled_count: 0,
                issue_count: if has_skill_md { 0 } else { 1 },
                content_preview: content,
            });
        }

        skills.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(skills)
    }

    pub fn scan_target_root(
        &self,
        skills: &[Skill],
        root: &Path,
        target_kind: TargetKind,
        agent: &Agent,
        project: Option<&Project>,
    ) -> Result<Vec<TargetStatus>> {
        let root_exists = root.exists();
        let mut statuses = Vec::new();
        let mut seen = HashSet::new();

        for skill in skills {
            let target_path = root.join(&skill.name);
            let status = analyze_target_path(&target_path, Path::new(&skill.path), root_exists);
            seen.insert(skill.name.clone());
            statuses.push(TargetStatus {
                id: status_id(&skill.name, &target_kind, &agent.id, project.map(|p| &p.id)),
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                display_name: skill.display_name.clone(),
                description: skill.description.clone(),
                target_kind: target_kind.clone(),
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                project_id: project.map(|p| p.id.clone()),
                project_name: project.map(|p| p.name.clone()),
                status: status.status,
                target_path: target_path.to_string_lossy().to_string(),
                link_target: status.link_target,
                issue: status.issue,
                root_exists,
            });
        }

        if root_exists {
            for entry in
                fs::read_dir(root).with_context(|| format!("无法读取 {}", root.display()))?
            {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if seen.contains(&name) {
                    continue;
                }
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)?;
                let is_skill_like = metadata.file_type().is_symlink()
                    || path.join("SKILL.md").exists()
                    || path.join("README.md").exists();
                if !is_skill_like {
                    continue;
                }
                let source_path = resolve_symlink_target(&path).unwrap_or(path.clone());
                let skill_md = source_path.join("SKILL.md");
                let content = fs::read_to_string(skill_md).unwrap_or_default();
                let parsed = parse_skill_metadata(&name, &content);
                statuses.push(TargetStatus {
                    id: status_id(&name, &target_kind, &agent.id, project.map(|p| &p.id)),
                    skill_id: name.clone(),
                    skill_name: name.clone(),
                    display_name: parsed.display_name,
                    description: parsed.description,
                    target_kind: target_kind.clone(),
                    agent_id: agent.id.clone(),
                    agent_name: agent.name.clone(),
                    project_id: project.map(|p| p.id.clone()),
                    project_name: project.map(|p| p.name.clone()),
                    status: SkillStatus::Unmanaged,
                    target_path: path.to_string_lossy().to_string(),
                    link_target: resolve_symlink_target(&path)
                        .map(|p| p.to_string_lossy().to_string()),
                    issue: Some("目标目录有技能，但尚未进入主库".to_string()),
                    root_exists,
                });
            }
        }

        statuses.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(statuses)
    }

    pub fn persist_deployments(&self, statuses: &[TargetStatus]) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM deployments", [])?;
        for status in statuses {
            conn.execute(
                "INSERT INTO deployments (id, skill_id, target_kind, agent_id, project_id, status, target_path, link_target)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    status.id,
                    status.skill_id,
                    format!("{:?}", status.target_kind),
                    status.agent_id,
                    status.project_id,
                    status.status.label(),
                    status.target_path,
                    status.link_target
                ],
            )?;
        }
        Ok(())
    }

    pub fn skill_path(&self, skill_id: &str) -> PathBuf {
        self.skills_root.join(skill_id)
    }

    pub fn add_project(&self, path: &Path) -> Result<()> {
        let project_path = path
            .canonicalize()
            .with_context(|| format!("无法读取项目路径 {}", path.display()))?;
        let name = project_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名项目".to_string());
        let id = stable_id(&project_path.to_string_lossy());
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO projects (id, name, path) VALUES (?1, ?2, ?3)",
            params![id, name, project_path.to_string_lossy()],
        )?;
        Ok(())
    }

    pub fn remove_project(&self, project_id: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
        Ok(())
    }

    pub fn update_agent_path(&self, agent_id: &str, path: &Path) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE agents SET global_path = ?1 WHERE id = ?2",
            params![path.to_string_lossy(), agent_id],
        )?;
        Ok(())
    }

    pub fn upsert_preset(
        &self,
        id: Option<String>,
        name: String,
        description: String,
        skill_ids: Vec<String>,
    ) -> Result<String> {
        let preset_id = id.unwrap_or_else(|| slugify(&name));
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO presets (id, name, description) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description",
            params![preset_id, name, description],
        )?;
        conn.execute(
            "DELETE FROM preset_skills WHERE preset_id = ?1",
            params![preset_id],
        )?;
        for skill_id in skill_ids {
            conn.execute(
                "INSERT OR IGNORE INTO preset_skills (preset_id, skill_id) VALUES (?1, ?2)",
                params![preset_id, skill_id],
            )?;
        }
        Ok(preset_id)
    }

    pub fn delete_preset(&self, id: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "DELETE FROM preset_skills WHERE preset_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM presets WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn find_agent(&self, agent_id: &str) -> Result<Agent> {
        self.load_agents()?
            .into_iter()
            .find(|agent| agent.id == agent_id)
            .ok_or_else(|| anyhow!("未找到智能体应用：{}", agent_id))
    }

    pub fn find_project(&self, project_id: &str) -> Result<Project> {
        self.load_projects()?
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| anyhow!("未找到项目：{}", project_id))
    }

    pub fn find_preset(&self, preset_id: &str) -> Result<Preset> {
        self.load_presets()?
            .into_iter()
            .find(|preset| preset.id == preset_id)
            .ok_or_else(|| anyhow!("未找到技能套装：{}", preset_id))
    }
}

struct PathAnalysis {
    status: SkillStatus,
    link_target: Option<String>,
    issue: Option<String>,
}

struct SkillMetadata {
    display_name: String,
    description: String,
    tags: Vec<String>,
}

pub fn slugify(value: &str) -> String {
    let mut slug = String::new();
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() || matches!(ch, '/' | '\\' | ':' | '.') {
            if !slug.ends_with('-') {
                slug.push('-');
            }
        } else {
            slug.push(ch);
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        stable_id(value)
    } else {
        slug
    }
}

pub fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in WalkDir::new(src).min_depth(1) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(src)?;
        let target = dst.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

pub fn remove_path(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)?;
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[cfg(unix)]
pub fn create_dir_symlink(src: &Path, dst: &Path) -> Result<()> {
    std::os::unix::fs::symlink(src, dst)?;
    Ok(())
}

#[cfg(windows)]
pub fn create_dir_symlink(src: &Path, dst: &Path) -> Result<()> {
    std::os::windows::fs::symlink_dir(src, dst)?;
    Ok(())
}

pub fn is_link_to(path: &Path, expected: &Path) -> bool {
    if !matches!(fs::symlink_metadata(path), Ok(meta) if meta.file_type().is_symlink()) {
        return false;
    }
    let Some(target) = resolve_symlink_target(path) else {
        return false;
    };
    match (target.canonicalize(), expected.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => target == expected,
    }
}

pub fn resolve_symlink_target(path: &Path) -> Option<PathBuf> {
    let target = fs::read_link(path).ok()?;
    if target.is_absolute() {
        Some(target)
    } else {
        path.parent().map(|parent| parent.join(target))
    }
}

fn analyze_target_path(target_path: &Path, skill_path: &Path, root_exists: bool) -> PathAnalysis {
    if !root_exists {
        return PathAnalysis {
            status: SkillStatus::PathMissing,
            link_target: None,
            issue: Some("目标技能目录不存在".to_string()),
        };
    }

    let Ok(metadata) = fs::symlink_metadata(target_path) else {
        return PathAnalysis {
            status: SkillStatus::Disabled,
            link_target: None,
            issue: None,
        };
    };

    if metadata.file_type().is_symlink() {
        let target = resolve_symlink_target(target_path);
        if is_link_to(target_path, skill_path) {
            return PathAnalysis {
                status: SkillStatus::Enabled,
                link_target: target.map(|path| path.to_string_lossy().to_string()),
                issue: None,
            };
        }
        if let Some(target_path) = &target {
            if !target_path.exists() {
                return PathAnalysis {
                    status: SkillStatus::Broken,
                    link_target: Some(target_path.to_string_lossy().to_string()),
                    issue: Some("软链接目标不存在".to_string()),
                };
            }
        }
        return PathAnalysis {
            status: SkillStatus::Conflict,
            link_target: target.map(|path| path.to_string_lossy().to_string()),
            issue: Some("目标位置已有指向别处的软链接".to_string()),
        };
    }

    PathAnalysis {
        status: SkillStatus::Conflict,
        link_target: None,
        issue: Some("目标位置已有同名内容".to_string()),
    }
}

fn parse_skill_metadata(fallback_name: &str, content: &str) -> SkillMetadata {
    let mut display_name = fallback_name.to_string();
    let mut description = String::new();
    let mut tags = Vec::new();

    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        let mut lines = trimmed.lines();
        let _ = lines.next();
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                match key {
                    "name" => display_name = value.to_string(),
                    "description" => description = value.to_string(),
                    "tags" => {
                        tags = value
                            .trim_matches('[')
                            .trim_matches(']')
                            .split(',')
                            .map(|tag| tag.trim().trim_matches('"').trim_matches('\'').to_string())
                            .filter(|tag| !tag.is_empty())
                            .collect();
                    }
                    _ => {}
                }
            }
        }
    }

    if description.is_empty() {
        description = content
            .lines()
            .find(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty() && !trimmed.starts_with('#') && trimmed != "---"
            })
            .unwrap_or("暂无描述")
            .trim()
            .to_string();
    }

    SkillMetadata {
        display_name,
        description,
        tags,
    }
}

fn load_preset_skills(conn: &Connection, preset_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT skill_id FROM preset_skills WHERE preset_id = ?1 ORDER BY skill_id")?;
    let rows = stmt.query_map(params![preset_id], |row| row.get(0))?;
    rows.collect()
}

fn stable_id(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("id-{:x}", hasher.finish())
}

fn status_id(
    skill_name: &str,
    target_kind: &TargetKind,
    agent_id: &str,
    project_id: Option<&String>,
) -> String {
    let scope = match target_kind {
        TargetKind::Global => "global".to_string(),
        TargetKind::Project => format!("project-{}", project_id.map(String::as_str).unwrap_or("")),
    };
    format!("{}-{}-{}", scope, agent_id, skill_name)
}
