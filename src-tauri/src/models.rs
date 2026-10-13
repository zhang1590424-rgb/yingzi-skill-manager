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
    /// 仅冲突（同名内容 / 指向别处的软链接）和失效软链接可一键覆盖。
    /// 前端卡片与详情抽屉共用此字段，不再靠匹配 issue 文案判断。
    #[serde(default)]
    pub can_overwrite: bool,
}

impl TargetStatus {
    /// 根据诊断状态推导是否允许一键覆盖。
    pub fn overwritable(status: &SkillStatus) -> bool {
        matches!(status, SkillStatus::Conflict | SkillStatus::Broken)
    }
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
    #[serde(default)]
    pub is_isolated: bool,
    pub targets: Vec<Target>,
    pub skills: Vec<Skill>,
    pub workspaces: Vec<TargetWorkspace>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PathFingerprint {
    pub kind: String,
    pub link_target: Option<String>,
    pub size: Option<u64>,
    pub mtime_ms: Option<i64>,
    pub content_hash: Option<String>,
}

impl PartialEq for PathFingerprint {
    fn eq(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.link_target == other.link_target
            && self.size == other.size
            && self.mtime_ms == other.mtime_ms
            && self.content_hash == other.content_hash
    }
}
impl Eq for PathFingerprint {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployTarget {
    pub target_id: String,
    #[serde(default)]
    pub expected: Option<PathFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationItem {
    pub skill_id: String,
    pub target_id: String,
    pub outcome: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationReport {
    pub changed: usize,
    pub skipped: usize,
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
    pub items: Vec<OperationItem>,
}

impl OperationReport {
    pub fn empty() -> Self {
        Self {
            changed: 0,
            skipped: 0,
            conflicts: Vec::new(),
            errors: Vec::new(),
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub content: String,
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
    /// 中文诊断标签，仅用于写入部署快照（测试）。
    #[cfg(test)]
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
