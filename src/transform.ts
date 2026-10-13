// Zero-dependency pure transform from the raw serde AppState (camelCase) to the
// frontend AppState. Kept separate so it can be unit-tested without Tauri.
import type {
  AppState,
  Skill,
  Target,
  TargetSkillStatus,
  SkillStatusRaw,
} from "./types.ts";
import { mapStatus } from "./types.ts";

export interface RawTarget {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  pathExists: boolean;
}

export interface RawTargetStatus {
  id: string;
  skillId: string;
  skillName: string;
  displayName: string;
  description: string;
  targetId: string;
  targetName: string;
  status: SkillStatusRaw;
  targetPath: string;
  issue: string | null;
  linkTarget: string | null;
  rootExists: boolean;
  canOverwrite?: boolean;
}

export interface RawWorkspace {
  targetId: string;
  targetName: string;
  targetPath: string;
  skillsPath: string;
  targetExists: boolean;
  rootExists: boolean;
  statuses: RawTargetStatus[];
}

export interface RawAppState {
  baseDir: string;
  skillsRoot: string;
  databasePath: string;
  configPath: string;
  targets: RawTarget[];
  skills: Skill[];
  workspaces: RawWorkspace[];
  issues: string[];
  isIsolated: boolean;
}

export function transformState(raw: RawAppState): AppState {
  const byTarget = new Map(raw.targets.map(t => [t.id, t]));
  const targetStatuses = new Map<string, TargetSkillStatus[]>();
  const targets: Target[] = [];

  for (const ws of raw.workspaces) {
    const rt = byTarget.get(ws.targetId);
    targets.push({
      id: ws.targetId,
      name: ws.targetName,
      path: ws.targetPath,
      isDefault: rt?.isDefault ?? false,
      pathExists: rt?.pathExists ?? false,
      skillsPath: ws.skillsPath,
      targetExists: ws.targetExists,
      rootExists: ws.rootExists,
    });
    targetStatuses.set(ws.targetId, ws.statuses.map(s => ({
      id: s.id,
      skillId: s.skillId,
      skillName: s.skillName,
      displayName: s.displayName,
      description: s.description,
      status: mapStatus(s.status),
      targetPath: s.targetPath,
      issue: s.issue,
      linkTarget: s.linkTarget,
      rootExists: s.rootExists,
      // 旧后端无此字段时按“不可覆盖”处理（fail-closed）。
      canOverwrite: s.canOverwrite === true,
    })));
  }

  return {
    baseDir: raw.baseDir,
    skillsRoot: raw.skillsRoot,
    skills: raw.skills,
    targets,
    targetStatuses,
    issues: raw.issues ?? [],
    isIsolated: raw.isIsolated ?? false,
  };
}
