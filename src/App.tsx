import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FolderKanban,
  FolderPlus,
  Globe2,
  Layers3,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addAgent,
  addProject,
  adoptSkillFromTarget,
  bulkAdoptSkills,
  deletePreset,
  deleteSkill,
  deploySkill,
  detectDefaultAgents,
  getAppState,
  getOnboardingStatus,
  ignoreIssueKeys,
  installBuiltinPresetSkills,
  importSkill,
  listUnmanagedForOnboarding,
  openPath,
  removeAgent,
  removeProject,
  scanBuiltinPresetSkills,
  setAgentEnabled,
  setOnboardingCompleted,
  suggestOnboardingProjects,
  resolveBrokenIssueKeys,
  updateAgentPath,
  upsertPreset,
  withdrawSkill,
} from "./api";
import type {
  Agent,
  AppState,
  BulkAdoptItem,
  DeployTarget,
  DetectedAgent,
  OperationReport,
  PackageSkill,
  Preset,
  Project,
  ProjectSuggestion,
  SkillPackageScan,
  Skill,
  SkillStatus,
  TargetStatus,
  ViewKey,
} from "./types";

const navItems: Array<{ key: Extract<ViewKey, "library" | "presets" | "settings">; label: string; icon: typeof BookOpen }> = [
  { key: "library", label: "技能列表", icon: BookOpen },
  { key: "presets", label: "技能组合", icon: Layers3 },
  { key: "settings", label: "设置", icon: Settings },
];

const statusText: Record<SkillStatus, string> = {
  enabled: "已启用",
  disabled: "未启用",
  unmanaged: "未入库",
  conflict: "冲突",
  broken: "失效",
  pathMissing: "路径不存在",
  invalid: "格式异常",
};

const statusTone: Record<SkillStatus, string> = {
  enabled: "good",
  disabled: "muted",
  unmanaged: "note",
  conflict: "warn",
  broken: "danger",
  pathMissing: "danger",
  invalid: "warn",
};

type TransferStatus = SkillStatus | "partial" | "problem";
type FeedbackSurface = "page" | "overlay";

const transferStatusText: Record<TransferStatus, string> = {
  ...statusText,
  partial: "部分应用",
  problem: "有问题",
};

const transferStatusTone: Record<TransferStatus, string> = {
  ...statusTone,
  partial: "note",
  problem: "warn",
};

type StatusFilter =
  | "all"
  | "issues"
  | "unmanaged"
  | "conflict"
  | "broken"
  | "invalid"
  | "disabled"
  | "enabled";

const statusFilterLabels: Record<StatusFilter, string> = {
  all: "全部",
  issues: "有问题",
  unmanaged: "未入库",
  conflict: "冲突",
  broken: "失效",
  invalid: "格式异常",
  disabled: "未启用",
  enabled: "已启用",
};

const transferIssueFilterLabels: Record<StatusFilter, string> = {
  ...statusFilterLabels,
  all: "显示全部",
  issues: "全部问题",
  broken: "路径异常",
};

const statusFilterOrder: StatusFilter[] = [
  "all",
  "issues",
  "unmanaged",
  "conflict",
  "broken",
  "invalid",
  "disabled",
  "enabled",
];

const skillFilterOrder: StatusFilter[] = ["all", "issues", "enabled", "disabled"];
const transferIssueFilterOrder: StatusFilter[] = ["issues", "conflict", "unmanaged", "broken", "invalid"];

const FEEDBACK_AUTO_DISMISS_MS = 2400;
const PRODUCT_NAME = "影子";
const PRODUCT_TAGLINE = "本地 Skill 工作台";
const EMPTY_STATE_ILLUSTRATIONS = {
  skills: "/empty-states/skills.png",
  compositions: "/empty-states/compositions.png",
  agents: "/empty-states/agents.png",
  projects: "/empty-states/projects.png",
};

type Selection =
  | { type: "skill"; id: string }
  | { type: "status"; id: string }
  | { type: "transferSkill"; id: string }
  | { type: "preset"; id: string }
  | { type: "settings" };

type TransferColumnKey = "applied" | "available";

const TRANSFER_DRAG_MIME_TYPE = "application/x-skill-hub-transfer-item";
const PACKAGE_CATEGORIES = ["产品创意", "需求编写", "UI 设计", "其他工具"] as const;

type TransferDragPayload = {
  id: string;
  column: TransferColumnKey;
};

type TransferItem = {
  id: string;
  kind: "skill" | "composition";
  skillId: string;
  skillIds: string[];
  presetId?: string;
  skillName: string;
  displayName: string;
  description: string;
  status: TransferStatus;
  statuses: TargetStatus[];
  librarySkill: Skill | null;
  targetCount: number;
  enabledCount: number;
  issueCount: number;
  blockingPathCount: number;
  targets: DeployTarget[];
  memberCount: number;
  missingCount: number;
  children?: TransferItem[];
};

type DrawerState =
  | { type: "skill"; skillIds: string[] }
  | { type: "preset"; presetId: string }
  | null;

type PresetDraft = {
  id: string | null;
  name: string;
  description: string;
  skillIds: string[];
};

type HealthIssueKind = "conflict" | "broken" | "pathMissing" | "unmanaged" | "invalid";

type HealthIssue = {
  kind: HealthIssueKind;
  label: string;
  count: number;
  summary: string;
  filter: StatusFilter;
  status?: TargetStatus;
  statuses: TargetStatus[];
  skill?: Skill;
  skills: Skill[];
};

type ConfirmDialogState = {
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
  tone: "danger" | "warn";
  onConfirm: () => Promise<boolean | void>;
} | null;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onboardingCompleted, setOnboardingCompletedState] = useState<boolean | null>(null);
  const [view, setView] = useState<ViewKey>("library");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProjectAgentId, setSelectedProjectAgentId] = useState<string>("codex");
  const [checkedSkillIds, setCheckedSkillIds] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [issuePanel, setIssuePanel] = useState<HealthIssue | null>(null);
  const [importSkillOpen, setImportSkillOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<PresetDraft | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [expandedTransferPresetIds, setExpandedTransferPresetIds] = useState<Set<string>>(new Set());
  const activeOverlayKey = drawer ? "drawer" : issuePanel ? "issues" : importSkillOpen ? "import" : presetDraft ? "preset" : confirmDialog ? "confirm" : "";
  const activeOverlayKeyRef = useRef(activeOverlayKey);

  async function load(showSpinner = false) {
    try {
      if (showSpinner) {
        setLoading(true);
      }
      setError(null);
      const next = await getAppState();
      const nextAgentId = next.agents.some((agent) => agent.id === selectedAgentId)
        ? selectedAgentId
        : next.agents[0]?.id ?? selectedAgentId;
      const nextProjectAgentId = next.agents.some((agent) => agent.id === selectedProjectAgentId)
        ? selectedProjectAgentId
        : next.agents[0]?.id ?? selectedProjectAgentId;
      const nextProjectId = resolveProjectId(next, selectedProjectId);
      setState(next);
      setSelectedAgentId(nextAgentId);
      setSelectedProjectAgentId(nextProjectAgentId);
      setSelectedProjectId(nextProjectId);
      setSelected((current) =>
        current && selectionBelongsToScope(current, view, next, nextAgentId, nextProjectId, nextProjectAgentId)
          ? current
          : defaultSelectionForView(view, next, nextAgentId, nextProjectId, nextProjectAgentId),
      );
    } catch (cause) {
      setError(formatActionError(cause));
      setNotice(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const status = await getOnboardingStatus();
        setOnboardingCompletedState(status.completed);
      } catch (cause) {
        // 引导状态读取失败时，按未完成处理；用户仍可在设置中绕过
        console.warn("无法读取初始化引导状态：", cause);
        setOnboardingCompletedState(false);
      }
    })();
    void load(true);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timeoutId = window.setTimeout(() => setNotice(null), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    if (!error) return undefined;
    const timeoutId = window.setTimeout(() => setError(null), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  useEffect(() => {
    if (!overlayError) return undefined;
    const timeoutId = window.setTimeout(() => setOverlayError(null), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [overlayError]);

  useEffect(() => {
    if (activeOverlayKey === activeOverlayKeyRef.current) return;
    activeOverlayKeyRef.current = activeOverlayKey;
    setOverlayError(null);
  }, [activeOverlayKey]);

  const allStatuses = useMemo(() => {
    if (!state) return [];
    return [
      ...state.globalWorkspaces.flatMap((workspace) => workspace.statuses),
      ...state.projectWorkspaces.flatMap((workspace) => workspace.statuses),
    ];
  }, [state]);

  const healthIssues = useMemo(() => {
    if (!state) return [];
    return buildHealthIssues(state);
  }, [state]);

  const globalUnmanagedStatuses = useMemo(() => {
    if (!state) return [];
    return state.globalWorkspaces
      .flatMap((workspace) => workspace.statuses)
      .filter((status) => status.status === "unmanaged");
  }, [state]);

  const selectedSkill = useMemo(() => {
    if (!state || view !== "library" || selected?.type !== "skill") return null;
    return state.skills.find((skill) => skill.id === selected.id) ?? null;
  }, [selected, state, view]);

  const selectedStatus = useMemo(() => {
    if (!selected || selected.type !== "status" || (view !== "global" && view !== "projects")) return null;
    const status = allStatuses.find((item) => item.id === selected.id) ?? null;
    if (!status) return null;
    if (view === "global") {
      return status.targetKind === "global" && status.agentId === selectedAgentId ? status : null;
    }
    if (view === "projects") {
      return status.targetKind === "project" &&
        status.projectId === selectedProjectId &&
        status.agentId === selectedProjectAgentId
        ? status
        : null;
    }
    return null;
  }, [allStatuses, selected, selectedAgentId, selectedProjectAgentId, selectedProjectId, view]);

  const selectedPreset = useMemo(() => {
    if (!state || view !== "presets" || selected?.type !== "preset") return null;
    return state.presets.find((preset) => preset.id === selected.id) ?? null;
  }, [selected, state, view]);

  const queriedSkills = useMemo(() => {
    if (!state) return [];
    return state.skills.filter((skill) => matchesQuery(query, [
      skill.displayName,
      skill.name,
      skill.description,
      skill.path,
      ...skill.tags,
    ]));
  }, [query, state]);

  const filteredSkills = useMemo(
    () => queriedSkills.filter((skill) => skillMatchesStatusFilter(skill, statusFilter)),
    [queriedSkills, statusFilter],
  );

  const queriedPresets = useMemo(() => {
    if (!state) return [];
    return state.presets.filter((preset) => presetMatchesQuery(preset, state.skills, query));
  }, [query, state]);

  const globalWorkspace = state?.globalWorkspaces.find(
    (workspace) => workspace.agentId === selectedAgentId,
  );

  const projectWorkspaces = state?.projectWorkspaces.filter(
    (workspace) => workspace.projectId === selectedProjectId,
  ) ?? [];

  const projectWorkspace = projectWorkspaces.find(
    (workspace) => workspace.agentId === selectedProjectAgentId,
  );

  const transferItems = useMemo(() => {
    if (!state) return [];
    if (view === "global") return buildGlobalTransferItems(state, selectedAgentId);
    if (view === "projects" && selectedProjectId) return buildProjectTransferItems(state, selectedProjectId);
    return [];
  }, [selectedAgentId, selectedProjectId, state, view]);

  const queriedTransferItems = useMemo(
    () => transferItems.filter((item) =>
      matchesQuery(query, [
        item.displayName,
        item.skillName,
        item.description,
        transferStatusText[item.status],
        ...item.statuses.flatMap((status) => [
          status.agentName,
          status.projectName ?? "",
          status.targetPath,
          status.issue ?? "",
          statusText[status.status],
        ]),
      ]),
    ),
    [query, transferItems],
  );

  const filteredTransferItems = useMemo(
    () => queriedTransferItems.filter((item) => transferItemMatchesFilter(item, statusFilter)),
    [queriedTransferItems, statusFilter],
  );

  const transferIssueFilterOptions = useMemo(
    () => buildTransferIssueFilterOptions(queriedTransferItems, statusFilter),
    [queriedTransferItems, statusFilter],
  );

  const appliedTransferItems = useMemo(
    () => filteredTransferItems.filter((item) => item.status !== "disabled"),
    [filteredTransferItems],
  );

  const availableTransferItems = useMemo(
    () => filteredTransferItems.filter((item) => item.status === "disabled"),
    [filteredTransferItems],
  );

  const selectedTransferItem = useMemo(() => {
    if ((view !== "global" && view !== "projects") || selected?.type !== "transferSkill") return null;
    return transferItems.find((item) => item.id === selected.id) ?? null;
  }, [selected, transferItems, view]);

  const selectedAgent = useMemo(
    () => state?.agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [selectedAgentId, state],
  );

  const selectedProject = useMemo(
    () => state?.projects.find((project) => project.id === selectedProjectId) ?? null,
    [selectedProjectId, state],
  );

  const queriedGlobalStatuses = useMemo(
    () => (globalWorkspace?.statuses ?? []).filter((status) =>
      matchesQuery(query, [
        status.displayName,
        status.skillName,
        status.description,
        status.targetPath,
        status.agentName,
        statusText[status.status],
      ]),
    ),
    [globalWorkspace, query],
  );

  const filteredGlobalStatuses = useMemo(
    () => queriedGlobalStatuses.filter((status) => targetStatusMatchesFilter(status, statusFilter)),
    [queriedGlobalStatuses, statusFilter],
  );

  const queriedProjectStatuses = useMemo(
    () => (projectWorkspace?.statuses ?? []).filter((status) =>
      matchesQuery(query, [
        status.displayName,
        status.skillName,
        status.description,
        status.targetPath,
        status.agentName,
        status.projectName ?? "",
        statusText[status.status],
      ]),
    ),
    [projectWorkspace, query],
  );

  const filteredProjectStatuses = useMemo(
    () => queriedProjectStatuses.filter((status) => targetStatusMatchesFilter(status, statusFilter)),
    [queriedProjectStatuses, statusFilter],
  );

  useEffect(() => {
    if (!state) return;
    if ((view === "global" || view === "projects") &&
      statusFilter !== "all" &&
      !transferIssueFilterOptions.some((option) => option.id === statusFilter)
    ) {
      setStatusFilter("all");
      return;
    }
    if (view === "library") {
      if (selected?.type === "skill" && filteredSkills.some((skill) => skill.id === selected.id)) return;
      setSelected(null);
      return;
    }
    if (view === "global") {
      if (selected?.type === "transferSkill" && filteredTransferItems.some((item) => item.id === selected.id)) return;
      const next = availableTransferItems[0] ?? appliedTransferItems[0] ?? null;
      setSelected(next ? { type: "transferSkill", id: next.id } : null);
      return;
    }
    if (view === "projects") {
      if (selected?.type === "transferSkill" && filteredTransferItems.some((item) => item.id === selected.id)) return;
      const next = availableTransferItems[0] ?? appliedTransferItems[0] ?? null;
      setSelected(next ? { type: "transferSkill", id: next.id } : null);
      return;
    }
    if (view === "presets") {
      if (!selected || (selected.type === "preset" && queriedPresets.some((preset) => preset.id === selected.id))) return;
      setSelected(null);
    }
  }, [
    appliedTransferItems,
    availableTransferItems,
    filteredSkills,
    filteredTransferItems,
    queriedPresets,
    selected,
    state,
    statusFilter,
    transferIssueFilterOptions,
    view,
  ]);

  function selectView(nextView: ViewKey) {
    setView(nextView);
    setStatusFilter("all");
    setSelected(defaultSelectionForView(
      nextView,
      state,
      selectedAgentId,
      selectedProjectId,
      selectedProjectAgentId,
    ));
  }

  function selectGlobalAgent(agentId: string) {
    setView("global");
    setStatusFilter("all");
    setSelectedAgentId(agentId);
    setSelected(defaultSelectionForView(
      "global",
      state,
      agentId,
      selectedProjectId,
      selectedProjectAgentId,
    ));
  }

  function selectProject(projectId: string) {
    setView("projects");
    setStatusFilter("all");
    setSelectedProjectId(projectId);
    setSelected(defaultSelectionForView(
      "projects",
      state,
      selectedAgentId,
      projectId,
      selectedProjectAgentId,
    ));
  }

  function selectProjectAgent(agentId: string) {
    setSelectedProjectAgentId(agentId);
    setSelected(defaultSelectionForView(
      "projects",
      state,
      selectedAgentId,
      selectedProjectId,
      agentId,
    ));
  }

  function selectHealthIssue(issue: HealthIssue) {
    if (!issue.statuses.length && issue.skill) {
      setQuery("");
      setStatusFilter(issue.filter);
      setView("library");
      setSelected({ type: "skill", id: issue.skill.id });
      return;
    }
    setIssuePanel(issue);
  }

  function changeStatusFilter(nextFilter: StatusFilter) {
    setStatusFilter(nextFilter);
    if (view === "library") {
      const skill = queriedSkills.find((item) => skillMatchesStatusFilter(item, nextFilter));
      setSelected(skill ? { type: "skill", id: skill.id } : null);
      return;
    }
    if (view === "global") {
      const item = queriedTransferItems.find((nextItem) => transferItemMatchesFilter(nextItem, nextFilter));
      setSelected(item ? { type: "transferSkill", id: item.id } : null);
      return;
    }
    if (view === "projects") {
      const item = queriedTransferItems.find((nextItem) => transferItemMatchesFilter(nextItem, nextFilter));
      setSelected(item ? { type: "transferSkill", id: item.id } : null);
    }
  }

  function confirmDeleteSkill(skill: Skill, locations: TargetStatus[]) {
    if (locations.length) {
      setError(`请先收回 ${locations.length} 个启用位置`);
      return;
    }
    setConfirmDialog({
      title: `删除技能：${skill.displayName}`,
      message: "将从主库删除该技能目录。此操作不会保留备份。",
      details: [skill.path],
      confirmLabel: "确认删除",
      tone: "danger",
      onConfirm: async () => {
        return runAction(async () => {
          const next = await deleteSkill(skill.id);
          setState(next);
          setSelected(defaultSelectionForView("library", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
        }, "已删除技能", "overlay");
      },
    });
  }

  function confirmDeletePreset(preset: Preset) {
    setConfirmDialog({
      title: `删除组合：${presetDisplayName(preset)}`,
      message: "将删除这个技能组合配置，不会删除技能列表里的技能。",
      details: preset.skillIds.length ? [`包含 ${preset.skillIds.length} 个技能`] : undefined,
      confirmLabel: "确认删除",
      tone: "danger",
      onConfirm: async () => {
        return runAction(async () => {
          const next = await deletePreset(preset.id);
          setState(next);
          setSelected(defaultSelectionForView("presets", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
        }, "已删除组合", "overlay");
      },
    });
  }

  async function deployLibraryToStatus(skill: Skill, status: TargetStatus) {
    const apply = async (surface: FeedbackSurface = "page") => {
      return runAction(async () => {
        const report = await deploySkill(
          skill.id,
          [
            {
              agentId: status.agentId,
              projectId: status.projectId ?? null,
            },
          ],
          true,
        );
        return refreshAfterReport(report, "已按技能列表分发", surface);
      }, undefined, surface);
    };

    if (status.status === "conflict" || status.status === "unmanaged") {
      setConfirmDialog({
        title: `用主库覆盖：${status.displayName}`,
        message: "目标位置已有同名内容，确认后会按技能列表版本重建软链接。",
        details: [status.targetPath, `技能列表：${skill.path}`],
        confirmLabel: "确认覆盖",
        tone: "warn",
        onConfirm: () => apply("overlay"),
      });
      return;
    }

    await apply("page");
  }

  function setFeedbackError(message: string, surface: FeedbackSurface) {
    if (surface === "overlay") {
      setOverlayError(message);
      return;
    }
    setError(message);
  }

  async function runAction(
    action: () => Promise<boolean | void>,
    success?: string,
    surface: FeedbackSurface = "page",
  ) {
    try {
      setWorking(true);
      if (surface === "overlay") {
        setOverlayError(null);
      } else {
        setError(null);
      }
      const result = await action();
      if (success) setNotice(success);
      return result !== false;
    } catch (cause) {
      setFeedbackError(formatActionError(cause), surface);
      setNotice(null);
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function refreshAfterReport(
    report: OperationReport,
    successLabel: string,
    surface: FeedbackSurface = "page",
  ): Promise<boolean> {
    await load();
    const summary = formatOperationReport(report, successLabel);
    if (report.errors.length) {
      setFeedbackError(`${summary}。${formatReportExamples(report.errors)}`, surface);
      setNotice(null);
      return false;
    }
    if (report.conflicts.length) {
      setNotice(`${summary}，请处理冲突`);
      return true;
    }
    setNotice(summary);
    return true;
  }

  async function pickAndImportSkill(onImported?: () => void, sourceKind: "folder" | "zip" = "folder") {
    const picked = await open(sourceKind === "folder"
      ? { directory: true, multiple: false, title: "选择技能文件夹" }
      : {
          multiple: false,
          title: "选择 .zip 技能压缩包",
          filters: [{ name: "Skill 压缩包", extensions: ["zip"] }],
        });
    if (!picked || Array.isArray(picked)) return;
    const previousIds = new Set(state?.skills.map((skill) => skill.id) ?? []);
    const imported = await runAction(async () => {
      const next = await importSkill(picked);
      const importedId = slugifyClient(stripKnownExtension(fileNameFromPath(picked)));
      const newSkills = next.skills.filter((skill) => !previousIds.has(skill.id));
      const importedSkill = next.skills.find(
        (skill) => skill.id === importedId || skill.name === importedId,
      ) ?? newSkills[0];
      const changedCount = Math.max(newSkills.length, 1);
      setState(next);
      setView("library");
      setStatusFilter("all");
      setSelected(null);
      setNotice(`已导入技能：${changedCount} 个。下一步可以在列表卡片上使用。`);
    }, undefined, "overlay");
    if (imported) onImported?.();
  }

  async function pickAndAddProject() {
    const picked = await open({ directory: true, multiple: false, title: "选择项目目录" });
    if (!picked || Array.isArray(picked)) return;
    await runAction(async () => {
      const next = await addProject(picked);
      setState(next);
      const project = next.projects.find((item) => item.path === picked);
      if (project) {
        setSelectedProjectId(project.id);
        setSelected(defaultSelectionForView("projects", next, selectedAgentId, project.id, selectedProjectAgentId));
      }
    }, "已添加项目");
  }

  async function pickAndAddAgent() {
    const picked = await open({ directory: true, multiple: false, title: "选择 Agent 全局 Skill 目录" });
    if (!picked || Array.isArray(picked)) return;
    await runAction(async () => {
      const next = await addAgent(picked);
      setState(next);
      const agent = next.agents.find((item) => item.globalPath === picked);
      if (agent) setSelectedAgentId(agent.id);
    }, "已添加 Agent");
  }

  async function pickAndUpdateAgent(agentId: string) {
    const picked = await open({ directory: true, multiple: false, title: "选择 Agent 全局 Skill 目录" });
    if (!picked || Array.isArray(picked)) return;
    await runAction(async () => {
      const next = await updateAgentPath(agentId, picked);
      setState(next);
    }, "已更新 Agent 目录");
  }

  function adoptStatuses(statuses: TargetStatus[]) {
    if (!statuses.length) return;
    setConfirmDialog({
      title: `导入 ${statuses.length} 个存量技能`,
      message: "将把目标位置的存量技能导入主库，并把原位置改成指向主库的软链接。",
      details: ["冲突策略：技能列表优先处理同名技能"],
      confirmLabel: "确认导入",
      tone: "warn",
      onConfirm: async () => {
        return runAction(async () => {
          let nextState: AppState | null = null;
          let changed = 0;
          const errors: string[] = [];
          for (const status of statuses) {
            try {
              nextState = await adoptSkillFromTarget(
                status.agentId,
                status.projectId ?? null,
                status.skillName,
              );
              changed += 1;
            } catch (cause) {
              errors.push(`${status.displayName}：${formatActionError(cause)}`);
            }
          }
          if (nextState) setState(nextState);
          const report: OperationReport = {
            changed,
            skipped: statuses.length - changed - errors.length,
            conflicts: [],
            errors,
          };
          return refreshAfterReport(report, "已导入存量技能", "overlay");
        }, undefined, "overlay");
      },
    });
  }

  async function ignoreStatuses(statuses: TargetStatus[]) {
    const issueKeys = issueKeysForStatuses(statuses);
    if (!issueKeys.length) return;
    await runAction(async () => {
      const next = await ignoreIssueKeys(issueKeys);
      setState(next);
      setIssuePanel(null);
    }, `已忽略 ${issueKeys.length} 个问题`, "overlay");
  }

  function resolveIssueStatuses(statuses: TargetStatus[]) {
    const brokenStatuses = statuses.filter((status) => status.status === "broken");
    const unmanagedStatuses = statuses.filter((status) => status.status === "unmanaged");
    const conflictStatuses = statuses.filter((status) => status.status === "conflict");
    if (unmanagedStatuses.length && unmanagedStatuses.length === statuses.length) {
      setIssuePanel(null);
      adoptStatuses(unmanagedStatuses);
      return;
    }
    if (conflictStatuses.length && conflictStatuses.length === statuses.length) {
      setConfirmDialog({
        title: `处理 ${conflictStatuses.length} 个冲突`,
        message: "将用技能列表里的主库版本覆盖目标同名内容，并重新建立软链接。",
        details: conflictStatuses.slice(0, 5).map((status) => status.targetPath),
        confirmLabel: "确认覆盖",
        tone: "warn",
        onConfirm: async () => {
          const ok = await runAction(async () => {
            let combined = OperationReportEmpty();
            for (const status of conflictStatuses) {
              const report = await deploySkill(
                status.skillId,
                [{ agentId: status.agentId, projectId: status.projectId ?? null }],
                true,
              );
              combined = mergeReport(combined, report);
            }
            const handled = await refreshAfterReport(combined, "已处理冲突", "overlay");
            if (handled) setIssuePanel(null);
            return handled;
          }, undefined, "overlay");
          return ok;
        },
      });
      return;
    }
    const issueKeys = issueKeysForStatuses(brokenStatuses);
    if (!issueKeys.length) return;
    setConfirmDialog({
      title: `处理 ${issueKeys.length} 个失效链接`,
      message: "将删除这些已经指向不存在位置的软链接。不会删除主库 Skill，也不会删除真实 Skill 文件夹。",
      details: brokenStatuses.slice(0, 5).map((status) => status.targetPath),
      confirmLabel: "确认处理",
      tone: "warn",
      onConfirm: async () => {
        const ok = await runAction(async () => {
          const report = await resolveBrokenIssueKeys(issueKeys);
          const handled = await refreshAfterReport(report, "已处理失效链接", "overlay");
          if (handled) setIssuePanel(null);
          return handled;
        }, undefined, "overlay");
        return ok;
      },
    });
  }

  function currentTransferTargets() {
    if (!state) return [];
    if (view === "global") {
      return [{ agentId: selectedAgentId, projectId: null }];
    }
    if (view === "projects" && selectedProjectId) {
      return state.agents.map((agent) => ({ agentId: agent.id, projectId: selectedProjectId }));
    }
    return [];
  }

  async function applyTransferItem(item: TransferItem) {
    if (!item.skillIds.length) {
      setError(item.kind === "composition"
        ? "这个组合没有可应用成员"
        : "这个 Skill 尚未入库");
      return;
    }
    if (hasBlockingPathRisk(item)) {
      setError("项目路径不存在，请先到设置修正");
      return;
    }
    const targets = currentTransferTargets();
    if (!targets.length) return;
    const hasOverwriteRisk = itemHasOverwriteRisk(item);
    const hasMissingMembers = item.kind === "composition" && item.missingCount > 0;
    const apply = async (surface: FeedbackSurface = "page") => {
      return runAction(async () => {
        let combined = OperationReportEmpty();
        if (hasMissingMembers) {
          combined.skipped += item.missingCount * targets.length;
        }
        for (const skillId of item.skillIds) {
          const report = await deploySkill(skillId, targets, hasOverwriteRisk);
          combined = mergeReport(combined, report);
        }
        return refreshAfterReport(combined, view === "projects" ? "已应用到项目" : "已应用到 Agent", surface);
      }, undefined, surface);
    };
    if (hasOverwriteRisk || hasMissingMembers) {
      const riskyStatuses = item.statuses.filter((status) => isOverwriteRiskStatus(status.status));
      const details = [
        ...riskyStatuses.slice(0, 4).map((status) => `${status.agentName}：${status.targetPath}`),
        ...(hasMissingMembers ? [`有 ${item.missingCount} 个组合成员已不在技能列表中，本次会跳过。`] : []),
      ];
      setConfirmDialog({
        title: `${hasOverwriteRisk ? "用技能列表覆盖" : "应用可用成员"}：${item.displayName}`,
        message: view === "projects"
          ? `会影响当前项目下 ${targets.length} 个 Agent，其中 ${riskyStatuses.length} 个位置存在覆盖风险。`
          : hasOverwriteRisk
            ? "目标位置已有同名内容，确认后会按技能列表版本重建软链接。"
            : "这个技能组合有成员缺失，确认后只应用当前仍存在的成员。",
        details,
        confirmLabel: hasOverwriteRisk ? "覆盖并应用" : "应用可用成员",
        tone: "warn",
        onConfirm: () => apply("overlay"),
      });
      return;
    }
    await apply("page");
  }

  async function withdrawTransferItem(item: TransferItem) {
    if (!item.skillIds.length) {
      setError(item.kind === "composition"
        ? "这个组合没有可收回成员"
        : "这个 Skill 尚未入库，无法收回");
      return;
    }
    if (!canWithdrawTransferItem(item)) {
      setError("当前状态不能直接收回");
      return;
    }
    const targets = currentTransferTargets();
    if (!targets.length) return;
    await runAction(async () => {
      let combined = OperationReportEmpty();
      for (const skillId of item.skillIds) {
        const report = await withdrawSkill(skillId, targets);
        combined = mergeReport(combined, report);
      }
      await refreshAfterReport(combined, view === "projects" ? "已从项目收回" : "已从 Agent 收回");
    });
  }

  async function moveTransferItem(item: TransferItem, targetColumn: TransferColumnKey) {
    if (targetColumn === "applied") {
      await applyTransferItem(item);
      return;
    }
    await withdrawTransferItem(item);
  }

  function toggleChecked(skillId: string) {
    setCheckedSkillIds((current) => {
      const next = new Set(current);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  }

  function renderMiddle() {
    if (!state) return null;

    if (view === "library") {
      if (!state.skills.length) {
        return (
          <EmptyGuidance
            illustration={EMPTY_STATE_ILLUSTRATIONS.skills}
            title="导入第一个技能"
            description="导入后会进入本地技能列表，之后可以按需应用到我的 Agent 或我的项目。"
            action="导入技能"
            actionIcon={<Upload size={16} />}
            onAction={() => setImportSkillOpen(true)}
          />
        );
      }
      return (
        <>
          <StatusFilterBar
            value={statusFilter}
            options={buildSkillFilterOptions(queriedSkills)}
            onChange={changeStatusFilter}
          />
          <SkillList
            skills={filteredSkills}
            selectedId={selected?.type === "skill" ? selected.id : null}
            checkedIds={checkedSkillIds}
            onToggleCheck={toggleChecked}
            onSelect={(skill) => setSelected({ type: "skill", id: skill.id })}
            onDeploy={(skill) => setDrawer({ type: "skill", skillIds: [skill.id] })}
            onOpen={(skill) => void openPath(skill.path)}
            onDelete={(skill) => confirmDeleteSkill(skill, allStatuses.filter(
              (status) => status.skillId === skill.id && status.status === "enabled",
            ))}
            emptyTitle={state.skills.length ? "没有匹配的技能" : "技能列表里还没有技能"}
            emptyDescription={state.skills.length
              ? "换个关键词，或清除筛选后再看全部技能。"
              : "先导入一个包含 SKILL.md 的文件夹。导入只进入主库，不会自动应用到 Agent。"}
            emptyAction={state.skills.length ? undefined : "导入技能"}
            emptyOnAction={state.skills.length ? undefined : () => setImportSkillOpen(true)}
          />
        </>
      );
    }

    if (view === "global") {
      if (!state.skills.length && !state.presets.length && !transferItems.length) {
        return (
          <EmptyGuidance
            illustration={EMPTY_STATE_ILLUSTRATIONS.agents}
            title="先导入可应用的技能"
            description="导入后，这里会显示未应用和已应用的 Skill，你可以把技能连接到当前 Agent。"
            action="导入技能"
            actionIcon={<Upload size={16} />}
            onAction={() => setImportSkillOpen(true)}
          />
        );
      }
      return (
        <>
          {transferIssueFilterOptions.length ? (
            <StatusFilterBar
              value={statusFilter}
              options={transferIssueFilterOptions}
              onChange={changeStatusFilter}
            />
          ) : null}
          <ImportExistingToolbar
            statuses={transferItems.flatMap((item) => item.statuses)}
            onImport={adoptStatuses}
          />
          <SkillTransferView
            appliedItems={appliedTransferItems}
            availableItems={availableTransferItems}
            selectedId={selected?.type === "transferSkill" ? selected.id : null}
            expandedPresetIds={expandedTransferPresetIds}
            onSelect={(item) => setSelected({ type: "transferSkill", id: item.id })}
            onTogglePreset={(presetId) => toggleSetValue(setExpandedTransferPresetIds, presetId)}
            onMove={moveTransferItem}
            working={working}
          />
        </>
      );
    }

    if (view === "projects") {
      if (!selectedProjectId) {
        return (
          <EmptyGuidance
            illustration={EMPTY_STATE_ILLUSTRATIONS.projects}
            title="添加第一个项目"
            description="添加后可以按项目查看各 Agent 的 Skill 应用状态，并把技能应用到项目目录。"
            action="添加项目"
            actionIcon={<FolderPlus size={16} />}
            onAction={pickAndAddProject}
          />
        );
      }
      if (!state.skills.length && !state.presets.length && !transferItems.length) {
        return (
          <EmptyGuidance
            illustration={EMPTY_STATE_ILLUSTRATIONS.projects}
            title="这个项目还没有可应用的技能"
            description="先导入一个包含 SKILL.md 的技能，再把它应用到这个项目下的 Agent。"
            action="导入技能"
            actionIcon={<Upload size={16} />}
            onAction={() => setImportSkillOpen(true)}
          />
        );
      }
      return (
        <>
          {transferIssueFilterOptions.length ? (
            <StatusFilterBar
              value={statusFilter}
              options={transferIssueFilterOptions}
              onChange={changeStatusFilter}
            />
          ) : null}
          <ImportExistingToolbar
            statuses={transferItems.flatMap((item) => item.statuses)}
            onImport={adoptStatuses}
          />
          <SkillTransferView
            appliedItems={appliedTransferItems}
            availableItems={availableTransferItems}
            selectedId={selected?.type === "transferSkill" ? selected.id : null}
            expandedPresetIds={expandedTransferPresetIds}
            onSelect={(item) => setSelected({ type: "transferSkill", id: item.id })}
            onTogglePreset={(presetId) => toggleSetValue(setExpandedTransferPresetIds, presetId)}
            onMove={moveTransferItem}
            working={working}
          />
        </>
      );
    }

    if (view === "presets") {
      return (
        <PresetList
          presets={queriedPresets}
          totalCount={state.presets.length}
          skills={state.skills}
          selectedId={selected?.type === "preset" ? selected.id : null}
          onSelect={(preset) => setSelected({ type: "preset", id: preset.id })}
          onApply={(preset) => setDrawer({ type: "preset", presetId: preset.id })}
          onEdit={(preset) =>
            setPresetDraft({
              id: preset.id,
              name: presetDisplayName(preset),
              description: preset.description,
              skillIds: preset.skillIds,
            })
          }
          onDelete={confirmDeletePreset}
          onCreate={() => setPresetDraft({ id: null, name: "", description: "", skillIds: [] })}
          working={working}
        />
      );
    }

    return (
      <SettingsPanel
        state={state}
        onPickAgent={pickAndAddAgent}
        onPickProject={pickAndAddProject}
        onUpdateAgentPath={pickAndUpdateAgent}
        onReopenOnboarding={async () => {
          try {
            const next = await setOnboardingCompleted(false);
            setState(next);
            setOnboardingCompletedState(false);
          } catch (cause) {
            setError(formatActionError(cause));
          }
        }}
        onToggleAgentEnabled={async (agentId, enabled) => {
          await runAction(async () => {
            const next = await setAgentEnabled(agentId, enabled);
            setState(next);
          }, enabled ? "已启用 Agent" : "已停用 Agent");
        }}
        onRemoveAgent={(agentId) => {
          const agent = state.agents.find((item) => item.id === agentId);
          setConfirmDialog({
            title: `移除 Agent：${agent?.name ?? agentId}`,
            message: "只会从影子的管理列表移除，不会删除真实目录，也不会删除已经存在的 Skill。",
            details: agent ? [agent.globalPath, `项目目录规则：<项目根目录>/${agent.projectRelativePath}`] : undefined,
            confirmLabel: "确认移除",
            tone: "warn",
            onConfirm: async () => {
              return runAction(async () => {
                const next = await removeAgent(agentId);
                const nextAgentId = next.agents.some((item) => item.id === selectedAgentId)
                  ? selectedAgentId
                  : next.agents[0]?.id ?? selectedAgentId;
                const nextProjectAgentId = next.agents.some((item) => item.id === selectedProjectAgentId)
                  ? selectedProjectAgentId
                  : next.agents[0]?.id ?? selectedProjectAgentId;
                setState(next);
                setSelectedAgentId(nextAgentId);
                setSelectedProjectAgentId(nextProjectAgentId);
                setSelected(defaultSelectionForView(view, next, nextAgentId, selectedProjectId, nextProjectAgentId));
              }, "已移除 Agent", "overlay");
            },
          });
        }}
        onRemoveProject={(projectId) => {
          const project = state.projects.find((item) => item.id === projectId);
          setConfirmDialog({
            title: `移除项目：${project?.name ?? projectId}`,
            message: "只会从影子的管理列表移除，不会删除项目目录。",
            details: project ? [project.path] : undefined,
            confirmLabel: "确认移除",
            tone: "warn",
            onConfirm: async () => {
              return runAction(async () => {
                const next = await removeProject(projectId);
                const nextProjectId = resolveProjectId(next, selectedProjectId === projectId ? null : selectedProjectId);
                setState(next);
                setSelectedProjectId(nextProjectId);
                setSelected(defaultSelectionForView("projects", next, selectedAgentId, nextProjectId, selectedProjectAgentId));
              }, "已移除项目", "overlay");
            },
          });
        }}
        healthIssues={healthIssues}
        onSelectHealthIssue={selectHealthIssue}
      />
    );
  }

  function renderDetail() {
    if (!state) return null;

    const transferItem = selectedTransferItem && filteredTransferItems.some((item) => item.id === selectedTransferItem.id)
      ? selectedTransferItem
      : availableTransferItems[0] ?? appliedTransferItems[0] ?? null;

    if ((view === "global" || view === "projects") && transferItem) {
      const librarySkill = transferItem.librarySkill;
      const unmanagedStatuses = transferItem.statuses.filter((status) => status.status === "unmanaged");
      const firstStatus = transferItem.statuses[0] ?? null;
      return (
        <ContextPanel title={transferItem.displayName}>
          <StatusPill status={transferItem.status} />
          <p className="description">{transferItem.description || "暂无描述"}</p>
          <KeyValue label="当前对象" value={view === "projects" ? selectedProject?.name ?? "项目" : selectedAgent?.name ?? "Agent"} />
          <KeyValue
            label="应用范围"
            value={view === "projects"
              ? `${transferItem.enabledCount}/${transferItem.targetCount} 个 Agent 已应用`
              : selectedAgent?.globalPath ?? "全局"}
          />
          <TransferStatusDetails item={transferItem} />
          <div className="detail-actions">
            {unmanagedStatuses.length ? (
              <button
                className="primary-button"
                disabled={working}
                onClick={() => adoptStatuses(unmanagedStatuses)}
              >
                <Archive size={16} />
                入库
              </button>
            ) : null}
            {canApplyTransferItem(transferItem) ? (
              <button
                className="primary-button"
                disabled={working}
                onClick={() => void applyTransferItem(transferItem)}
              >
                <Link2 size={16} />
                {transferItem.status === "conflict" ? "用主库覆盖" : transferItem.status === "partial" ? "补齐应用" : "应用"}
              </button>
            ) : null}
            {canWithdrawTransferItem(transferItem) ? (
              <button
                className="icon-button"
                disabled={working}
                aria-label={`收回 ${transferItem.displayName}`}
                title="收回"
                onClick={() => void withdrawTransferItem(transferItem)}
              >
                <Unlink size={16} />
              </button>
            ) : null}
            {firstStatus ? (
              <button
                className="icon-button subtle"
                aria-label="打开位置"
                title="打开位置"
                onClick={() => void openPath(firstStatus.targetPath)}
              >
                <ExternalLink size={16} />
              </button>
            ) : null}
          </div>
          {librarySkill ? <SkillPreview skill={librarySkill} /> : null}
        </ContextPanel>
      );
    }

    if (view === "global" || view === "projects") {
      return (
        <ContextPanel title={view === "global" ? selectedAgent?.name ?? "我的 Agent" : selectedProject?.name ?? "我的项目"}>
          <EmptyState
            title={view === "projects" && !selectedProjectId
              ? "还没有纳入管理的项目"
              : "当前筛选没有匹配的 Skill"}
            action={view === "projects" && !selectedProjectId ? "添加项目" : undefined}
            onAction={view === "projects" && !selectedProjectId ? pickAndAddProject : undefined}
          />
          {view === "projects" && selectedProject && !selectedProject.exists ? (
            <InlineWarning text="项目路径当前不可访问，请在设置中确认项目目录。" />
          ) : null}
        </ContextPanel>
      );
    }

    if (selectedPreset) {
      const presetMembers = buildPresetMemberRows(selectedPreset, state.skills);
      const availableMemberCount = presetMembers.filter((member) => member.skill).length;
      const missingMemberCount = presetMembers.length - availableMemberCount;
      const abnormalMemberCount = presetMembers.filter((member) =>
        member.skill && (!member.skill.hasSkillMd || member.skill.issueCount > 0)
      ).length;
      const presetProblemCount = missingMemberCount + abnormalMemberCount;
      const canApplyPreset = availableMemberCount > 0;
      return (
        <ContextPanel
          title={presetDisplayName(selectedPreset)}
          onClose={() => setSelected(null)}
          closeLabel="关闭组合详情"
        >
          <div className="detail-status-row">
            <DetailBadge tone={selectedPreset.skillIds.length ? "note" : "muted"}>
              {selectedPreset.skillIds.length ? `${selectedPreset.skillIds.length} 个成员` : "空组合"}
            </DetailBadge>
            <DetailBadge tone={presetProblemCount ? "warn" : "good"}>
              {presetProblemCount ? `${presetProblemCount} 个问题` : "成员正常"}
            </DetailBadge>
          </div>
          <p className="description">{selectedPreset.description || skillNames(selectedPreset, state.skills) || "暂无描述"}</p>
          {!canApplyPreset ? <InlineWarning text="这个组合没有可用成员。下一步：编辑组合，至少选择一个仍在技能列表里的技能。" /> : null}
          <div className="detail-actions">
            <button
              className="primary-button"
              disabled={!canApplyPreset}
              onClick={() => setDrawer({ type: "preset", presetId: selectedPreset.id })}
            >
              <Link2 size={16} />
              应用组合
            </button>
            <button
              className="icon-button"
              aria-label="编辑组合"
              title="编辑组合"
              onClick={() =>
                setPresetDraft({
                  id: selectedPreset.id,
                  name: presetDisplayName(selectedPreset),
                  description: selectedPreset.description,
                  skillIds: selectedPreset.skillIds,
                })
              }
            >
              <Pencil size={16} />
            </button>
            <button
              className="icon-button danger"
              disabled={working}
              aria-label="删除组合"
              title="删除组合"
              onClick={() => confirmDeletePreset(selectedPreset)}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <DetailSection title="组合概览">
            <div className="detail-meta-list">
              <DetailMeta label="成员总数">{`${selectedPreset.skillIds.length} 个`}</DetailMeta>
              <DetailMeta label="可用成员">{`${availableMemberCount} 个`}</DetailMeta>
              <DetailMeta label="缺失成员">{`${missingMemberCount} 个`}</DetailMeta>
            </div>
          </DetailSection>
          <DetailSection title="成员清单">
            <PresetMemberList members={presetMembers} />
          </DetailSection>
          <p className="muted-text preset-rule-note">组合本身不会被软链接；应用或收回组合时，只批量处理成员 Skill。</p>
        </ContextPanel>
      );
    }

    const skill = selectedSkill && filteredSkills.some((item) => item.id === selectedSkill.id)
      ? selectedSkill
      : null;
    if (!skill) {
      if (state.skills.length) {
        return (
          <ContextPanel title="技能列表">
            <EmptyState title="当前筛选没有匹配的技能" />
          </ContextPanel>
        );
      }
      const unmanaged = state.globalWorkspaces
        .flatMap((workspace) => workspace.statuses)
        .filter((status) => status.status === "unmanaged");
      return (
        <ContextPanel title="技能列表">
          {unmanaged.length ? (
            <>
              <InlineWarning text={`发现 ${unmanaged.length} 个全局存量技能尚未入库。`} />
              <div className="detail-actions">
                <button className="primary-button" onClick={() => void adoptStatuses(unmanaged)}>
                  <Archive size={16} />
                  导入全部全局存量
                </button>
                <button
                  className="icon-button"
                  aria-label="查看我的 Agent"
                  title="查看我的 Agent"
                  onClick={() => setView("global")}
                >
                  <Globe2 size={16} />
                </button>
              </div>
            </>
          ) : (
            <EmptyState
              title="技能列表里还没有技能"
              description="选择一个包含 SKILL.md 的本地文件夹，先进入主库，再决定应用范围。"
              action="导入技能"
              onAction={() => setImportSkillOpen(true)}
            />
          )}
        </ContextPanel>
      );
    }

    const locations = allStatuses.filter(
      (status) => status.skillId === skill.id && status.status === "enabled",
    );
    const skillProblemCount = skill.issueCount || (!skill.hasSkillMd ? 1 : 0);

    return (
      <ContextPanel
        title={skill.displayName}
        onClose={() => setSelected(null)}
        closeLabel="关闭技能详情"
      >
        <div className="detail-status-row">
          <DetailBadge tone={locations.length ? "good" : "muted"}>
            {locations.length ? `已启用 ${locations.length} 处` : "未启用"}
          </DetailBadge>
          <DetailBadge tone={skillProblemCount ? "warn" : "good"}>
            {skillProblemCount ? `${skillProblemCount} 个问题` : "无问题"}
          </DetailBadge>
        </div>
        <p className="description">{skill.description || "暂无描述"}</p>
        {!skill.hasSkillMd ? <InlineWarning text="该技能缺少 SKILL.md" /> : null}
        <DetailSection title="使用情况">
          <div className="detail-meta-list">
            <DetailMeta label="格式状态">{skill.hasSkillMd ? "SKILL.md 正常" : "缺少 SKILL.md"}</DetailMeta>
            <DetailMeta label="应用状态">{locations.length ? `${locations.length} 处已启用` : "未启用"}</DetailMeta>
            <DetailMeta label="标签">{skill.tags.length ? <TagRow tags={skill.tags} /> : "无标签"}</DetailMeta>
          </div>
        </DetailSection>
        <EnabledLocations statuses={locations} />
        <SkillPreview skill={skill} />
        <PathDisclosure title="更多技术信息" rows={[{ label: "主库路径", path: skill.path }]} />
      </ContextPanel>
    );
  }
  const workspaceClassName = [
    "workspace",
    view === "library" && selectedSkill ? "library-detail-open" : "",
    view === "library" && !selectedSkill ? "library-list-only" : "",
    view === "presets" && selectedPreset ? "preset-detail-open" : "",
    view === "presets" && !selectedPreset ? "preset-list-only" : "",
    view === "global" || view === "projects" ? "transfer-mode" : "",
    view === "settings" ? "settings-mode" : "",
  ].filter(Boolean).join(" ");
  const shouldShowDetailPane = (view === "presets" && Boolean(selectedPreset)) || (view === "library" && Boolean(selectedSkill));
  const shouldMountDetailPane = view === "presets" || view === "library";
  const selectedDetailKey = selected && "id" in selected ? `${selected.type}:${selected.id}` : selected?.type ?? "none";
  const detailPaneKey = `${view}:${selectedDetailKey}`;

  if (onboardingCompleted === false) {
    return (
      <OnboardingScreen
        onFinished={async (summary) => {
          try {
            const next = await setOnboardingCompleted(true);
            setState(next);
            setOnboardingCompletedState(true);
            setView("library");
            const noticeParts: string[] = [];
            noticeParts.push(`${summary.enabledAgents} 个 Agent`);
            if (summary.adoptedSkills > 0) noticeParts.push(`${summary.adoptedSkills} 个 Skill 入库`);
            if (summary.installedPackageSkills > 0) noticeParts.push(`${summary.installedPackageSkills} 个预置 Skill`);
            if (summary.addedProjects > 0) noticeParts.push(`${summary.addedProjects} 个项目`);
            setNotice(`已完成初始化：${noticeParts.join("，")}`);
          } catch (cause) {
            setError(formatActionError(cause));
          }
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-workspace">
        跳到主内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="/app-icon.png" alt="" />
          </div>
          <div>
            <strong>{PRODUCT_NAME}</strong>
            <span>{PRODUCT_TAGLINE}</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          <button
            className={view === "library" ? "nav-item active" : "nav-item"}
            onClick={() => selectView("library")}
          >
            <BookOpen size={17} />
            技能列表
          </button>
          <button
            className={view === "presets" ? "nav-item active" : "nav-item"}
            onClick={() => selectView("presets")}
          >
            <Layers3 size={17} />
            技能组合
          </button>

          <div className="nav-section">
            <div className="nav-section-header">我的 Agent</div>
            {state?.agents.map((agent) => (
              <button
                key={agent.id}
                className={view === "global" && selectedAgentId === agent.id ? "nav-item sub active" : "nav-item sub"}
                onClick={() => selectGlobalAgent(agent.id)}
                title={agent.globalPath}
              >
                <Globe2 size={16} />
                <span>{agent.name}</span>
              </button>
            ))}
          </div>

          <div className="nav-section">
            <div className="nav-section-header">我的项目</div>
            {state?.projects.length ? (
              state.projects.map((project) => (
                <button
                  key={project.id}
                  className={[
                    "nav-item",
                    "sub",
                    view === "projects" && selectedProjectId === project.id ? "active" : "",
                    project.exists ? "" : "warning",
                  ].filter(Boolean).join(" ")}
                  onClick={() => selectProject(project.id)}
                  title={project.path}
                >
                  <FolderKanban size={16} />
                  <span>{project.name}</span>
                </button>
              ))
            ) : (
              <button
                className={view === "projects" && !selectedProjectId ? "nav-item sub active" : "nav-item sub"}
                onClick={() => selectView("projects")}
              >
                <FolderKanban size={16} />
                <span>我的项目</span>
              </button>
            )}
          </div>

          <div className="nav-section bottom">
            {navItems.filter((item) => item.key === "settings").map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  className={view === item.key ? "nav-item active" : "nav-item"}
                  onClick={() => selectView(item.key)}
                >
                  <Icon size={17} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
        {state ? (
          <div className="sidebar-meta">
            <span>技能 {state.skills.length} 个</span>
            <span>组合 {state.presets.length} 个</span>
            <span>{state.projects.length} 个项目</span>
          </div>
        ) : null}
      </aside>

      <main className="main-surface" id="main-workspace">
        <header className="topbar">
          <div className="search-box" role="search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索技能、项目、智能体应用或路径"
              aria-label="搜索技能、项目、智能体应用或路径"
            />
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              disabled={working}
              aria-label="刷新"
              title="刷新"
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
            <button className="primary-button" onClick={() => setImportSkillOpen(true)}>
              <Upload size={16} />
              导入技能
            </button>
          </div>
        </header>

        {!state && !loading ? (
          <StartupFallback error={error} onRetry={() => void load(true)} />
        ) : (
          <section className={workspaceClassName}>
            <div className="list-pane">
              <PaneHeader
                view={view}
                title={view === "global" ? selectedAgent?.name ?? "我的 Agent" : view === "projects" ? selectedProject?.name ?? "我的项目" : undefined}
                subtitle={view === "settings" ? "对象和本地路径" : view === "projects" && selectedProject ? "项目整体应用到所有 Agent" : view === "global" && selectedAgent ? selectedAgent.globalPath : undefined}
                count={
                  view === "library"
                    ? filteredSkills.length
                    : view === "global"
                      ? filteredTransferItems.length
                      : view === "projects"
                        ? filteredTransferItems.length
                        : view === "presets"
                          ? queriedPresets.length
                          : (state?.agents.length ?? 0) + (state?.projects.length ?? 0)
                }
              />
              {loading ? (
                <div className="loading-state">
                  <Loader2 className="spin" size={20} />
                  正在读取本地技能状态
                </div>
              ) : (
                renderMiddle()
              )}
            </div>
            {shouldMountDetailPane ? (
              <div key={detailPaneKey} className={shouldShowDetailPane ? "detail-pane" : "detail-pane is-closed"}>
                {shouldShowDetailPane ? renderDetail() : null}
              </div>
            ) : null}
          </section>
        )}

        {checkedSkillIds.size > 0 ? (
          <div className="bulk-bar">
            <span>已选择 {checkedSkillIds.size} 个技能</span>
            <button className="primary-button" onClick={() => setDrawer({ type: "skill", skillIds: [...checkedSkillIds] })}>
              <Link2 size={16} />
              批量分发
            </button>
            <button
              className="icon-button subtle"
              aria-label="清除选择"
              title="清除选择"
              onClick={() => setCheckedSkillIds(new Set())}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
      </main>

      {state && drawer ? (
        <DistributionDrawer
          state={state}
          drawer={drawer}
          onClose={() => setDrawer(null)}
          onApply={async (targets, overwrite) => {
            await runAction(async () => {
              let ok = true;
              if (drawer.type === "skill") {
                let combined: OperationReport = {
                  changed: 0,
                  skipped: 0,
                  conflicts: [],
                  errors: [],
                };
                for (const skillId of drawer.skillIds) {
                  const report = await deploySkill(skillId, targets, overwrite);
                  combined = mergeReport(combined, report);
                }
                ok = await refreshAfterReport(combined, "已分发", "overlay");
              } else {
                const skillIds = existingPresetSkillIds(state, drawer.presetId);
                let combined = OperationReportEmpty();
                const preset = state.presets.find((item) => item.id === drawer.presetId);
                const missingCount = Math.max((preset?.skillIds.length ?? 0) - skillIds.length, 0);
                if (missingCount) combined.skipped += missingCount * targets.length;
                for (const skillId of skillIds) {
                  const report = await deploySkill(skillId, targets, overwrite);
                  combined = mergeReport(combined, report);
                }
                ok = await refreshAfterReport(combined, "已应用组合", "overlay");
              }
              if (!ok) return false;
              setDrawer(null);
              setCheckedSkillIds(new Set());
            }, undefined, "overlay");
          }}
          onWithdraw={async (targets) => {
            await runAction(async () => {
              if (drawer.type === "preset") {
                let combined = OperationReportEmpty();
                for (const skillId of existingPresetSkillIds(state, drawer.presetId)) {
                  const report = await withdrawSkill(skillId, targets);
                  combined = mergeReport(combined, report);
                }
                return refreshAfterReport(combined, "已收回组合", "overlay");
              }
              return true;
            }, undefined, "overlay");
          }}
        />
      ) : null}

      {state && issuePanel ? (
        <IssueResolutionDrawer
          issue={issuePanel}
          working={working}
          onClose={() => setIssuePanel(null)}
          onIgnore={(statuses) => void ignoreStatuses(statuses)}
          onResolve={resolveIssueStatuses}
          onOpenStatus={(status) => {
            setIssuePanel(null);
            setQuery("");
            setStatusFilter(status.status === "broken" ? "broken" : issuePanel.filter);
            if (status.targetKind === "project") {
              setView("projects");
              setSelectedProjectId(status.projectId ?? null);
              setSelectedProjectAgentId(status.agentId);
            } else {
              setView("global");
              setSelectedAgentId(status.agentId);
            }
            setSelected({ type: "transferSkill", id: transferItemIdForSkill(status.skillId) });
          }}
        />
      ) : null}

      {importSkillOpen ? (
        <ImportSkillDialog
          working={working}
          onClose={() => setImportSkillOpen(false)}
          onPickLocal={(sourceKind) => void pickAndImportSkill(() => setImportSkillOpen(false), sourceKind)}
        />
      ) : null}

      {state && presetDraft ? (
        <PresetDialog
          draft={presetDraft}
          skills={state.skills}
          onClose={() => setPresetDraft(null)}
          onSubmit={(draft) =>
            runAction(async () => {
              const next = await upsertPreset(
                draft.id,
                draft.name,
                draft.description,
                draft.skillIds,
              );
              setState(next);
              setSelected({ type: "preset", id: draft.id ?? slugifyClient(draft.name) });
              setPresetDraft(null);
            }, "已保存技能组合", "overlay")
          }
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmDialog
          dialog={confirmDialog}
          working={working}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={async () => {
            const ok = await confirmDialog.onConfirm();
            if (ok !== false) setConfirmDialog(null);
          }}
        />
      ) : null}
      <ToastViewport
        items={[
          ...(overlayError ? [{ id: "overlay-error", tone: "error" as const, text: overlayError }] : []),
          ...(error ? [{ id: "page-error", tone: "error" as const, text: error }] : []),
          ...(notice ? [{ id: "notice", tone: "success" as const, text: notice }] : []),
        ].slice(0, 2)}
      />
    </div>
  );
}

function PaneHeader({
  view,
  count,
  title: customTitle,
  subtitle,
}: {
  view: ViewKey;
  count: number;
  title?: string;
  subtitle?: string;
}) {
  const title: Record<ViewKey, string> = {
    library: "技能列表",
    global: "我的 Agent",
    projects: "我的项目",
    presets: "技能组合",
    settings: "设置",
  };
  return (
    <div className="pane-header">
      <div>
        <h1>{customTitle ?? title[view]}</h1>
        <span>{subtitle ? `${subtitle} · ` : ""}{count} 项</span>
      </div>
    </div>
  );
}

function HealthOverview({
  issues,
  onSelect,
}: {
  issues: HealthIssue[];
  onSelect: (issue: HealthIssue) => void;
}) {
  const total = issues.reduce((sum, issue) => sum + issue.count, 0);
  if (!issues.length) {
    return null;
  }

  return (
    <section className="health-overview" aria-label="健康总览">
      <div className="health-copy">
        <strong>健康总览</strong>
        <span>{total} 个问题需要处理</span>
      </div>
      <div className="health-actions">
        {issues.map((issue) => (
          <button
            key={issue.kind}
            type="button"
            className={`health-chip ${issue.kind}`}
            onClick={() => onSelect(issue)}
            title={issue.summary}
          >
            <span>{issue.label}</span>
            <strong>{issue.count}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

type OnboardingSummary = {
  enabledAgents: number;
  adoptedSkills: number;
  addedProjects: number;
  installedPackageSkills: number;
};

type OnboardingStep = 0 | 1 | 2 | 3 | 4;

const onboardingStepMeta: Array<{ id: Exclude<OnboardingStep, 0>; title: string; label: string; description: string }> = [
  {
    id: 1,
    title: "添加 Agent",
    label: "工具",
    description: "选择要管理的工具。已检测到的工具会默认选中，也可以先跳过。",
  },
  {
    id: 2,
    title: "添加项目",
    label: "项目",
    description: "把常用项目加入影子，之后可以按项目管理 Skill。也可以稍后再加。",
  },
  {
    id: 3,
    title: "已有 Skill 导入",
    label: "整理",
    description: "这些 Skill 已经在你的工具里。导入后会进入主库，方便统一管理。",
  },
  {
    id: 4,
    title: "预置 Skill 安装",
    label: "安装",
    description: "影子自带一些常用 Skill。选择你想安装的，之后可以在主库里统一管理。",
  },
];

function OnboardingScreen({ onFinished }: { onFinished: (summary: OnboardingSummary) => void | Promise<void> }) {
  const [step, setStep] = useState<OnboardingStep>(0);
  const [detectedAgents, setDetectedAgents] = useState<DetectedAgent[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [enabledAgentCount, setEnabledAgentCount] = useState(0);
  const [agentLoading, setAgentLoading] = useState(true);
  const [unmanaged, setUnmanaged] = useState<TargetStatus[]>([]);
  const [selectedAdoptIds, setSelectedAdoptIds] = useState<Set<string>>(new Set());
  const [unmanagedLoading, setUnmanagedLoading] = useState(false);
  const [unmanagedScanFailed, setUnmanagedScanFailed] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [adoptedCount, setAdoptedCount] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepNotice, setStepNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectSuggestions, setProjectSuggestions] = useState<ProjectSuggestion[]>([]);
  const [selectedProjectSuggestionIds, setSelectedProjectSuggestionIds] = useState<Set<string>>(new Set());
  const [projectSuggestionLoading, setProjectSuggestionLoading] = useState(false);
  const [projectSuggestionScanStarted, setProjectSuggestionScanStarted] = useState(false);
  const [projectSuggestionScanFailed, setProjectSuggestionScanFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [presetScan, setPresetScan] = useState<SkillPackageScan | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetAutoScanStarted, setPresetAutoScanStarted] = useState(false);
  const [selectedPresetSkillIds, setSelectedPresetSkillIds] = useState<Set<string>>(new Set());
  const [presetInstalledCount, setPresetInstalledCount] = useState(0);
  const [presetInstalling, setPresetInstalling] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setAgentLoading(true);
        setStepError(null);
        const list = await detectDefaultAgents();
        setDetectedAgents(list);
        setSelectedAgentIds(new Set(list.filter((agent) => agent.exists).map((agent) => agent.id)));
      } catch (cause) {
        setStepError(`无法检测默认 Agent：${cleanErrorMessage(cause)}`);
      } finally {
        setAgentLoading(false);
      }
    })();
  }, []);

  function toggleAgent(id: string) {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function goToProjectStep() {
    setStep(2);
    setStepError(null);
    setStepNotice(null);
  }

  useEffect(() => {
    if (step !== 2 || projectSuggestionScanStarted) return;
    setProjectSuggestionScanStarted(true);
    void loadProjectSuggestions();
  }, [projectSuggestionScanStarted, step]);

  async function commitAgentSelection() {
    setBusy(true);
    setStepError(null);
    try {
      for (const agent of detectedAgents) {
        await setAgentEnabled(agent.id, selectedAgentIds.has(agent.id));
      }
      setEnabledAgentCount(selectedAgentIds.size);
    } catch (cause) {
      setStepError(`保存 Agent 选择失败：${cleanErrorMessage(cause)}`);
      setBusy(false);
      return false;
    }
    setBusy(false);
    return true;
  }

  async function continueFromAgentStep() {
    if (!(await commitAgentSelection())) return;
    goToProjectStep();
  }

  async function goToExistingSkillStep() {
    setStep(3);
    setUnmanagedLoading(true);
    setStepError(null);
    setStepNotice(null);
    setUnmanagedScanFailed(false);
    try {
      const list = await listUnmanagedForOnboarding();
      setUnmanaged(list);
      setSelectedAdoptIds(new Set(list.map((status) => status.id)));
    } catch (cause) {
      setUnmanagedScanFailed(true);
      setUnmanaged([]);
      setSelectedAdoptIds(new Set());
      setStepError(`暂时无法扫描存量 Skill，可以先跳过这一步：${cleanErrorMessage(cause)}`);
    } finally {
      setUnmanagedLoading(false);
    }
  }

  async function loadProjectSuggestions() {
    setProjectSuggestionLoading(true);
    setProjectSuggestionScanFailed(false);
    try {
      const suggestions = await suggestOnboardingProjects();
      setProjectSuggestions(suggestions);
      setSelectedProjectSuggestionIds(new Set(
        suggestions
          .filter((suggestion) => suggestion.recommended && !suggestion.alreadyAdded)
          .map((suggestion) => suggestion.id),
      ));
    } catch (cause) {
      setProjectSuggestions([]);
      setSelectedProjectSuggestionIds(new Set());
      setProjectSuggestionScanFailed(true);
      setStepError(`暂时无法推荐项目，可以手动添加或继续：${cleanErrorMessage(cause)}`);
    } finally {
      setProjectSuggestionLoading(false);
    }
  }

  function toggleProjectSuggestion(id: string) {
    setSelectedProjectSuggestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSelectedProjectSuggestions() {
    const selectedSuggestions = projectSuggestions.filter(
      (suggestion) => selectedProjectSuggestionIds.has(suggestion.id) && !suggestion.alreadyAdded,
    );
    if (!selectedSuggestions.length) {
      return true;
    }

    setBusy(true);
    setStepError(null);
    setStepNotice(null);
    try {
      let nextProjects = projects;
      for (const suggestion of selectedSuggestions) {
        const next = await addProject(suggestion.path);
        nextProjects = next.projects;
      }
      setProjects(nextProjects);
      setProjectSuggestions((current) =>
        current.map((suggestion) =>
          selectedProjectSuggestionIds.has(suggestion.id)
            ? { ...suggestion, alreadyAdded: true, reason: suggestion.reason.startsWith("已添加") ? suggestion.reason : `已添加 · ${suggestion.reason}` }
            : suggestion
        )
      );
      setSelectedProjectSuggestionIds(new Set());
      setStepNotice(`已添加 ${selectedSuggestions.length} 个项目`);
      return true;
    } catch (cause) {
      setStepError(`添加推荐项目失败：${cleanErrorMessage(cause)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function continueFromProjectStep() {
    if (!(await addSelectedProjectSuggestions())) return;
    await goToExistingSkillStep();
  }

  function toggleAdopt(id: string) {
    setSelectedAdoptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function adoptSelected() {
    const targets = unmanaged.filter((status) => selectedAdoptIds.has(status.id));
    if (!targets.length) {
      setStep(4);
      return;
    }
    setAdopting(true);
    setStepError(null);
    setStepNotice(null);
    try {
      const items: BulkAdoptItem[] = targets.map((status) => ({
        agentId: status.agentId,
        projectId: status.projectId ?? null,
        skillName: status.skillName,
      }));
      const report = await bulkAdoptSkills(items);
      setAdoptedCount((prev) => prev + report.changed);
      if (report.errors.length) {
        const nextUnmanaged = await listUnmanagedForOnboarding();
        setUnmanaged(nextUnmanaged);
        setSelectedAdoptIds(new Set(nextUnmanaged.map((status) => status.id)));
        setStepError(`部分 Skill 入库失败：${report.errors.slice(0, 3).join("；")}${report.errors.length > 3 ? "…" : ""}`);
        if (report.changed > 0) {
          setStepNotice(`已入库 ${report.changed} 个，剩余项需要处理后再继续。`);
        }
        return;
      } else {
        setStepNotice(`已入库 ${report.changed} 个 Skill`);
      }
      setStep(4);
    } catch (cause) {
      setStepError(`批量入库失败：${cleanErrorMessage(cause)}`);
    } finally {
      setAdopting(false);
    }
  }

  function skipExistingSkillStep() {
    setStep(4);
    setStepError(null);
    setStepNotice(null);
  }

  async function pickProjectInOnboarding() {
    setBusy(true);
    setStepError(null);
    try {
      const picked = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (!picked || Array.isArray(picked)) {
        setBusy(false);
        return;
      }
      const next = await addProject(picked);
      setProjects(next.projects);
      setStepNotice(`已添加项目：${picked}`);
    } catch (cause) {
      setStepError(`添加项目失败：${cleanErrorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== 4 || presetAutoScanStarted) return;
    setPresetAutoScanStarted(true);
    void loadPresetSkills();
  }, [presetAutoScanStarted, step]);

  useEffect(() => {
    if (!stepError) return undefined;
    const timeoutId = window.setTimeout(() => setStepError(null), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [stepError]);

  useEffect(() => {
    if (!stepNotice) return undefined;
    const timeoutId = window.setTimeout(() => setStepNotice(null), FEEDBACK_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [stepNotice]);

  async function loadPresetSkills() {
    setPresetLoading(true);
    setStepError(null);
    setStepNotice(null);
    try {
      const scan = await scanBuiltinPresetSkills();
      setPresetScan(scan);
      setSelectedPresetSkillIds(new Set(scan.skills.filter((skill) => !skill.exists).map((skill) => skill.id)));
    } catch (cause) {
      setPresetScan(null);
      setSelectedPresetSkillIds(new Set());
      setStepError(`预置 Skill 暂时不可用，可以先跳过：${cleanErrorMessage(cause)}`);
    } finally {
      setPresetLoading(false);
    }
  }

  function togglePresetSkill(skill: PackageSkill) {
    if (skill.exists) return;
    setSelectedPresetSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skill.id)) next.delete(skill.id);
      else next.add(skill.id);
      return next;
    });
  }

  async function installSelectedPresetSkills() {
    const skillIds = [...selectedPresetSkillIds];
    if (!skillIds.length) {
      await finishOnboarding();
      return;
    }
    setPresetInstalling(true);
    setStepError(null);
    setStepNotice(null);
    try {
      const report = await installBuiltinPresetSkills(skillIds);
      const installed = presetInstalledCount + report.changed;
      setPresetInstalledCount(installed);
      if (report.errors.length) {
        setStepError(`部分预置 Skill 安装失败：${report.errors.slice(0, 3).join("；")}${report.errors.length > 3 ? "…" : ""}`);
        setStepNotice(`已安装 ${report.changed} 个，跳过 ${report.skipped} 个。可以先进入工作台。`);
        setSelectedPresetSkillIds(new Set());
      } else {
        await finishOnboarding(installed);
      }
    } catch (cause) {
      setStepError(`安装预置 Skill 失败：${cleanErrorMessage(cause)}`);
    } finally {
      setPresetInstalling(false);
    }
  }

  async function finishOnboarding(installedOverride?: number) {
    await onFinished({
      enabledAgents: enabledAgentCount,
      adoptedSkills: adoptedCount,
      addedProjects: projects.length,
      installedPackageSkills: installedOverride ?? presetInstalledCount,
    });
  }

  if (step === 0) {
    return (
      <div className="onboarding-shell welcome" role="main">
        <ToastViewport
          items={[
            ...(stepError ? [{ id: "onboarding-error", tone: "error" as const, text: stepError }] : []),
            ...(stepNotice ? [{ id: "onboarding-notice", tone: "success" as const, text: stepNotice }] : []),
          ].slice(0, 2)}
        />
        <section className="onboarding-welcome" aria-labelledby="onboarding-welcome-title">
          <div className="onboarding-welcome-copy">
            <img src="/app-icon.png" alt="" className="onboarding-welcome-icon" />
            <h1 id="onboarding-welcome-title">影子</h1>
            <p>你的本地 Skill 管理专家</p>
            <button type="button" className="primary-button welcome-start" onClick={() => setStep(1)}>
              开始探索
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="shadow-field" aria-hidden="true">
            <span className="shadow-plane plane-a" />
            <span className="shadow-plane plane-b" />
            <span className="shadow-plane plane-c" />
            <span className="shadow-line line-a" />
            <span className="shadow-line line-b" />
          </div>
        </section>
      </div>
    );
  }

  const stepMeta = onboardingStepMeta.find((item) => item.id === step)!;

  return (
    <div className="onboarding-shell" role="main">
      <div className="onboarding-flow">
        <aside className="onboarding-rail" aria-label="初始化进度">
          <div className="onboarding-rail-brand">
            <img src="/app-icon.png" alt="" />
            <strong>影子</strong>
          </div>
          <ol>
            {onboardingStepMeta.map((item) => (
              <li key={item.id} className={item.id === step ? "active" : item.id < step ? "done" : ""}>
                <span>{item.id}</span>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.label}</small>
                </div>
              </li>
            ))}
          </ol>
        </aside>

        <main className="onboarding-panel">
        <header className="onboarding-header">
          <span>步骤 {step} / 4</span>
          <h1>{stepMeta.title}</h1>
          <p>{stepMeta.description}</p>
        </header>
        <ToastViewport
          items={[
            ...(stepError ? [{ id: "onboarding-error", tone: "error" as const, text: stepError }] : []),
            ...(stepNotice ? [{ id: "onboarding-notice", tone: "success" as const, text: stepNotice }] : []),
          ].slice(0, 2)}
        />

        {step === 1 ? (
          <section className="onboarding-step">
            {agentLoading ? (
              <div className="loading-state">
                <Loader2 className="spin" size={18} />
                正在查找本机工具
              </div>
            ) : (
              <div className="onboarding-list">
                {detectedAgents.map((agent) => {
                  const checked = selectedAgentIds.has(agent.id);
                  return (
                    <label key={agent.id} className={`onboarding-row ${checked ? "selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                      />
                      <div className="onboarding-row-main">
                        <strong>{agent.name}</strong>
                        <small>{agent.exists ? "已找到" : "未找到，可以稍后添加"}</small>
                        <code>{agent.globalPath}</code>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <footer className="onboarding-footer">
              <span />
              <div className="onboarding-footer-right">
              <button
                type="button"
                className="secondary-button"
                disabled={busy || agentLoading}
                onClick={goToProjectStep}
              >
                跳过
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || agentLoading}
                onClick={() => void continueFromAgentStep()}
              >
                继续
                <ArrowRight size={16} />
              </button>
              </div>
            </footer>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding-step">
            {projectSuggestionLoading ? (
              <div className="loading-state">
                <Loader2 className="spin" size={18} />
                正在查找常用项目
              </div>
            ) : projectSuggestions.length ? (
              <div className="onboarding-list">
                {projectSuggestions.map((suggestion) => {
                  const checked = selectedProjectSuggestionIds.has(suggestion.id);
                  return (
                    <label
                      key={suggestion.id}
                      className={[
                        "onboarding-row",
                        "project-suggestion-row",
                        checked ? "selected" : "",
                        suggestion.alreadyAdded ? "disabled" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={checked || suggestion.alreadyAdded}
                        disabled={suggestion.alreadyAdded}
                        onChange={() => toggleProjectSuggestion(suggestion.id)}
                      />
                      <div className="onboarding-row-main">
                        <strong>{suggestion.name}</strong>
                        <small>{suggestion.recommended ? "推荐" : "可选"} · {suggestion.reason}</small>
                        <code>{suggestion.path}</code>
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="onboarding-empty">
                {projectSuggestionScanFailed
                  ? "暂时没有拿到项目推荐。可以手动添加，也可以继续。"
                  : "没有发现明显的 Agent 工作目录。可以手动添加，也可以稍后在设置里添加。"}
              </div>
            )}
            {projects.length ? (
              <div className="onboarding-list">
                {projects.map((project) => (
                  <div key={project.id} className="onboarding-row static">
                    <FolderKanban size={16} />
                    <div className="onboarding-row-main">
                      <strong>{project.name}</strong>
                      <code>{project.path}</code>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="onboarding-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void pickProjectInOnboarding()}
                disabled={busy}
              >
                <FolderPlus size={16} />
                添加项目
              </button>
            </div>
            <footer className="onboarding-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setStep(1)}
                disabled={busy}
              >
                <ArrowLeft size={16} />
                上一步
              </button>
              <div className="onboarding-footer-right">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void goToExistingSkillStep()}
                  disabled={busy}
                >
                  跳过
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void continueFromProjectStep()}
                  disabled={busy}
                >
                  继续
                  <ArrowRight size={16} />
                </button>
              </div>
            </footer>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onboarding-step">
            {unmanagedLoading ? (
              <div className="loading-state">
                <Loader2 className="spin" size={18} />
                正在查找已有 Skill
              </div>
            ) : unmanaged.length === 0 ? (
              <div className="onboarding-empty">
                {unmanagedScanFailed ? "暂时无法查找已有 Skill，可以先跳过。" : "没有发现需要导入的已有 Skill。"}
              </div>
            ) : (
              <div className="onboarding-list">
                {unmanaged.map((status) => {
                  const checked = selectedAdoptIds.has(status.id);
                  return (
                    <label key={status.id} className={`onboarding-row ${checked ? "selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAdopt(status.id)}
                      />
                      <div className="onboarding-row-main">
                        <strong>{status.displayName || status.skillName}</strong>
                        <small>{status.agentName} · {status.skillName}</small>
                        <code>{status.targetPath}</code>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <footer className="onboarding-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setStep(2)}
                disabled={adopting}
              >
                <ArrowLeft size={16} />
                上一步
              </button>
              <div className="onboarding-footer-right">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={skipExistingSkillStep}
                  disabled={adopting}
                >
                  跳过
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => selectedAdoptIds.size > 0 ? void adoptSelected() : skipExistingSkillStep()}
                  disabled={adopting || unmanagedLoading}
                >
                  {adopting ? <Loader2 className="spin" size={16} /> : selectedAdoptIds.size > 0 ? <Archive size={16} /> : <ArrowRight size={16} />}
                  {selectedAdoptIds.size > 0 ? `导入已选（${selectedAdoptIds.size}）` : "下一步"}
                </button>
              </div>
            </footer>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="onboarding-step">
            {presetLoading ? (
              <div className="loading-state">
                <Loader2 className="spin" size={18} />
                正在准备预置 Skill
              </div>
            ) : presetScan ? (
              <PackageSkillPicker
                scan={presetScan}
                selectedIds={selectedPresetSkillIds}
                onToggleSkill={togglePresetSkill}
              />
            ) : (
              <div className="onboarding-empty">
                预置 Skill 暂时不可用，可以先跳过。
              </div>
            )}
            <footer className="onboarding-footer">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setStep(3)}
                disabled={presetInstalling}
              >
                <ArrowLeft size={16} />
                上一步
              </button>
              <div className="onboarding-footer-right">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void finishOnboarding()}
                  disabled={presetInstalling}
                >
                  跳过
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void installSelectedPresetSkills()}
                  disabled={presetInstalling || presetLoading || !presetScan || selectedPresetSkillIds.size === 0}
                >
                  {presetInstalling ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
                  安装已选（{selectedPresetSkillIds.size}）
                </button>
              </div>
            </footer>
          </section>
        ) : null}
        </main>
      </div>
    </div>
  );
}

function PackageSkillPicker({
  scan,
  selectedIds,
  onToggleSkill,
}: {
  scan: SkillPackageScan;
  selectedIds: Set<string>;
  onToggleSkill: (skill: PackageSkill) => void;
}) {
  const grouped = PACKAGE_CATEGORIES.map((category) => ({
    category,
    skills: scan.skills.filter((skill) => skill.category === category),
  })).filter((group) => group.skills.length > 0);
  const selectableCount = scan.skills.filter((skill) => !skill.exists).length;

  return (
    <div className="package-picker">
      <div className="package-picker-head">
        <strong>找到 {scan.skills.length} 个预置项</strong>
        <span>{selectableCount} 个可安装</span>
      </div>
      <div className="package-category-list">
        {grouped.map((group) => {
          const selectable = group.skills.filter((skill) => !skill.exists);
          const selectedInGroup = selectable.filter((skill) => selectedIds.has(skill.id)).length;
          return (
            <section key={group.category} className="package-category">
              <header>
                <div>
                  <h3>{group.category}</h3>
                  <span>已选 {selectedInGroup} / 可安装 {selectable.length}</span>
                </div>
              </header>
              <div className="package-skill-list">
                {group.skills.map((skill) => {
                  const checked = selectedIds.has(skill.id);
                  return (
                    <label
                      key={skill.id}
                      className={[
                        "package-skill-row",
                        checked ? "selected" : "",
                        skill.exists ? "disabled" : "",
                      ].filter(Boolean).join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={skill.exists}
                        onChange={() => onToggleSkill(skill)}
                      />
                      <div className="package-skill-main">
                        <div>
                          <strong>{skill.displayName || skill.name}</strong>
                          <span>
                            {skill.exists
                              ? "已安装"
                              : skill.itemKind === "bundle"
                                ? `${skill.memberCount} 个成员`
                                : "可安装"}
                          </span>
                        </div>
                        <p>{skill.description || "暂无说明"}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function StartupFallback({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <section className="startup-fallback" role="alert">
      <AlertTriangle size={22} />
      <div>
        <h1>本地状态没有读取成功</h1>
        <p>{error ? cleanErrorMessage(error) : "应用暂时没有拿到技能、Agent 和项目状态。"}</p>
        <p>优先检查 <code>~/.skills-manager</code> 目录权限，或直接刷新重试。</p>
        <button type="button" className="primary-button" onClick={onRetry}>
          <RefreshCw size={16} />
          刷新重试
        </button>
      </div>
    </section>
  );
}

function StatusFilterBar({
  value,
  options,
  onChange,
}: {
  value: StatusFilter;
  options: Array<{ id: StatusFilter; label: string; count: number }>;
  onChange: (filter: StatusFilter) => void;
}) {
  return (
    <div className="status-filter-bar" aria-label="状态筛选">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={value === option.id ? "active" : ""}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          <span>{option.count}</span>
        </button>
      ))}
    </div>
  );
}

function SkillList({
  skills,
  selectedId,
  checkedIds,
  onToggleCheck,
  onSelect,
  onDeploy,
  onOpen,
  onDelete,
  emptyTitle = "没有匹配的技能",
  emptyDescription,
  emptyAction,
  emptyOnAction,
}: {
  skills: Skill[];
  selectedId: string | null;
  checkedIds: Set<string>;
  onToggleCheck: (skillId: string) => void;
  onSelect: (skill: Skill) => void;
  onDeploy: (skill: Skill) => void;
  onOpen: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: string;
  emptyOnAction?: () => void;
}) {
  if (!skills.length) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
        onAction={emptyOnAction}
      />
    );
  }
  return (
    <div className="rows">
      {skills.map((skill) => (
        <div
          key={skill.id}
          className={selectedId === skill.id ? "row skill-row selected" : "row skill-row"}
        >
          <button
            type="button"
            className="row-check-button"
            aria-checked={checkedIds.has(skill.id)}
            aria-label={`${checkedIds.has(skill.id) ? "取消选择" : "选择"} ${skill.displayName}`}
            role="checkbox"
            onClick={() => onToggleCheck(skill.id)}
          >
            {checkedIds.has(skill.id) ? <CheckCircle2 size={16} /> : <Circle size={16} />}
          </button>
          <button type="button" className="row-content-button" onClick={() => onSelect(skill)}>
            <span className="row-main">
              <strong>{skill.displayName}</strong>
              <small title={skill.description}>{skill.description}</small>
              {skill.tags.length ? (
                <span className="row-tags">
                  {skill.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                  {skill.tags.length > 3 ? <span>+{skill.tags.length - 3}</span> : null}
                </span>
              ) : null}
            </span>
          </button>
          <div className="skill-row-trailing">
            <span className="row-meta">
              {skill.issueCount ? <span className="mini-warn">{skill.issueCount} 个问题</span> : null}
              <span>{skill.enabledCount} 处启用</span>
            </span>
            <div className="skill-card-actions" aria-label={`${skill.displayName} 操作`}>
              <button
                type="button"
                className="compact-action primary"
                onClick={() => onDeploy(skill)}
                title="使用"
              >
                <Link2 size={14} />
                <span>使用</span>
              </button>
              <button
                type="button"
                className="icon-button micro"
                onClick={() => onOpen(skill)}
                aria-label={`打开 ${skill.displayName} 本地路径`}
                title="打开本地路径"
              >
                <ExternalLink size={14} />
              </button>
              <button
                type="button"
                className="icon-button micro danger"
                onClick={() => onDelete(skill)}
                aria-label={`删除 ${skill.displayName}`}
                title="删除"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusList({
  statuses,
  selectedId,
  onSelect,
}: {
  statuses: TargetStatus[];
  selectedId: string | null;
  onSelect: (status: TargetStatus) => void;
}) {
  if (!statuses.length) {
    return <EmptyState title="没有匹配的应用状态" />;
  }
  return (
    <div className="rows">
      {statuses.map((status) => (
        <button
          key={status.id}
          className={selectedId === status.id ? "row selected" : "row"}
          onClick={() => onSelect(status)}
        >
          <span className="row-main">
            <strong>{status.displayName}</strong>
            <small>{status.targetPath}</small>
          </span>
          <span className="row-meta">
            <StatusPill status={status.status} />
          </span>
        </button>
      ))}
    </div>
  );
}

function parseTransferDragPayload(dataTransfer: DataTransfer): TransferDragPayload | null {
  const rawPayload = dataTransfer.getData(TRANSFER_DRAG_MIME_TYPE);
  if (!rawPayload) return null;
  try {
    const payload = JSON.parse(rawPayload) as Partial<TransferDragPayload>;
    if (typeof payload.id === "string" && isTransferColumnKey(payload.column)) {
      return { id: payload.id, column: payload.column };
    }
  } catch {
    return null;
  }
  return null;
}

function isTransferColumnKey(value: unknown): value is TransferColumnKey {
  return value === "available" || value === "applied";
}

function SkillTransferView({
  appliedItems,
  availableItems,
  selectedId,
  expandedPresetIds,
  onSelect,
  onTogglePreset,
  onMove,
  working,
}: {
  appliedItems: TransferItem[];
  availableItems: TransferItem[];
  selectedId: string | null;
  expandedPresetIds: Set<string>;
  onSelect: (item: TransferItem) => void;
  onTogglePreset: (presetId: string) => void;
  onMove: (item: TransferItem, targetColumn: TransferColumnKey) => Promise<void>;
  working: boolean;
}) {
  const draggedRef = useRef<{ item: TransferItem; column: TransferColumnKey } | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<TransferColumnKey | null>(null);
  const allTransferItems = useMemo(
    () => [...availableItems, ...appliedItems].flatMap((item) => [item, ...(item.children ?? [])]),
    [appliedItems, availableItems],
  );
  const selectedItem = allTransferItems.find((item) => item.id === selectedId) ?? null;

  function startDrag(item: TransferItem, column: TransferColumnKey) {
    draggedRef.current = { item, column };
    setDraggedColumn(column);
  }

  function clearDrag() {
    draggedRef.current = null;
    setDraggedColumn(null);
  }

  function resolveDragged(dataTransfer: DataTransfer) {
    if (draggedRef.current) return draggedRef.current;
    const payload = parseTransferDragPayload(dataTransfer);
    if (!payload) return null;
    const item = allTransferItems.find((nextItem) => nextItem.id === payload.id) ?? null;
    return item ? { item, column: payload.column } : null;
  }

  function canDropTo(column: TransferColumnKey, event: DragEvent<HTMLElement>) {
    if (working) return false;
    const dropped = resolveDragged(event.dataTransfer);
    return Boolean(dropped && dropped.column !== column && canMoveTransferItem(dropped.item, column));
  }

  function dropTo(column: TransferColumnKey, event: DragEvent<HTMLElement>) {
    const dropped = resolveDragged(event.dataTransfer);
    if (!dropped || dropped.column === column) {
      clearDrag();
      return;
    }
    const item = dropped.item;
    clearDrag();
    void onMove(item, column);
  }

  return (
    <div className="transfer-workbench">
      <SkillTransferColumn
        title="未应用 Skill"
        description="技能列表中还没有应用到当前对象的 Skill"
        column="available"
        items={availableItems}
        selectedId={selectedId}
        expandedPresetIds={expandedPresetIds}
        draggedColumn={draggedColumn}
        onSelect={onSelect}
        onTogglePreset={onTogglePreset}
        onMove={onMove}
        onCanDrop={canDropTo}
        onDragStart={startDrag}
        onDragEnd={clearDrag}
        onDrop={dropTo}
      />
      <div className="transfer-action-bar" aria-label="应用和收回 Skill">
        <button
          type="button"
          className="icon-button transfer-apply-button"
          disabled={working || !selectedItem || !canApplyTransferItem(selectedItem)}
          onClick={() => selectedItem && void onMove(selectedItem, "applied")}
          aria-label="应用选中的 Skill"
          title="应用选中的 Skill"
        >
          <ArrowRight size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={working || !selectedItem || !canWithdrawTransferItem(selectedItem)}
          onClick={() => selectedItem && void onMove(selectedItem, "available")}
          aria-label="收回选中的 Skill"
          title="收回选中的 Skill"
        >
          <ArrowLeft size={17} />
        </button>
      </div>
      <SkillTransferColumn
        title="已应用 Skill"
        description="当前对象已关联或正在生效的 Skill"
        column="applied"
        items={appliedItems}
        selectedId={selectedId}
        expandedPresetIds={expandedPresetIds}
        draggedColumn={draggedColumn}
        onSelect={onSelect}
        onTogglePreset={onTogglePreset}
        onMove={onMove}
        onCanDrop={canDropTo}
        onDragStart={startDrag}
        onDragEnd={clearDrag}
        onDrop={dropTo}
      />
    </div>
  );
}

function SkillTransferColumn({
  title,
  description,
  column,
  items,
  selectedId,
  expandedPresetIds,
  draggedColumn,
  onSelect,
  onTogglePreset,
  onMove,
  onCanDrop,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  title: string;
  description: string;
  column: TransferColumnKey;
  items: TransferItem[];
  selectedId: string | null;
  expandedPresetIds: Set<string>;
  draggedColumn: TransferColumnKey | null;
  onSelect: (item: TransferItem) => void;
  onTogglePreset: (presetId: string) => void;
  onMove: (item: TransferItem, targetColumn: TransferColumnKey) => Promise<void>;
  onCanDrop: (column: TransferColumnKey, event: DragEvent<HTMLElement>) => boolean;
  onDragStart: (item: TransferItem, column: TransferColumnKey) => void;
  onDragEnd: () => void;
  onDrop: (column: TransferColumnKey, event: DragEvent<HTMLElement>) => void;
}) {
  const isDropTarget = Boolean(draggedColumn && draggedColumn !== column);
  return (
    <section
      className={[
        "transfer-column",
        `transfer-column-${column}`,
        isDropTarget ? "drop-target" : "",
      ].filter(Boolean).join(" ")}
      onDragOver={(event) => {
        if (!onCanDrop(column, event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!onCanDrop(column, event)) return;
        event.preventDefault();
        onDrop(column, event);
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
        <strong>{items.length}</strong>
      </header>
      {items.length ? (
        <div className="transfer-rows">
          {items.map((item) => {
            const expanded = Boolean(item.presetId && expandedPresetIds.has(item.presetId));
            return (
              <div key={item.id} className="transfer-row-block">
                <SkillTransferRow
                  item={item}
                  selected={selectedId === item.id}
                  column={column}
                  expanded={expanded}
                  onSelect={onSelect}
                  onTogglePreset={onTogglePreset}
                  onMove={onMove}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
                {item.kind === "composition" && expanded && item.children?.length ? (
                  <div className="transfer-child-rows">
                    {item.children.map((child) => (
                      <SkillTransferRow
                        key={child.id}
                        item={child}
                        selected={selectedId === child.id}
                        column={column}
                        nested
                        expanded={false}
                        onSelect={onSelect}
                        onTogglePreset={onTogglePreset}
                        onMove={onMove}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title={column === "applied" ? "当前没有已应用 Skill" : "当前没有未应用 Skill"} />
      )}
    </section>
  );
}

function SkillTransferRow({
  item,
  selected,
  column,
  nested = false,
  expanded,
  onSelect,
  onTogglePreset,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  item: TransferItem;
  selected: boolean;
  column: TransferColumnKey;
  nested?: boolean;
  expanded: boolean;
  onSelect: (item: TransferItem) => void;
  onTogglePreset: (presetId: string) => void;
  onMove: (item: TransferItem, targetColumn: TransferColumnKey) => Promise<void>;
  onDragStart: (item: TransferItem, column: TransferColumnKey) => void;
  onDragEnd: () => void;
}) {
  const targetColumn = column === "available" ? "applied" : "available";
  const canMove = canMoveTransferItem(item, targetColumn);
  const secondaryMeta = item.kind === "composition"
    ? `${item.enabledCount}/${item.memberCount} 技能`
    : item.targetCount > 1
      ? `${item.enabledCount}/${item.targetCount} Agent`
      : null;
  const showStatusPill = item.status !== "disabled" && item.status !== "enabled";

  return (
    <button
      type="button"
      className={[
        "transfer-row",
        item.kind === "composition" ? "composition-row" : "",
        nested ? "nested-transfer-row" : "",
        selected ? "selected" : "",
        canMove ? "" : "not-draggable",
      ].filter(Boolean).join(" ")}
      draggable={canMove}
      onClick={() => {
        onSelect(item);
        if (item.kind === "composition" && item.presetId) onTogglePreset(item.presetId);
      }}
      onDoubleClick={() => {
        if (canMove) void onMove(item, targetColumn);
      }}
      onDragStart={(event) => {
        if (!canMove) {
          event.preventDefault();
          return;
        }
        const payload: TransferDragPayload = { id: item.id, column };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(TRANSFER_DRAG_MIME_TYPE, JSON.stringify(payload));
        event.dataTransfer.setData("text/plain", item.id);
        onDragStart(item, column);
      }}
      onDragEnd={onDragEnd}
    >
      <span className="transfer-row-main">
        <span className="transfer-row-title">
          {item.kind === "composition" ? (
            <span className="transfer-row-disclosure" aria-hidden="true">
              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </span>
          ) : null}
          <strong>{item.displayName}</strong>
        </span>
        <small>{item.description || item.skillName}</small>
      </span>
      {showStatusPill || secondaryMeta ? (
        <span className="transfer-row-side">
          {showStatusPill ? <StatusPill status={item.status} /> : null}
          {secondaryMeta ? <small>{secondaryMeta}</small> : null}
        </span>
      ) : null}
      <TransferRowHint item={item} />
    </button>
  );
}

function TransferRowHint({ item }: { item: TransferItem }) {
  if (item.kind === "composition" && item.missingCount > 0) {
    return <small className="transfer-row-hint">有 {item.missingCount} 个成员缺失，应用时会跳过</small>;
  }
  const issue = item.statuses.find((status) =>
    status.issue && (status.status !== "pathMissing" || item.blockingPathCount > 0)
  )?.issue;
  if (issue) {
    return <small className="transfer-row-hint">{issue}</small>;
  }
  if (item.status === "partial") {
    return <small className="transfer-row-hint">部分 Agent 已应用，可继续补齐</small>;
  }
  return null;
}

function ImportExistingToolbar({
  statuses,
  onImport,
}: {
  statuses: TargetStatus[];
  onImport: (statuses: TargetStatus[]) => void;
}) {
  const unmanaged = statuses.filter((status) => status.status === "unmanaged");
  if (!unmanaged.length) return null;
  return (
    <div className="list-toolbar import-toolbar">
      <span>{unmanaged.length} 个存量技能未入库</span>
      <button className="secondary-button compact" onClick={() => onImport(unmanaged)}>
        <Archive size={16} />
        导入当前范围
      </button>
    </div>
  );
}

function PresetList({
  presets,
  totalCount,
  skills,
  selectedId,
  onSelect,
  onApply,
  onEdit,
  onDelete,
  onCreate,
  working,
}: {
  presets: Preset[];
  totalCount: number;
  skills: Skill[];
  selectedId: string | null;
  onSelect: (preset: Preset) => void;
  onApply: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onDelete: (preset: Preset) => void;
  onCreate: () => void;
  working: boolean;
}) {
  return (
    <>
      {totalCount ? (
        <div className="list-toolbar">
          <button
            className="icon-button"
            aria-label="新建技能组合"
            title="新建组合"
            onClick={onCreate}
          >
            <Plus size={16} />
          </button>
        </div>
      ) : null}
      {presets.length ? (
        <div className="rows">
          {presets.map((preset) => {
            const summary = summarizePresetMembers(preset, skills);
            const canApply = summary.availableMemberCount > 0;
            return (
              <div
                key={preset.id}
                className={["row", "preset-row", selectedId === preset.id ? "selected" : ""].filter(Boolean).join(" ")}
              >
                <span className="preset-row-icon" aria-hidden="true">
                  <Layers3 size={16} />
                </span>
                <button type="button" className="row-content-button" onClick={() => onSelect(preset)}>
                  <span className="row-main">
                    <strong>{presetDisplayName(preset)}</strong>
                    <small>{preset.description || skillNames(preset, skills) || "还没有描述"}</small>
                  </span>
                </button>
                <div className="preset-row-trailing">
                  <span className="row-meta">
                    <span>{summary.memberCount ? `${summary.memberCount} 个技能` : "空组合"}</span>
                    <span className={summary.problemCount ? "mini-warn" : undefined}>{summary.statusLabel}</span>
                  </span>
                  <div className="skill-card-actions preset-card-actions" aria-label={`${presetDisplayName(preset)} 操作`}>
                    <button
                      type="button"
                      className="compact-action primary"
                      disabled={working || !canApply}
                      onClick={() => onApply(preset)}
                      title={canApply ? "应用组合" : "空组合不能应用"}
                    >
                      <Link2 size={14} />
                      <span>应用</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button micro"
                      disabled={working}
                      onClick={() => onEdit(preset)}
                      aria-label={`编辑 ${presetDisplayName(preset)}`}
                      title="编辑"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button micro danger"
                      disabled={working}
                      onClick={() => onDelete(preset)}
                      aria-label={`删除 ${presetDisplayName(preset)}`}
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        totalCount ? (
          <EmptyState
            title="没有匹配的技能组合"
            description="换个关键词，或清空搜索后再看全部组合。"
          />
        ) : (
          <EmptyGuidance
            illustration={EMPTY_STATE_ILLUSTRATIONS.compositions}
            title="创建第一个技能组合"
            description="创建后可以把多个 Skill 组织成一个能力单元，之后一键应用到我的 Agent 或我的项目。"
            action="新建组合"
            actionIcon={<Plus size={16} />}
            onAction={onCreate}
          />
        )
      )}
    </>
  );
}

function ContextPanel({
  title,
  children,
  onClose,
  closeLabel = "关闭详情",
}: {
  title: string;
  children: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <section className="context-panel">
      <header className="context-panel-header">
        <h2>{title}</h2>
        {onClose ? (
          <button
            type="button"
            className="icon-button micro subtle"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X size={15} />
          </button>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function AgentTabs({
  agents,
  selectedId,
  onSelect,
}: {
  agents: Agent[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="segmented">
      {agents.map((agent) => (
        <button
          key={agent.id}
          className={agent.id === selectedId ? "active" : ""}
          onClick={() => onSelect(agent.id)}
        >
          {agent.name}
        </button>
      ))}
    </div>
  );
}

function ProjectSelector({
  projects,
  selectedId,
  onSelect,
  onAdd,
}: {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="project-selector">
      <select
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        aria-label="选择项目"
      >
        <option value="" disabled>
          选择项目
        </option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <button className="icon-button" onClick={onAdd} aria-label="添加项目" title="添加项目">
        <FolderPlus size={17} />
      </button>
    </div>
  );
}

function SettingsPanel({
  state,
  healthIssues,
  onPickAgent,
  onPickProject,
  onUpdateAgentPath,
  onReopenOnboarding,
  onToggleAgentEnabled,
  onRemoveAgent,
  onRemoveProject,
  onSelectHealthIssue,
}: {
  state: AppState;
  healthIssues: HealthIssue[];
  onPickAgent: () => void;
  onPickProject: () => void;
  onUpdateAgentPath: (agentId: string) => void;
  onReopenOnboarding: () => void | Promise<void>;
  onToggleAgentEnabled: (agentId: string, enabled: boolean) => void | Promise<void>;
  onRemoveAgent: (agentId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSelectHealthIssue: (issue: HealthIssue) => void;
}) {
  return (
    <div className="settings-list">
      <HealthOverview issues={healthIssues} onSelect={onSelectHealthIssue} />

      <section className="settings-section application-section">
        <div className="section-title-row">
          <div>
            <h2>应用位置</h2>
            <p>管理 Skill 会被应用到哪些 Agent 和项目。技能主库仍是唯一事实源，应用位置只保存软链接关系。</p>
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <div>
              <h3>我的 Agent</h3>
              <p>选择 Agent 的全局 Skill 目录，系统自动识别名称和项目目录规则。</p>
            </div>
            <button
              className="icon-button"
              aria-label="添加 Agent"
              title="添加 Agent"
              onClick={onPickAgent}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="settings-subsection-body">
            {state.agents.map((agent) => (
              <AgentSettingRow
                key={agent.id}
                agent={agent}
                canRemove={state.agents.length > 1}
                onPickPath={onUpdateAgentPath}
                onRemove={onRemoveAgent}
                onToggleEnabled={onToggleAgentEnabled}
              />
            ))}
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subsection-header">
            <div>
              <h3>项目</h3>
              <p>只管理手动添加的项目路径，不自动扫描本机项目。</p>
            </div>
            <button
              className="icon-button"
              aria-label="添加项目"
              title="添加项目"
              onClick={onPickProject}
            >
              <FolderPlus size={16} />
            </button>
          </div>
          <div className="settings-subsection-body">
            {state.projects.length ? (
              state.projects.map((project) => (
                <div key={project.id} className="setting-row project-setting-row">
                  <div className="setting-row-main">
                    <div>
                      <strong>{project.name}</strong>
                      <small>{project.exists ? "路径已存在" : "路径不存在"}</small>
                    </div>
                    <code>{project.path}</code>
                  </div>
                  <div className="setting-row-actions">
                    <button
                      className="icon-button danger"
                      aria-label={`移除项目 ${project.name}`}
                      title="移除项目"
                      onClick={() => onRemoveProject(project.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState title="还没有手动添加的项目" action="添加项目" onAction={onPickProject} />
            )}
          </div>
        </div>
      </section>

      <section className="settings-section local-data-section">
        <div className="section-title-row">
          <div>
            <h2>本机数据</h2>
            <p>这些路径用于定位主库、配置和本地数据库；日常应用 Skill 时一般不需要改动。</p>
          </div>
        </div>
        <div className="settings-key-grid">
          <KeyValue label="主库路径" value={state.skillsRoot} />
          <KeyValue label="数据库" value={state.databasePath} />
          <KeyValue label="配置文件" value={state.configPath} />
        </div>
        <div className="settings-actions">
          <button
            className="icon-button"
            aria-label="打开主库目录"
            title="打开主库目录"
            onClick={() => void openPath(state.baseDir)}
          >
            <ExternalLink size={16} />
          </button>
          <button
            className="icon-button subtle"
            aria-label="重新打开初始化引导"
            title="重新打开初始化引导"
            onClick={() => void onReopenOnboarding()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

function AgentSettingRow({
  agent,
  canRemove,
  onPickPath,
  onRemove,
  onToggleEnabled,
}: {
  agent: Agent;
  canRemove: boolean;
  onPickPath: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onToggleEnabled: (agentId: string, enabled: boolean) => void | Promise<void>;
}) {
  return (
    <div className={`setting-row agent-setting-row ${agent.enabled ? "" : "is-disabled"}`}>
      <div className="setting-row-main">
        <div>
          <strong>{agent.name}</strong>
          <small>
            {agent.enabled ? (agent.pathExists ? "已启用 · 全局目录已识别" : "已启用 · 全局目录不存在") : "已停用"}
          </small>
        </div>
        <div className="setting-path-grid">
          <span>全局目录</span>
          <code>{agent.globalPath}</code>
          <span>项目目录规则</span>
          <code>{"<项目根目录>/"}{agent.projectRelativePath}</code>
        </div>
      </div>
      <div className="setting-row-actions">
        <label className="agent-enable-toggle">
          <input
            type="checkbox"
            checked={agent.enabled}
            onChange={(event) => void onToggleEnabled(agent.id, event.target.checked)}
          />
          <span>{agent.enabled ? "已启用" : "已停用"}</span>
        </label>
        <button
          className="icon-button"
          aria-label={`重新选择 ${agent.name} 目录`}
          title="重新选择目录"
          onClick={() => onPickPath(agent.id)}
        >
          <FolderPlus size={16} />
        </button>
        <button
          className="icon-button danger"
          disabled={!canRemove}
          aria-label={`移除 Agent ${agent.name}`}
          title="移除 Agent"
          onClick={() => onRemove(agent.id)}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function IssueResolutionDrawer({
  issue,
  working,
  onClose,
  onIgnore,
  onResolve,
  onOpenStatus,
}: {
  issue: HealthIssue;
  working: boolean;
  onClose: () => void;
  onIgnore: (statuses: TargetStatus[]) => void;
  onResolve: (statuses: TargetStatus[]) => void;
  onOpenStatus: (status: TargetStatus) => void;
}) {
  const drawerRef = useDialogFocus<HTMLElement>(onClose);
  const statuses = issue.statuses;
  const canResolve = issue.kind === "broken" || issue.kind === "unmanaged" || issue.kind === "conflict";
  const title = issue.kind === "broken" ? "处理失效链接" : `处理${issue.label}`;
  const resolveLabel: Record<HealthIssueKind, string> = {
    broken: "处理全部",
    unmanaged: "导入全部",
    conflict: "覆盖全部",
    pathMissing: "处理全部",
    invalid: "处理全部",
  };
  const description = (() => {
    if (issue.kind === "broken") return "这些链接指向的 Skill 已经不存在。可以忽略它们，也可以删除这些失效链接。";
    if (issue.kind === "unmanaged") return "这些目标位置已有 Skill，但尚未进入主库。可以导入主库，或忽略本次提醒。";
    if (issue.kind === "conflict") return "这些目标位置有同名内容。可以用主库版本覆盖目标，或先查看具体位置。";
    return "这个问题暂时需要人工确认。可以先查看位置，或忽略同一问题的后续提醒。";
  })();

  return (
    <div className="drawer-backdrop">
      <aside
        ref={drawerRef}
        className="drawer issue-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="issue-drawer-title"
      >
        <header>
          <div>
            <span>问题处理</span>
            <h2 id="issue-drawer-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={17} />
          </button>
        </header>

        <p className="drawer-description">{description}</p>

        <div className="issue-drawer-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={working || !statuses.length}
            onClick={() => onIgnore(statuses)}
          >
            忽略全部
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={working || !canResolve || !statuses.length}
            onClick={() => onResolve(statuses)}
          >
            {issue.kind === "unmanaged" ? <Archive size={16} /> : issue.kind === "conflict" ? <RefreshCw size={16} /> : <Trash2 size={16} />}
            {resolveLabel[issue.kind]}
          </button>
        </div>

        <div className="issue-list">
          {statuses.map((status) => (
            <div key={status.issueKey ?? status.id} className="issue-row">
              <div className="issue-row-main">
                <strong>{status.displayName || status.skillName}</strong>
                <span>{status.projectName ? `${status.projectName} / ` : ""}{status.agentName}</span>
                <small>{status.issue || status.description || issue.summary}</small>
                <code>{status.targetPath}</code>
                {status.linkTarget ? <code>{status.linkTarget}</code> : null}
              </div>
              <div className="issue-row-actions">
                <button
                  type="button"
                  className="ghost-button compact"
                  disabled={working}
                  onClick={() => onOpenStatus(status)}
                >
                  查看
                </button>
                <button
                  type="button"
                  className="secondary-button compact"
                  disabled={working}
                  onClick={() => onIgnore([status])}
                >
                  忽略
                </button>
                <button
                  type="button"
                  className="primary-button compact"
                  disabled={working || !canResolve}
                  onClick={() => onResolve([status])}
                >
                  {status.status === "unmanaged" ? "导入" : status.status === "conflict" ? "覆盖" : "处理"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function DistributionDrawer({
  state,
  drawer,
  onClose,
  onApply,
  onWithdraw,
}: {
  state: AppState;
  drawer: DrawerState;
  onClose: () => void;
  onApply: (targets: DeployTarget[], overwrite: boolean) => Promise<void>;
  onWithdraw: (targets: DeployTarget[]) => Promise<void>;
}) {
  const drawerRef = useDialogFocus<HTMLElement>(onClose);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const isPreset = drawer?.type === "preset";
  const preset = drawer?.type === "preset"
    ? state.presets.find((item) => item.id === drawer.presetId) ?? null
    : null;
  const drawerSkillIds = drawer?.type === "skill" ? drawer.skillIds : preset?.skillIds ?? [];
  const drawerSkills = drawerSkillIds
    .map((skillId) => state.skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is Skill => Boolean(skill));
  const missingSkillCount = Math.max(drawerSkillIds.length - drawerSkills.length, 0);
  const title =
    drawer?.type === "preset"
      ? `应用组合：${preset ? presetDisplayName(preset) : ""}`
      : `分发技能：${drawer?.skillIds.length ?? 0} 个`;

  const targetRows = [
    ...state.agents.map((agent) => ({
      key: `global:${agent.id}`,
      label: `${agent.name} / 全局`,
      path: agent.globalPath,
      target: { agentId: agent.id, projectId: null },
      scopeMissing: false,
    })),
    ...state.projects.flatMap((project) =>
      state.agents.map((agent) => ({
        key: `project:${project.id}:${agent.id}`,
        label: `${project.name} / ${agent.name}`,
        path: `${project.path}/${agent.projectRelativePath}`,
        target: { agentId: agent.id, projectId: project.id },
        scopeMissing: !project.exists,
      })),
    ),
  ].map((row) => {
    const statuses = drawerSkillIds
      .map((skillId) => findTargetStatus(state, row.target.agentId, row.target.projectId ?? null, skillId))
      .filter((status): status is TargetStatus => Boolean(status));
    const displayStatuses = statuses.map((status) =>
      status.status === "pathMissing" && !row.scopeMissing
        ? { ...status, status: "disabled" as SkillStatus }
        : status,
    );
    const statusLabel = summarizeTargetStatuses(displayStatuses, drawerSkillIds.length);
    const hasOverwriteRisk = statuses.some((status) => isOverwriteRiskStatus(status.status));
    const hasPathMissing = statuses.some((status) => status.status === "pathMissing");
    const hasBlockingPathRisk = row.scopeMissing && hasPathMissing;
    const hasPathRisk = statuses.some((status) => status.status === "broken" || status.status === "invalid")
      || hasBlockingPathRisk;
    const skillLabel = drawerSkills.length === 1
      ? drawerSkills[0].displayName
      : `${drawerSkillIds.length} 个技能`;
    return {
      ...row,
      finalPath: drawerSkills.length === 1
        ? `${row.path}/${drawerSkills[0].name} -> ${drawerSkills[0].path}`
        : `${row.path}/{skill-name} -> ${state.skillsRoot}/{skill-name}`,
      resultLabel: `将 ${skillLabel} 启用到 ${row.label}`,
      riskLabel: hasOverwriteRisk
        ? "需要覆盖目标同名内容"
        : hasBlockingPathRisk
          ? "项目路径不存在，需先修复"
          : hasPathRisk
            ? "目标路径存在异常"
            : "可直接创建软链接",
      statusLabel,
      hasOverwriteRisk,
      hasBlockingPathRisk,
      hasPathRisk,
    };
  });

  function toggle(key: string) {
    setSelectedTargets((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const targets = targetRows
    .filter((row) => selectedTargets.has(row.key))
    .map((row) => row.target);

  const selectedRows = targetRows.filter((row) => selectedTargets.has(row.key));
  const selectedOverwriteRisks = selectedRows.filter((row) => row.hasOverwriteRisk).length;
  const selectedPathRisks = selectedRows.filter((row) => row.hasPathRisk).length;
  const selectedBlockingPathRisks = selectedRows.filter((row) => row.hasBlockingPathRisk).length;
  const shouldOverwrite = selectedOverwriteRisks + selectedPathRisks > 0;
  const selectedRiskCount = selectedOverwriteRisks + selectedPathRisks;
  const previewRows = selectedRows.slice(0, 3);
  const canApply = Boolean(targets.length && drawerSkills.length && selectedBlockingPathRisks === 0);

  return (
    <div className="drawer-backdrop">
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="distribution-title"
      >
        <header>
          <div>
            <h2 id="distribution-title">{title}</h2>
            <span>选择要启用的全局或项目位置</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="drawer-list">
          {targetRows.map((row) => (
            <button
              key={row.key}
              className={selectedTargets.has(row.key) ? "target-row selected" : "target-row"}
              aria-pressed={selectedTargets.has(row.key)}
              onClick={() => toggle(row.key)}
            >
              {selectedTargets.has(row.key) ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              <span>
                <strong>{row.label}</strong>
                <small className="target-result">{row.resultLabel}</small>
                <small className={row.hasOverwriteRisk || row.hasPathRisk ? "target-risk" : "target-status"}>
                  当前：{row.statusLabel} · {row.riskLabel}
                </small>
                <code>{row.finalPath}</code>
              </span>
            </button>
          ))}
        </div>
        <div className={selectedRiskCount ? "preflight-box warn" : "preflight-box"}>
          <div className="preflight-summary">
            {selectedRiskCount ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <strong>分发预检</strong>
            <span>已选 {targets.length} 个目标</span>
            <span>会覆盖 {selectedOverwriteRisks} 个</span>
            <span>异常路径 {selectedPathRisks} 个</span>
            {missingSkillCount ? <span>缺失成员 {missingSkillCount} 个</span> : null}
          </div>
          {previewRows.length ? (
            <div className="preflight-paths">
              {previewRows.map((row) => (
                <code key={row.key}>{row.finalPath}</code>
              ))}
              {selectedRows.length > previewRows.length ? (
                <small>另有 {selectedRows.length - previewRows.length} 个目标将在确认后处理</small>
              ) : null}
            </div>
          ) : (
            <p>选择目标后会在这里展示最终软链接路径。</p>
          )}
          <p>
            确认后只创建或更新目标软链接，不会修改主库内容
            {selectedBlockingPathRisks
              ? "；项目路径不存在的位置需要先在设置里修复。"
              : selectedRiskCount
                ? "；冲突位置会按技能列表优先处理。"
                : missingSkillCount
                  ? "；缺失成员会跳过。"
                  : "。"}
          </p>
        </div>
        <footer>
          {isPreset ? (
            <button
              className="icon-button"
              disabled={!targets.length}
              aria-label="收回组合"
              title="收回组合"
              onClick={() => void onWithdraw(targets)}
            >
              <Unlink size={16} />
            </button>
          ) : null}
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={!canApply} onClick={() => void onApply(targets, shouldOverwrite)}>
            <Link2 size={16} />
            {isPreset ? (shouldOverwrite ? "覆盖并应用" : "应用组合") : shouldOverwrite ? "覆盖并分发" : "确认分发"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function ImportSkillDialog({
  onClose,
  onPickLocal,
  working,
}: {
  onClose: () => void;
  onPickLocal: (sourceKind: "folder" | "zip") => void;
  working: boolean;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog import-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-skill-title"
      >
        <header>
          <h2 id="import-skill-title">导入技能</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="import-dropzone" aria-describedby="local-import-note local-import-detail">
          <span className="import-dropzone-icon" aria-hidden="true">
            <Upload size={24} />
          </span>
          <strong>点击选择技能文件夹或 .zip</strong>
          <span id="local-import-note">文件夹需包含 SKILL.md；.zip 可包含单个或多个技能</span>
          <small id="local-import-detail">导入后进入主库，不会自动分发</small>
          <div className="import-dropzone-actions">
            <button type="button" className="secondary-button" disabled={working} onClick={() => onPickLocal("folder")}>
              <FolderPlus size={15} />
              选择文件夹
            </button>
            <button type="button" className="primary-button" disabled={working} onClick={() => onPickLocal("zip")}>
              <Archive size={15} />
              选择 .zip
            </button>
          </div>
        </div>
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
        </footer>
      </div>
    </div>
  );
}

function PresetDialog({
  draft,
  skills,
  onClose,
  onSubmit,
}: {
  draft: PresetDraft;
  skills: Skill[];
  onClose: () => void;
  onSubmit: (draft: PresetDraft) => void;
}) {
  const [next, setNext] = useState(draft);
  const [skillQuery, setSkillQuery] = useState("");
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose);
  const selectableSkills = skills.filter((skill) =>
    matchesQuery(skillQuery, [skill.displayName, skill.name, skill.description, skill.path, ...skill.tags]),
  );
  const trimmedName = next.name.trim();
  const nameError = trimmedName ? "" : "组合名称不能为空";

  function toggle(skillId: string) {
    setNext((current) => ({
      ...current,
      skillIds: current.skillIds.includes(skillId)
        ? current.skillIds.filter((id) => id !== skillId)
        : [...current.skillIds, skillId],
    }));
  }

  return (
    <div className="dialog-backdrop">
      <form
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preset-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (nameError) return;
          onSubmit({
            ...next,
            name: trimmedName,
            description: next.description.trim(),
          });
        }}
      >
        <header>
          <h2 id="preset-dialog-title">{draft.id ? "编辑技能组合" : "新建技能组合"}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <label>
          组合名称
          <input
            value={next.name}
            onChange={(event) => setNext({ ...next, name: event.target.value })}
            required
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? "preset-name-error" : undefined}
          />
          {nameError ? <p id="preset-name-error" className="field-error">{nameError}</p> : null}
        </label>
        <label>
          描述
          <textarea
            value={next.description}
            onChange={(event) => setNext({ ...next, description: event.target.value })}
          />
        </label>
        <label>
          搜索成员
          <input
            value={skillQuery}
            onChange={(event) => setSkillQuery(event.target.value)}
            placeholder="搜索技能名称、描述或路径"
          />
        </label>
        <div className="preset-skill-picker">
          {selectableSkills.map((skill) => (
            <button
              type="button"
              key={skill.id}
              className={next.skillIds.includes(skill.id) ? "target-row selected" : "target-row"}
              onClick={() => toggle(skill.id)}
            >
              {next.skillIds.includes(skill.id) ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              <span>
                <strong>{skill.displayName}</strong>
                <small>{skill.description}</small>
              </span>
            </button>
          ))}
          {!selectableSkills.length ? (
            <EmptyState
              title={skills.length ? "没有匹配的技能" : "技能列表里还没有技能"}
              description={skills.length ? "换个关键词后再选择成员。" : "先导入技能，再把它们加入组合。"}
            />
          ) : null}
        </div>
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" disabled={Boolean(nameError)}>
            保存
          </button>
        </footer>
      </form>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  working,
  onCancel,
  onConfirm,
}: {
  dialog: NonNullable<ConfirmDialogState>;
  working: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel);
  return (
    <div className="dialog-backdrop">
      <div
        ref={dialogRef}
        className="dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <header>
          <h2 id="confirm-dialog-title">{dialog.title}</h2>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="confirm-body">
          <p>{dialog.message}</p>
          {dialog.details?.length ? (
            <div className="confirm-details">
              {dialog.details.map((detail) => (
                <code key={detail}>{detail}</code>
              ))}
            </div>
          ) : null}
        </div>
        <footer>
          <button type="button" className="ghost-button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={dialog.tone === "danger" ? "danger-button" : "primary-button"}
            disabled={working}
            onClick={() => void onConfirm()}
          >
            {dialog.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function ToastViewport({
  items,
}: {
  items: Array<{ id: string; tone: "success" | "error"; text: string }>;
}) {
  if (!items.length) return null;
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      {items.map((item) => {
        const Icon = item.tone === "success" ? CheckCircle2 : AlertTriangle;
        return (
          <div key={item.id} className={`toast ${item.tone}`} role={item.tone === "error" ? "alert" : "status"}>
            <Icon size={15} />
            <span>{item.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: TransferStatus }) {
  return (
    <span className={`status-pill ${transferStatusTone[status]}`}>
      <span />
      {transferStatusText[status]}
    </span>
  );
}

type DetailTone = "good" | "warn" | "danger" | "muted" | "note";

function DetailBadge({ tone, children }: { tone: DetailTone; children: React.ReactNode }) {
  return (
    <span className={`detail-badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DetailMeta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-meta-row">
      <span>{label}</span>
      <div className="detail-meta-value">{children}</div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function TransferStatusDetails({ item }: { item: TransferItem }) {
  const issueStatuses = item.statuses.filter((status) =>
    status.issue && (status.status !== "pathMissing" || item.blockingPathCount > 0)
  );
  const pathRows = item.statuses.slice(0, 4);
  return (
    <div className="transfer-detail-block">
      {issueStatuses.length ? (
        <InlineWarning text={`${issueStatuses.length} 个目标需要处理：${issueStatuses[0].issue}`} />
      ) : null}
      <div className="transfer-detail-list">
        {pathRows.map((status) => (
          <div key={status.id} className="transfer-detail-row">
            <div>
              <strong>{status.projectName ? `${status.projectName} / ${status.agentName}` : status.agentName}</strong>
              <small>{status.issue ?? statusText[status.status]}</small>
            </div>
            <StatusPill status={status.status} />
            <InlinePathDisclosure path={status.targetPath} />
          </div>
        ))}
        {item.statuses.length > pathRows.length ? (
          <p className="muted-text">另有 {item.statuses.length - pathRows.length} 个目标位置。</p>
        ) : null}
      </div>
    </div>
  );
}

function TagRow({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="tag-row">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  );
}

function InlinePathDisclosure({ path }: { path: string }) {
  return (
    <details className="inline-path-disclosure">
      <summary aria-label="查看路径" title="查看路径">
        <ChevronRight className="summary-icon summary-closed" size={14} />
        <ChevronDown className="summary-icon summary-open" size={14} />
        <span className="visually-hidden">查看路径</span>
      </summary>
      <code>{path}</code>
    </details>
  );
}

function PathDisclosure({ title, rows }: { title: string; rows: Array<{ label: string; path: string }> }) {
  if (!rows.length) return null;
  return (
    <details className="path-disclosure">
      <summary>
        <ChevronRight className="summary-icon summary-closed" size={14} />
        <ChevronDown className="summary-icon summary-open" size={14} />
        <span>{title}</span>
      </summary>
      <div className="path-disclosure-list">
        {rows.map((row) => (
          <div key={`${row.label}:${row.path}`}>
            <span>{row.label}</span>
            <code>{row.path}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

function SkillPreview({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false);
  const preview = trimMarkdownPreview(skill.contentPreview, expanded ? 4_000 : 1_200);
  const canExpand = skill.contentPreview.length > preview.length;

  return (
    <div className="markdown-preview">
      <div className="preview-title-row">
        <h3>SKILL.md 正文预览</h3>
        {canExpand || expanded ? (
          <button
            type="button"
            className="icon-button micro"
            aria-label={expanded ? "收起正文预览" : "展开正文预览"}
            title={expanded ? "收起" : "展开"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : null}
      </div>
      {skill.contentPreview ? (
        <>
          <div className={expanded ? "markdown-preview-body expanded" : "markdown-preview-body"}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
          {canExpand && !expanded ? (
            <p className="preview-note">已隐藏后续正文，展开后可继续查看摘要内容。</p>
          ) : null}
        </>
      ) : (
        <p className="muted-text">没有可预览内容</p>
      )}
    </div>
  );
}

function EnabledLocations({ statuses }: { statuses: TargetStatus[] }) {
  return (
    <div className="enabled-list">
      <h3>启用位置</h3>
      {statuses.length ? (
        statuses.map((status) => (
          <div key={status.id} className="location-row">
            <div>
              <strong>{status.projectName ? `${status.projectName} / ${status.agentName}` : `${status.agentName} / 全局`}</strong>
              <small>{statusText[status.status]}</small>
            </div>
            <InlinePathDisclosure path={status.targetPath} />
          </div>
        ))
      ) : (
        <p className="empty-inline">还没有启用位置。下一步可以在技能卡片上点击「使用」选择 Agent 或项目。</p>
      )}
    </div>
  );
}

type PresetMemberRow = {
  id: string;
  skill: Skill | null;
};

function PresetMemberList({ members }: { members: PresetMemberRow[] }) {
  if (!members.length) {
    return <p className="empty-inline">还没有成员。下一步可以点击「编辑」选择技能。</p>;
  }
  return (
    <div className="preset-member-list">
      {members.map((member) => {
        const state = getPresetMemberState(member);
        const MemberIcon = state.icon;
        return (
          <div key={member.id} className={`preset-member-row ${state.tone}`}>
            <MemberIcon size={16} />
            <div className="preset-member-main">
              <strong>{member.skill?.displayName ?? member.id}</strong>
              <small>{member.skill?.description || member.skill?.name || "已不在技能列表中"}</small>
            </div>
            <span>{state.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProblemBox({ issues }: { issues: string[] }) {
  if (!issues.length) {
    return (
      <div className="problem-box clean">
        <CheckCircle2 size={16} />
        当前没有发现冲突或失效链接
      </div>
    );
  }
  return (
    <div className="problem-box">
      <AlertTriangle size={16} />
      <div>
        <strong>当前问题</strong>
        {issues.slice(0, 6).map((issue) => (
          <p key={issue}>{issue}</p>
        ))}
      </div>
    </div>
  );
}

function InlineWarning({ text }: { text: string }) {
  return (
    <div className="inline-warning">
      <AlertTriangle size={16} />
      {text}
    </div>
  );
}

function EmptyGuidance({
  illustration,
  title,
  description,
  action,
  actionIcon,
  onAction,
}: {
  illustration: string;
  title: string;
  description: string;
  action: string;
  actionIcon?: ReactNode;
  onAction: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <div className="empty-guidance">
      {!imageFailed ? (
        <img src={illustration} alt="" draggable={false} onError={() => setImageFailed(true)} />
      ) : (
        <div className="empty-guidance-mark" aria-hidden="true" />
      )}
      <div className="empty-guidance-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button type="button" className="primary-button" onClick={onAction}>
        {actionIcon}
        {action}
      </button>
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span>{title}</span>
      {description ? <small>{description}</small> : null}
      {action && onAction ? (
        <button className="secondary-button compact" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

function PresetSkillNames({ preset, skills }: { preset: Preset; skills: Skill[] }) {
  const names = preset.skillIds.map(
    (id) => skills.find((skill) => skill.id === id)?.displayName ?? id,
  );
  return (
    <div className="tag-row">
      {names.map((name) => (
        <span key={name}>{name}</span>
      ))}
    </div>
  );
}

function matchesQuery(query: string, values: string[]) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => value.toLowerCase().includes(normalized));
}

function trimMarkdownPreview(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n\n...`;
}

function buildHealthIssues(state: AppState): HealthIssue[] {
  const statuses = [
    ...state.globalWorkspaces.flatMap((workspace) => workspace.statuses),
    ...state.projectWorkspaces.flatMap((workspace) => workspace.statuses),
  ];
  const invalidSkills = state.skills.filter((skill) => !skill.hasSkillMd);

  const groups: Array<{
    kind: HealthIssueKind;
    label: string;
    filter: StatusFilter;
    statuses?: TargetStatus[];
    skills?: Skill[];
  }> = [
    {
      kind: "conflict",
      label: "冲突",
      filter: "conflict",
      statuses: statuses.filter((status) => status.status === "conflict"),
    },
    {
      kind: "broken",
      label: "失效链接",
      filter: "broken",
      statuses: statuses.filter((status) => status.status === "broken"),
    },
    {
      kind: "pathMissing",
      label: "路径不存在",
      filter: "broken",
      statuses: statuses.filter((status) => isBlockingPathMissingStatus(state, status)),
    },
    {
      kind: "unmanaged",
      label: "未入库",
      filter: "unmanaged",
      statuses: statuses.filter((status) => status.status === "unmanaged"),
    },
    {
      kind: "invalid",
      label: "格式异常",
      filter: "issues",
      statuses: statuses.filter((status) => status.status === "invalid"),
      skills: invalidSkills,
    },
  ];

  const issues: HealthIssue[] = [];
  for (const group of groups) {
    const count = (group.statuses?.length ?? 0) + (group.skills?.length ?? 0);
    if (!count) continue;
    const firstStatus = group.statuses?.[0];
    const firstSkill = group.skills?.[0];
    const target = firstStatus
      ? `${firstStatus.projectName ? `${firstStatus.projectName} / ` : ""}${firstStatus.agentName} / ${firstStatus.displayName}`
      : firstSkill?.displayName ?? "";
    issues.push({
      kind: group.kind,
      label: group.label,
      count,
      filter: group.filter,
      status: firstStatus,
      statuses: group.statuses ?? [],
      skill: firstStatus ? undefined : firstSkill,
      skills: group.skills ?? [],
      summary: `${group.label} ${count} 个${target ? `，先处理：${target}` : ""}`,
    });
  }
  return issues;
}

function buildSkillFilterOptions(skills: Skill[]) {
  return skillFilterOrder.map((id) => ({
    id,
    label: statusFilterLabels[id],
    count: skills.filter((skill) => skillMatchesStatusFilter(skill, id)).length,
  }));
}

function buildStatusFilterOptions(statuses: TargetStatus[]) {
  return statusFilterOrder.map((id) => ({
    id,
    label: statusFilterLabels[id],
    count: statuses.filter((status) => targetStatusMatchesFilter(status, id)).length,
  }));
}

function issueKeysForStatuses(statuses: TargetStatus[]) {
  return [...new Set(statuses.map((status) => status.issueKey).filter((key): key is string => Boolean(key)))];
}

function buildTransferIssueFilterOptions(items: TransferItem[], activeFilter: StatusFilter) {
  const issueOptions = transferIssueFilterOrder
    .map((id) => ({
      id,
      label: transferIssueFilterLabels[id],
      count: items.filter((item) => transferItemMatchesFilter(item, id)).length,
    }))
    .filter((option) => option.count > 0);
  if (!issueOptions.length) return [];
  if (activeFilter === "all") return issueOptions;
  return [
    { id: "all" as const, label: transferIssueFilterLabels.all, count: items.length },
    ...issueOptions,
  ];
}

function skillMatchesStatusFilter(skill: Skill, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "issues") return skill.issueCount > 0 || !skill.hasSkillMd;
  if (filter === "enabled") return skill.enabledCount > 0;
  if (filter === "disabled") return skill.enabledCount === 0;
  return false;
}

function targetStatusMatchesFilter(status: TargetStatus, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "issues") return isProblemStatus(status.status);
  if (filter === "broken") return status.status === "broken" || status.status === "pathMissing";
  return status.status === filter;
}

function transferItemMatchesFilter(item: TransferItem, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "issues") return item.issueCount > 0 || item.status === "problem";
  if (filter === "enabled") return item.status === "enabled" || item.status === "partial";
  if (filter === "disabled") return item.status === "disabled";
  if (filter === "broken") return item.status === "broken" || item.status === "pathMissing";
  if (filter === "invalid") return item.status === "invalid" || item.statuses.some((status) => status.status === "invalid");
  return item.status === filter;
}

function isProblemStatus(status: SkillStatus) {
  return status === "unmanaged"
    || status === "conflict"
    || status === "broken"
    || status === "pathMissing"
    || status === "invalid";
}

function isBlockingPathMissingStatus(state: AppState, status: TargetStatus) {
  if (status.status !== "pathMissing") return false;
  if (status.targetKind === "project") {
    const project = state.projects.find((item) => item.id === status.projectId);
    return !project?.exists;
  }
  return false;
}

function buildGlobalTransferItems(state: AppState, agentId: string): TransferItem[] {
  const workspace = state.globalWorkspaces.find((item) => item.agentId === agentId);
  if (!workspace) return [];
  const skillItems = workspace.statuses
    .map((status) => buildSkillTransferItem(
      state,
      [status],
      workspace.rootExists ? status.status : "disabled",
      [{ agentId: status.agentId, projectId: null }],
      1,
      false,
    ))
    .sort(compareTransferItems);
  return addPresetTransferItems(state, skillItems, [{ agentId, projectId: null }], 1);
}

function buildProjectTransferItems(state: AppState, projectId: string): TransferItem[] {
  const project = state.projects.find((item) => item.id === projectId) ?? null;
  const pathMissingIsBlocking = !project?.exists;
  const workspaces = state.projectWorkspaces.filter((workspace) => workspace.projectId === projectId);
  const grouped = new Map<string, TargetStatus[]>();
  for (const workspace of workspaces) {
    for (const status of workspace.statuses) {
      const bucket = grouped.get(status.skillId) ?? [];
      bucket.push(status);
      grouped.set(status.skillId, bucket);
    }
  }
  const targets = state.agents.map((agent) => ({ agentId: agent.id, projectId }));
  const targetCount = Math.max(targets.length, 1);
  const skillItems = [...grouped.values()]
    .map((statuses) => buildSkillTransferItem(
      state,
      statuses,
      resolveProjectTransferStatus(statuses, targetCount, !pathMissingIsBlocking),
      targets,
      targetCount,
      pathMissingIsBlocking,
    ))
    .sort(compareTransferItems);
  return addPresetTransferItems(state, skillItems, targets, targetCount);
}

function buildSkillTransferItem(
  state: AppState,
  statuses: TargetStatus[],
  status: TransferStatus,
  targets: DeployTarget[],
  targetCount: number,
  pathMissingIsBlocking: boolean,
): TransferItem {
  const first = statuses[0];
  const librarySkill = state.skills.find((skill) => skill.id === first.skillId) ?? null;
  const blockingPathCount = pathMissingIsBlocking
    ? statuses.filter((item) => item.status === "pathMissing").length
    : 0;
  return {
    id: transferItemIdForSkill(first.skillId),
    kind: "skill",
    skillId: first.skillId,
    skillIds: librarySkill ? [librarySkill.id] : [],
    skillName: librarySkill?.name ?? first.skillName,
    displayName: librarySkill?.displayName ?? first.displayName,
    description: librarySkill?.description ?? first.description,
    status,
    statuses,
    librarySkill,
    targetCount,
    enabledCount: statuses.filter((item) => item.status === "enabled").length,
    issueCount: statuses.filter((item) => isProblemStatus(item.status) && (item.status !== "pathMissing" || pathMissingIsBlocking)).length,
    blockingPathCount,
    targets,
    memberCount: 1,
    missingCount: librarySkill ? 0 : 1,
  };
}

function addPresetTransferItems(
  state: AppState,
  skillItems: TransferItem[],
  targets: DeployTarget[],
  scopeTargetCount: number,
) {
  const bySkillId = new Map(skillItems.map((item) => [item.skillId, item]));
  const presetItems = state.presets.map((preset) =>
    buildPresetTransferItem(state, preset, bySkillId, targets, scopeTargetCount),
  );
  return [...skillItems, ...presetItems].sort(compareTransferItems);
}

function buildPresetTransferItem(
  state: AppState,
  preset: Preset,
  skillItemsById: Map<string, TransferItem>,
  targets: DeployTarget[],
  scopeTargetCount: number,
): TransferItem {
  const children = preset.skillIds
    .map((skillId) => skillItemsById.get(skillId))
    .filter((item): item is TransferItem => Boolean(item));
  const existingSkillIds = new Set(state.skills.map((skill) => skill.id));
  const missingCount = preset.skillIds.filter((skillId) => !existingSkillIds.has(skillId)).length;
  const statuses = children.flatMap((child) => child.statuses);
  const status = resolvePresetTransferStatus(children, missingCount);
  const issueCount = missingCount + children.filter((child) =>
    child.issueCount > 0 || child.status === "problem",
  ).length;
  const blockingPathCount = children.reduce((count, child) => count + child.blockingPathCount, 0);
  const enabledCount = children.filter((child) => child.status === "enabled").length;
  const description = preset.description || skillNames(preset, state.skills);
  const displayName = presetDisplayName(preset);

  return {
    id: transferItemIdForPreset(preset.id),
    kind: "composition",
    skillId: preset.id,
    skillIds: preset.skillIds.filter((skillId) => existingSkillIds.has(skillId)),
    presetId: preset.id,
    skillName: displayName,
    displayName,
    description,
    status,
    statuses,
    librarySkill: null,
    targetCount: Math.max(scopeTargetCount, 1),
    enabledCount,
    issueCount,
    blockingPathCount,
    targets,
    memberCount: Math.max(preset.skillIds.length, 1),
    missingCount,
    children,
  };
}

function resolvePresetTransferStatus(children: TransferItem[], missingCount: number): TransferStatus {
  if (missingCount > 0) return "problem";
  if (!children.length) return "disabled";
  if (children.some((child) => child.status === "pathMissing")) return "pathMissing";
  if (children.some((child) => child.status === "conflict")) return "conflict";
  if (children.some((child) => child.status === "unmanaged")) return "unmanaged";
  if (children.some((child) => child.status === "broken")) return "broken";
  if (children.some((child) => child.status === "invalid" || child.status === "problem")) return "problem";
  const enabledCount = children.filter((child) => child.status === "enabled").length;
  if (enabledCount === children.length) return "enabled";
  if (enabledCount > 0 || children.some((child) => child.status === "partial")) return "partial";
  return "disabled";
}

function resolveProjectTransferStatus(
  statuses: TargetStatus[],
  targetCount: number,
  pathMissingIsDeployable: boolean,
): TransferStatus {
  const effectiveStatuses = statuses.map((status) =>
    pathMissingIsDeployable && status.status === "pathMissing" ? "disabled" : status.status,
  );
  if (effectiveStatuses.some((status) => status === "conflict")) return "conflict";
  if (effectiveStatuses.some((status) => status === "unmanaged")) return "unmanaged";
  if (effectiveStatuses.some((status) => status === "broken")) return "broken";
  if (effectiveStatuses.some((status) => status === "pathMissing")) return "pathMissing";
  if (effectiveStatuses.some((status) => status === "invalid")) return "invalid";
  const enabledCount = effectiveStatuses.filter((status) => status === "enabled").length;
  if (enabledCount > 0 && enabledCount < targetCount) return "partial";
  if (enabledCount >= targetCount && targetCount > 0) return "enabled";
  return "disabled";
}

function compareTransferItems(left: TransferItem, right: TransferItem) {
  const statusDiff = transferStatusWeight(left.status) - transferStatusWeight(right.status);
  if (statusDiff) return statusDiff;
  return left.displayName.localeCompare(right.displayName, "zh-Hans-CN");
}

function transferStatusWeight(status: TransferStatus) {
  const order: Record<TransferStatus, number> = {
    conflict: 0,
    unmanaged: 1,
    broken: 2,
    pathMissing: 3,
    invalid: 4,
    problem: 5,
    partial: 6,
    enabled: 7,
    disabled: 8,
  };
  return order[status];
}

function canApplyTransferItem(item: TransferItem) {
  return item.skillIds.length > 0
    && !hasBlockingPathRisk(item)
    && (
      item.status === "disabled"
      || item.status === "partial"
      || item.status === "conflict"
      || item.status === "unmanaged"
      || item.status === "broken"
      || item.status === "invalid"
      || item.status === "problem"
    );
}

function canWithdrawTransferItem(item: TransferItem) {
  return item.skillIds.length > 0
    && (item.status === "enabled" || item.status === "partial");
}

function canMoveTransferItem(item: TransferItem, targetColumn: TransferColumnKey) {
  return targetColumn === "applied"
    ? canApplyTransferItem(item)
    : canWithdrawTransferItem(item);
}

function hasBlockingPathRisk(item: TransferItem) {
  return item.blockingPathCount > 0;
}

function itemHasOverwriteRisk(item: TransferItem) {
  return item.statuses.some((status) => isOverwriteRiskStatus(status.status))
    || item.status === "broken"
    || item.status === "invalid";
}

function isOverwriteRiskStatus(status: SkillStatus) {
  return status === "conflict" || status === "unmanaged" || status === "broken" || status === "invalid";
}

function mergeReport(left: OperationReport, right: OperationReport): OperationReport {
  return {
    changed: left.changed + right.changed,
    skipped: left.skipped + right.skipped,
    conflicts: [...left.conflicts, ...right.conflicts],
    errors: [...left.errors, ...right.errors],
  };
}

function OperationReportEmpty(): OperationReport {
  return {
    changed: 0,
    skipped: 0,
    conflicts: [],
    errors: [],
  };
}

function transferItemIdForSkill(skillId: string) {
  return `skill:${skillId}`;
}

function transferItemIdForPreset(presetId: string) {
  return `composition:${presetId}`;
}

function presetMatchesQuery(preset: Preset, skills: Skill[], query: string) {
  const memberNames = preset.skillIds.flatMap((skillId) => {
    const skill = skills.find((item) => item.id === skillId);
    return skill ? [skill.displayName, skill.name, skill.description, skill.path, ...skill.tags] : [skillId];
  });
  return matchesQuery(query, [preset.name, preset.description, ...memberNames]);
}

function buildPresetMemberRows(preset: Preset, skills: Skill[]): PresetMemberRow[] {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return preset.skillIds.map((skillId) => ({
    id: skillId,
    skill: byId.get(skillId) ?? null,
  }));
}

function summarizePresetMembers(preset: Preset, skills: Skill[]) {
  const members = buildPresetMemberRows(preset, skills);
  const availableMemberCount = members.filter((member) => member.skill).length;
  const missingMemberCount = members.length - availableMemberCount;
  const abnormalMemberCount = members.filter((member) =>
    member.skill && (!member.skill.hasSkillMd || member.skill.issueCount > 0)
  ).length;
  const problemCount = missingMemberCount + abnormalMemberCount;
  const statusLabel = !members.length
    ? "空组合"
    : problemCount
      ? `${problemCount} 个问题`
      : "成员正常";
  return {
    memberCount: members.length,
    availableMemberCount,
    missingMemberCount,
    abnormalMemberCount,
    problemCount,
    statusLabel,
  };
}

function getPresetMemberState(member: PresetMemberRow) {
  if (!member.skill) {
    return { tone: "warn" as const, label: "缺失", icon: AlertTriangle };
  }
  if (!member.skill.hasSkillMd) {
    return { tone: "warn" as const, label: "格式异常", icon: AlertTriangle };
  }
  if (member.skill.issueCount > 0) {
    return { tone: "warn" as const, label: `${member.skill.issueCount} 个问题`, icon: AlertTriangle };
  }
  return { tone: "good" as const, label: "正常", icon: CheckCircle2 };
}

function existingPresetSkillIds(state: AppState, presetId: string) {
  const preset = state.presets.find((item) => item.id === presetId);
  if (!preset) return [];
  const existing = new Set(state.skills.map((skill) => skill.id));
  return preset.skillIds.filter((skillId) => existing.has(skillId));
}

function toggleSetValue(setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });
}

function formatOperationReport(report: OperationReport, label: string) {
  const parts = [`${label}：变更 ${report.changed} 个`];
  if (report.skipped) parts.push(`跳过 ${report.skipped} 个`);
  if (report.conflicts.length) parts.push(`冲突 ${report.conflicts.length} 个`);
  if (report.errors.length) parts.push(`错误 ${report.errors.length} 个`);
  return parts.join("，");
}

function formatReportExamples(values: string[]) {
  if (!values.length) return "";
  return `原因：${values.slice(0, 2).map(simplifyErrorMessage).join("；")}`;
}

function cleanErrorMessage(cause: unknown) {
  return String(cause).replace(/^Error:\s*/i, "").trim();
}

function formatActionError(cause: unknown) {
  return simplifyErrorMessage(cleanErrorMessage(cause));
}

function simplifyErrorMessage(message: string) {
  return message
    .replace(/^主库里已经存在同名技能：/, "已存在同名技能：")
    .replace("该文件夹缺少 SKILL.md，不能作为正式技能入库", "这个文件夹缺少 SKILL.md")
    .replace("压缩包里未找到包含 SKILL.md 的技能目录", "压缩包里没有找到 SKILL.md")
    .replace("请选择一个技能文件夹或 .zip 压缩包", "请选择技能文件夹或 .zip")
    .replace("只支持导入 .zip 压缩包", "只支持 .zip 压缩包")
    .replace(/。下一步：.*$/, "")
    .replace(/下一步：.*$/, "")
    .trim();
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function stripKnownExtension(name: string) {
  return name.replace(/\.zip$/i, "");
}

function defaultSelectionForView(
  view: ViewKey,
  state: AppState | null,
  agentId: string,
  projectId: string | null,
  projectAgentId: string,
): Selection | null {
  if (!state) return null;
  if (view === "library") {
    return null;
  }
  if (view === "global") {
    const items = buildGlobalTransferItems(state, agentId);
    const item = items.find((transferItem) => transferItem.status === "disabled") ?? items[0];
    return item ? { type: "transferSkill", id: item.id } : null;
  }
  if (view === "projects") {
    const resolvedProjectId = resolveProjectId(state, projectId);
    if (!resolvedProjectId) return null;
    const items = buildProjectTransferItems(state, resolvedProjectId);
    const item = items.find((transferItem) => transferItem.status === "disabled") ?? items[0];
    return item ? { type: "transferSkill", id: item.id } : null;
  }
  if (view === "presets") {
    return null;
  }
  return { type: "settings" };
}

function resolveProjectId(state: AppState, currentProjectId: string | null) {
  if (currentProjectId && state.projects.some((project) => project.id === currentProjectId)) {
    return currentProjectId;
  }
  return state.projects[0]?.id ?? null;
}

function selectionBelongsToScope(
  selection: Selection,
  view: ViewKey,
  state: AppState,
  agentId: string,
  projectId: string | null,
  projectAgentId: string,
) {
  if (view === "library") {
    return selection.type === "skill" && state.skills.some((skill) => skill.id === selection.id);
  }
  if (view === "global") {
    return selection.type === "transferSkill"
      && buildGlobalTransferItems(state, agentId).some((item) => item.id === selection.id);
  }
  if (view === "projects") {
    if (!projectId) return false;
    return selection.type === "transferSkill"
      && buildProjectTransferItems(state, projectId).some((item) => item.id === selection.id);
  }
  if (view === "presets") {
    return selection.type === "preset" && state.presets.some((preset) => preset.id === selection.id);
  }
  return selection.type === "settings";
}

function findTargetStatus(
  state: AppState,
  agentId: string,
  projectId: string | null,
  skillId: string,
) {
  const workspace = projectId
    ? state.projectWorkspaces.find((item) => item.agentId === agentId && item.projectId === projectId)
    : state.globalWorkspaces.find((item) => item.agentId === agentId);
  return workspace?.statuses.find((status) => status.skillId === skillId) ?? null;
}

function summarizeTargetStatuses(statuses: TargetStatus[], expectedCount: number) {
  if (!statuses.length) return "未发现当前状态";
  if (expectedCount === 1) return statusText[statuses[0].status];
  const counts = statuses.reduce<Record<string, number>>((acc, status) => {
    acc[statusText[status.status]] = (acc[statusText[status.status]] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([label, count]) => `${label} ${count}`)
    .join("，");
}

function useDialogFocus<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const getFocusable = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("disabled") && element.offsetParent !== null);

    requestAnimationFrame(() => {
      getFocusable()[0]?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    root.addEventListener("keydown", handleKeyDown);
    return () => {
      root.removeEventListener("keydown", handleKeyDown);
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, [onClose]);

  return ref;
}

function skillNames(preset: Preset, skills: Skill[]) {
  return preset.skillIds
    .map((id) => skills.find((skill) => skill.id === id)?.displayName ?? id)
    .join("、");
}

function presetDisplayName(preset: Preset) {
  return preset.name.trim() || "未命名组合";
}

function slugifyClient(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[\\/:\.\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || value;
}
