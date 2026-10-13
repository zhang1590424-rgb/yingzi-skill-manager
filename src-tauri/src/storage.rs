use crate::models::{AppState, Skill, SkillStatus, TagInfo, Target, TargetStatus, TargetWorkspace};
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
    pub is_isolated: bool,
    pub global_root: PathBuf,
}

const TEST_HOME_ENV: &str = "YINGZI_TEST_HOME";
const TEST_ROOT_MARKER: &str = ".yingzi-test-root";

/// 项目级技能统一分发到该相对目录。
pub const PROJECT_SKILLS_RELATIVE: &str = ".agents/skills";
const DEFAULT_GLOBAL_DIR_ID: &str = "agents";
const DEFAULT_GLOBAL_DIR_NAME: &str = "全局";

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

/// 纯路径规划结果（不建库），便于单测隔离规则。
pub(crate) struct StorePaths {
    base_dir: PathBuf,
    skills_root: PathBuf,
    database_path: PathBuf,
    config_path: PathBuf,
    is_isolated: bool,
    global_root: PathBuf,
}

/// 纯路径规划（不写库、不建 skills_root），可直接单测。
fn plan_store_paths(test_home: Option<&str>, home: &Path) -> Result<StorePaths> {
    match test_home {
        None => {
            let base_dir = home.join(".skills-manager");
            Ok(StorePaths {
                skills_root: base_dir.join("skills"),
                database_path: base_dir.join("app.db"),
                config_path: base_dir.join("config.json"),
                is_isolated: false,
                global_root: home.join(".agents").join("skills"),
                base_dir,
            })
        }
        Some(th) => {
            let th = th.trim();
            if th.is_empty() {
                anyhow::bail!("{} 已设置但为空", TEST_HOME_ENV);
            }
            let root = PathBuf::from(th);
            if !root.is_absolute() {
                anyhow::bail!("{} 必须是绝对路径：{}", TEST_HOME_ENV, th);
            }
            let marker = root.join(TEST_ROOT_MARKER);
            if root.exists() {
                if !marker.exists() {
                    anyhow::bail!(
                        "{} 已存在但缺少标记文件 {}，拒绝启动以避免误写真实目录",
                        TEST_HOME_ENV,
                        TEST_ROOT_MARKER
                    );
                }
            } else {
                fs::create_dir_all(&root).context("无法创建测试根目录")?;
                fs::write(&marker, "yingzi isolation root").context("无法写入测试根标记")?;
            }
            let root_canon = root
                .canonicalize()
                .with_context(|| format!("无法解析测试根：{}", root.display()))?;
            let real_base = home.join(".skills-manager");
            let real_agents = home.join(".agents");
            for forbidden in [&real_base, &real_agents] {
                if let Ok(f) = forbidden.canonicalize() {
                    if root_canon == f || root_canon.starts_with(&f) {
                        anyhow::bail!(
                            "{} 不能位于真实技能目录内：{}",
                            TEST_HOME_ENV,
                            root_canon.display()
                        );
                    }
                }
            }
            let base_dir = root_canon.join(".skills-manager");
            Ok(StorePaths {
                skills_root: base_dir.join("skills"),
                database_path: base_dir.join("app.db"),
                config_path: base_dir.join("config.json"),
                is_isolated: true,
                global_root: root_canon.join(".agents").join("skills"),
                base_dir,
            })
        }
    }
}

/// 读取某张表当前的列名集合；表不存在时返回空集合。
fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let rows = stmt.query_map([table], |row| row.get::<_, String>(0))?;
    let mut columns = HashSet::new();
    for row in rows {
        columns.insert(row?);
    }
    Ok(columns)
}

impl Store {
    pub fn new() -> Result<Self> {
        let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位用户主目录"))?;
        let p = plan_store_paths(std::env::var(TEST_HOME_ENV).ok().as_deref(), &home)?;
        fs::create_dir_all(&p.skills_root).context("无法创建技能主库目录")?;
        let store = Self {
            base_dir: p.base_dir,
            skills_root: p.skills_root,
            database_path: p.database_path,
            config_path: p.config_path,
            is_isolated: p.is_isolated,
            global_root: p.global_root,
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

        // 旧版数据库（Agent/Project 双模型时期）的 deployments 表用
        // target_kind/agent_id/project_id 记录归属，没有 target_id。CREATE TABLE
        // IF NOT EXISTS 无法修复这类结构漂移，而旧表遗留的无默认值 NOT NULL 列会让
        // 后续写入必然失败，所以这里直接丢弃旧表，交给下方 schema 重建。
        // 该表只是每次扫描后整体重写的派生快照（先 DELETE 再 INSERT），从不被读取，
        // 因此重建不会丢失有效数据。
        let required_columns = [
            "id",
            "skill_id",
            "target_id",
            "status",
            "target_path",
            "link_target",
        ];
        let existing_columns = table_columns(&conn, "deployments")?;
        if !existing_columns.is_empty()
            && !required_columns
                .iter()
                .all(|column| existing_columns.contains(*column))
        {
            conn.execute("DROP TABLE deployments", [])?;
        }

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS targets (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE,
              is_default INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS deployments (
              id TEXT PRIMARY KEY,
              skill_id TEXT NOT NULL,
              target_id TEXT NOT NULL,
              status TEXT NOT NULL,
              target_path TEXT NOT NULL,
              link_target TEXT
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

        sync_default_target(&conn, &self.global_root)?;

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
        for (sid, tag) in tag_rows.flatten() {
            db_tags.entry(sid).or_default().push(tag);
        }
        // U16: 已初始化（导入）的技能以 DB 为权威——即使无标签行也置空，不从前置 frontmatter 复活。
        let mut initialized: HashSet<String> = HashSet::new();
        if let Ok(mut init_stmt) = conn_for_tags
            .prepare("SELECT key FROM settings WHERE key LIKE 'tag_initialized:%'")
        {
            if let Ok(rows) = init_stmt.query_map([], |row| row.get::<_, String>(0)) {
                for row in rows.flatten() {
                    if let Some(id) = row.strip_prefix("tag_initialized:") {
                        initialized.insert(id.to_string());
                    }
                }
            }
        }
        for skill in &mut skills {
            if let Some(tags) = db_tags.get(&skill.id) {
                skill.tags = tags.clone();
            } else if initialized.contains(&skill.id) {
                skill.tags = Vec::new();
            }
        }

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

        // 读取状态不写数据库：deployments 快照从不被读取，每次刷新整表重写只会
        // 增加写锁竞争（dsh 插件也会打开同一个 app.db），且非事务写入可能留下半张表。

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
            is_isolated: self.is_isolated,
            targets,
            skills,
            workspaces,
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
                can_overwrite: TargetStatus::overwritable(&status.status),
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
                        root_exists,
                        can_overwrite: false,
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
                            root_exists,
                            can_overwrite: false,
                        });
                        continue;
                    }
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if seen.contains(&name) {
                    continue;
                }
                let path = entry.path();
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    Err(_) => {
                        statuses.push(TargetStatus {
                            id: status_id(&name, &target.id),
                            skill_id: name.clone(),
                            skill_name: name.clone(),
                            display_name: name.clone(),
                            description: "条目无法读取".to_string(),
                            target_id: target.id.clone(),
                            target_name: target.name.clone(),
                            status: SkillStatus::Invalid,
                            target_path: path.to_string_lossy().to_string(),
                            link_target: None,
                            issue: Some("无法读取该条目".to_string()),
                            root_exists,
                            can_overwrite: false,
                        });
                        continue;
                    }
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
                            root_exists,
                            can_overwrite: false,
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
                            root_exists,
                            can_overwrite: false,
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
                            root_exists,
                            can_overwrite: false,
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
                        root_exists,
                        can_overwrite: false,
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
                    root_exists,
                    can_overwrite: false,
                });
            }
        }

        statuses.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        Ok(statuses)
    }

    /// 写入部署快照（单事务）。当前产品不读取该表，仅保留给迁移测试；
    /// 不要在读取路径（load_app_state）中调用。
    #[cfg(test)]
    pub fn persist_deployments(&self, statuses: &[TargetStatus]) -> Result<()> {
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM deployments", [])?;
        for status in statuses {
            tx.execute(
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
        tx.commit()?;
        Ok(())
    }

    pub fn skill_path(&self, skill_id: &str) -> PathBuf {
        self.skills_root.join(skill_id)
    }

    pub fn add_target(&self, path: &Path) -> Result<()> {
        let target_path = path
            .canonicalize()
            .with_context(|| format!("无法读取目标路径 {}", path.display()))?;
        if !target_path.is_dir() {
            return Err(anyhow!("目标路径不是文件夹：{}", target_path.display()));
        }
        let name = target_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名目标".to_string());
        let id = stable_id(&target_path.to_string_lossy());
        let conn = self.connection()?;
        // 同一路径（含默认全局目录）已存在时明确报错，不静默覆盖。
        let existing: Option<String> = conn
            .query_row(
                "SELECT name FROM targets WHERE id = ?1 OR path = ?2",
                params![id, target_path.to_string_lossy()],
                |row| row.get(0),
            )
            .ok();
        if let Some(existing_name) = existing {
            return Err(anyhow!("该目标已存在：{}", existing_name));
        }
        conn.execute(
            "INSERT INTO targets (id, name, path, is_default) VALUES (?1, ?2, ?3, 0)",
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
        // U05: 若目标下仍有指向主库的受管软链，必须先收回，拒绝直接移除。
        let target_row: String = conn.query_row(
            "SELECT path FROM targets WHERE id = ?1",
            params![target_id],
            |row| row.get(0),
        )?;
        let skills_path = compute_skills_path(&target_row);
        if let Ok(entries) = fs::read_dir(&skills_path) {
            let mut managed = 0usize;
            for entry in entries {
                let entry = entry
                    .with_context(|| format!("读取目标目录条目失败：{}", skills_path.display()))?;
                let p = entry.path();
                let expected = self.skills_root.join(entry.file_name());
                if is_link_to(&p, &expected) {
                    managed += 1;
                }
            }
            if managed > 0 {
                return Err(anyhow!("该目标下仍有 {} 个受管技能，请先收回后再移除", managed));
            }
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

    pub fn set_skill_tags(&self, skill_id: &str, tags: &[String]) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            "DELETE FROM skill_tags WHERE skill_id = ?1",
            params![skill_id],
        )?;
        let mut stmt = conn
            .prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag) VALUES (?1, ?2)")?;
        let mut seen: HashSet<String> = HashSet::new();
        for tag in tags {
            let trimmed = tag.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                stmt.execute(params![skill_id, trimmed])?;
            }
        }
        Ok(())
    }

    /// U16: 导入时写入权威标记，使空标签集合为权威（删空不从前置 frontmatter 复活）。
    pub fn initialize_skill_tags(&self, skill_id: &str, tags: &[String]) -> Result<()> {
        let key = format!("tag_initialized:{}", skill_id);
        {
            let conn = self.connection()?;
            let already: Option<String> = conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .ok();
            if already.is_some() {
                return Ok(());
            }
        }
        self.set_skill_tags(skill_id, tags)?;
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
            params![key],
        )?;
        Ok(())
    }

    /// 删除技能时清理其标签关联。
    pub fn forget_skill_tags(&self, skill_id: &str) -> Result<()> {
        let conn = self.connection()?;
        conn.execute("DELETE FROM skill_tags WHERE skill_id = ?1", params![skill_id])?;
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![format!("tag_initialized:{}", skill_id)],
        )?;
        Ok(())
    }

    pub fn get_all_tags(&self) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT tag FROM skill_tags \
             UNION SELECT tag FROM tag_meta \
             ORDER BY tag",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .context("无法读取标签列表")
    }

    pub fn get_all_tags_info(&self) -> Result<Vec<TagInfo>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT tag, color_index, cnt, sort_order FROM ( \
               SELECT st.tag AS tag, COALESCE(tm.color_index, -1) AS color_index, COUNT(*) AS cnt, COALESCE(tm.sort_order, 0) AS sort_order \
               FROM skill_tags st \
               LEFT JOIN tag_meta tm ON tm.tag = st.tag \
               GROUP BY st.tag \
             UNION ALL \
               SELECT tm2.tag AS tag, tm2.color_index, 0 AS cnt, tm2.sort_order \
               FROM tag_meta tm2 \
               WHERE tm2.tag NOT IN (SELECT tag FROM skill_tags) \
             ) ORDER BY sort_order ASC, tag ASC",
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
        if old_name == new_name {
            return Ok(()); // 同名 no-op
        }
        // 目标名已存在 → 拒绝，避免意外合并
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tag_meta WHERE tag = ?1",
                params![new_name],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            return Err(anyhow!("标签已存在：{}", new_name));
        }
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

    pub fn create_tag(&self, tag: &str) -> Result<()> {
        let conn = self.connection()?;
        // Determine next sort_order
        let max_order: i32 = conn
            .prepare("SELECT COALESCE(MAX(sort_order), -1) FROM tag_meta")?
            .query_row([], |row| row.get(0))
            .unwrap_or(-1);
        conn.execute(
            "INSERT OR IGNORE INTO tag_meta (tag, color_index, sort_order) VALUES (?1, -1, ?2)",
            params![tag, max_order + 1],
        )?;
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

    pub fn reorder_tags(&self, tags: &[String]) -> Result<()> {
        let conn = self.connection()?;
        for (i, tag) in tags.iter().enumerate() {
            conn.execute(
                "INSERT INTO tag_meta (tag, color_index, sort_order) VALUES (?1, -1, ?2) \
                 ON CONFLICT(tag) DO UPDATE SET sort_order = ?2",
                params![tag, i as i32],
            )?;
        }
        Ok(())
    }

}

fn sync_default_target(conn: &Connection, global_root: &Path) -> Result<()> {
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
            global_root.to_string_lossy(),
        ],
    )?;
    Ok(())
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

    let metadata = match fs::symlink_metadata(target_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return PathAnalysis { status: SkillStatus::Disabled, link_target: None, issue: None };
        }
        Err(_) => {
            return PathAnalysis {
                status: SkillStatus::Invalid,
                link_target: None,
                issue: Some("无法读取目标位置".to_string()),
            };
        }
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
// U04: 目标位置指纹（覆盖竞态保护）
// ---------------------------------------------------------------------------

/// 纯分类：stat 错误 → 指纹 kind。NotFound→missing，其余→unknown（绝不误判缺失）。
pub(crate) fn classify_stat_error(e: &std::io::Error) -> &'static str {
    if e.kind() == std::io::ErrorKind::NotFound {
        "missing"
    } else {
        "unknown"
    }
}

/// 计算目标位置现存对象指纹。目录用递归内容散列，内部修改即变。读取失败 → unknown。
pub fn fingerprint_of(path: &Path) -> crate::models::PathFingerprint {
    use crate::models::PathFingerprint;
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => {
            return PathFingerprint { kind: classify_stat_error(&e).to_string(), ..Default::default() };
        }
    };
    if metadata.file_type().is_symlink() {
        return PathFingerprint {
            kind: "symlink".into(),
            link_target: resolve_symlink_target(path).map(|p| p.to_string_lossy().to_string()),
            ..Default::default()
        };
    }
    if metadata.is_dir() {
        return match hash_dir_contents(path) {
            Some(h) => PathFingerprint { kind: "dir".into(), content_hash: Some(h), ..Default::default() },
            None => PathFingerprint { kind: "unknown".into(), ..Default::default() },
        };
    }
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    PathFingerprint { kind: "file".into(), size: Some(metadata.len()), mtime_ms, ..Default::default() }
}

/// 递归目录内容散列；任一条目读取失败 → None（fail-closed）。
fn hash_dir_contents(root: &Path) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    for e in WalkDir::new(root).follow_links(false) {
        let e = match e {
            Ok(v) => v,
            Err(_) => return None,
        };
        let rel = match e.path().strip_prefix(root) {
            Ok(r) if !r.as_os_str().is_empty() => r.to_string_lossy().to_string(),
            _ => continue,
        };
        let m = match e.metadata() {
            Ok(m) => m,
            Err(_) => return None,
        };
        let kind = if m.file_type().is_dir() {
            'd'
        } else if m.file_type().is_symlink() {
            'l'
        } else {
            'f'
        };
        let mtime_ns = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        entries.push(format!("{}\t{}\t{}\t{}", rel, kind, m.len(), mtime_ns));
    }
    entries.sort();
    let canonical = entries.join("\n");
    let mut h: u64 = 0xcbf29ce484222325;
    for b in canonical.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Some(format!("{:016x}", h))
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

// ---------------------------------------------------------------------------
// ID helpers
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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

    fn fresh_home(tag: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!(
            "yz-home-{}-{}-{}",
            tag,
            std::process::id(),
            std::thread::current().name().unwrap_or("t").replace(|c: char| !c.is_ascii_alphanumeric(), "")
        ));
        let _ = fs::remove_dir_all(&h);
        fs::create_dir_all(&h).unwrap();
        h
    }

    #[test]
    fn default_plan_uses_real_home_paths() {
        let home = fresh_home("default");
        let p = plan_store_paths(None, &home).unwrap();
        assert!(!p.is_isolated);
        assert_eq!(p.base_dir, home.join(".skills-manager"));
        assert_eq!(p.global_root, home.join(".agents").join("skills"));
    }

    #[test]
    fn isolated_plan_requires_absolute_and_marker() {
        let home = fresh_home("iso");
        assert!(plan_store_paths(Some("relative/path"), &home).is_err());
        let existing = home.join("plain");
        fs::create_dir_all(&existing).unwrap();
        assert!(plan_store_paths(existing.to_str(), &home).is_err());
        let root = home.join("casper-root");
        let p = plan_store_paths(root.to_str(), &home).unwrap();
        assert!(p.is_isolated);
        assert!(root.join(TEST_ROOT_MARKER).exists());
        let root_canon = root.canonicalize().unwrap();
        assert!(p.base_dir.starts_with(&root_canon));
        assert!(p.global_root.starts_with(&root_canon));
    }

    #[test]
    fn isolated_plan_refuses_real_skill_dir() {
        let home = fresh_home("forbid");
        let real_base = home.join(".skills-manager");
        fs::create_dir_all(&real_base).unwrap();
        fs::write(real_base.join(TEST_ROOT_MARKER), "x").unwrap();
        assert!(plan_store_paths(real_base.to_str(), &home).is_err());
        let real_agents = home.join(".agents").join("skills");
        fs::create_dir_all(&real_agents).unwrap();
        fs::write(real_agents.join(TEST_ROOT_MARKER), "x").unwrap();
        assert!(plan_store_paths(real_agents.to_str(), &home).is_err());
    }

    #[test]
    fn fingerprint_classifies_and_detects_internal_change() {
        let tmp = fresh_home("fp");
        let dir = tmp.join("occupied");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/a.txt"), "v1").unwrap();
        let fp1 = fingerprint_of(&dir);
        assert_eq!(fp1.kind, "dir");
        let hash1 = fp1.content_hash.clone().unwrap();
        fs::write(dir.join("sub/a.txt"), "v2 changed").unwrap();
        let fp2 = fingerprint_of(&dir);
        assert_ne!(fp1, fp2);
        assert_ne!(hash1, fp2.content_hash.unwrap());
        assert_eq!(fingerprint_of(&tmp.join("nope")).kind, "missing");
    }

    #[test]
    fn analyze_target_path_cores_states() {
        let tmp = fresh_home("states");
        let skill = tmp.join("libskill");
        fs::create_dir_all(&skill).unwrap();
        assert_eq!(analyze_target_path(&tmp.join("x"), &skill, false).status, SkillStatus::PathMissing);
        assert_eq!(analyze_target_path(&tmp.join("missing"), &skill, true).status, SkillStatus::Disabled);
        let link = tmp.join("own");
        std::os::unix::fs::symlink(&skill, &link).unwrap();
        assert_eq!(analyze_target_path(&link, &skill, true).status, SkillStatus::Enabled);
        let realdir = tmp.join("realdir");
        fs::create_dir_all(&realdir).unwrap();
        assert_eq!(analyze_target_path(&realdir, &skill, true).status, SkillStatus::Conflict);
    }

    #[test]
    fn ensure_database_rebuilds_legacy_deployments_table() {
        let home = fresh_home("legacy-deployments");
        let base_dir = home.join(".skills-manager");
        let store = Store {
            skills_root: base_dir.join("skills"),
            database_path: base_dir.join("app.db"),
            config_path: base_dir.join("config.json"),
            base_dir,
            is_isolated: false,
            global_root: home.join(".agents").join("skills"),
        };
        fs::create_dir_all(&store.skills_root).unwrap();

        // 复现 Agent/Project 双模型时期的 deployments 表结构
        {
            let conn = store.connection().unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE deployments (
                  id TEXT PRIMARY KEY,
                  skill_id TEXT NOT NULL,
                  target_kind TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  project_id TEXT,
                  status TEXT NOT NULL,
                  target_path TEXT NOT NULL,
                  link_target TEXT
                );
                INSERT INTO deployments (id, skill_id, target_kind, agent_id, status, target_path)
                  VALUES ('legacy', 'demo', 'agent', 'agents', 'enabled', '/tmp/demo');
                "#,
            )
            .unwrap();
        }

        store.ensure_database().unwrap();

        let conn = store.connection().unwrap();
        let columns = table_columns(&conn, "deployments").unwrap();
        for column in ["id", "skill_id", "target_id", "status", "target_path", "link_target"] {
            assert!(columns.contains(column), "迁移后缺少列 {column}");
        }
        assert!(!columns.contains("agent_id"), "旧列 agent_id 应已移除");
        let stale_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM deployments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stale_rows, 0, "旧快照行不应残留");

        // 迁移后写入部署快照必须成功（即原报错路径）
        store
            .persist_deployments(&[TargetStatus {
                id: "demo-agents".to_string(),
                skill_id: "demo".to_string(),
                skill_name: "demo".to_string(),
                display_name: "demo".to_string(),
                description: String::new(),
                target_id: "agents".to_string(),
                target_name: "全局".to_string(),
                status: SkillStatus::Enabled,
                target_path: "/tmp/demo".to_string(),
                link_target: None,
                issue: None,
                root_exists: true,
                can_overwrite: false,
            }])
            .unwrap();
        let snapshot_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM deployments", [], |row| row.get(0))
            .unwrap();
        assert_eq!(snapshot_rows, 1);
    }

    #[test]
    fn ensure_database_keeps_current_deployments_schema() {
        let home = fresh_home("current-deployments");
        let base_dir = home.join(".skills-manager");
        let store = Store {
            skills_root: base_dir.join("skills"),
            database_path: base_dir.join("app.db"),
            config_path: base_dir.join("config.json"),
            base_dir,
            is_isolated: false,
            global_root: home.join(".agents").join("skills"),
        };
        fs::create_dir_all(&store.skills_root).unwrap();
        store.ensure_database().unwrap();
        // 二次调用不应破坏已有结构
        store.ensure_database().unwrap();
        let columns = table_columns(&store.connection().unwrap(), "deployments").unwrap();
        assert!(columns.contains("target_id"));
    }
}
