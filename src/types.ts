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

export function mapStatus(raw: SkillStatusRaw): SkillStatusV2 {
  if (raw === "enabled") return "applied";
  if (raw === "disabled") return "notApplied";
  return "problem";
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
}

export interface TargetSkillStatus {
  id: string;
  skillId: string;
  skillName: string;
  displayName: string;
  description: string;
  status: SkillStatusV2;
}

export interface AppState {
  baseDir: string;
  skillsRoot: string;
  skills: Skill[];
  targets: Target[];
  targetStatuses: Map<string, TargetSkillStatus[]>; // key = target.id
}

// Tag management
export interface TagInfo {
  name: string;
  colorIndex: number;
  count: number;
  sortOrder: number;
}
