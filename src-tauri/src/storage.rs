use crate::models::{
    AppState, OnboardingStatus, Preset, ProjectSuggestion, Skill, SkillStatus, TagInfo, Target,
    TargetStatus, TargetWorkspace,
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

/// 项目级技能统一分发到该相对目录。
pub const PROJECT_SKILLS_RELATIVE: &str = ".agents/skills";
const DEFAULT_GLOBAL_DIR_ID: &str = "agents";
const DEFAULT_GLOBAL_DIR_NAME: &str = "全局";
const TARGETS_TABLE_MIGRATION_KEY: &str = "targets_table_migrated";
const ONBOARDING_PROJECT_SCAN_LIMIT: usize = 200;
const ONBOARDING_PROJECT_RETURN_LIMIT: usize = 8;
const ONBOARDING_PROJECT_SCORE_THRESHOLD: usize = 24;
const ONBOARDING_PROJECT_RECOMMENDED_SCORE: usize = 50;

/// Smart path detection: if `path` already ends with `.agents/skills`, use as-is;
/// otherwise append `/.agents/skills`.
pub fn compute_skills_path(path: &str) -> PathBuf {
    let trimmed = path.trim_end_matches('/');
    if trimmed.ends_with(".agents/skills") {
        PathBuf::from(trimmed)
    } else {
        PathBuf::from(trimmed).join(PROJECT_SKILLS_RELATIVE)
    }
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
            CREATE TABLE IF NOT EXISTS targets (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE,
              is_default INTEGER NOT NULL DEFAULT 0
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
              target_id TEXT NOT NULL,
              status TEXT NOT NULL,
              target_path TEXT NOT NULL,
              link_target TEXT
            );
            CREATE TABLE IF NOT EXISTS ignored_issues (
              issue_key TEXT PRIMARY KEY,
              ignored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS skill_tags (
              skill_id TEXT NOT NULL,
              tag TEXT NOT NULL,
              PRIMARY KEY (skill_id, tag)
            );
            CREATE TABLE IF NOT EXISTS tag_meta (
              tag TEXT PRIMARY KEY,
              color_index INTEGER NOT NULL DEFAULT -1,
              sort_order INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )?;

        // Ensure sort_order column exists (migration for existing DBs)
        let has_sort_order: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('tag_meta') WHERE name='sort_order'")?
            .query_row([], |row| row.get::<_, i32>(0))
            .unwrap_or(0)
            > 0;
        if !has_sort_order {
            conn.execute(
                "ALTER TABLE tag_meta ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }

        // Seed default tags on first launch (only when tag_meta is empty)
        let tag_count: i32 = conn
            .prepare("SELECT COUNT(*) FROM tag_meta")?
            .query_row([], |row| row.get(0))
            .unwrap_or(0);
        if tag_count == 0 {
            let default_tags = [
                ("文档处理", 0, 0),
                ("界面设计", 1, 1),
                ("代码开发", 2, 2),
            ];
            for (tag, color_index, sort_order) in &default_tags {
                conn.execute(
                    "INSERT OR IGNORE INTO tag_meta (tag, color_index, sort_order) VALUES (?1, ?2, ?3)",
                    rusqlite::params![tag, color_index, sort_order],
                )?;
            }
        }

        // Migrate data from old agents/projects tables into targets
        migrate_old_tables_to_targets(&conn)?;

        sync_default_target(&conn)?;

        Ok(())
    }

    pub fn load_app_state(&self) -> Result<AppState> {
        let targets = self.load_targets()?;
        let mut extra_issues: Vec<String> = Vec::new();
        let mut skills = match self.scan_library_skills() {
            Ok(value) => value,
            Err(error) => {
                extra_issues.push(format!("无法扫描技能主库：{:#}", error));
                Vec::new()
            }
        };

        // Merge user-defined tags from database
        let conn_for_tags = self.connection()?;
        let mut tag_stmt = conn_for_tags
            .prepare("SELECT skill_id, tag FROM skill_tags ORDER BY skill_id, tag")?;
        let tag_rows = tag_stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut db_tags: HashMap<String, Vec<String>> = HashMap::new();
        for row in tag_rows {
            if let Ok((sid, tag)) = row {
                db_tags.entry(sid).or_default().push(tag);
            }
        }
        for skill in &mut skills {
            if let Some(tags) = db_tags.get(&skill.id) {
                skill.tags = tags.clone();
            }
        }

        let presets = self.load_presets()?;

        let mut workspaces = Vec::new();
        let mut all_statuses = Vec::new();

        for target in &targets {
            let skills_path = compute_skills_path(&target.path);
            let statuses = match self.scan_target_root(&skills, &skills_path, target) {
                Ok(value) => value,
                Err(error) => {
                    extra_issues.push(format!("{}：{:#}", target.name, error));
                    Vec::new()
                }
            };
            all_statuses.extend(statuses.clone());
            workspaces.push(TargetWorkspace {
                target_id: target.id.clone(),
                target_name: target.name.clone(),
                target_path: target.path.clone(),
                skills_path: skills_path.to_string_lossy().to_string(),
                target_exists: Path::new(&target.path).exists(),
                root_exists: skills_path.exists(),
                statuses,
            });
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

        if let Err(error) = self.persist_deployments(&all_statuses) {
            extra_issues.push(format!("无法写入部署快照：{:#}", error));
        }

        let mut issues: Vec<String> = all_statuses
            .iter()
            .filter_map(|status| {
                status.issue.as_ref().map(|issue| {
                    format!(
                        "{} / {}：{}",
                        status.target_name, status.display_name, issue
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
            targets,
            skills,
            workspaces,
            presets,
            issues,
        })
    }

    pub fn load_targets(&self) -> Result<Vec<Target>> {
        let conn = self.connection()?;
        let mut stmt =
            conn.prepare("SELECT id, name, path, is_default FROM targets ORDER BY is_default DESC, rowid")?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(2)?;
            Ok(Target {
                id: row.get(0)?,
                name: row.get(1)?,
                path_exists: Path::new(&path).exists(),
                path,
                is_default: row.get::<_, i64>(3)? == 1,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取目标列表")
    }

    pub fn suggest_onboarding_projects(&self) -> Result<Vec<ProjectSuggestion>> {
        let existing_paths: HashSet<String> = self
            .load_targets()?
            .into_iter()
            .filter_map(|target| normalize_existing_path(Path::new(&target.path)))
            .collect();
        let mut suggestions: HashMap<String, ProjectSuggestion> = HashMap::new();

        for root in onboarding_document_roots() {
            if !root.is_dir() {
                continue;
            }
            for path in collect_onboarding_candidate_dirs(&root) {
                let Ok(canonical) = path.canonicalize() else {
                    continue;
                };
                if !canonical.is_dir() {
                    continue;
                }
                let Some(score) = score_onboarding_project_dir(&canonical) else {
                    continue;
                };
                if score.score < ONBOARDING_PROJECT_SCORE_THRESHOLD {
                    continue;
                }

                let normalized = canonical.to_string_lossy().to_string();
                let name = canonical
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| "未命名项目".to_string());
                let already_added = existing_paths.contains(&normalized);
                let reason = if already_added {
                    format!("已添加 · {}", score.reasons.join("，"))
                } else {
                    score.reasons.join("，")
                };
                let suggestion = ProjectSuggestion {
                    id: stable_id(&normalized),
                    name,
                    path: normalized.clone(),
                    reason,
                    score: score.score,
                    recommended: score.score >= ONBOARDING_PROJECT_RECOMMENDED_SCORE,
                    already_added,
                };

                suggestions
                    .entry(normalized)
                    .and_modify(|current| {
                        if suggestion.score > current.score {
                            *current = suggestion.clone();
                        }
                    })
                    .or_insert(suggestion);
            }
        }

        let mut result = suggestions.into_values().collect::<Vec<_>>();
        result.sort_by(|a, b| {
            b.recommended
                .cmp(&a.recommended)
                .then(b.score.cmp(&a.score))
                .then(a.already_added.cmp(&b.already_added))
                .then(a.name.cmp(&b.name))
        });
        result.truncate(ONBOARDING_PROJECT_RETURN_LIMIT);
        Ok(result)
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
        target: &Target,
    ) -> Result<Vec<TargetStatus>> {
        let ignored_issue_keys = self.load_ignored_issue_keys().unwrap_or_default();
        let root_exists = root.exists();
        let scope_exists = Path::new(&target.path).exists();
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
                id: status_id(&skill.name, &target.id),
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                display_name: skill.display_name.clone(),
                description: skill.description.clone(),
                target_id: target.id.clone(),
                target_name: target.name.clone(),
                status: status.status,
                target_path: target_path.to_string_lossy().to_string(),
                link_target: status.link_target,
                issue: status.issue,
                issue_key: None,
                ignored: false,
                root_exists,
            });
        }

        if root_exists {
            let entries = match fs::read_dir(root) {
                Ok(value) => value,
                Err(error) => {
                    statuses.push(TargetStatus {
                        id: status_id("__unreadable__", &target.id),
                        skill_id: "__unreadable__".to_string(),
                        skill_name: "__unreadable__".to_string(),
                        display_name: "目录无法读取".to_string(),
                        description: format!("无法读取 {}：{}", root.display(), error),
                        target_id: target.id.clone(),
                        target_name: target.name.clone(),
                        status: SkillStatus::Invalid,
                        target_path: root.to_string_lossy().to_string(),
                        link_target: None,
                        issue: Some(format!("无法读取目录：{}", error)),
                        issue_key: None,
                        ignored: false,
                        root_exists,
                    });
                    apply_issue_metadata(&mut statuses, &ignored_issue_keys);
                    statuses.sort_by(|a, b| a.display_name.cmp(&b.display_name));
                    return Ok(statuses);
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(value) => value,
                    Err(error) => {
                        statuses.push(TargetStatus {
                            id: status_id("__entry_error__", &target.id),
                            skill_id: "__entry_error__".to_string(),
                            skill_name: "__entry_error__".to_string(),
                            display_name: "目录条目无法读取".to_string(),
                            description: format!("{}", error),
                            target_id: target.id.clone(),
                            target_name: target.name.clone(),
                            status: SkillStatus::Invalid,
                            target_path: root.to_string_lossy().to_string(),
                            link_target: None,
                            issue: Some(format!("目录条目无法读取：{}", error)),
                            issue_key: None,
                            ignored: false,
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
                if metadata.file_type().is_symlink() {
                    let link_target = resolve_symlink_target(&path);
                    let Some(source_path) = link_target.clone() else {
                        statuses.push(TargetStatus {
                            id: status_id(&name, &target.id),
                            skill_id: name.clone(),
                            skill_name: name.clone(),
                            display_name: name.clone(),
                            description: "软链接目标无法读取".to_string(),
                            target_id: target.id.clone(),
                            target_name: target.name.clone(),
                            status: SkillStatus::Broken,
                            target_path: path.to_string_lossy().to_string(),
                            link_target: None,
                            issue: Some("软链接目标无法读取".to_string()),
                            issue_key: None,
                            ignored: false,
                            root_exists,
                        });
                        continue;
                    };
                    if !source_path.exists() {
                        statuses.push(TargetStatus {
                            id: status_id(&name, &target.id),
                            skill_id: name.clone(),
                            skill_name: name.clone(),
                            display_name: name.clone(),
                            description: "软链接目标不存在".to_string(),
                            target_id: target.id.clone(),
                            target_name: target.name.clone(),
                            status: SkillStatus::Broken,
                            target_path: path.to_string_lossy().to_string(),
                            link_target: Some(source_path.to_string_lossy().to_string()),
                            issue: Some("软链接目标不存在".to_string()),
                            issue_key: None,
                            ignored: false,
                            root_exists,
                        });
                        continue;
                    }
                    if !source_path.is_dir() {
                        continue;
                    }
                    let skill_md = source_path.join("SKILL.md");
                    if !skill_md.exists() {
                        statuses.push(TargetStatus {
                            id: status_id(&name, &target.id),
                            skill_id: name.clone(),
                            skill_name: name.clone(),
                            display_name: name.clone(),
                            description: "软链接目标不是有效 Skill".to_string(),
                            target_id: target.id.clone(),
                            target_name: target.name.clone(),
                            status: SkillStatus::Invalid,
                            target_path: path.to_string_lossy().to_string(),
                            link_target: Some(source_path.to_string_lossy().to_string()),
                            issue: Some("软链接目标缺少 SKILL.md".to_string()),
                            issue_key: None,
                            ignored: false,
                            root_exists,
                        });
                        continue;
                    }
                    let content = fs::read_to_string(skill_md).unwrap_or_default();
                    let parsed = parse_skill_metadata(&name, &content);
                    statuses.push(TargetStatus {
                        id: status_id(&name, &target.id),
                        skill_id: name.clone(),
                        skill_name: name.clone(),
                        display_name: parsed.display_name,
                        description: parsed.description,
                        target_id: target.id.clone(),
                        target_name: target.name.clone(),
                        status: SkillStatus::Unmanaged,
                        target_path: path.to_string_lossy().to_string(),
                        link_target: Some(source_path.to_string_lossy().to_string()),
                        issue: Some("目标目录有技能，但尚未进入主库".to_string()),
                        issue_key: None,
                        ignored: false,
                        root_exists,
                    });
                    continue;
                }
                if !metadata.is_dir() {
                    continue;
                }
                let is_skill_like =
                    path.join("SKILL.md").exists() || path.join("README.md").exists();
                if !is_skill_like {
                    continue;
                }
                let source_path = resolve_symlink_target(&path).unwrap_or(path.clone());
                let skill_md = source_path.join("SKILL.md");
                let content = fs::read_to_string(skill_md).unwrap_or_default();
                let parsed = parse_skill_metadata(&name, &content);
                statuses.push(TargetStatus {
                    id: status_id(&name, &target.id),
                    skill_id: name.clone(),
                    skill_name: name.clone(),
                    display_name: parsed.display_name,
                    description: parsed.description,
                    target_id: target.id.clone(),
                    target_name: target.name.clone(),
                    status: SkillStatus::Unmanaged,
                    target_path: path.to_string_lossy().to_string(),
                    link_target: resolve_symlink_target(&path)
                        .map(|p| p.to_string_lossy().to_string()),
                    issue: Some("目标目录有技能，但尚未进入主库".to_string()),
                    issue_key: None,
                    ignored: false,
                    root_exists,
                });
            }
        }

        apply_issue_metadata(&mut statuses, &ignored_issue_keys);
        statuses.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(statuses)
    }

    pub fn load_ignored_issue_keys(&self) -> Result<HashSet<String>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare("SELECT issue_key FROM ignored_issues")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut keys = HashSet::new();
        for row in rows {
            keys.insert(row?);
        }
        Ok(keys)
    }

    pub fn ignore_issue_keys(&self, keys: &[String]) -> Result<()> {
        let mut conn = self.connection()?;
        let transaction = conn.transaction()?;
        for key in keys {
            transaction.execute(
                "INSERT INTO ignored_issues (issue_key) VALUES (?1)
                 ON CONFLICT(issue_key) DO UPDATE SET ignored_at = CURRENT_TIMESTAMP",
                params![key],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn resolve_broken_issue_keys(
        &self,
        keys: &[String],
    ) -> Result<crate::models::OperationReport> {
        let requested: HashSet<&str> = keys.iter().map(String::as_str).collect();
        let state = self.load_app_state()?;
        let statuses = state
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.statuses.iter());
        let mut report = crate::models::OperationReport::empty();

        for status in statuses {
            let Some(issue_key) = &status.issue_key else {
                continue;
            };
            if !requested.contains(issue_key.as_str()) {
                continue;
            }
            if status.status != SkillStatus::Broken {
                report.skipped += 1;
                continue;
            }
            let target_path = PathBuf::from(&status.target_path);
            let Ok(metadata) = fs::symlink_metadata(&target_path) else {
                report.skipped += 1;
                continue;
            };
            if !metadata.file_type().is_symlink() {
                report
                    .errors
                    .push(format!("{} 不是软链接，已跳过", status.target_path));
                continue;
            }
            match fs::remove_file(&target_path) {
                Ok(()) => report.changed += 1,
                Err(error) => report
                    .errors
                    .push(format!("{}：{}", status.target_path, error)),
            }
        }

        if report.changed + report.skipped + report.errors.len() < keys.len() {
            report.skipped += keys.len() - report.changed - report.skipped - report.errors.len();
        }
        Ok(report)
    }

    pub fn persist_deployments(&self, statuses: &[TargetStatus]) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM deployments", [])?;
        for status in statuses {
            conn.execute(
                "INSERT INTO deployments (id, skill_id, target_id, status, target_path, link_target)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    status.id,
                    status.skill_id,
                    status.target_id,
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

    pub fn add_target(&self, path: &Path) -> Result<()> {
        let target_path = path
            .canonicalize()
            .with_context(|| format!("无法读取目标路径 {}", path.display()))?;
        let name = target_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名目标".to_string());
        let id = stable_id(&target_path.to_string_lossy());
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO targets (id, name, path, is_default) VALUES (?1, ?2, ?3, 0)",
            params![id, name, target_path.to_string_lossy()],
        )?;
        Ok(())
    }

    pub fn remove_target(&self, target_id: &str) -> Result<()> {
        let conn = self.connection()?;
        if target_id == DEFAULT_GLOBAL_DIR_ID {
            return Err(anyhow!("默认全局目录不能移除"));
        }
        let is_default: bool = conn
            .query_row(
                "SELECT is_default FROM targets WHERE id = ?1",
                params![target_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|v| v == 1)
            .unwrap_or(false);
        if is_default {
            return Err(anyhow!("默认目标不能移除"));
        }
        let changed = conn.execute("DELETE FROM targets WHERE id = ?1", params![target_id])?;
        if changed == 0 {
            return Err(anyhow!("未找到目标：{}", target_id));
        }
        Ok(())
    }

    pub fn find_target(&self, target_id: &str) -> Result<Target> {
        self.load_targets()?
            .into_iter()
            .find(|target| target.id == target_id)
            .ok_or_else(|| anyhow!("未找到目标：{}", target_id))
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

    pub fn set_skill_tags(&self, skill_id: &str, tags: &[String]) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "DELETE FROM skill_tags WHERE skill_id = ?1",
            params![skill_id],
        )?;
        let mut stmt = conn
            .prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag) VALUES (?1, ?2)")?;
        for tag in tags {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                stmt.execute(params![skill_id, trimmed])?;
            }
        }
        Ok(())
    }

    pub fn get_all_tags(&self) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare("SELECT DISTINCT tag FROM skill_tags ORDER BY tag")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取标签列表")
    }

    pub fn get_skill_tags(&self, skill_id: &str) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut stmt =
            conn.prepare("SELECT tag FROM skill_tags WHERE skill_id = ?1 ORDER BY tag")?;
        let rows = stmt.query_map(params![skill_id], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取技能标签")
    }

    pub fn get_all_tags_info(&self) -> Result<Vec<TagInfo>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT st.tag, COALESCE(tm.color_index, -1), COUNT(*) as cnt, COALESCE(tm.sort_order, 0) \
             FROM skill_tags st \
             LEFT JOIN tag_meta tm ON tm.tag = st.tag \
             GROUP BY st.tag \
             ORDER BY COALESCE(tm.sort_order, 0) ASC, st.tag ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TagInfo {
                name: row.get::<_, String>(0)?,
                color_index: row.get::<_, i32>(1)?,
                count: row.get::<_, u32>(2)?,
                sort_order: row.get::<_, i32>(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取标签信息")
    }

    pub fn rename_tag(&self, old_name: &str, new_name: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE skill_tags SET tag = ?1 WHERE tag = ?2",
            params![new_name, old_name],
        )?;
        conn.execute("DELETE FROM tag_meta WHERE tag = ?1", params![new_name])?;
        conn.execute(
            "UPDATE tag_meta SET tag = ?1 WHERE tag = ?2",
            params![new_name, old_name],
        )?;
        Ok(())
    }

    pub fn set_tag_color(&self, tag: &str, color_index: i32) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO tag_meta (tag, color_index) VALUES (?1, ?2) \
             ON CONFLICT(tag) DO UPDATE SET color_index = excluded.color_index",
            params![tag, color_index],
        )?;
        Ok(())
    }

    pub fn delete_tag(&self, tag: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM skill_tags WHERE tag = ?1", params![tag])?;
        conn.execute("DELETE FROM tag_meta WHERE tag = ?1", params![tag])?;
        Ok(())
    }

    pub fn reorder_tag(&self, tag: &str, direction: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR IGNORE INTO tag_meta (tag, color_index, sort_order) \
             SELECT st.tag, -1, 0 FROM skill_tags st \
             WHERE st.tag NOT IN (SELECT tag FROM tag_meta)",
            [],
        )?;
        let all_zero: bool = conn
            .prepare("SELECT COUNT(*) FROM tag_meta WHERE sort_order != 0")?
            .query_row([], |row| row.get::<_, i32>(0))
            .unwrap_or(0)
            == 0;
        if all_zero {
            conn.execute(
                "UPDATE tag_meta SET sort_order = (SELECT COUNT(*) FROM tag_meta t2 WHERE t2.tag < tag_meta.tag)",
                [],
            )?;
        }
        let current_order: i32 = conn
            .prepare("SELECT sort_order FROM tag_meta WHERE tag = ?1")?
            .query_row(params![tag], |row| row.get(0))
            .unwrap_or(0);
        let swap_order = if direction == "up" {
            current_order - 1
        } else {
            current_order + 1
        };
        let swap_tag: Option<String> = conn
            .prepare("SELECT tag FROM tag_meta WHERE sort_order = ?1")?
            .query_row(params![swap_order], |row| row.get::<_, String>(0))
            .ok();
        if let Some(other) = swap_tag {
            conn.execute(
                "UPDATE tag_meta SET sort_order = ?1 WHERE tag = ?2",
                params![swap_order, tag],
            )?;
            conn.execute(
                "UPDATE tag_meta SET sort_order = ?1 WHERE tag = ?2",
                params![current_order, other],
            )?;
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

    pub fn list_unmanaged_in_targets(&self) -> Result<Vec<TargetStatus>> {
        let targets = self.load_targets()?;
        let skills = self.scan_library_skills()?;
        let mut result = Vec::new();
        for target in &targets {
            let skills_path = compute_skills_path(&target.path);
            if !skills_path.exists() {
                continue;
            }
            let statuses = self.scan_target_root(&skills, &skills_path, target)?;
            for status in statuses {
                if is_importable_unmanaged_status(&status) {
                    result.push(status);
                }
            }
        }
        Ok(result)
    }
}

// ---------------------------------------------------------------------------
// Database migration helpers
// ---------------------------------------------------------------------------

fn migrate_old_tables_to_targets(conn: &Connection) -> Result<()> {
    let already: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![TARGETS_TABLE_MIGRATION_KEY],
            |row| row.get(0),
        )
        .ok();
    if matches!(already.as_deref(), Some("true")) {
        return Ok(());
    }

    // Check if agents table has the 'enabled' column before using it
    let agents_has_enabled: bool = conn
        .prepare("SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name='enabled'")?
        .query_row([], |row| row.get::<_, i32>(0))
        .unwrap_or(0)
        > 0;

    if agents_has_enabled {
        conn.execute_batch(
            "INSERT OR IGNORE INTO targets (id, name, path, is_default)
             SELECT id, name, global_path, CASE WHEN id = 'agents' THEN 1 ELSE 0 END
             FROM agents WHERE enabled = 1",
        )?;
    } else {
        conn.execute_batch(
            "INSERT OR IGNORE INTO targets (id, name, path, is_default)
             SELECT id, name, global_path, CASE WHEN id = 'agents' THEN 1 ELSE 0 END
             FROM agents",
        )?;
    }

    conn.execute_batch(
        "INSERT OR IGNORE INTO targets (id, name, path, is_default)
         SELECT id, name, path, 0 FROM projects",
    )?;

    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![TARGETS_TABLE_MIGRATION_KEY],
    )?;

    Ok(())
}

fn sync_default_target(conn: &Connection) -> Result<()> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位用户主目录"))?;
    let global_path = home.join(".agents").join("skills");
    conn.execute(
        "INSERT INTO targets (id, name, path, is_default)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           is_default = 1",
        params![
            DEFAULT_GLOBAL_DIR_ID,
            DEFAULT_GLOBAL_DIR_NAME,
            global_path.to_string_lossy(),
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Onboarding project scanning
// ---------------------------------------------------------------------------

struct OnboardingProjectScore {
    score: usize,
    reasons: Vec<String>,
}

fn onboarding_document_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(document_dir) = dirs::document_dir() {
        push_unique_path(&mut roots, document_dir);
    }
    if let Some(home) = dirs::home_dir() {
        push_unique_path(&mut roots, home.join("Documents"));
        push_unique_path(&mut roots, home.join("文稿"));
    }
    roots
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn collect_onboarding_candidate_dirs(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in read_limited_child_dirs(root) {
        if should_ignore_project_scan_dir(&path) {
            continue;
        }
        if is_project_grouping_dir(&path) {
            for child in read_limited_child_dirs(&path) {
                if !should_ignore_project_scan_dir(&child) {
                    result.push(child);
                }
            }
        }
        result.push(path);
    }
    result
}

fn read_limited_child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for entry in entries.take(ONBOARDING_PROJECT_SCAN_LIMIT).flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            result.push(entry.path());
        }
    }
    result
}

fn should_ignore_project_scan_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || matches!(
            lower.as_str(),
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "library"
                | "applications"
                | "movies"
                | "music"
                | "pictures"
                | "downloads"
        )
}

fn is_project_grouping_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "project"
            | "projects"
            | "workspace"
            | "workspaces"
            | "code"
            | "codes"
            | "repo"
            | "repos"
            | "repositories"
            | "dev"
            | "developer"
            | "work"
    ) || matches!(name.as_str(), "项目" | "代码" | "开发" | "工作区")
}

fn score_onboarding_project_dir(path: &Path) -> Option<OnboardingProjectScore> {
    let mut score = 0usize;
    let mut reasons = Vec::new();
    let skill_roots = [
        ".codex/skills",
        ".claude/skills",
        ".trae-cn/skills",
        ".aiden/skills",
        ".agents/skills",
    ];
    let agent_roots = [".codex", ".claude", ".trae-cn", ".aiden", ".agents"];
    let rule_files = ["AGENTS.md", "CLAUDE.md"];
    let project_markers = [
        ".git",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "pnpm-workspace.yaml",
        "yarn.lock",
    ];

    let skill_root_count = skill_roots
        .iter()
        .filter(|relative| path.join(relative).is_dir())
        .count();
    if skill_root_count > 0 {
        score += 70;
        reasons.push(format!("发现 {} 个项目级 Skill 目录", skill_root_count));
    }

    let agent_root_count = agent_roots
        .iter()
        .filter(|relative| path.join(relative).exists())
        .count();
    if agent_root_count > 0 {
        score += 25;
        reasons.push("发现 Agent 工作痕迹".to_string());
    }

    let rule_file_count = rule_files
        .iter()
        .filter(|relative| path.join(relative).is_file())
        .count();
    if rule_file_count > 0 {
        score += 24;
        reasons.push("发现 Agent 协作规则".to_string());
    }

    let project_marker_count = project_markers
        .iter()
        .filter(|relative| path.join(relative).exists())
        .count();
    if project_marker_count > 0 {
        score += 16;
        reasons.push("像项目根目录".to_string());
    }

    if has_project_name_hint(path) {
        score += 4;
    }

    (!reasons.is_empty()).then_some(OnboardingProjectScore { score, reasons })
}

fn has_project_name_hint(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    lower.contains("project")
        || lower.contains("workspace")
        || lower.contains("repo")
        || name.contains("项目")
        || name.contains("产品")
}

fn normalize_existing_path(path: &Path) -> Option<String> {
    path.canonicalize()
        .ok()
        .map(|value| value.to_string_lossy().to_string())
}

fn is_importable_unmanaged_status(status: &TargetStatus) -> bool {
    if status.status != SkillStatus::Unmanaged {
        return false;
    }
    let target_path = Path::new(&status.target_path);
    target_path.join("SKILL.md").exists()
        || status
            .link_target
            .as_deref()
            .map(|path| Path::new(path).join("SKILL.md").exists())
            .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Path analysis & symlink utilities
// ---------------------------------------------------------------------------

struct PathAnalysis {
    status: SkillStatus,
    link_target: Option<String>,
    issue: Option<String>,
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

pub fn resolve_symlink_target(path: &Path) -> Option<PathBuf> {
    let target = fs::read_link(path).ok()?;
    if target.is_absolute() {
        Some(target)
    } else {
        path.parent().map(|parent| parent.join(target))
    }
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

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

struct SkillMetadata {
    display_name: String,
    description: String,
    tags: Vec<String>,
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

// ---------------------------------------------------------------------------
// ID & issue key helpers
// ---------------------------------------------------------------------------

fn stable_id(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("id-{:x}", hasher.finish())
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

fn status_id(skill_name: &str, target_id: &str) -> String {
    format!("{}-{}", target_id, skill_name)
}

fn apply_issue_metadata(statuses: &mut Vec<TargetStatus>, ignored_issue_keys: &HashSet<String>) {
    for status in statuses.iter_mut() {
        if !is_issue_status(&status.status) {
            continue;
        }
        let issue_key = issue_key_for_status(status);
        status.ignored = ignored_issue_keys.contains(&issue_key);
        status.issue_key = Some(issue_key);
    }
    statuses.retain(|status| !status.ignored);
}

fn is_issue_status(status: &SkillStatus) -> bool {
    matches!(
        status,
        SkillStatus::Unmanaged
            | SkillStatus::Conflict
            | SkillStatus::Broken
            | SkillStatus::PathMissing
            | SkillStatus::Invalid
    )
}

fn issue_key_for_status(status: &TargetStatus) -> String {
    format!(
        "status={:?}|target={}|skill={}|path={}|link={}",
        status.status,
        status.target_id,
        status.skill_name,
        status.target_path,
        status.link_target.as_deref().unwrap_or("")
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "skill-hub-onboarding-{}-{}",
            name,
            std::process::id()
        ));
        if root.exists() {
            let _ = fs::remove_dir_all(&root);
        }
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn project_candidate_scan_returns_empty_for_empty_root() {
        let root = temp_root("empty");
        let candidates = collect_onboarding_candidate_dirs(&root);
        let _ = fs::remove_dir_all(&root);
        assert!(candidates.is_empty());
    }

    #[test]
    fn project_candidate_scan_tolerates_unreadable_root() {
        let root = temp_root("unreadable");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
        let candidates = read_limited_child_dirs(&root);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_dir_all(&root);
        assert!(candidates.is_empty());
    }

    #[test]
    fn project_candidate_scan_scores_agent_workspace() {
        let root = temp_root("candidate");
        let project = root.join("Projects").join("ShadowProduct");
        fs::create_dir_all(project.join(".codex").join("skills")).unwrap();
        fs::write(project.join("AGENTS.md"), "# Rules").unwrap();
        fs::write(
            project.join("Cargo.toml"),
            "[package]\nname = \"demo\"\n",
        )
        .unwrap();

        let candidates = collect_onboarding_candidate_dirs(&root);
        let score = score_onboarding_project_dir(&project).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(candidates.iter().any(|candidate| candidate == &project));
        assert!(score.score >= ONBOARDING_PROJECT_RECOMMENDED_SCORE);
    }

    #[test]
    fn project_candidate_scan_scores_agents_workspace() {
        let root = temp_root("agents-candidate");
        let project = root.join("Projects").join("AgentsProduct");
        fs::create_dir_all(project.join(".agents").join("skills")).unwrap();
        fs::write(project.join("package.json"), "{}").unwrap();

        let candidates = collect_onboarding_candidate_dirs(&root);
        let score = score_onboarding_project_dir(&project).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(candidates.iter().any(|candidate| candidate == &project));
        assert!(score.score >= ONBOARDING_PROJECT_RECOMMENDED_SCORE);
    }

    #[test]
    fn onboarding_unmanaged_candidate_requires_skill_md() {
        let root = temp_root("unmanaged");
        let target = root.join("readme-only");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("README.md"), "# Not enough").unwrap();
        let mut status = TargetStatus {
            id: "id".to_string(),
            skill_id: "readme-only".to_string(),
            skill_name: "readme-only".to_string(),
            display_name: "readme-only".to_string(),
            description: String::new(),
            target_id: "agents".to_string(),
            target_name: "全局".to_string(),
            status: SkillStatus::Unmanaged,
            target_path: target.to_string_lossy().to_string(),
            link_target: None,
            issue: None,
            issue_key: None,
            ignored: false,
            root_exists: true,
        };

        assert!(!is_importable_unmanaged_status(&status));
        fs::write(target.join("SKILL.md"), "---\nname: readme-only\n---\n").unwrap();
        status.target_path = target.to_string_lossy().to_string();
        assert!(is_importable_unmanaged_status(&status));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn compute_skills_path_appends_when_needed() {
        let result = compute_skills_path("/Users/test/my-project");
        assert_eq!(result, PathBuf::from("/Users/test/my-project/.agents/skills"));
    }

    #[test]
    fn compute_skills_path_uses_as_is_when_already_ends_with_agents_skills() {
        let result = compute_skills_path("/Users/test/.agents/skills");
        assert_eq!(result, PathBuf::from("/Users/test/.agents/skills"));
    }

    #[test]
    fn compute_skills_path_strips_trailing_slash() {
        let result = compute_skills_path("/Users/test/.agents/skills/");
        assert_eq!(result, PathBuf::from("/Users/test/.agents/skills"));
    }
}
