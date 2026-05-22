export type TargetKind = "global" | "project";

export type SkillStatus =
  | "enabled"
  | "disabled"
  | "unmanaged"
  | "conflict"
  | "broken"
  | "pathMissing"
  | "invalid";

export interface Agent {
  id: string;
  name: string;
  globalPath: string;
  projectRelativePath: string;
  enabled: boolean;
  pathExists: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  exists: boolean;
}

export interface Skill {
  id: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  hasSkillMd: boolean;
  tags: string[];
  enabledCount: number;
  issueCount: number;
  contentPreview: string;
}

export interface TargetStatus {
  id: string;
  skillId: string;
  skillName: string;
  displayName: string;
  description: string;
  targetKind: TargetKind;
  agentId: string;
  agentName: string;
  projectId?: string | null;
  projectName?: string | null;
  status: SkillStatus;
  targetPath: string;
  linkTarget?: string | null;
  issue?: string | null;
  rootExists: boolean;
}

export interface AgentWorkspace {
  agentId: string;
  agentName: string;
  rootPath: string;
  rootExists: boolean;
  statuses: TargetStatus[];
}

export interface ProjectAgentWorkspace {
  projectId: string;
  projectName: string;
  projectPath: string;
  projectExists: boolean;
  agentId: string;
  agentName: string;
  rootPath: string;
  rootExists: boolean;
  statuses: TargetStatus[];
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
}

export interface AppState {
  baseDir: string;
  skillsRoot: string;
  databasePath: string;
  configPath: string;
  agents: Agent[];
  projects: Project[];
  skills: Skill[];
  globalWorkspaces: AgentWorkspace[];
  projectWorkspaces: ProjectAgentWorkspace[];
  presets: Preset[];
  issues: string[];
}

export interface DeployTarget {
  agentId: string;
  projectId?: string | null;
}

export interface OperationReport {
  changed: number;
  skipped: number;
  conflicts: string[];
  errors: string[];
}

export interface OnboardingStatus {
  completed: boolean;
}

export interface DetectedAgent {
  id: string;
  name: string;
  globalPath: string;
  projectRelativePath: string;
  exists: boolean;
}

export interface BulkAdoptItem {
  agentId: string;
  projectId?: string | null;
  skillName: string;
}

export interface BulkAdoptReport {
  state: AppState;
  changed: number;
  errors: string[];
}

export type ViewKey = "library" | "global" | "projects" | "presets" | "settings";
