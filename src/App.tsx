import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Circle,
  ExternalLink,
  FolderKanban,
  FolderPlus,
  Globe2,
  Layers3,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Unlink,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addProject,
  adoptSkillFromTarget,
  applyPreset,
  deletePreset,
  deleteSkill,
  deploySkill,
  getAppState,
  importSkill,
  installSkillFromMarket,
  openPath,
  removeProject,
  updateAgentPath,
  upsertPreset,
  withdrawPreset,
  withdrawSkill,
} from "./api";
import type {
  Agent,
  AppState,
  DeployTarget,
  OperationReport,
  Preset,
  Project,
  Skill,
  SkillStatus,
  TargetStatus,
  ViewKey,
} from "./types";

const navItems: Array<{ key: ViewKey; label: string; icon: typeof BookOpen }> = [
  { key: "library", label: "技能主库", icon: BookOpen },
  { key: "global", label: "全局应用", icon: Globe2 },
  { key: "projects", label: "项目应用", icon: FolderKanban },
  { key: "presets", label: "技能套装", icon: Layers3 },
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

type StatusFilter =
  | "all"
  | "issues"
  | "unmanaged"
  | "conflict"
  | "broken"
  | "disabled"
  | "enabled";

const statusFilterLabels: Record<StatusFilter, string> = {
  all: "全部",
  issues: "有问题",
  unmanaged: "未入库",
  conflict: "冲突",
  broken: "失效",
  disabled: "未启用",
  enabled: "已启用",
};

const statusFilterOrder: StatusFilter[] = [
  "all",
  "issues",
  "unmanaged",
  "conflict",
  "broken",
  "disabled",
  "enabled",
];

const skillFilterOrder: StatusFilter[] = ["all", "issues", "enabled", "disabled"];

type Selection =
  | { type: "skill"; id: string }
  | { type: "status"; id: string }
  | { type: "preset"; id: string }
  | { type: "settings" };

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

type ImportSkillMode = "local" | "market";

type HealthIssueKind = "conflict" | "broken" | "pathMissing" | "unmanaged" | "invalid";

type HealthIssue = {
  kind: HealthIssueKind;
  label: string;
  count: number;
  summary: string;
  filter: StatusFilter;
  status?: TargetStatus;
  skill?: Skill;
};

type ConfirmDialogState = {
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
  tone: "danger" | "warn";
  onConfirm: () => Promise<void>;
} | null;

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("library");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProjectAgentId, setSelectedProjectAgentId] = useState<string>("codex");
  const [checkedSkillIds, setCheckedSkillIds] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [importSkillOpen, setImportSkillOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<PresetDraft | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);

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
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, []);

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

  const globalWorkspace = state?.globalWorkspaces.find(
    (workspace) => workspace.agentId === selectedAgentId,
  );

  const projectWorkspaces = state?.projectWorkspaces.filter(
    (workspace) => workspace.projectId === selectedProjectId,
  ) ?? [];

  const projectWorkspace = projectWorkspaces.find(
    (workspace) => workspace.agentId === selectedProjectAgentId,
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
    if (view === "library") {
      if (selected?.type === "skill" && filteredSkills.some((skill) => skill.id === selected.id)) return;
      setSelected(filteredSkills[0] ? { type: "skill", id: filteredSkills[0].id } : null);
      return;
    }
    if (view === "global") {
      if (selected?.type === "status" && filteredGlobalStatuses.some((status) => status.id === selected.id)) return;
      setSelected(filteredGlobalStatuses[0] ? { type: "status", id: filteredGlobalStatuses[0].id } : null);
      return;
    }
    if (view === "projects") {
      if (selected?.type === "status" && filteredProjectStatuses.some((status) => status.id === selected.id)) return;
      setSelected(filteredProjectStatuses[0] ? { type: "status", id: filteredProjectStatuses[0].id } : null);
    }
  }, [filteredGlobalStatuses, filteredProjectStatuses, filteredSkills, selected, state, view]);

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
    setQuery("");
    setStatusFilter(issue.filter);
    if (issue.skill) {
      setView("library");
      setSelected({ type: "skill", id: issue.skill.id });
      return;
    }
    if (!issue.status) return;
    if (issue.status.targetKind === "project") {
      setView("projects");
      setSelectedProjectId(issue.status.projectId ?? null);
      setSelectedProjectAgentId(issue.status.agentId);
    } else {
      setView("global");
      setSelectedAgentId(issue.status.agentId);
    }
    setSelected({ type: "status", id: issue.status.id });
  }

  function changeStatusFilter(nextFilter: StatusFilter) {
    setStatusFilter(nextFilter);
    if (view === "library") {
      const skill = queriedSkills.find((item) => skillMatchesStatusFilter(item, nextFilter));
      setSelected(skill ? { type: "skill", id: skill.id } : null);
      return;
    }
    if (view === "global") {
      const status = queriedGlobalStatuses.find((item) => targetStatusMatchesFilter(item, nextFilter));
      setSelected(status ? { type: "status", id: status.id } : null);
      return;
    }
    if (view === "projects") {
      const status = queriedProjectStatuses.find((item) => targetStatusMatchesFilter(item, nextFilter));
      setSelected(status ? { type: "status", id: status.id } : null);
    }
  }

  function confirmDeleteSkill(skill: Skill, locations: TargetStatus[]) {
    if (locations.length) {
      setError(`请先收回 ${locations.length} 个启用位置，再删除主库技能。`);
      return;
    }
    setConfirmDialog({
      title: `删除技能：${skill.displayName}`,
      message: "将从主库删除该技能目录。此操作不会保留备份。",
      details: [skill.path],
      confirmLabel: "确认删除",
      tone: "danger",
      onConfirm: async () => {
        await runAction(async () => {
          const next = await deleteSkill(skill.id);
          setState(next);
          setSelected(defaultSelectionForView("library", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
        }, "已删除技能");
      },
    });
  }

  function confirmDeletePreset(preset: Preset) {
    setConfirmDialog({
      title: `删除套装：${preset.name}`,
      message: "将删除这个套装配置，不会删除主库里的技能。",
      details: preset.skillIds.length ? [`包含 ${preset.skillIds.length} 个技能`] : undefined,
      confirmLabel: "确认删除",
      tone: "danger",
      onConfirm: async () => {
        await runAction(async () => {
          const next = await deletePreset(preset.id);
          setState(next);
          setSelected(defaultSelectionForView("presets", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
        }, "已删除套装");
      },
    });
  }

  async function deployLibraryToStatus(skill: Skill, status: TargetStatus) {
    const apply = async () => {
      await runAction(async () => {
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
        await refreshAfterReport(report, "已按主库分发");
      });
    };

    if (status.status === "conflict" || status.status === "unmanaged") {
      setConfirmDialog({
        title: `用主库覆盖：${status.displayName}`,
        message: "目标位置已有同名内容，确认后会按主库版本重建软链接。",
        details: [status.targetPath, `主库：${skill.path}`],
        confirmLabel: "确认覆盖",
        tone: "warn",
        onConfirm: apply,
      });
      return;
    }

    await apply();
  }

  async function runAction(action: () => Promise<void>, success?: string) {
    try {
      setWorking(true);
      setError(null);
      await action();
      if (success) setNotice(success);
      return true;
    } catch (cause) {
      setError(formatActionError(cause));
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function refreshAfterReport(report: OperationReport, successLabel: string) {
    await load();
    const summary = formatOperationReport(report, successLabel);
    if (report.errors.length) {
      setError(`${summary}。下一步：检查目标路径、目录权限或设置里的 Agent 路径后重试。${formatReportExamples(report.errors)}`);
      return;
    }
    if (report.conflicts.length) {
      setNotice(`${summary}。下一步：在列表中筛选“冲突”，确认后可用主库覆盖。`);
      return;
    }
    setNotice(`${summary}。`);
  }

  async function pickAndImportSkill(onImported?: () => void) {
    const picked = await open({ directory: true, multiple: false, title: "选择技能文件夹" });
    if (!picked || Array.isArray(picked)) return;
    const imported = await runAction(async () => {
      const next = await importSkill(picked);
      const importedId = slugifyClient(fileNameFromPath(picked));
      const importedSkill = next.skills.find(
        (skill) => skill.id === importedId || skill.name === importedId,
      );
      setState(next);
      setView("library");
      setStatusFilter("all");
      setSelected(importedSkill
        ? { type: "skill", id: importedSkill.id }
        : defaultSelectionForView("library", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
      setNotice(`已导入技能：变更 1 个。下一步可以在右侧分发。`);
    });
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

  function adoptStatuses(statuses: TargetStatus[]) {
    if (!statuses.length) return;
    setConfirmDialog({
      title: `导入 ${statuses.length} 个存量技能`,
      message: "将把目标位置的存量技能导入主库，并把原位置改成指向主库的软链接。",
      details: ["冲突策略：主库优先处理同名技能"],
      confirmLabel: "确认导入",
      tone: "warn",
      onConfirm: async () => {
        await runAction(async () => {
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
              errors.push(`${status.displayName}：${cleanErrorMessage(cause)}`);
            }
          }
          if (nextState) setState(nextState);
          const report: OperationReport = {
            changed,
            skipped: statuses.length - changed - errors.length,
            conflicts: [],
            errors,
          };
          await refreshAfterReport(report, "已导入存量技能");
        });
      },
    });
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
          />
        </>
      );
    }

    if (view === "global") {
      return (
        <>
          <AgentTabs
            agents={state.agents}
            selectedId={selectedAgentId}
            onSelect={selectGlobalAgent}
          />
          <StatusFilterBar
            value={statusFilter}
            options={buildStatusFilterOptions(queriedGlobalStatuses)}
            onChange={changeStatusFilter}
          />
          <ImportExistingToolbar
            statuses={globalWorkspace?.statuses ?? []}
            onImport={adoptStatuses}
          />
          <StatusList
            statuses={filteredGlobalStatuses}
            selectedId={selected?.type === "status" ? selected.id : null}
            onSelect={(status) => setSelected({ type: "status", id: status.id })}
          />
        </>
      );
    }

    if (view === "projects") {
      return (
        <>
          <ProjectSelector
            projects={state.projects}
            selectedId={selectedProjectId}
            onSelect={selectProject}
            onAdd={pickAndAddProject}
          />
          {selectedProjectId ? (
            <>
              <AgentTabs
                agents={state.agents}
                selectedId={selectedProjectAgentId}
                onSelect={selectProjectAgent}
              />
              <StatusFilterBar
                value={statusFilter}
                options={buildStatusFilterOptions(queriedProjectStatuses)}
                onChange={changeStatusFilter}
              />
              <ImportExistingToolbar
                statuses={projectWorkspace?.statuses ?? []}
                onImport={adoptStatuses}
              />
              <StatusList
                statuses={filteredProjectStatuses}
                selectedId={selected?.type === "status" ? selected.id : null}
                onSelect={(status) => setSelected({ type: "status", id: status.id })}
              />
            </>
          ) : (
            <EmptyState
              title="还没有纳入管理的项目"
              action="添加项目"
              onAction={pickAndAddProject}
            />
          )}
        </>
      );
    }

    if (view === "presets") {
      const presets = state.presets.filter((preset) =>
        matchesQuery(query, [preset.name, preset.description, ...preset.skillIds]),
      );
      return (
        <PresetList
          presets={presets}
          skills={state.skills}
          selectedId={selected?.type === "preset" ? selected.id : null}
          onSelect={(preset) => setSelected({ type: "preset", id: preset.id })}
          onCreate={() => setPresetDraft({ id: null, name: "", description: "", skillIds: [] })}
        />
      );
    }

    return (
      <SettingsPanel
        state={state}
        onPickProject={pickAndAddProject}
        onUpdateAgentPath={(agentId, path) =>
          runAction(async () => setState(await updateAgentPath(agentId, path)), "已更新路径")
        }
        onRemoveProject={(projectId) => {
          const project = state.projects.find((item) => item.id === projectId);
          setConfirmDialog({
            title: `移除项目：${project?.name ?? projectId}`,
            message: "只会从技能中枢的管理列表移除，不会删除项目目录。",
            details: project ? [project.path] : undefined,
            confirmLabel: "确认移除",
            tone: "warn",
            onConfirm: async () => {
              await runAction(async () => {
                const next = await removeProject(projectId);
                const nextProjectId = resolveProjectId(next, selectedProjectId === projectId ? null : selectedProjectId);
                setState(next);
                setSelectedProjectId(nextProjectId);
                setSelected(defaultSelectionForView("projects", next, selectedAgentId, nextProjectId, selectedProjectAgentId));
              }, "已移除项目");
            },
          });
        }}
      />
    );
  }

  function renderDetail() {
    if (!state) return null;

    if (view === "settings") {
      return (
        <ContextPanel title="本地配置">
          <KeyValue label="主库路径" value={state.skillsRoot} />
          <KeyValue label="数据库" value={state.databasePath} />
          <KeyValue label="配置文件" value={state.configPath} />
          <div className="detail-actions">
            <button className="secondary-button" onClick={() => void openPath(state.baseDir)}>
              <ExternalLink size={16} />
              打开主库目录
            </button>
          </div>
          <ProblemBox issues={state.issues} />
        </ContextPanel>
      );
    }

    const scopedSelectedStatus = selectedStatus && (
      view === "global"
        ? filteredGlobalStatuses.some((status) => status.id === selectedStatus.id)
        : view === "projects"
          ? filteredProjectStatuses.some((status) => status.id === selectedStatus.id)
          : false
    ) ? selectedStatus : null;

    if (scopedSelectedStatus) {
      const selectedStatus = scopedSelectedStatus;
      const librarySkill = state.skills.find((skill) => skill.id === selectedStatus.skillId);
      return (
        <ContextPanel title={selectedStatus.displayName}>
          <StatusPill status={selectedStatus.status} />
          <p className="description">{selectedStatus.description || "暂无描述"}</p>
          <KeyValue label="智能体应用" value={selectedStatus.agentName} />
          <KeyValue label="应用范围" value={selectedStatus.projectName ?? "全局"} />
          <KeyValue label="目标路径" value={selectedStatus.targetPath} />
          {selectedStatus.linkTarget ? <KeyValue label="链接目标" value={selectedStatus.linkTarget} /> : null}
          {selectedStatus.issue ? <InlineWarning text={selectedStatus.issue} /> : null}
          <div className="detail-actions">
            {selectedStatus.status === "unmanaged" ? (
              <button
                className="primary-button"
                disabled={working}
                onClick={() =>
                  runAction(async () => {
                    const next = await adoptSkillFromTarget(
                      selectedStatus.agentId,
                      selectedStatus.projectId ?? null,
                      selectedStatus.skillName,
                    );
                    setState(next);
                    setNotice("已入库并重建软链接：变更 1 个。下一步可以确认启用位置或继续分发。");
                  })
                }
              >
                <Archive size={16} />
                入库
              </button>
            ) : null}
            {librarySkill && selectedStatus.status !== "enabled" ? (
              <button
                className="primary-button"
                disabled={working}
                onClick={() => void deployLibraryToStatus(librarySkill, selectedStatus)}
              >
                <Link2 size={16} />
                {selectedStatus.status === "conflict" || selectedStatus.status === "unmanaged"
                  ? "用主库覆盖"
                  : "分发到此位置"}
              </button>
            ) : null}
            {librarySkill && selectedStatus.status === "enabled" ? (
              <button
                className="secondary-button"
                disabled={working}
                onClick={() =>
                  runAction(async () => {
                    const report = await withdrawSkill(librarySkill.id, [
                      {
                        agentId: selectedStatus.agentId,
                        projectId: selectedStatus.projectId ?? null,
                      },
                    ]);
                    await refreshAfterReport(report, "已收回");
                  })
                }
              >
                <Unlink size={16} />
                收回
              </button>
            ) : null}
            <button className="ghost-button" onClick={() => void openPath(selectedStatus.targetPath)}>
              <ExternalLink size={16} />
              打开位置
            </button>
          </div>
          {librarySkill ? <SkillPreview skill={librarySkill} /> : null}
        </ContextPanel>
      );
    }

    if (view === "global" || view === "projects") {
      return (
        <ContextPanel title={view === "global" ? "全局应用" : "项目应用"}>
          <EmptyState
            title={view === "projects" && !selectedProjectId
              ? "还没有纳入管理的项目"
              : "当前筛选没有匹配的应用状态"}
            action={view === "projects" && !selectedProjectId ? "添加项目" : undefined}
            onAction={view === "projects" && !selectedProjectId ? pickAndAddProject : undefined}
          />
        </ContextPanel>
      );
    }

    if (selectedPreset) {
      return (
        <ContextPanel title={selectedPreset.name}>
          <p className="description">{selectedPreset.description || "暂无描述"}</p>
          <KeyValue label="包含技能" value={`${selectedPreset.skillIds.length} 个`} />
          <PresetSkillNames preset={selectedPreset} skills={state.skills} />
          <div className="detail-actions">
            <button className="primary-button" onClick={() => setDrawer({ type: "preset", presetId: selectedPreset.id })}>
              <Link2 size={16} />
              应用套装
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                setPresetDraft({
                  id: selectedPreset.id,
                  name: selectedPreset.name,
                  description: selectedPreset.description,
                  skillIds: selectedPreset.skillIds,
                })
              }
            >
              编辑
            </button>
            <button
              className="danger-button"
              disabled={working}
              onClick={() => confirmDeletePreset(selectedPreset)}
            >
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </ContextPanel>
      );
    }

    if (view === "presets") {
      return (
        <ContextPanel title="技能套装">
          <EmptyState title="还没有技能套装" action="新建套装" onAction={() => setPresetDraft({ id: null, name: "", description: "", skillIds: [] })} />
        </ContextPanel>
      );
    }

    const skill = selectedSkill && filteredSkills.some((item) => item.id === selectedSkill.id)
      ? selectedSkill
      : filteredSkills[0] ?? null;
    if (!skill) {
      if (state.skills.length) {
        return (
          <ContextPanel title="技能主库">
            <EmptyState title="当前筛选没有匹配的技能" />
          </ContextPanel>
        );
      }
      const unmanaged = state.globalWorkspaces
        .flatMap((workspace) => workspace.statuses)
        .filter((status) => status.status === "unmanaged");
      return (
        <ContextPanel title="技能主库">
          {unmanaged.length ? (
            <>
              <InlineWarning text={`发现 ${unmanaged.length} 个全局存量技能尚未入库。`} />
              <div className="detail-actions">
                <button className="primary-button" onClick={() => void adoptStatuses(unmanaged)}>
                  <Archive size={16} />
                  导入全部全局存量
                </button>
                <button className="secondary-button" onClick={() => setView("global")}>
                  查看全局应用
                </button>
              </div>
            </>
          ) : (
            <EmptyState title="主库里还没有技能" action="导入技能" onAction={() => setImportSkillOpen(true)} />
          )}
        </ContextPanel>
      );
    }

    const locations = allStatuses.filter(
      (status) => status.skillId === skill.id && status.status === "enabled",
    );

    return (
      <ContextPanel title={skill.displayName}>
        <p className="description">{skill.description}</p>
        {!skill.hasSkillMd ? <InlineWarning text="该技能缺少 SKILL.md" /> : null}
        <KeyValue label="主库路径" value={skill.path} />
        <KeyValue label="启用位置" value={`${locations.length} 个`} />
        <TagRow tags={skill.tags} />
        <div className="detail-actions">
          <button className="primary-button" onClick={() => setDrawer({ type: "skill", skillIds: [skill.id] })}>
            <Link2 size={16} />
            分发
          </button>
          <button className="secondary-button" onClick={() => void openPath(skill.path)}>
            <ExternalLink size={16} />
            打开目录
          </button>
          <button
            className="danger-button"
            disabled={working}
            onClick={() => confirmDeleteSkill(skill, locations)}
          >
            <Trash2 size={16} />
            删除
          </button>
        </div>
        <EnabledLocations statuses={locations} />
        <SkillPreview skill={skill} />
      </ContextPanel>
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
            <Layers3 size={18} />
          </div>
          <div>
            <strong>技能中枢</strong>
            <span>本地 Skill 工作台</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
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
        </nav>
        {state ? (
          <div className="sidebar-meta">
            <span>主库 {state.skills.length} 个技能</span>
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
            <button className="secondary-button" disabled={working} onClick={() => void load()}>
              <RefreshCw size={16} />
              刷新
            </button>
            <button className="primary-button" onClick={() => setImportSkillOpen(true)}>
              <Upload size={16} />
              导入技能
            </button>
          </div>
        </header>

        {error ? (
          <div className="banner error">
            <AlertTriangle size={16} />
            {error}
            <button onClick={() => setError(null)} aria-label="关闭错误">
              <X size={14} />
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="banner success">
            <CheckCircle2 size={16} />
            {notice}
            <button onClick={() => setNotice(null)} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        ) : null}

        {state ? (
          <HealthOverview
            issues={healthIssues}
            onSelect={selectHealthIssue}
          />
        ) : null}

        <section className="workspace">
          <div className="list-pane">
            <PaneHeader
              view={view}
              count={
                view === "library"
                  ? filteredSkills.length
                  : view === "global"
                    ? filteredGlobalStatuses.length
                    : view === "projects"
                      ? filteredProjectStatuses.length
                      : view === "presets"
                        ? state?.presets.length ?? 0
                        : state?.agents.length ?? 0
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
          <div className="detail-pane">{renderDetail()}</div>
        </section>

        {checkedSkillIds.size > 0 ? (
          <div className="bulk-bar">
            <span>已选择 {checkedSkillIds.size} 个技能</span>
            <button className="primary-button" onClick={() => setDrawer({ type: "skill", skillIds: [...checkedSkillIds] })}>
              <Link2 size={16} />
              批量分发
            </button>
            <button className="ghost-button" onClick={() => setCheckedSkillIds(new Set())}>
              清除选择
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
                await refreshAfterReport(combined, "已分发");
              } else {
                const report = await applyPreset(drawer.presetId, targets, overwrite);
                await refreshAfterReport(report, "已应用套装");
              }
              setDrawer(null);
              setCheckedSkillIds(new Set());
            });
          }}
          onWithdraw={async (targets) => {
            await runAction(async () => {
              if (drawer.type === "preset") {
                const report = await withdrawPreset(drawer.presetId, targets);
                await refreshAfterReport(report, "已收回套装");
              }
            });
          }}
        />
      ) : null}

      {importSkillOpen ? (
        <ImportSkillDialog
          working={working}
          onClose={() => setImportSkillOpen(false)}
          onPickLocal={() => void pickAndImportSkill(() => setImportSkillOpen(false))}
          onInstallFromMarket={(marketUrl, version) =>
            runAction(async () => {
              const next = await installSkillFromMarket(marketUrl, version);
              setState(next);
              setView("library");
              setStatusFilter("all");
              const marketSkillId = marketSkillIdFromUrlClient(marketUrl);
              const skill = next.skills.find(
                (item) => item.name === slugifyClient(marketSkillId) || item.id === slugifyClient(marketSkillId),
              );
              setSelected(skill ? { type: "skill", id: skill.id } : defaultSelectionForView("library", next, selectedAgentId, selectedProjectId, selectedProjectAgentId));
              setImportSkillOpen(false);
              setNotice("已从 Skill 市场安装：变更 1 个。下一步可以在右侧分发。");
            })
          }
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
            }, "已保存技能套装")
          }
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmDialog
          dialog={confirmDialog}
          working={working}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={async () => {
            await confirmDialog.onConfirm();
            setConfirmDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PaneHeader({ view, count }: { view: ViewKey; count: number }) {
  const title: Record<ViewKey, string> = {
    library: "技能主库",
    global: "全局应用",
    projects: "项目应用",
    presets: "技能套装",
    settings: "设置",
  };
  return (
    <div className="pane-header">
      <div>
        <h1>{title[view]}</h1>
        <span>{count} 项</span>
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
    return (
      <section className="health-overview clean" aria-label="健康总览">
        <div>
          <strong>健康总览</strong>
          <span>当前没有发现冲突、失效链接或路径异常</span>
        </div>
        <CheckCircle2 size={16} />
      </section>
    );
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
}: {
  skills: Skill[];
  selectedId: string | null;
  checkedIds: Set<string>;
  onToggleCheck: (skillId: string) => void;
  onSelect: (skill: Skill) => void;
}) {
  if (!skills.length) {
    return <EmptyState title="没有匹配的技能" />;
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
            <span className="row-meta">
              {skill.issueCount ? <span className="mini-warn">{skill.issueCount} 个问题</span> : null}
              <span>{skill.enabledCount} 处启用</span>
            </span>
          </button>
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
      <button className="secondary-button" onClick={() => onImport(unmanaged)}>
        <Archive size={16} />
        导入当前范围
      </button>
    </div>
  );
}

function PresetList({
  presets,
  skills,
  selectedId,
  onSelect,
  onCreate,
}: {
  presets: Preset[];
  skills: Skill[];
  selectedId: string | null;
  onSelect: (preset: Preset) => void;
  onCreate: () => void;
}) {
  return (
    <>
      <div className="list-toolbar">
        <button className="secondary-button" onClick={onCreate}>
          <Plus size={16} />
          新建套装
        </button>
      </div>
      {presets.length ? (
        <div className="rows">
          {presets.map((preset) => (
            <button
              key={preset.id}
              className={selectedId === preset.id ? "row selected" : "row"}
              onClick={() => onSelect(preset)}
            >
              <span className="row-main">
                <strong>{preset.name}</strong>
                <small>{preset.description || skillNames(preset, skills)}</small>
              </span>
              <span className="row-meta">{preset.skillIds.length} 个技能</span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState title="还没有技能套装" action="新建套装" onAction={onCreate} />
      )}
    </>
  );
}

function ContextPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="context-panel">
      <h2>{title}</h2>
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
  onPickProject,
  onUpdateAgentPath,
  onRemoveProject,
}: {
  state: AppState;
  onPickProject: () => void;
  onUpdateAgentPath: (agentId: string, path: string) => void;
  onRemoveProject: (projectId: string) => void;
}) {
  return (
    <div className="settings-list">
      <section>
        <h2>智能体应用路径</h2>
        {state.agents.map((agent) => (
          <AgentPathRow key={agent.id} agent={agent} onSave={onUpdateAgentPath} />
        ))}
      </section>
      <section>
        <div className="section-title-row">
          <h2>项目列表</h2>
          <button className="secondary-button" onClick={onPickProject}>
            <FolderPlus size={16} />
            添加项目
          </button>
        </div>
        {state.projects.length ? (
          state.projects.map((project) => (
            <div key={project.id} className="setting-row">
              <div>
                <strong>{project.name}</strong>
                <small>{project.path}</small>
              </div>
              <button className="ghost-button" onClick={() => onRemoveProject(project.id)}>
                移除
              </button>
            </div>
          ))
        ) : (
          <EmptyState title="还没有手动添加的项目" action="添加项目" onAction={onPickProject} />
        )}
      </section>
    </div>
  );
}

function AgentPathRow({
  agent,
  onSave,
}: {
  agent: Agent;
  onSave: (agentId: string, path: string) => void;
}) {
  const [path, setPath] = useState(agent.globalPath);
  useEffect(() => setPath(agent.globalPath), [agent.globalPath]);
  return (
    <div className="setting-row">
      <div>
        <strong>{agent.name}</strong>
        <small>{agent.pathExists ? "路径已存在" : "路径不存在"}</small>
      </div>
      <input value={path} onChange={(event) => setPath(event.target.value)} />
      <button className="secondary-button" onClick={() => onSave(agent.id, path)}>
        保存
      </button>
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
  const title =
    drawer?.type === "preset"
      ? `应用套装：${preset?.name ?? ""}`
      : `分发技能：${drawer?.skillIds.length ?? 0} 个`;

  const targetRows = [
    ...state.agents.map((agent) => ({
      key: `global:${agent.id}`,
      label: `${agent.name} / 全局`,
      path: agent.globalPath,
      target: { agentId: agent.id, projectId: null },
    })),
    ...state.projects.flatMap((project) =>
      state.agents.map((agent) => ({
        key: `project:${project.id}:${agent.id}`,
        label: `${project.name} / ${agent.name}`,
        path: `${project.path}/${agent.projectRelativePath}`,
        target: { agentId: agent.id, projectId: project.id },
      })),
    ),
  ].map((row) => {
    const statuses = drawerSkillIds
      .map((skillId) => findTargetStatus(state, row.target.agentId, row.target.projectId ?? null, skillId))
      .filter((status): status is TargetStatus => Boolean(status));
    const statusLabel = summarizeTargetStatuses(statuses, drawerSkillIds.length);
    const hasOverwriteRisk = statuses.some((status) => status.status === "conflict" || status.status === "unmanaged");
    const hasPathRisk = statuses.some((status) => status.status === "broken" || status.status === "pathMissing" || status.status === "invalid");
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
        : hasPathRisk
          ? "目标路径存在异常"
          : "可直接创建软链接",
      statusLabel,
      hasOverwriteRisk,
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
  const shouldOverwrite = selectedOverwriteRisks + selectedPathRisks > 0;
  const selectedRiskCount = selectedOverwriteRisks + selectedPathRisks;
  const previewRows = selectedRows.slice(0, 3);

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
            {selectedRiskCount ? "；冲突位置会按主库优先处理。" : "。"}
          </p>
        </div>
        <footer>
          {isPreset ? (
            <button className="secondary-button" disabled={!targets.length} onClick={() => void onWithdraw(targets)}>
              <Unlink size={16} />
              收回套装
            </button>
          ) : null}
          <button className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={!targets.length} onClick={() => void onApply(targets, shouldOverwrite)}>
            <Link2 size={16} />
            {shouldOverwrite ? "覆盖并分发" : "确认分发"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function ImportSkillDialog({
  onClose,
  onPickLocal,
  onInstallFromMarket,
  working,
}: {
  onClose: () => void;
  onPickLocal: () => void;
  onInstallFromMarket: (marketUrl: string, version: string) => void;
  working: boolean;
}) {
  const [mode, setMode] = useState<ImportSkillMode>("local");
  const [marketUrl, setMarketUrl] = useState("");
  const [version, setVersion] = useState("");
  const [marketTouched, setMarketTouched] = useState(false);
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose);
  const marketError = validateMarketSkillUrl(marketUrl);
  const showMarketError = mode === "market" && marketTouched && Boolean(marketError);

  return (
    <div className="dialog-backdrop">
      <form
        ref={dialogRef}
        className="dialog import-skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-skill-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "market") {
            setMarketTouched(true);
            if (marketError) return;
            onInstallFromMarket(marketUrl.trim(), version.trim());
          }
        }}
      >
        <header>
          <h2 id="import-skill-title">导入技能</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="dialog-segmented" aria-label="选择技能来源">
          <button
            type="button"
            className={mode === "local" ? "active" : ""}
            onClick={() => setMode("local")}
          >
            本地文件夹
          </button>
          <button
            type="button"
            className={mode === "market" ? "active" : ""}
            onClick={() => setMode("market")}
          >
            市场链接
          </button>
        </div>
        {mode === "local" ? (
          <div className="import-source-panel">
            <button
              type="button"
              className="primary-button"
              disabled={working}
              onClick={onPickLocal}
            >
              <FolderPlus size={16} />
              选择技能文件夹
            </button>
            <p className="field-note">需要选择包含 SKILL.md 的文件夹。</p>
          </div>
        ) : (
          <>
            <label>
              市场链接
              <input
                value={marketUrl}
                onChange={(event) => setMarketUrl(event.target.value)}
                onBlur={() => setMarketTouched(true)}
                placeholder="https://skills.bytedance.net/skill/skills:..."
                aria-invalid={showMarketError}
                aria-describedby={showMarketError ? "market-url-error" : "market-url-note"}
                required
              />
            </label>
            {showMarketError ? (
              <p id="market-url-error" className="field-error" role="alert">{marketError}</p>
            ) : null}
            <label>
              版本号
              <input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="留空安装最新版本"
              />
            </label>
            <p id="market-url-note" className="field-note">只支持公司 Skill 市场详情链接；安装结果会先进入主库，分发位置仍由你单独选择。</p>
          </>
        )}
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          {mode === "market" ? (
            <button
              type="submit"
              className="primary-button"
              disabled={working || Boolean(marketError)}
            >
              <Globe2 size={16} />
              安装
            </button>
          ) : null}
        </footer>
      </form>
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
  const dialogRef = useDialogFocus<HTMLFormElement>(onClose);
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
          onSubmit(next);
        }}
      >
        <header>
          <h2 id="preset-dialog-title">{draft.id ? "编辑技能套装" : "新建技能套装"}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>
        <label>
          套装名称
          <input
            value={next.name}
            onChange={(event) => setNext({ ...next, name: event.target.value })}
            required
          />
        </label>
        <label>
          描述
          <textarea
            value={next.description}
            onChange={(event) => setNext({ ...next, description: event.target.value })}
          />
        </label>
        <div className="preset-skill-picker">
          {skills.map((skill) => (
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
        </div>
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button">
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

function StatusPill({ status }: { status: SkillStatus }) {
  return (
    <span className={`status-pill ${statusTone[status]}`}>
      <span />
      {statusText[status]}
    </span>
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

function SkillPreview({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false);
  const preview = trimMarkdownPreview(skill.contentPreview, expanded ? 4_000 : 1_200);
  const canExpand = skill.contentPreview.length > preview.length;

  return (
    <div className="markdown-preview">
      <div className="preview-title-row">
        <h3>SKILL.md 正文预览</h3>
        {canExpand || expanded ? (
          <button type="button" className="ghost-button compact" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "收起" : "展开"}
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
  if (!statuses.length) return null;
  return (
    <div className="enabled-list">
      <h3>启用位置</h3>
      {statuses.map((status) => (
        <div key={status.id}>
          <strong>{status.projectName ? `${status.projectName} / ${status.agentName}` : `${status.agentName} / 全局`}</strong>
          <code>{status.targetPath}</code>
        </div>
      ))}
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

function EmptyState({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <span>{title}</span>
      {action && onAction ? (
        <button className="secondary-button" onClick={onAction}>
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
      statuses: statuses.filter((status) => status.status === "pathMissing"),
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
      skill: firstStatus ? undefined : firstSkill,
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

function isProblemStatus(status: SkillStatus) {
  return status === "unmanaged"
    || status === "conflict"
    || status === "broken"
    || status === "pathMissing"
    || status === "invalid";
}

function mergeReport(left: OperationReport, right: OperationReport): OperationReport {
  return {
    changed: left.changed + right.changed,
    skipped: left.skipped + right.skipped,
    conflicts: [...left.conflicts, ...right.conflicts],
    errors: [...left.errors, ...right.errors],
  };
}

function formatOperationReport(report: OperationReport, label: string) {
  const parts = [`${label}：变更 ${report.changed} 个`];
  parts.push(`跳过 ${report.skipped} 个`);
  parts.push(`冲突 ${report.conflicts.length} 个`);
  parts.push(`错误 ${report.errors.length} 个`);
  return parts.join("，");
}

function formatReportExamples(values: string[]) {
  if (!values.length) return "";
  return ` 示例：${values.slice(0, 2).join("；")}`;
}

function cleanErrorMessage(cause: unknown) {
  return String(cause).replace(/^Error:\s*/i, "").trim();
}

function formatActionError(cause: unknown) {
  const message = cleanErrorMessage(cause);
  return `${message}。下一步：检查输入内容、目标路径和目录权限后重试；如果是市场安装失败，确认公司网络和登录状态。`;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
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
    return state.skills[0] ? { type: "skill", id: state.skills[0].id } : null;
  }
  if (view === "global") {
    const status = state.globalWorkspaces.find((workspace) => workspace.agentId === agentId)?.statuses[0];
    return status ? { type: "status", id: status.id } : null;
  }
  if (view === "projects") {
    const resolvedProjectId = resolveProjectId(state, projectId);
    const status = state.projectWorkspaces.find(
      (workspace) => workspace.projectId === resolvedProjectId && workspace.agentId === projectAgentId,
    )?.statuses[0];
    return status ? { type: "status", id: status.id } : null;
  }
  if (view === "presets") {
    return state.presets[0] ? { type: "preset", id: state.presets[0].id } : null;
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
    const workspace = state.globalWorkspaces.find((item) => item.agentId === agentId);
    return selection.type === "status" && Boolean(
      workspace?.statuses.some((status) => status.id === selection.id),
    );
  }
  if (view === "projects") {
    if (!projectId) return false;
    const workspace = state.projectWorkspaces.find(
      (item) => item.projectId === projectId && item.agentId === projectAgentId,
    );
    return selection.type === "status" && Boolean(
      workspace?.statuses.some((status) => status.id === selection.id),
    );
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

function slugifyClient(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[\\/:\.\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || value;
}

function marketSkillIdFromUrlClient(value: string) {
  const tail = value.trim().split("/skill/skills:")[1];
  if (!tail) return "";
  const pathPart = tail.split(/[?#]/)[0].split("/-/")[0].replace(/\/+$/, "");
  const parts = pathPart.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function validateMarketSkillUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "请粘贴公司 Skill 市场的技能详情链接。";
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "skills.bytedance.net") {
      return "只支持 skills.bytedance.net 的技能详情链接。";
    }
    if (!url.pathname.includes("/skill/skills:") || !marketSkillIdFromUrlClient(trimmed)) {
      return "链接需要包含 /skill/skills:... 的技能详情路径。";
    }
    return null;
  } catch {
    return "链接格式不正确，请粘贴完整的 https://skills.bytedance.net/skill/skills:... 链接。";
  }
}
