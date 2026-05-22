use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub global_path: String,
    pub project_relative_path: String,
    pub enabled: bool,
    pub path_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub path: String,
    pub has_skill_md: bool,
    pub tags: Vec<String>,
    pub enabled_count: usize,
    pub issue_count: usize,
    pub content_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    pub id: String,
    pub skill_id: String,
    pub skill_name: String,
    pub display_name: String,
    pub description: String,
    pub target_kind: TargetKind,
    pub agent_id: String,
    pub agent_name: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub status: SkillStatus,
    pub target_path: String,
    pub link_target: Option<String>,
    pub issue: Option<String>,
    pub root_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentWorkspace {
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub project_exists: bool,
    pub agent_id: String,
    pub agent_name: String,
    pub root_path: String,
    pub root_exists: bool,
    pub statuses: Vec<TargetStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub agent_id: String,
    pub agent_name: String,
    pub root_path: String,
    pub root_exists: bool,
    pub statuses: Vec<TargetStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub base_dir: String,
    pub skills_root: String,
    pub database_path: String,
    pub config_path: String,
    pub agents: Vec<Agent>,
    pub projects: Vec<Project>,
    pub skills: Vec<Skill>,
    pub global_workspaces: Vec<AgentWorkspace>,
    pub project_workspaces: Vec<ProjectAgentWorkspace>,
    pub presets: Vec<Preset>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployTarget {
    pub agent_id: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReport {
    pub changed: usize,
    pub skipped: usize,
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
}

impl OperationReport {
    pub fn empty() -> Self {
        Self {
            changed: 0,
            skipped: 0,
            conflicts: Vec::new(),
            errors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillStatus {
    Enabled,
    Disabled,
    Unmanaged,
    Conflict,
    Broken,
    PathMissing,
    Invalid,
}

impl SkillStatus {
    pub fn label(&self) -> &'static str {
        match self {
            SkillStatus::Enabled => "已启用",
            SkillStatus::Disabled => "未启用",
            SkillStatus::Unmanaged => "未入库",
            SkillStatus::Conflict => "冲突",
            SkillStatus::Broken => "失效",
            SkillStatus::PathMissing => "路径不存在",
            SkillStatus::Invalid => "格式异常",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatus {
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub name: String,
    pub global_path: String,
    pub project_relative_path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkAdoptItem {
    pub agent_id: String,
    pub project_id: Option<String>,
    pub skill_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkAdoptReport {
    pub state: AppState,
    pub changed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSkill {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub entry_prefix: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackageScan {
    pub package_path: String,
    pub skills: Vec<PackageSkill>,
    pub ignored_plugin_skills: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageImportReport {
    pub state: AppState,
    pub changed: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}
