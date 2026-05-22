import { invoke } from "@tauri-apps/api/core";
import type { AppState, DeployTarget, OperationReport } from "./types";

export async function getAppState(): Promise<AppState> {
  if (!isTauriRuntime()) return mockState();
  return invoke<AppState>("get_app_state");
}

export async function createSkill(name: string, description: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(name, description);
  return invoke<AppState>("create_skill", { name, description });
}

export async function importSkill(sourcePath: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(sourcePath);
  return invoke<AppState>("import_skill", { sourcePath });
}

export async function installSkillFromMarket(
  marketUrl: string,
  version: string,
): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(marketUrl, version);
  return invoke<AppState>("install_skill_from_market", {
    marketUrl,
    version: version.trim() ? version.trim() : null,
  });
}

export async function deleteSkill(skillId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(skillId);
  return invoke<AppState>("delete_skill", { skillId });
}

export async function deploySkill(
  skillId: string,
  targets: DeployTarget[],
  overwrite: boolean,
): Promise<OperationReport> {
  if (!isTauriRuntime()) return mockReport(targets.length || (skillId && overwrite ? 1 : 0));
  return invoke<OperationReport>("deploy_skill", { skillId, targets, overwrite });
}

export async function withdrawSkill(
  skillId: string,
  targets: DeployTarget[],
): Promise<OperationReport> {
  if (!isTauriRuntime()) return mockReport(targets.length || (skillId ? 1 : 0));
  return invoke<OperationReport>("withdraw_skill", { skillId, targets });
}

export async function adoptSkillFromTarget(
  agentId: string,
  projectId: string | null,
  skillName: string,
): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(agentId, projectId ?? "", skillName);
  return invoke<AppState>("adopt_skill_from_target", { agentId, projectId, skillName });
}

export async function addProject(path: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(path);
  return invoke<AppState>("add_project", { path });
}

export async function removeProject(projectId: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(projectId);
  return invoke<AppState>("remove_project", { projectId });
}

export async function updateAgentPath(agentId: string, path: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(agentId, path);
  return invoke<AppState>("update_agent_path", { agentId, path });
}

export async function upsertPreset(
  id: string | null,
  name: string,
  description: string,
  skillIds: string[],
): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(id ?? "", name, description, skillIds.join(","));
  return invoke<AppState>("upsert_preset", { id, name, description, skillIds });
}

export async function deletePreset(id: string): Promise<AppState> {
  if (!isTauriRuntime()) return mockState(id);
  return invoke<AppState>("delete_preset", { id });
}

export async function applyPreset(
  presetId: string,
  targets: DeployTarget[],
  overwrite: boolean,
): Promise<OperationReport> {
  if (!isTauriRuntime()) return mockReport(targets.length || (presetId && overwrite ? 1 : 0));
  return invoke<OperationReport>("apply_preset", { presetId, targets, overwrite });
}

export async function withdrawPreset(
  presetId: string,
  targets: DeployTarget[],
): Promise<OperationReport> {
  if (!isTauriRuntime()) return mockReport(targets.length || (presetId ? 1 : 0));
  return invoke<OperationReport>("withdraw_preset", { presetId, targets });
}

export async function openPath(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    console.info("openPath", path);
    return;
  }
  return invoke<void>("open_path", { path });
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function mockReport(changed = 1): OperationReport {
  return {
    changed,
    skipped: 0,
    conflicts: [],
    errors: [],
  };
}

function mockState(..._values: string[]): AppState {
  const agents = [
    {
      id: "trae",
      name: "Trae",
      globalPath: "/Users/bytedance/.trae/skills",
      projectRelativePath: ".trae/skills",
      enabled: true,
      pathExists: false,
    },
    {
      id: "codex",
      name: "Codex",
      globalPath: "/Users/bytedance/.codex/skills",
      projectRelativePath: ".codex/skills",
      enabled: true,
      pathExists: true,
    },
    {
      id: "claude-code",
      name: "Claude Code",
      globalPath: "/Users/bytedance/.claude/skills",
      projectRelativePath: ".claude/skills",
      enabled: true,
      pathExists: true,
    },
  ];
  const projects = [
    {
      id: "skill-manager",
      name: "skill管理器",
      path: "/Users/bytedance/项目/skill管理器",
      exists: true,
    },
    {
      id: "knowledge",
      name: "知识管理",
      path: "/Users/bytedance/项目/知识管理",
      exists: false,
    },
  ];
  const skills = [
    {
      id: "code-review",
      name: "code-review",
      displayName: "代码审查",
      description: "检查代码变更里的逻辑、健壮性、性能和测试风险。",
      path: "/Users/bytedance/.skills-manager/skills/code-review",
      hasSkillMd: true,
      tags: ["开发", "质量"],
      enabledCount: 3,
      issueCount: 0,
      contentPreview: "# 代码审查\n\n用于在提交前检查代码质量和隐藏风险。",
    },
    {
      id: "product-research",
      name: "product-research",
      displayName: "产品调研",
      description: "整理竞品、用户场景和需求判断，输出结构化产品结论。",
      path: "/Users/bytedance/.skills-manager/skills/product-research",
      hasSkillMd: true,
      tags: ["产品", "知识管理"],
      enabledCount: 1,
      issueCount: 1,
      contentPreview: "# 产品调研\n\n输出事实、推测和下一步建议。",
    },
    {
      id: "session-wrap-up",
      name: "session-wrap-up",
      displayName: "会话收尾",
      description: "把实质性改动同步到项目文档和长期记忆。",
      path: "/Users/bytedance/.skills-manager/skills/session-wrap-up",
      hasSkillMd: true,
      tags: ["文档"],
      enabledCount: 2,
      issueCount: 0,
      contentPreview: "# 会话收尾\n\n整理变更、规则和后续注意事项。",
    },
  ];
  const globalWorkspaces = agents.map((agent) => ({
    agentId: agent.id,
    agentName: agent.name,
    rootPath: agent.globalPath,
    rootExists: agent.pathExists,
    statuses: skills.map((skill, index) => ({
      id: `global-${agent.id}-${skill.id}`,
      skillId: skill.id,
      skillName: skill.name,
      displayName: skill.displayName,
      description: skill.description,
      targetKind: "global" as const,
      agentId: agent.id,
      agentName: agent.name,
      projectId: null,
      projectName: null,
      status: index === 1 && agent.id === "trae" ? "conflict" as const : index === 2 ? "disabled" as const : "enabled" as const,
      targetPath: `${agent.globalPath}/${skill.name}`,
      linkTarget: index === 2 ? null : skill.path,
      issue: index === 1 && agent.id === "trae" ? "目标位置已有同名内容" : null,
      rootExists: agent.pathExists,
    })),
  }));
  const projectWorkspaces = projects.flatMap((project) =>
    agents.map((agent) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectExists: project.exists,
      agentId: agent.id,
      agentName: agent.name,
      rootPath: `${project.path}/${agent.projectRelativePath}`,
      rootExists: project.exists,
      statuses: skills.map((skill, index) => ({
        id: `project-${project.id}-${agent.id}-${skill.id}`,
        skillId: skill.id,
        skillName: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        targetKind: "project" as const,
        agentId: agent.id,
        agentName: agent.name,
        projectId: project.id,
        projectName: project.name,
        status: project.exists ? (index === 0 ? "enabled" as const : "disabled" as const) : "pathMissing" as const,
        targetPath: `${project.path}/${agent.projectRelativePath}/${skill.name}`,
        linkTarget: index === 0 ? skill.path : null,
        issue: project.exists ? null : "项目路径不存在",
        rootExists: project.exists,
      })),
    })),
  );
  return {
    baseDir: "/Users/bytedance/.skills-manager",
    skillsRoot: "/Users/bytedance/.skills-manager/skills",
    databasePath: "/Users/bytedance/.skills-manager/app.db",
    configPath: "/Users/bytedance/.skills-manager/config.json",
    agents,
    projects,
    skills,
    globalWorkspaces,
    projectWorkspaces,
    presets: [
      {
        id: "dev",
        name: "开发协作",
        description: "代码审查、会话收尾和开发质量检查。",
        skillIds: ["code-review", "session-wrap-up"],
      },
    ],
    issues: ["Trae / 全局 / 产品调研：目标位置已有同名内容"],
  };
}
