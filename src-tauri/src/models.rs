use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
    pub path_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub path: String,
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
    pub target_id: String,
    pub target_name: String,
    pub status: SkillStatus,
    pub target_path: String,
    pub link_target: Option<String>,
    pub issue: Option<String>,
    pub root_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWorkspace {
    pub target_id: String,
    pub target_name: String,
    pub target_path: String,
    pub skills_path: String,
    pub target_exists: bool,
    pub root_exists: bool,
    pub statuses: Vec<TargetStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub base_dir: String,
    pub skills_root: String,
    pub database_path: String,
    pub config_path: String,
    pub targets: Vec<Target>,
    pub skills: Vec<Skill>,
    pub workspaces: Vec<TargetWorkspace>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployTarget {
    pub target_id: String,
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
pub struct PackageSkill {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub entry_prefix: String,
    pub exists: bool,
    pub item_kind: String,
    pub member_count: usize,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub color_index: i32,
    pub count: u32,
    pub sort_order: i32,
}
