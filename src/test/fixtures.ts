import type { RawAppState } from "../transform.ts";

// Realistic serde-shaped fixture. Mirrors what the Rust side emits (camelCase,
// 7 raw statuses, per-status issue/linkTarget/rootExists, flattened target flags).
export function serdeFixture(overrides: Partial<RawAppState> = {}): RawAppState {
  return {
    baseDir: "/home/u/.skills-manager",
    skillsRoot: "/home/u/.skills-manager/skills",
    databasePath: "/home/u/.skills-manager/app.db",
    configPath: "/home/u/.skills-manager/config.json",
    targets: [
      { id: "agents", name: "全局", path: "/home/u/.agents", isDefault: true, pathExists: true },
      { id: "id-proj", name: "知识管理", path: "/home/u/proj", isDefault: false, pathExists: true },
    ],
    skills: [
      { id: "alpha", name: "alpha", displayName: "Alpha", description: "a skill", path: "/home/u/.skills-manager/skills/alpha", tags: ["产品"], enabledCount: 1, issueCount: 0, contentPreview: "# Alpha" },
      { id: "beta", name: "beta", displayName: "Beta", description: "b skill", path: "/home/u/.skills-manager/skills/beta", tags: ["产品"], enabledCount: 0, issueCount: 1, contentPreview: "# Beta" },
      { id: "gamma", name: "gamma", displayName: "Gamma", description: "g skill", path: "/home/u/.skills-manager/skills/gamma", tags: [], enabledCount: 0, issueCount: 0, contentPreview: "# Gamma" },
    ],
    workspaces: [
      {
        targetId: "agents",
        targetName: "全局",
        targetPath: "/home/u/.agents",
        skillsPath: "/home/u/.agents/skills",
        targetExists: true,
        rootExists: true,
        statuses: [
          { id: "agents-alpha", skillId: "alpha", skillName: "alpha", displayName: "Alpha", description: "a skill", targetId: "agents", targetName: "全局", status: "enabled", targetPath: "/home/u/.agents/skills/alpha", issue: null, linkTarget: "/home/u/.skills-manager/skills/alpha", rootExists: true },
          { id: "agents-beta", skillId: "beta", skillName: "beta", displayName: "Beta", description: "b skill", targetId: "agents", targetName: "全局", status: "broken", targetPath: "/home/u/.agents/skills/beta", issue: "软链接目标不存在", linkTarget: "/home/u/.skills-manager/skills/beta", rootExists: true, canOverwrite: true },
          { id: "agents-gamma", skillId: "gamma", skillName: "gamma", displayName: "Gamma", description: "g skill", targetId: "agents", targetName: "全局", status: "disabled", targetPath: "/home/u/.agents/skills/gamma", issue: null, linkTarget: null, rootExists: true },
        ],
      },
      {
        targetId: "id-proj",
        targetName: "知识管理",
        targetPath: "/home/u/proj",
        skillsPath: "/home/u/proj/.agents/skills",
        targetExists: true,
        rootExists: false,
        statuses: [
          { id: "id-proj-alpha", skillId: "alpha", skillName: "alpha", displayName: "Alpha", description: "a skill", targetId: "id-proj", targetName: "知识管理", status: "disabled", targetPath: "/home/u/proj/.agents/skills/alpha", issue: null, linkTarget: null, rootExists: false },
          { id: "id-proj-beta", skillId: "beta", skillName: "beta", displayName: "Beta", description: "b skill", targetId: "id-proj", targetName: "知识管理", status: "conflict", targetPath: "/home/u/proj/.agents/skills/beta", issue: "目标位置已有同名内容", linkTarget: null, rootExists: false, canOverwrite: true },
          { id: "id-proj-gamma", skillId: "gamma", skillName: "gamma", displayName: "Gamma", description: "g skill", targetId: "id-proj", targetName: "知识管理", status: "disabled", targetPath: "/home/u/proj/.agents/skills/gamma", issue: null, linkTarget: null, rootExists: false },
        ],
      },
    ],
    issues: ["全局 / Beta：软链接目标不存在"],
    isIsolated: false,
    ...overrides,
  };
}
