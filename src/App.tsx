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
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addProject,
  adoptSkillFromTarget,
  applyPreset,
  createSkill,
  deletePreset,
  deleteSkill,
  deploySkill,
  getAppState,
  importSkill,
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

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("library");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("codex");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProjectAgentId, setSelectedProjectAgentId] = useState<string>("codex");
  const [checkedSkillIds, setCheckedSkillIds] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<PresetDraft | null>(null);

  async function load(showSpinner = false) {
    try {
      if (showSpinner) {
        setLoading(true);
      }
      setError(null);
      const next = await getAppState();
      setState(next);
      if (!selected && next.skills[0]) {
        setSelected({ type: "skill", id: next.skills[0].id });
      }
      if (!selectedProjectId && next.projects[0]) {
        setSelectedProjectId(next.projects[0].id);
      }
      if (!next.agents.some((agent) => agent.id === selectedAgentId) && next.agents[0]) {
        setSelectedAgentId(next.agents[0].id);
      }
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

  const selectedSkill = useMemo(() => {
    if (!state || selected?.type !== "skill") return null;
    return state.skills.find((skill) => skill.id === selected.id) ?? null;
  }, [selected, state]);

  const selectedStatus = useMemo(() => {
    if (!selected || selected.type !== "status") return null;
    return allStatuses.find((status) => status.id === selected.id) ?? null;
  }, [allStatuses, selected]);

  const selectedPreset = useMemo(() => {
    if (!state || selected?.type !== "preset") return null;
    return state.presets.find((preset) => preset.id === selected.id) ?? null;
  }, [selected, state]);

  const filteredSkills = useMemo(() => {
    if (!state) return [];
    return state.skills.filter((skill) => matchesQuery(query, [
      skill.displayName,
      skill.name,
      skill.description,
      skill.path,
      ...skill.tags,
    ]));
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

  async function runAction(action: () => Promise<void>, success?: string) {
    try {
      setWorking(true);
      setError(null);
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setWorking(false);
    }
  }

  async function refreshAfterReport(report: OperationReport, successLabel: string) {
    await load();
    const parts = [`${successLabel}：变更 ${report.changed} 个`];
    if (report.skipped) parts.push(`跳过 ${report.skipped} 个`);
    if (report.conflicts.length) parts.push(`冲突 ${report.conflicts.length} 个`);
    if (report.errors.length) parts.push(`错误 ${report.errors.length} 个`);
    setNotice(parts.join("，"));
  }

  async function pickAndImportSkill() {
    const picked = await open({ directory: true, multiple: false, title: "选择技能文件夹" });
    if (!picked || Array.isArray(picked)) return;
    await runAction(async () => {
      setState(await importSkill(picked));
    }, "已导入技能");
  }

  async function pickAndAddProject() {
    const picked = await open({ directory: true, multiple: false, title: "选择项目目录" });
    if (!picked || Array.isArray(picked)) return;
    await runAction(async () => {
      const next = await addProject(picked);
      setState(next);
      const project = next.projects.find((item) => item.path === picked);
      if (project) setSelectedProjectId(project.id);
    }, "已添加项目");
  }

  async function adoptStatuses(statuses: TargetStatus[]) {
    if (!statuses.length) return;
    const confirmed = window.confirm(
      `将把 ${statuses.length} 个存量技能导入主库，并把原位置改成指向主库的软链接。此操作按主库优先处理同名技能。`,
    );
    if (!confirmed) return;
    await runAction(async () => {
      let nextState: AppState | null = null;
      for (const status of statuses) {
        nextState = await adoptSkillFromTarget(
          status.agentId,
          status.projectId ?? null,
          status.skillName,
        );
      }
      if (nextState) setState(nextState);
      await load();
    }, "已导入存量技能");
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
        <SkillList
          skills={filteredSkills}
          selectedId={selected?.type === "skill" ? selected.id : null}
          checkedIds={checkedSkillIds}
          onToggleCheck={toggleChecked}
          onSelect={(skill) => setSelected({ type: "skill", id: skill.id })}
        />
      );
    }

    if (view === "global") {
      const statuses = (globalWorkspace?.statuses ?? []).filter((status) =>
        matchesQuery(query, [
          status.displayName,
          status.skillName,
          status.description,
          status.targetPath,
          status.agentName,
          statusText[status.status],
        ]),
      );
      return (
        <>
          <AgentTabs
            agents={state.agents}
            selectedId={selectedAgentId}
            onSelect={setSelectedAgentId}
          />
          <ImportExistingToolbar
            statuses={globalWorkspace?.statuses ?? []}
            onImport={adoptStatuses}
          />
          <StatusList
            statuses={statuses}
            selectedId={selected?.type === "status" ? selected.id : null}
            onSelect={(status) => setSelected({ type: "status", id: status.id })}
          />
        </>
      );
    }

    if (view === "projects") {
      const statuses = (projectWorkspace?.statuses ?? []).filter((status) =>
        matchesQuery(query, [
          status.displayName,
          status.skillName,
          status.description,
          status.targetPath,
          status.agentName,
          status.projectName ?? "",
          statusText[status.status],
        ]),
      );
      return (
        <>
          <ProjectSelector
            projects={state.projects}
            selectedId={selectedProjectId}
            onSelect={setSelectedProjectId}
            onAdd={pickAndAddProject}
          />
          {selectedProjectId ? (
            <>
              <AgentTabs
                agents={state.agents}
                selectedId={selectedProjectAgentId}
                onSelect={setSelectedProjectAgentId}
              />
              <ImportExistingToolbar
                statuses={projectWorkspace?.statuses ?? []}
                onImport={adoptStatuses}
              />
              <StatusList
                statuses={statuses}
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
        onRemoveProject={(projectId) =>
          runAction(async () => setState(await removeProject(projectId)), "已移除项目")
        }
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

    if (selectedStatus) {
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
                    setState(
                      await adoptSkillFromTarget(
                        selectedStatus.agentId,
                        selectedStatus.projectId ?? null,
                        selectedStatus.skillName,
                      ),
                    );
                  }, "已入库并重建软链接")
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
                onClick={() =>
                  runAction(async () => {
                    const report = await deploySkill(
                      librarySkill.id,
                      [
                        {
                          agentId: selectedStatus.agentId,
                          projectId: selectedStatus.projectId ?? null,
                        },
                      ],
                      true,
                    );
                    await refreshAfterReport(report, "已按主库分发");
                  })
                }
              >
                <Link2 size={16} />
                用主库覆盖
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
              onClick={() =>
                runAction(async () => {
                  setState(await deletePreset(selectedPreset.id));
                  setSelected(null);
                }, "已删除套装")
              }
            >
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </ContextPanel>
      );
    }

    const skill = selectedSkill ?? state.skills[0] ?? null;
    if (!skill) {
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
            <EmptyState title="主库里还没有技能" action="新建技能" onAction={() => setNewSkillOpen(true)} />
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
            onClick={() =>
              runAction(async () => {
                setState(await deleteSkill(skill.id));
                setSelected(null);
              }, "已删除技能")
            }
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
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">技</div>
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
                onClick={() => {
                  setView(item.key);
                  if (item.key === "settings") setSelected({ type: "settings" });
                }}
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

      <main className="main-surface">
        <header className="topbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索技能、项目、智能体应用或路径"
            />
          </div>
          <div className="topbar-actions">
            <button className="secondary-button" disabled={working} onClick={() => void load()}>
              <RefreshCw size={16} />
              刷新
            </button>
            <button className="secondary-button" onClick={() => setNewSkillOpen(true)}>
              <Plus size={16} />
              新建技能
            </button>
            <button className="primary-button" onClick={() => void pickAndImportSkill()}>
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

        <section className="workspace">
          <div className="list-pane">
            <PaneHeader
              view={view}
              count={
                view === "library"
                  ? filteredSkills.length
                  : view === "global"
                    ? globalWorkspace?.statuses.length ?? 0
                    : view === "projects"
                      ? projectWorkspace?.statuses.length ?? 0
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

      {newSkillOpen ? (
        <NewSkillDialog
          onClose={() => setNewSkillOpen(false)}
          onSubmit={(name, description) =>
            runAction(async () => {
              const next = await createSkill(name, description);
              setState(next);
              const skill = next.skills.find((item) => item.name === slugifyClient(name));
              if (skill) setSelected({ type: "skill", id: skill.id });
              setNewSkillOpen(false);
            }, "已新建技能")
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
        <button
          key={skill.id}
          className={selectedId === skill.id ? "row selected" : "row"}
          onClick={() => onSelect(skill)}
        >
          <span
            className="row-check"
            onClick={(event) => {
              event.stopPropagation();
              onToggleCheck(skill.id);
            }}
            role="checkbox"
            aria-checked={checkedIds.has(skill.id)}
            tabIndex={0}
          >
            {checkedIds.has(skill.id) ? <CheckCircle2 size={16} /> : <Circle size={16} />}
          </span>
          <span className="row-main">
            <strong>{skill.displayName}</strong>
            <small>{skill.description}</small>
          </span>
          <span className="row-meta">
            {skill.issueCount ? <span className="mini-warn">{skill.issueCount} 个问题</span> : null}
            <span>{skill.enabledCount} 处启用</span>
          </span>
        </button>
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
      <button className="icon-button" onClick={onAdd} aria-label="添加项目">
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
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const isPreset = drawer?.type === "preset";
  const title =
    drawer?.type === "preset"
      ? `应用套装：${state.presets.find((preset) => preset.id === drawer.presetId)?.name ?? ""}`
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
  ];

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

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" aria-label="分发面板">
        <header>
          <div>
            <h2>{title}</h2>
            <span>选择要启用的全局或项目位置</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="drawer-list">
          {targetRows.map((row) => (
            <button
              key={row.key}
              className={selectedTargets.has(row.key) ? "target-row selected" : "target-row"}
              onClick={() => toggle(row.key)}
            >
              {selectedTargets.has(row.key) ? <CheckCircle2 size={16} /> : <Circle size={16} />}
              <span>
                <strong>{row.label}</strong>
                <small>{row.path}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="overwrite-line">
          <AlertTriangle size={16} />
          主库优先：确认后会覆盖目标位置的同名内容。
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
          <button className="primary-button" disabled={!targets.length} onClick={() => void onApply(targets, true)}>
            <Link2 size={16} />
            确认分发
          </button>
        </footer>
      </aside>
    </div>
  );
}

function NewSkillDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <div className="dialog-backdrop">
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(name, description);
        }}
      >
        <header>
          <h2>新建技能</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <label>
          技能名称
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          描述
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <footer>
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button">
            创建
          </button>
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
        className="dialog wide"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(next);
        }}
      >
        <header>
          <h2>{draft.id ? "编辑技能套装" : "新建技能套装"}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
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
  return (
    <div className="markdown-preview">
      <h3>SKILL.md</h3>
      {skill.contentPreview ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.contentPreview}</ReactMarkdown>
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

function mergeReport(left: OperationReport, right: OperationReport): OperationReport {
  return {
    changed: left.changed + right.changed,
    skipped: left.skipped + right.skipped,
    conflicts: [...left.conflicts, ...right.conflicts],
    errors: [...left.errors, ...right.errors],
  };
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
