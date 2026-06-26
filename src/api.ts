import { invoke } from "@tauri-apps/api/core";
import type { AppState, Skill, Target, TargetSkillStatus, SkillStatusRaw } from "./types";
import { mapStatus } from "./types";

// Raw backend types (unchanged from Rust)
interface RawAppState {
  baseDir: string;
  skillsRoot: string;
  databasePath: string;
  configPath: string;
  targets: Array<{ id: string; name: string; path: string; isDefault: boolean; pathExists: boolean }>;
  skills: Skill[];
  workspaces: Array<{
    targetId: string;
    targetName: string;
    targetPath: string;
    skillsPath: string;
    targetExists: boolean;
    rootExists: boolean;
    statuses: RawTargetStatus[];
  }>;
  presets: Array<{ id: string; name: string; description: string; skillIds: string[] }>;
  issues: string[];
}

interface RawTargetStatus {
  id: string;
  skillId: string;
  skillName: string;
  displayName: string;
  description: string;
  status: SkillStatusRaw;
  targetPath: string;
  issue?: string | null;
}

function transformState(raw: RawAppState): AppState {
  const targets: Target[] = [];
  const targetStatuses = new Map<string, TargetSkillStatus[]>();

  for (const workspace of raw.workspaces) {
    const applied = workspace.statuses.filter(s => s.status === "enabled").length;
    targets.push({
      id: workspace.targetId,
      name: workspace.targetName,
      path: workspace.targetPath,
      isDefault: raw.targets.find(t => t.id === workspace.targetId)?.isDefault ?? false,
      exists: workspace.targetExists,
      appliedCount: applied,
      totalCount: raw.skills.length,
    });
    targetStatuses.set(workspace.targetId, workspace.statuses.map(s => ({
      id: s.id,
      skillId: s.skillId,
      skillName: s.skillName,
      displayName: s.displayName,
      description: s.description,
      status: mapStatus(s.status),
      rawStatus: s.status,
      targetPath: s.targetPath,
      issue: s.issue,
    })));
  }

  return {
    baseDir: raw.baseDir,
    skillsRoot: raw.skillsRoot,
    skills: raw.skills,
    targets,
    targetStatuses,
    issues: raw.issues,
  };
}

export async function getAppState(): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("get_app_state");
  return transformState(raw);
}

export async function importSkill(sourcePath: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("import_skill", { sourcePath });
  return transformState(raw);
}

export async function deleteSkill(skillId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("delete_skill", { skillId });
  return transformState(raw);
}

interface DeployTarget {
  targetId: string;
}

interface OperationReport {
  changed: number;
  skipped: number;
  conflicts: string[];
  errors: string[];
}

export async function deploySkill(
  skillId: string,
  targets: DeployTarget[],
  overwrite: boolean,
): Promise<OperationReport> {
  if (!isTauriRuntime()) return { changed: targets.length, skipped: 0, conflicts: [], errors: [] };
  return invoke<OperationReport>("deploy_skill", { skillId, targets, overwrite });
}

export async function withdrawSkill(
  skillId: string,
  targets: DeployTarget[],
): Promise<OperationReport> {
  if (!isTauriRuntime()) return { changed: targets.length, skipped: 0, conflicts: [], errors: [] };
  return invoke<OperationReport>("withdraw_skill", { skillId, targets });
}

export async function adoptSkillFromTarget(
  targetId: string,
  skillName: string,
): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("adopt_skill_from_target", { targetId, skillName });
  return transformState(raw);
}

export async function removeUnmanagedSkill(targetPath: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("remove_unmanaged_skill", { targetPath });
  return transformState(raw);
}

export async function addTarget(path: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("add_target", { path });
  return transformState(raw);
}

export async function removeTarget(targetId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("remove_target", { targetId });
  return transformState(raw);
}

export async function setSkillTags(skillId: string, tags: string[]): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("set_skill_tags", { skillId, tags });
  return transformState(raw);
}

export async function getAllTags(): Promise<string[]> {
  if (!isTauriRuntime()) {
    return ["产品", "创意", "设计", "开发", "质量", "飞书", "文档"];
  }
  return invoke<string[]>("get_all_tags");
}

export async function getAllTagsInfo(): Promise<import("./types").TagInfo[]> {
  if (!isTauriRuntime()) {
    return [
      { name: "产品", colorIndex: 0, count: 5, sortOrder: 0 },
      { name: "创意", colorIndex: 2, count: 3, sortOrder: 1 },
      { name: "开发", colorIndex: 4, count: 8, sortOrder: 2 },
      { name: "文档", colorIndex: 5, count: 4, sortOrder: 3 },
      { name: "飞书", colorIndex: 9, count: 2, sortOrder: 4 },
      { name: "质量", colorIndex: 3, count: 1, sortOrder: 5 },
    ];
  }
  return invoke<import("./types").TagInfo[]>("get_all_tags_info");
}

export async function renameTag(oldName: string, newName: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("rename_tag", { oldName, newName });
  return transformState(raw);
}

export async function setTagColor(tag: string, colorIndex: number): Promise<import("./types").TagInfo[]> {
  if (!isTauriRuntime()) return getAllTagsInfo();
  return invoke<import("./types").TagInfo[]>("set_tag_color", { tag, colorIndex });
}

export async function deleteTag(tag: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("delete_tag", { tag });
  return transformState(raw);
}

export async function reorderTag(tag: string, direction: "up" | "down"): Promise<import("./types").TagInfo[]> {
  if (!isTauriRuntime()) return getAllTagsInfo();
  return invoke<import("./types").TagInfo[]>("reorder_tag", { tag, direction });
}

export async function openPath(path: string): Promise<void> {
  if (!isTauriRuntime()) return;
  return invoke<void>("open_path", { path });
}

export async function scanSkillPackage(packagePath: string) {
  if (!isTauriRuntime()) return { packagePath, skills: [], ignoredPluginSkills: 0 };
  return invoke("scan_skill_package", { packagePath });
}

export async function importSkillsFromPackage(packagePath: string, skillIds: string[]) {
  if (!isTauriRuntime()) return { state: mockState(), changed: skillIds.length, skipped: 0, errors: [] };
  const raw = await invoke<{ state: RawAppState; changed: number; skipped: number; errors: string[] }>(
    "import_skills_from_package", { packagePath, skillIds }
  );
  return { ...raw, state: transformState(raw.state) };
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function mockState(): AppState {
  const skills: Skill[] = [
    { id: "brainstorming", name: "brainstorming", displayName: "Brainstorming", description: "开发或创作前先澄清需求和设计", path: "/mock/skills/brainstorming", hasSkillMd: true, tags: ["产品", "创意"], enabledCount: 3, issueCount: 0, contentPreview: "# Brainstorming" },
    { id: "impeccable", name: "impeccable", displayName: "Impeccable", description: "产品界面设计、打磨和审计", path: "/mock/skills/impeccable", hasSkillMd: true, tags: ["设计"], enabledCount: 2, issueCount: 0, contentPreview: "# Impeccable" },
    { id: "code-review", name: "code-review", displayName: "代码审查", description: "检查代码变更里的逻辑和性能风险", path: "/mock/skills/code-review", hasSkillMd: true, tags: ["开发", "质量"], enabledCount: 5, issueCount: 0, contentPreview: "# 代码审查" },
    { id: "product-research", name: "product-research", displayName: "产品调研", description: "整理竞品、用户场景和需求判断", path: "/mock/skills/product-research", hasSkillMd: true, tags: ["产品"], enabledCount: 1, issueCount: 1, contentPreview: "# 产品调研" },
    { id: "lark-doc", name: "lark-doc", displayName: "lark-doc", description: "读取和编辑飞书文档内容", path: "/mock/skills/lark-doc", hasSkillMd: true, tags: ["飞书"], enabledCount: 0, issueCount: 0, contentPreview: "# lark-doc" },
    { id: "lark-sheets", name: "lark-sheets", displayName: "lark-sheets", description: "创建和操作电子表格", path: "/mock/skills/lark-sheets", hasSkillMd: true, tags: ["飞书"], enabledCount: 1, issueCount: 0, contentPreview: "# lark-sheets" },
    { id: "lark-calendar", name: "lark-calendar", displayName: "lark-calendar", description: "管理日历日程和会议室", path: "/mock/skills/lark-calendar", hasSkillMd: true, tags: ["飞书"], enabledCount: 1, issueCount: 0, contentPreview: "# lark-calendar" },
    { id: "session-wrap-up", name: "session-wrap-up", displayName: "会话收尾", description: "把实质性改动同步到项目文档和长期记忆", path: "/mock/skills/session-wrap-up", hasSkillMd: true, tags: ["文档"], enabledCount: 2, issueCount: 0, contentPreview: "# 会话收尾" },
    { id: "ab-test-setup", name: "ab-test-setup", displayName: "A/B Test Setup", description: "设计 A/B 测试方案", path: "/mock/skills/ab-test-setup", hasSkillMd: true, tags: ["产品"], enabledCount: 0, issueCount: 0, contentPreview: "# A/B Test Setup" },
  ];

  const targets: Target[] = [
    { id: "agents", name: "全局", path: "~/.agents/skills", isDefault: true, exists: true, appliedCount: 5, totalCount: 9 },
    { id: "project-skill-manager", name: "skill管理器", path: "~/项目/skill管理器", isDefault: false, exists: true, appliedCount: 3, totalCount: 9 },
    { id: "project-knowledge", name: "知识管理", path: "~/项目/知识管理", isDefault: false, exists: true, appliedCount: 2, totalCount: 9 },
  ];

  const targetStatuses = new Map<string, TargetSkillStatus[]>();
  for (const target of targets) {
    targetStatuses.set(target.id, skills.map((skill, i) => ({
      id: `${target.id}-${skill.id}`,
      skillId: skill.id,
      skillName: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      status: i < target.appliedCount ? "applied" as const : (skill.issueCount > 0 ? "problem" as const : "notApplied" as const),
      rawStatus: i < target.appliedCount ? "enabled" as const : (skill.issueCount > 0 ? "conflict" as const : "disabled" as const),
      targetPath: `${target.path}/${skill.name}`,
      issue: skill.issueCount > 0 && i >= target.appliedCount ? "目标位置已有同名内容" : null,
    })));
  }

  return { baseDir: "~/.skills-manager", skillsRoot: "~/.skills-manager/skills", skills, targets, targetStatuses, issues: [] };
}
