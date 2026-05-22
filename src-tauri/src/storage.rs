use crate::models::{
    Agent, AgentWorkspace, AppState, DetectedAgent, OnboardingStatus, Preset, Project,
    ProjectAgentWorkspace, Skill, SkillStatus, TargetKind, TargetStatus,
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

struct InferredAgentConfig {
    id: String,
    name: String,
    global_path: String,
    project_relative_path: String,
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

        migrate_agents_table(&conn)?;

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM agents", [], |row| row.get(0))?;
        if count == 0 {
            for detected in default_agent_definitions()? {
                let enabled_value = if detected.exists { 1 } else { 0 };
                conn.execute(
                    "INSERT INTO agents (id, name, global_path, project_relative_path, enabled) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        detected.id,
                        detected.name,
                        detected.global_path,
                        detected.project_relative_path,
                        enabled_value
                    ],
                )?;
            }
        }

        Ok(())
    }

    pub fn load_app_state(&self) -> Result<AppState> {
        let agents = self.load_agents()?;
        let projects = self.load_projects()?;
        let mut extra_issues: Vec<String> = Vec::new();
        let mut skills = match self.scan_library_skills() {
            Ok(value) => value,
            Err(error) => {
                extra_issues.push(format!("无法扫描技能主库：{:#}", error));
                Vec::new()
            }
        };
        let presets = self.load_presets()?;

        let mut global_workspaces = Vec::new();
        let mut project_workspaces = Vec::new();
        let mut all_statuses = Vec::new();

        for agent in &agents {
            if !agent.enabled {
                continue;
            }
            let root = PathBuf::from(&agent.global_path);
            let statuses = match self.scan_target_root(
                &skills,
                &root,
                TargetKind::Global,
                agent,
                None,
            ) {
                Ok(value) => value,
                Err(error) => {
                    extra_issues.push(format!(
                        "{} / 全局：{:#}",
                        agent.name, error
                    ));
                    Vec::new()
                }
            };
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
                let statuses = match self.scan_target_root(
                    &skills,
                    &root,
                    TargetKind::Project,
                    agent,
                    Some(project),
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        extra_issues.push(format!(
                            "{} / {}：{:#}",
                            agent.name, project.name, error
                        ));
                        Vec::new()
                    }
                };
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
            let local_issue_count = skill.issue_count;
            skill.enabled_count = *enabled_counts.get(&skill.id).unwrap_or(&0);
            skill.issue_count = local_issue_count + *issue_counts.get(&skill.id).unwrap_or(&0);
        }

        // persist_deployments 失败不阻断首屏，仅追加一条 issue。
        if let Err(error) = self.persist_deployments(&all_statuses) {
            extra_issues.push(format!("无法写入部署快照：{:#}", error));
        }

        let mut issues: Vec<String> = all_statuses
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
        issues.extend(extra_issues);

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
            .context("无法读取技能组合")
    }

    pub fn scan_library_skills(&self) -> Result<Vec<Skill>> {
        let mut skills = Vec::new();
        if !self.skills_root.exists() {
            return Ok(skills);
        }

        for entry in fs::read_dir(&self.skills_root).context("无法读取技能主库")? {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
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
            let content_preview = build_content_preview(&content);
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
                content_preview,
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
        let scope_exists = project
            .map(|project| Path::new(&project.path).exists())
            .unwrap_or(true);
        let root_missing_is_deployable = !root_exists && scope_exists;
        let mut statuses = Vec::new();
        let mut seen = HashSet::new();

        for skill in skills {
            let target_path = root.join(&skill.name);
            let status = if root_missing_is_deployable {
                PathAnalysis {
                    status: SkillStatus::Disabled,
                    link_target: None,
                    issue: None,
                }
            } else {
                analyze_target_path(&target_path, Path::new(&skill.path), root_exists)
            };
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
            let entries = match fs::read_dir(root) {
                Ok(value) => value,
                Err(error) => {
                    // 读取失败时退化为：保留主库已经匹配出的 statuses，整体 workspace 给一条占位 issue。
                    statuses.push(TargetStatus {
                        id: status_id("__unreadable__", &target_kind, &agent.id, project.map(|p| &p.id)),
                        skill_id: "__unreadable__".to_string(),
                        skill_name: "__unreadable__".to_string(),
                        display_name: "目录无法读取".to_string(),
                        description: format!("无法读取 {}：{}", root.display(), error),
                        target_kind: target_kind.clone(),
                        agent_id: agent.id.clone(),
                        agent_name: agent.name.clone(),
                        project_id: project.map(|p| p.id.clone()),
                        project_name: project.map(|p| p.name.clone()),
                        status: SkillStatus::Invalid,
                        target_path: root.to_string_lossy().to_string(),
                        link_target: None,
                        issue: Some(format!("无法读取目录：{}", error)),
                        root_exists,
                    });
                    statuses.sort_by(|a, b| a.display_name.cmp(&b.display_name));
                    return Ok(statuses);
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(value) => value,
                    Err(error) => {
                        statuses.push(TargetStatus {
                            id: status_id("__entry_error__", &target_kind, &agent.id, project.map(|p| &p.id)),
                            skill_id: "__entry_error__".to_string(),
                            skill_name: "__entry_error__".to_string(),
                            display_name: "目录条目无法读取".to_string(),
                            description: format!("{}", error),
                            target_kind: target_kind.clone(),
                            agent_id: agent.id.clone(),
                            agent_name: agent.name.clone(),
                            project_id: project.map(|p| p.id.clone()),
                            project_name: project.map(|p| p.name.clone()),
                            status: SkillStatus::Invalid,
                            target_path: root.to_string_lossy().to_string(),
                            link_target: None,
                            issue: Some(format!("目录条目无法读取：{}", error)),
                            root_exists,
                        });
                        continue;
                    }
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if seen.contains(&name) {
                    continue;
                }
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
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

    pub fn add_agent(&self, path: &Path) -> Result<()> {
        let agent = infer_agent_config(path)?;
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO agents (id, name, global_path, project_relative_path, enabled)
             VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               global_path = excluded.global_path,
               project_relative_path = excluded.project_relative_path,
               enabled = 1",
            params![
                agent.id,
                agent.name,
                agent.global_path,
                agent.project_relative_path
            ],
        )?;
        Ok(())
    }

    pub fn remove_agent(&self, agent_id: &str) -> Result<()> {
        let conn = self.connection()?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM agents", [], |row| row.get(0))?;
        if count <= 1 {
            return Err(anyhow!("至少需要保留一个 Agent"));
        }
        let changed = conn.execute("DELETE FROM agents WHERE id = ?1", params![agent_id])?;
        if changed == 0 {
            return Err(anyhow!("未找到智能体应用：{}", agent_id));
        }
        Ok(())
    }

    pub fn remove_project(&self, project_id: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM projects WHERE id = ?1", params![project_id])?;
        Ok(())
    }

    pub fn update_agent_path(&self, agent_id: &str, path: &Path) -> Result<()> {
        let agent = infer_agent_config(path)?;
        let conn = self.connection()?;
        let changed = conn.execute(
            "UPDATE agents SET global_path = ?1, project_relative_path = ?2 WHERE id = ?3",
            params![agent.global_path, agent.project_relative_path, agent_id],
        )?;
        if changed == 0 {
            return Err(anyhow!("未找到智能体应用：{}", agent_id));
        }
        Ok(())
    }

    pub fn upsert_preset(
        &self,
        id: Option<String>,
        name: String,
        description: String,
        skill_ids: Vec<String>,
    ) -> Result<String> {
        let trimmed_name = name.trim().to_string();
        let preset_id_from_request = id.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        });
        let is_create = preset_id_from_request.is_none();
        let preset_id = preset_id_from_request.unwrap_or_else(|| slugify(&trimmed_name));
        let conn = self.connection()?;
        if is_create {
            let existing: i64 = conn.query_row(
                "SELECT COUNT(*) FROM presets WHERE id = ?1",
                params![preset_id],
                |row| row.get(0),
            )?;
            if existing > 0 {
                return Err(anyhow!("已经存在同名技能组合：{}", trimmed_name));
            }
        }
        conn.execute(
            "INSERT INTO presets (id, name, description) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description",
            params![preset_id, trimmed_name, description.trim()],
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
            .ok_or_else(|| anyhow!("未找到技能组合：{}", preset_id))
    }

    pub fn detect_default_agents(&self) -> Result<Vec<DetectedAgent>> {
        default_agent_definitions()
    }

    pub fn set_agent_enabled(&self, agent_id: &str, enabled: bool) -> Result<()> {
        let conn = self.connection()?;
        let value = if enabled { 1 } else { 0 };
        let changed = conn.execute(
            "UPDATE agents SET enabled = ?1 WHERE id = ?2",
            params![value, agent_id],
        )?;
        if changed == 0 {
            return Err(anyhow!("未找到智能体应用：{}", agent_id));
        }
        Ok(())
    }

    pub fn onboarding_status(&self) -> Result<OnboardingStatus> {
        let conn = self.connection()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'onboarding_completed'",
                [],
                |row| row.get(0),
            )
            .ok();
        Ok(OnboardingStatus {
            completed: matches!(value.as_deref(), Some("true")),
        })
    }

    pub fn set_onboarding_completed(&self, value: bool) -> Result<()> {
        let conn = self.connection()?;
        let stored = if value { "true" } else { "false" };
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('onboarding_completed', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![stored],
        )?;
        Ok(())
    }

    pub fn list_unmanaged_in_enabled_agents(&self) -> Result<Vec<TargetStatus>> {
        let agents = self.load_agents()?;
        let skills = self.scan_library_skills()?;
        let mut result = Vec::new();
        for agent in &agents {
            if !agent.enabled {
                continue;
            }
            let root = PathBuf::from(&agent.global_path);
            if !root.exists() {
                continue;
            }
            let statuses =
                self.scan_target_root(&skills, &root, TargetKind::Global, agent, None)?;
            for status in statuses {
                if status.status == SkillStatus::Unmanaged {
                    result.push(status);
                }
            }
        }
        Ok(result)
    }
}

fn default_agent_definitions() -> Result<Vec<DetectedAgent>> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位用户主目录"))?;
    let entries = vec![
        ("trae", "Trae", ".trae"),
        ("codex", "Codex", ".codex"),
        ("claude-code", "Claude Code", ".claude"),
    ];
    let mut result = Vec::new();
    for (id, name, root_dir) in entries {
        let global_path = home.join(root_dir).join("skills");
        let project_relative_path = format!("{}/skills", root_dir);
        let exists = global_path.exists();
        result.push(DetectedAgent {
            id: id.to_string(),
            name: name.to_string(),
            global_path: global_path.to_string_lossy().to_string(),
            project_relative_path,
            exists,
        });
    }
    Ok(result)
}

fn migrate_agents_table(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(agents)")?;
    let column_names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);

    if !column_names.iter().any(|col| col == "enabled") {
        conn.execute(
            "ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
        // 按当前默认 Agent 探测结果回填一次：未安装的 Agent 默认禁用，避免老库升级后首屏炸出空 workspace。
        if let Ok(detected_list) = default_agent_definitions() {
            for detected in detected_list {
                let enabled_value = if detected.exists { 1 } else { 0 };
                conn.execute(
                    "UPDATE agents SET enabled = ?1 WHERE id = ?2",
                    params![enabled_value, detected.id],
                )?;
            }
        }
    }

    Ok(())
}

fn infer_agent_config(path: &Path) -> Result<InferredAgentConfig> {
    let global_path = path
        .canonicalize()
        .with_context(|| format!("无法读取 Agent 全局 Skill 目录 {}", path.display()))?;
    if !global_path.is_dir() {
        return Err(anyhow!("请选择一个 Agent 全局 Skill 目录"));
    }
    let folder_name = global_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("无法识别 Agent 全局 Skill 目录"))?;
    if !folder_name.eq_ignore_ascii_case("skills") {
        return Err(anyhow!("请选择以 skills 结尾的 Agent 全局 Skill 目录"));
    }
    let agent_root_name = global_path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("无法从全局 Skill 目录推断 Agent"))?;
    let key = agent_root_name.trim_start_matches('.').to_ascii_lowercase();
    let id = infer_agent_id(&key);
    let name = infer_agent_name(&key);
    let project_relative_path = PathBuf::from(&agent_root_name)
        .join("skills")
        .to_string_lossy()
        .to_string();

    Ok(InferredAgentConfig {
        id,
        name,
        global_path: global_path.to_string_lossy().to_string(),
        project_relative_path,
    })
}

fn infer_agent_id(key: &str) -> String {
    match key {
        "codex" => "codex".to_string(),
        "trae" => "trae".to_string(),
        "claude" | "claude-code" | "claude_code" => "claude-code".to_string(),
        _ => slugify(key),
    }
}

fn infer_agent_name(key: &str) -> String {
    match key {
        "codex" => "Codex".to_string(),
        "trae" => "Trae".to_string(),
        "claude" | "claude-code" | "claude_code" => "Claude Code".to_string(),
        _ => titleize_agent_name(key),
    }
}

fn titleize_agent_name(key: &str) -> String {
    key.split(|ch: char| ch == '-' || ch == '_' || ch == '.')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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

    let (frontmatter, body) = split_frontmatter(content);
    let readable_body = remove_preview_noise(&body);
    if let Some(frontmatter) = frontmatter {
        let mut collecting: Option<&str> = None;
        let mut description_lines: Vec<String> = Vec::new();
        let mut tag_lines: Vec<String> = Vec::new();

        for line in frontmatter.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if collecting == Some("description") {
                    description_lines.push(String::new());
                }
                continue;
            }

            let is_top_level = !line.starts_with(' ') && !line.starts_with('\t');
            if is_top_level {
                if let Some((key, value)) = trimmed.split_once(':') {
                    let key = key.trim();
                    let value = value.trim();
                    collecting = None;
                    match key {
                        "name" => {
                            let value = clean_frontmatter_scalar(value);
                            if !value.is_empty() {
                                display_name = value;
                            }
                        }
                        "description" => {
                            if value.is_empty() || value.starts_with('|') || value.starts_with('>')
                            {
                                collecting = Some("description");
                                description_lines.clear();
                            } else {
                                description = clean_frontmatter_scalar(value);
                            }
                        }
                        "tags" => {
                            if value.is_empty() {
                                collecting = Some("tags");
                                tag_lines.clear();
                            } else {
                                tags = parse_inline_tags(value);
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
            }

            match collecting {
                Some("description") => description_lines.push(trimmed.to_string()),
                Some("tags") => tag_lines.push(trimmed.to_string()),
                _ => {}
            }
        }

        if description.is_empty() && !description_lines.is_empty() {
            description = compact_text(&description_lines.join(" "));
        }
        if tags.is_empty() && !tag_lines.is_empty() {
            tags = parse_tag_lines(&tag_lines);
        }
    }

    if description.is_empty() || matches!(description.as_str(), "|" | ">") {
        description =
            first_meaningful_line(&readable_body).unwrap_or_else(|| "暂无描述".to_string());
    }

    SkillMetadata {
        display_name,
        description: compact_text(&description),
        tags,
    }
}

fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let trimmed = content.trim_start();
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, content.trim().to_string());
    }

    let mut frontmatter = Vec::new();
    for line in &mut lines {
        if line.trim() == "---" {
            return (
                Some(frontmatter.join("\n")),
                lines.collect::<Vec<_>>().join("\n").trim().to_string(),
            );
        }
        frontmatter.push(line);
    }

    (None, content.trim().to_string())
}

fn build_content_preview(content: &str) -> String {
    const PREVIEW_LIMIT: usize = 4_000;
    let (_, body) = split_frontmatter(content);
    let body = remove_preview_noise(&body);
    if body.chars().count() <= PREVIEW_LIMIT {
        return body;
    }

    let mut preview = body.chars().take(PREVIEW_LIMIT).collect::<String>();
    preview.push_str("\n\n...");
    preview
}

fn remove_preview_noise(value: &str) -> String {
    let mut text = value.to_string();
    const TELEMETRY_START: &str = "<!-- @telemetry:start -->";
    const TELEMETRY_END: &str = "<!-- @telemetry:end -->";

    while let Some(start) = text.find(TELEMETRY_START) {
        let Some(relative_end) = text[start..].find(TELEMETRY_END) else {
            break;
        };
        let end = start + relative_end + TELEMETRY_END.len();
        text.replace_range(start..end, "");
    }

    text.replace(TELEMETRY_START, "")
        .replace(TELEMETRY_END, "")
        .trim()
        .to_string()
}

fn clean_frontmatter_scalar(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn compact_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_meaningful_line(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .map(compact_text)
}

fn parse_inline_tags(value: &str) -> Vec<String> {
    let value = clean_frontmatter_scalar(value);
    let inner = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(&value);
    inner
        .split(',')
        .map(clean_frontmatter_scalar)
        .filter(|tag| !tag.is_empty())
        .collect()
}

fn parse_tag_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter_map(|line| {
            let value = line.trim().trim_start_matches('-').trim();
            let value = clean_frontmatter_scalar(value);
            (!value.is_empty()).then_some(value)
        })
        .collect()
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
