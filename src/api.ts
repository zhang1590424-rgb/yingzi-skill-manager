import { invoke } from "@tauri-apps/api/core";
import type { AppState, Skill, Target, TargetSkillStatus, SkillStatusRaw } from "./types";
import { mapStatus } from "./types";

// Raw backend types (unchanged from Rust)
interface RawAppState {
  baseDir: string;
  skillsRoot: string;
  databasePath: string;
  configPath: string;
  agents: Array<{ id: string; name: string; globalPath: string; enabled: boolean; pathExists: boolean }>;
  projects: Array<{ id: string; name: string; path: string; exists: boolean }>;
  skills: Skill[];
  globalWorkspaces: Array<{
    agentId: string;
    agentName: string;
    rootPath: string;
    rootExists: boolean;
    statuses: RawTargetStatus[];
  }>;
  projectWorkspaces: Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    projectExists: boolean;
    rootPath: string;
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

  // Global directories as targets
  for (const workspace of raw.globalWorkspaces) {
    const targetId = `global-${workspace.agentId}`;
    const applied = workspace.statuses.filter(s => s.status === "enabled").length;
    targets.push({
      id: targetId,
      kind: "global",
      name: workspace.agentName,
      path: workspace.rootPath,
      exists: workspace.rootExists,
      appliedCount: applied,
      totalCount: raw.skills.length,
    });
    targetStatuses.set(targetId, workspace.statuses.map(s => ({
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

  // Projects as targets
  for (const workspace of raw.projectWorkspaces) {
    const targetId = `project-${workspace.projectId}`;
    const applied = workspace.statuses.filter(s => s.status === "enabled").length;
    targets.push({
      id: targetId,
      kind: "project",
      name: workspace.projectName,
      path: workspace.projectPath,
      exists: workspace.projectExists,
      appliedCount: applied,
      totalCount: raw.skills.length,
    });
    targetStatuses.set(targetId, workspace.statuses.map(s => ({
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
  agentId?: string | null;
  projectId?: string | null;
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
  agentId: string | undefined,
  projectId: string | undefined,
  skillName: string,
): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("adopt_skill_from_target", { agentId, projectId, skillName });
  return transformState(raw);
}

export async function removeUnmanagedSkill(targetPath: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("remove_unmanaged_skill", { targetPath });
  return transformState(raw);
}

export async function addProject(path: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("add_project", { path });
  return transformState(raw);
}

export async function removeProject(projectId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("remove_project", { projectId });
  return transformState(raw);
}

export async function addGlobalDir(globalPath: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("add_agent", { globalPath });
  return transformState(raw);
}

export async function removeGlobalDir(agentId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  const raw = await invoke<RawAppState>("remove_agent", { agentId });
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
    { id: "global-agents", kind: "global", name: "全局目录", path: "~/.agents/skills", exists: true, appliedCount: 5, totalCount: 9 },
    { id: "project-skill-manager", kind: "project", name: "skill管理器", path: "~/项目/skill管理器", exists: true, appliedCount: 3, totalCount: 9 },
    { id: "project-knowledge", kind: "project", name: "知识管理", path: "~/项目/知识管理", exists: true, appliedCount: 2, totalCount: 9 },
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
