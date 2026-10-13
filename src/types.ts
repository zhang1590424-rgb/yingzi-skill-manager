// v2: UI only shows 3 states, mapped from backend's 7
export type SkillStatusRaw =
  | "enabled"
  | "disabled"
  | "unmanaged"
  | "conflict"
  | "broken"
  | "pathMissing"
  | "invalid";

export type SkillStatusV2 = "applied" | "notApplied" | "problem";

const STATUS_MAP: Record<SkillStatusRaw, SkillStatusV2> = {
  enabled: "applied",
  disabled: "notApplied",
  unmanaged: "problem",
  conflict: "problem",
  broken: "problem",
  pathMissing: "problem",
  invalid: "problem",
};

export function mapStatus(raw: SkillStatusRaw): SkillStatusV2 {
  return STATUS_MAP[raw] ?? "problem";
}

export interface Skill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  tags: string[];
  enabledCount: number;
  issueCount: number;
  contentPreview: string;
}

export interface Target {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  // U13: flattened workspace/target flags, no frontend path arithmetic.
  pathExists: boolean;
  skillsPath: string;
  targetExists: boolean;
  rootExists: boolean;
}

export interface TargetSkillStatus {
  id: string;
  skillId: string;
  skillName: string;
  displayName: string;
  description: string;
  status: SkillStatusV2;
  // U05:透传后端诊断字段，红点有原因
  targetPath: string;
  issue: string | null;
  linkTarget: string | null;
  rootExists: boolean;
  // 后端判定：仅冲突 / 失效软链接可一键覆盖。卡片与详情抽屉共用。
  canOverwrite: boolean;
}

export interface AppState {
  baseDir: string;
  skillsRoot: string;
  skills: Skill[];
  targets: Target[];
  targetStatuses: Map<string, TargetSkillStatus[]>; // key = target.id
  issues: string[];
  // Test-instance marker: true only under YINGZI_TEST_HOME.
  isIsolated: boolean;
}

// Tag management
export interface TagInfo {
  name: string;
  colorIndex: number;
  count: number;
  sortOrder: number;
}

// ---- Operations ----
export interface OperationItem {
  skillId: string;
  targetId: string;
  outcome: string;
  message: string;
}

export interface OperationReport {
  changed: number;
  skipped: number;
  conflicts: string[];
  errors: string[];
  items: OperationItem[];
}

// U04: on-disk fingerprint captured at confirm time.
// kind "unknown" = backend could not read the target; caller must refuse overwrite.
export interface PathFingerprint {
  kind: "missing" | "symlink" | "dir" | "unknown" | (string & {});
  linkTarget: string | null;
  size: number | null;
  mtimeMs: number | null;
  contentHash: string | null;
}

export interface DeployTarget {
  targetId: string;
  expected?: PathFingerprint;
}

// ---- Package import ----
export interface PackageSkill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category: string;
  entryPrefix: string;
  exists: boolean;
  itemKind: string;
  memberCount: number;
}

export interface SkillPackageScan {
  packagePath: string;
  skills: PackageSkill[];
  ignoredPluginSkills: string[];
}

export interface PackageImportReport {
  state: AppState;
  changed: number;
  skipped: number;
  errors: string[];
}
