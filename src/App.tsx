import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getAppState,
  importSkill,
  deleteSkill,
  deploySkill,
  withdrawSkill,
  addTarget,
  removeTarget,
  openPath,
  importSkillsFromPackage,
  scanSkillPackage,
  setSkillTags,
  getAllTags,
  getAllTagsInfo,
  renameTag,
  setTagColor,
  deleteTag,
  reorderTag,
} from "./api";
import type {
  AppState,
  Skill,
  Target,
  TargetSkillStatus,
  SkillStatusV2,
  TagInfo,
} from "./types";

type ToastMessage = {
  id: number;
  tone: "success" | "error";
  title: string;
  message: string;
};

type ConfirmRequest = {
  title: string;
  body: string;
  details?: string[];
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => Promise<void>;
};

// ────────────────────────────────────────
// App Shell
// ────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const s = await getAppState();
    setState(s);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading || !state) {
    return <div className="app-shell"><div className="empty-state">加载中…</div></div>;
  }

  return (
    <div className="app-shell">
      <div className="main-content">
        <SkillView state={state} refresh={refresh} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Skill View (unified: browsing + target operations)
// ────────────────────────────────────────

function SkillView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<SkillStatusV2 | null>(null);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const targetDropdownRef = useRef<HTMLDivElement>(null);
  const [tagManageOpen, setTagManageOpen] = useState(false);
  const [tagsInfo, setTagsInfo] = useState<TagInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const showToast = useCallback((message: Omit<ToastMessage, "id">) => {
    const id = Date.now();
    setToast({ ...message, id });
    window.setTimeout(() => {
      setToast(current => current?.id === id ? null : current);
    }, 4200);
  }, []);

  const showError = useCallback((title: string, error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error || fallback);
    showToast({ tone: "error", title, message: message || fallback });
  }, [showToast]);

  const requestConfirm = useCallback((request: ConfirmRequest) => {
    setConfirmRequest(request);
  }, []);

  // Load all known tags
  useEffect(() => {
    getAllTags().then(setKnownTags);
    getAllTagsInfo().then(setTagsInfo);
  }, [state.skills]);

  // Build a color map: tag name → colorIndex (from tagsInfo, fallback to hash)
  const tagColorMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tagsInfo) {
      if (t.colorIndex >= 0) map.set(t.name, t.colorIndex);
    }
    return map;
  }, [tagsInfo]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    state.skills.forEach(s => s.tags.forEach(t => tags.add(t)));
    const tagList = Array.from(tags);
    // Sort by tagsInfo sort_order, fallback to alphabetical
    const orderMap = new Map(tagsInfo.map((t, i) => [t.name, t.sortOrder ?? i]));
    tagList.sort((a, b) => {
      const oa = orderMap.get(a) ?? 9999;
      const ob = orderMap.get(b) ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
    return tagList;
  }, [state.skills, tagsInfo]);

  // Current target's statuses
  const targetStatuses = useMemo(() => {
    if (!activeTargetId) return null;
    return state.targetStatuses.get(activeTargetId) ?? [];
  }, [state.targetStatuses, activeTargetId]);

  // Build a map: skillId → status for the active target
  const skillStatusMap = useMemo(() => {
    if (!targetStatuses) return null;
    const map = new Map<string, TargetSkillStatus>();
    for (const s of targetStatuses) {
      map.set(s.skillId, s);
    }
    return map;
  }, [targetStatuses]);

  const activeTarget = useMemo(
    () => state.targets.find(t => t.id === activeTargetId) ?? null,
    [state.targets, activeTargetId]
  );

  // Count statuses in current target
  const statusCounts = useMemo(() => {
    if (!skillStatusMap) return null;
    let applied = 0, notApplied = 0, problem = 0;
    for (const s of skillStatusMap.values()) {
      if (s.status === "applied") applied++;
      else if (s.status === "notApplied") notApplied++;
      else if (s.status === "problem") problem++;
    }
    return { applied, notApplied, problem, total: applied + notApplied + problem };
  }, [skillStatusMap]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (targetDropdownRef.current && !targetDropdownRef.current.contains(e.target as Node)) {
        setTargetDropdownOpen(false);
      }
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    };
    if (targetDropdownOpen || statusDropdownOpen) {
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [targetDropdownOpen, statusDropdownOpen]);

  const filtered = useMemo(() => {
    let list = state.skills;
    // Text search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.displayName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
      );
    }
    // Tag filter
    if (activeTag) {
      list = list.filter(s => s.tags.includes(activeTag));
    }
    // Status filter (only when target selected)
    if (statusFilter && skillStatusMap) {
      list = list.filter(s => {
        const st = skillStatusMap.get(s.id);
        return st?.status === statusFilter;
      });
    }
    return list;
  }, [state.skills, search, activeTag, statusFilter, skillStatusMap]);

  // Batch stats: count applied/notApplied in current filtered results
  const batchStats = useMemo(() => {
    if (!skillStatusMap) return null;
    let applied = 0;
    let notApplied = 0;
    for (const skill of filtered) {
      const st = skillStatusMap.get(skill.id);
      if (!st || st.status === "notApplied") notApplied++;
      else if (st.status === "applied") applied++;
    }
    return { applied, notApplied, total: filtered.length };
  }, [filtered, skillStatusMap]);

  const selected = useMemo(
    () => state.skills.find(s => s.id === selectedId) ?? null,
    [state.skills, selectedId]
  );

  const handleClose = () => setSelectedId(null);

  const handleContextMenu = (e: React.MouseEvent, skill: Skill) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, skill });
  };

  const handleTagToggle = async (skillId: string, tag: string, currentTags: string[]) => {
    const newTags = currentTags.includes(tag)
      ? currentTags.filter(t => t !== tag)
      : [...currentTags, tag];
    await setSkillTags(skillId, newTags);
    await refresh();
    setContextMenu(null);
  };

  const handleTagCreate = async (skillId: string, tag: string, currentTags: string[]) => {
    if (!tag.trim()) return;
    const newTags = [...currentTags, tag.trim()];
    await setSkillTags(skillId, newTags);
    await refresh();
    setContextMenu(null);
  };

  // Target operations (inline on card)
  const handleDeploy = async (skillId: string, options?: { confirmOverwrite?: boolean }) => {
    if (!activeTarget) return;
    const skill = state.skills.find(s => s.id === skillId);
    const run = async () => {
      try {
        await deploySkill(skillId, [{ targetId: activeTarget.id }], true);
        await refresh();
        showToast({
          tone: "success",
          title: options?.confirmOverwrite ? "已覆盖目标技能" : "已应用技能",
          message: skill ? `「${skill.displayName}」已应用到「${activeTarget.name}」。` : `已应用到「${activeTarget.name}」。`,
        });
      } catch (e) {
        showError("应用失败", e, "请确认目标目录存在并且当前账户有写入权限。");
      }
    };
    if (options?.confirmOverwrite && skill) {
      requestConfirm({
        title: `覆盖「${skill.displayName}」？`,
        body: "目标位置已有异常或冲突项。覆盖会用主库中的技能重新写入目标目录。",
        details: [
          `目标：${activeTarget.name}`,
          `最终路径：${targetSkillPath(activeTarget, skill)}`,
        ],
        confirmLabel: "覆盖技能",
        tone: "danger",
        onConfirm: run,
      });
      return;
    }
    await run();
  };

  const handleWithdraw = async (skillId: string) => {
    if (!activeTarget) return;
    try {
      await withdrawSkill(skillId, [{ targetId: activeTarget.id }]);
      await refresh();
      const skill = state.skills.find(s => s.id === skillId);
      showToast({
        tone: "success",
        title: "已收回技能",
        message: skill ? `「${skill.displayName}」已从「${activeTarget.name}」收回。` : `已从「${activeTarget.name}」收回。`,
      });
    } catch (e) {
      showError("收回失败", e, "请确认目标中的技能是指向主库的软链接。");
    }
  };

  // Batch actions on current filtered results
  const handleBatchDeploy = async () => {
    if (!activeTarget || !skillStatusMap) return;
    const target = { targetId: activeTarget.id };
    const toDeploy = filtered.filter(s => {
      const st = skillStatusMap.get(s.id);
      return !st || st.status === "notApplied";
    });
    if (toDeploy.length === 0) return;
    requestConfirm({
      title: "应用当前筛选结果？",
      body: "这个操作只会应用当前筛选结果中尚未应用的技能，不会处理被筛选隐藏的技能。",
      details: [
        `目标：${activeTarget.name}`,
        `范围：当前筛选结果 ${filtered.length} 个技能`,
        `将应用：${toDeploy.length} 个未应用技能`,
        `目标目录：${targetSkillsPath(activeTarget)}`,
      ],
      confirmLabel: `应用 ${toDeploy.length} 个技能`,
      onConfirm: async () => {
        try {
          for (const skill of toDeploy) {
            await deploySkill(skill.id, [target], true);
          }
          await refresh();
          showToast({
            tone: "success",
            title: "批量应用完成",
            message: `已向「${activeTarget.name}」应用 ${toDeploy.length} 个技能。`,
          });
        } catch (e) {
          showError("批量应用失败", e, "部分技能可能未应用，请刷新后按状态筛选复查。");
        }
      },
    });
  };

  const handleBatchWithdraw = async () => {
    if (!activeTarget || !skillStatusMap) return;
    const target = { targetId: activeTarget.id };
    const toWithdraw = filtered.filter(s => {
      const st = skillStatusMap.get(s.id);
      return st?.status === "applied";
    });
    if (toWithdraw.length === 0) return;
    requestConfirm({
      title: "收回当前筛选结果？",
      body: "这个操作只会收回当前筛选结果中已应用的技能，不会处理被筛选隐藏的技能，也不会删除主库技能。",
      details: [
        `目标：${activeTarget.name}`,
        `范围：当前筛选结果 ${filtered.length} 个技能`,
        `将收回：${toWithdraw.length} 个已应用技能`,
        `目标目录：${targetSkillsPath(activeTarget)}`,
      ],
      confirmLabel: `收回 ${toWithdraw.length} 个技能`,
      tone: "danger",
      onConfirm: async () => {
        try {
          for (const skill of toWithdraw) {
            await withdrawSkill(skill.id, [target]);
          }
          await refresh();
          showToast({
            tone: "success",
            title: "批量收回完成",
            message: `已从「${activeTarget.name}」收回 ${toWithdraw.length} 个技能。`,
          });
        } catch (e) {
          showError("批量收回失败", e, "部分技能可能仍在目标目录中，请刷新后按状态筛选复查。");
        }
      },
    });
  };

  // Reset problem filter when target deselected
  const handleTargetChange = (targetId: string | null) => {
    setActiveTargetId(targetId);
    setStatusFilter(null);
    setStatusDropdownOpen(false);
    setTargetDropdownOpen(false);
  };

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
        {/* Row 1: Target + Search + Import + Settings */}
        <div className="toolbar-row">
          {state.targets.length > 0 && (
            <div className="target-dropdown" ref={targetDropdownRef}>
              <button
                className="target-dropdown-trigger"
                onClick={() => setTargetDropdownOpen(!targetDropdownOpen)}
              >
                <span className="target-dropdown-label">
                  {activeTarget ? activeTarget.name : "全部技能"}
                </span>
                <span className="target-dropdown-chevron">‹</span>
              </button>
              {targetDropdownOpen && (
                <div className="target-dropdown-menu">
                  <div
                    className={`target-dropdown-item ${!activeTargetId ? "active" : ""}`}
                    onClick={() => handleTargetChange(null)}
                  >
                    全部技能
                  </div>
                  {state.targets.map(t => (
                    <div
                      key={t.id}
                      className={`target-dropdown-item ${activeTargetId === t.id ? "active" : ""}`}
                      onClick={() => handleTargetChange(t.id)}
                    >
                      <span>{t.name}</span>
                      <span className="target-dropdown-path">{shortenPath(t.path)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <input
            className="search-input"
            placeholder="搜索技能…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="btn-icon" onClick={() => setShowImport(true)} title="导入技能">
            ＋
          </button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>

        {/* Row 2: Tag filter + Status dropdown */}
        {(allTags.length > 0 || activeTargetId) && (
          <div className="filter-row">
            {allTags.length > 0 && (
              <>
                <button
                  className={`filter-chip ${!activeTag ? "active" : ""}`}
                  onClick={() => { setActiveTag(null); setStatusFilter(null); }}
                >
                  全部
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    className={`filter-chip ${activeTag === tag ? "active" : ""}`}
                    onClick={() => { setActiveTag(activeTag === tag ? null : tag); }}
                  >
                    <span className="filter-chip-dot" style={{ background: TAG_PALETTE[resolveTagColor(tag, tagColorMap)]?.bg }} />
                    {tag}
                  </button>
                ))}
                <button
                  className={`manage-tags-pencil ${tagManageOpen ? "active" : ""}`}
                  onClick={() => setTagManageOpen(!tagManageOpen)}
                  title="管理标签"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
              </>
            )}
            {activeTargetId && statusCounts && (
              <div className="status-dropdown" ref={statusDropdownRef}>
                <button
                  className={`status-dropdown-trigger ${statusFilter ? "active" : ""}`}
                  onClick={() => setStatusDropdownOpen(!statusDropdownOpen)}
                >
                  <span className="status-dropdown-label">
                    {statusFilter === "applied" ? `已应用 · ${statusCounts.applied}` :
                     statusFilter === "notApplied" ? `未应用 · ${statusCounts.notApplied}` :
                     statusFilter === "problem" ? `有问题 · ${statusCounts.problem}` :
                     `全部状态 · ${statusCounts.total}`}
                  </span>
                  <span className="status-dropdown-chevron">{statusDropdownOpen ? "▴" : "▾"}</span>
                </button>
                {statusDropdownOpen && (
                  <div className="status-dropdown-menu">
                    <div
                      className={`status-dropdown-item ${!statusFilter ? "active" : ""}`}
                      onClick={() => { setStatusFilter(null); setStatusDropdownOpen(false); }}
                    >
                      全部状态 · {statusCounts.total}
                    </div>
                    <div
                      className={`status-dropdown-item ${statusFilter === "applied" ? "active" : ""}`}
                      onClick={() => { setStatusFilter("applied"); setStatusDropdownOpen(false); }}
                    >
                      <span className="status-dot applied" />
                      已应用 · {statusCounts.applied}
                    </div>
                    <div
                      className={`status-dropdown-item ${statusFilter === "notApplied" ? "active" : ""}`}
                      onClick={() => { setStatusFilter("notApplied"); setStatusDropdownOpen(false); }}
                    >
                      <span className="status-dot not-applied" />
                      未应用 · {statusCounts.notApplied}
                    </div>
                    {statusCounts.problem > 0 && (
                      <div
                        className={`status-dropdown-item ${statusFilter === "problem" ? "active" : ""}`}
                        onClick={() => { setStatusFilter("problem"); setStatusDropdownOpen(false); }}
                      >
                        <span className="status-dot problem" />
                        有问题 · {statusCounts.problem}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tag Management Panel (inline) */}
        {tagManageOpen && (
          <TagManagementPanel
            tagsInfo={tagsInfo}
            tagColorMap={tagColorMap}
            onColorChange={async (tag, colorIndex) => {
              const updated = await setTagColor(tag, colorIndex);
              setTagsInfo(updated);
            }}
            onRename={async (oldName, newName) => {
              await renameTag(oldName, newName);
              await refresh();
              const updated = await getAllTagsInfo();
              setTagsInfo(updated);
              if (activeTag === oldName) setActiveTag(newName);
            }}
            onDelete={async (tag) => {
              await deleteTag(tag);
              await refresh();
              const updated = await getAllTagsInfo();
              setTagsInfo(updated);
              if (activeTag === tag) setActiveTag(null);
            }}
            onMove={async (tag, direction) => {
              const updated = await reorderTag(tag, direction);
              setTagsInfo(updated);
            }}
          />
        )}
      </div>

      {/* Content: grid */}
      <SkillGrid
        skills={filtered}
        allSkillsCount={state.skills.length}
        hasFilters={!!search || !!activeTag || !!statusFilter}
        skillStatusMap={skillStatusMap}
        hasActiveTarget={!!activeTargetId}
        tagColorMap={tagColorMap}
        onSelect={setSelectedId}
        onContextMenu={handleContextMenu}
        onDeploy={handleDeploy}
        onWithdraw={handleWithdraw}
      />

      {/* Sticky bottom bar: batch actions on filtered results */}
      {activeTargetId && batchStats && (batchStats.notApplied > 0 || batchStats.applied > 0) && (
        <div className="sticky-action-bar">
          <span className="sticky-action-label">
            当前筛选结果 {batchStats.total} 个技能
            {batchStats.notApplied > 0 && <>：{batchStats.notApplied} 个未应用</>}
            {batchStats.notApplied > 0 && batchStats.applied > 0 && " · "}
            {batchStats.applied > 0 && <>{batchStats.applied} 个已应用</>}
          </span>
          <div className="sticky-action-buttons">
            {batchStats.notApplied > 0 && (
              <button className="btn btn-primary btn-sm" onClick={handleBatchDeploy}>
                全部应用
              </button>
            )}
            {batchStats.applied > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleBatchWithdraw}>
                全部收回
              </button>
            )}
          </div>
        </div>
      )}

      {/* Drawer overlay */}
      {selected && (
        <SkillDrawer
          skill={selected}
          state={state}
          knownTags={knownTags}
          tagColorMap={tagColorMap}
          requestConfirm={requestConfirm}
          showToast={showToast}
          showError={showError}
          onClose={handleClose}
          refresh={refresh}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <SkillContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          skill={contextMenu.skill}
          allTags={allTags}
          onTagToggle={handleTagToggle}
          onTagCreate={handleTagCreate}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Modals */}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={async () => { await refresh(); setShowImport(false); }}
        />
      )}
      {/* Settings Drawer */}
      {showSettings && (
        <SettingsDrawer
          state={state}
          refresh={refresh}
          onClose={() => setShowSettings(false)}
        />
      )}
      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onClose={() => setConfirmRequest(null)}
        />
      )}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </>
  );
}

// ── Skill Grid ──

function SkillGrid({
  skills,
  allSkillsCount,
  hasFilters,
  skillStatusMap,
  hasActiveTarget,
  tagColorMap,
  onSelect,
  onContextMenu,
  onDeploy,
  onWithdraw,
}: {
  skills: Skill[];
  allSkillsCount: number;
  hasFilters: boolean;
  skillStatusMap: Map<string, TargetSkillStatus> | null;
  hasActiveTarget: boolean;
  tagColorMap: Map<string, number>;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, skill: Skill) => void;
  onDeploy: (skillId: string, options?: { confirmOverwrite?: boolean }) => void;
  onWithdraw: (skillId: string) => void;
}) {
  if (skills.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">
          {allSkillsCount === 0 ? "主库还没有技能" : "当前筛选没有匹配的技能"}
        </div>
        <div className="empty-state-text">
          {allSkillsCount === 0
            ? "点击右上角加号导入包含 SKILL.md 的文件夹，或导入 .zip 技能包。"
            : hasFilters
              ? "清除搜索、标签或状态筛选后再查看；也可以切换顶部目标确认应用状态。"
              : "当前目标下暂时没有可展示的技能。"}
        </div>
      </div>
    );
  }
  return (
    <div className="skill-grid">
      {skills.map((skill, i) => {
        const status = skillStatusMap?.get(skill.id);
        return (
          <div
            key={skill.id}
            className={`skill-card ${hasActiveTarget ? "has-target" : ""}`}
            style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}
            onClick={() => onSelect(skill.id)}
            onContextMenu={(e) => onContextMenu(e, skill)}
          >
            {/* Header: title + status position (always reserved) */}
            <div className="card-header">
              <div className="card-title">{skill.displayName}</div>
              <div className="card-status-slot">
                {hasActiveTarget && status ? (
                  <span className={`card-status-badge ${statusClass(status.status)}`}>
                    <span className={`status-dot ${statusClass(status.status)}`} />
                    {statusLabel(status.status)}
                  </span>
                ) : (
                  <>
                    {skill.enabledCount > 0 && (
                      <span className="card-stat-text">应用 {skill.enabledCount}</span>
                    )}
                    {skill.issueCount > 0 && (
                      <span className="card-stat-text problem">问题 {skill.issueCount}</span>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="card-desc">{skill.description}</div>

            {/* Footer: tags only + hover action overlay */}
            <div className="card-footer">
              <div className="card-tags">
                {skill.tags.map(t => {
                  const ci = resolveTagColor(t, tagColorMap);
                  const p = TAG_PALETTE[ci];
                  return (
                    <span key={t} className="tag" style={{ background: p.bg, color: p.text }}>{t}</span>
                  );
                })}
              </div>
            </div>
            {hasActiveTarget && status && (
              <div className="card-hover-action" onClick={e => e.stopPropagation()}>
                {status.status === "applied" && (
                  <button className="btn btn-sm btn-secondary" onClick={() => onWithdraw(skill.id)}>
                    收回
                  </button>
                )}
                {status.status === "notApplied" && (
                  <button className="btn btn-sm btn-primary" onClick={() => onDeploy(skill.id)}>
                    应用
                  </button>
                )}
                {status.status === "problem" && (
                  <button className="btn btn-sm btn-primary" onClick={() => onDeploy(skill.id, { confirmOverwrite: true })}>
                    覆盖
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Skill Drawer (overlay) ──

function SkillDrawer({
  skill,
  state,
  knownTags,
  tagColorMap,
  requestConfirm,
  showToast,
  showError,
  onClose,
  refresh,
}: {
  skill: Skill;
  state: AppState;
  knownTags: string[];
  tagColorMap: Map<string, number>;
  requestConfirm: (request: ConfirmRequest) => void;
  showToast: (message: Omit<ToastMessage, "id">) => void;
  showError: (title: string, error: unknown, fallback: string) => void;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [closing, setClosing] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Compute this skill's status across all targets
  const targetRows = useMemo(() => {
    const rows: Array<{ target: Target; status: TargetSkillStatus | null }> = [];
    for (const target of state.targets) {
      const statuses = state.targetStatuses.get(target.id) ?? [];
      const match = statuses.find(s => s.skillId === skill.id);
      rows.push({ target, status: match ?? null });
    }
    return rows;
  }, [state, skill.id]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => onClose(), 280);
  }, [onClose]);

  // Esc key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleClose]);

  // Focus trap: move focus into drawer on open
  useEffect(() => {
    drawerRef.current?.focus({ preventScroll: true });
  }, []);

  const handleDelete = async () => {
    if (!confirm(`确定要删除技能「${skill.displayName}」吗？此操作不可撤销。`)) return;
    setDeleting(true);
    await deleteSkill(skill.id);
    onClose();
    window.location.reload();
  };

  const handleTagsChange = async (newTags: string[]) => {
    await setSkillTags(skill.id, newTags);
    await refresh();
  };

  const handleInlineDeploy = async (target: Target, options?: { confirmOverwrite?: boolean }) => {
    const run = async () => {
      try {
        await deploySkill(skill.id, [{ targetId: target.id }], true);
        await refresh();
        showToast({
          tone: "success",
          title: options?.confirmOverwrite ? "已覆盖目标技能" : "已应用技能",
          message: `「${skill.displayName}」已应用到「${target.name}」。`,
        });
      } catch (e) {
        showError("应用失败", e, "请确认目标目录存在并且当前账户有写入权限。");
      }
    };
    if (options?.confirmOverwrite) {
      requestConfirm({
        title: `覆盖「${skill.displayName}」？`,
        body: "目标位置已有异常或冲突项。覆盖会用主库中的技能重新写入目标目录。",
        details: [
          `目标：${target.name}`,
          `最终路径：${targetSkillPath(target, skill)}`,
        ],
        confirmLabel: "覆盖技能",
        tone: "danger",
        onConfirm: run,
      });
      return;
    }
    await run();
  };

  const handleInlineWithdraw = async (target: Target) => {
    try {
      await withdrawSkill(skill.id, [{ targetId: target.id }]);
      await refresh();
      showToast({
        tone: "success",
        title: "已收回技能",
        message: `「${skill.displayName}」已从「${target.name}」收回。`,
      });
    } catch (e) {
      showError("收回失败", e, "请确认目标中的技能是指向主库的软链接。");
    }
  };

  return (
    <div className={`drawer-overlay ${closing ? "closing" : ""}`} onClick={handleClose}>
      <div
        ref={drawerRef}
        className={`drawer-panel ${closing ? "closing" : ""}`}
        onClick={e => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="drawer-header">
          <h2 className="drawer-title">{skill.displayName}</h2>
          <div className="drawer-header-actions">
            <button
              className="drawer-icon-btn"
              onClick={() => openPath(skill.path)}
              title="打开目录"
            >
              <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button
              className="drawer-icon-btn danger"
              onClick={handleDelete}
              disabled={deleting}
              title="删除"
            >
              <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button className="drawer-icon-btn" onClick={handleClose}>
              <svg viewBox="0 0 24 24"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Description */}
        <div className="drawer-desc">{skill.description}</div>

        {/* Tags */}
        <TagEditor
          tags={skill.tags}
          knownTags={knownTags}
          tagColorMap={tagColorMap}
          onChange={handleTagsChange}
        />

        {/* Target status with inline actions */}
        <div className="drawer-section">
          <div className="drawer-section-title">应用状态</div>
          {targetRows.map(({ target, status }) => {
            const s = status?.status ?? "notApplied";
            return (
              <div key={target.id} className="target-action-row">
                <span className="target-action-name">
                  <span className={`status-dot ${statusClass(s)}`} />
                  {target.name}
                </span>
                {s === "notApplied" && (
                  <button
                    className="row-action-btn apply"
                    onClick={() => handleInlineDeploy(target)}
                  >
                    应用
                  </button>
                )}
                {s === "applied" && (
                  <button
                    className="row-action-btn withdraw"
                    onClick={() => handleInlineWithdraw(target)}
                  >
                    收回
                  </button>
                )}
                {s === "problem" && (
                  <button
                    className="row-action-btn apply"
                    onClick={() => handleInlineDeploy(target, { confirmOverwrite: true })}
                  >
                    覆盖
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Content preview - collapsible */}
        {skill.contentPreview && (
          <div className="drawer-section">
            <div
              className="drawer-section-title drawer-collapsible"
              onClick={() => setShowContent(!showContent)}
            >
              <span>SKILL.md</span>
              <span className={`drawer-chevron ${showContent ? "open" : ""}`}>›</span>
            </div>
            {showContent && (
              <div className="markdown-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {skill.contentPreview}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tag Editor (inline in detail panel) ──

function TagEditor({
  tags,
  knownTags,
  tagColorMap,
  onChange,
}: {
  tags: string[];
  knownTags: string[];
  tagColorMap: Map<string, number>;
  onChange: (tags: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    if (!input.trim()) return knownTags.filter(t => !tags.includes(t));
    const q = input.toLowerCase();
    return knownTags.filter(t => !tags.includes(t) && t.toLowerCase().includes(q));
  }, [input, knownTags, tags]);

  const handleAdd = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    onChange([...tags, trimmed]);
    setInput("");
    setHighlightIndex(-1);
    inputRef.current?.focus();
  };

  const handleRemove = (tag: string) => {
    onChange(tags.filter(t => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
        handleAdd(suggestions[highlightIndex]);
      } else if (input.trim()) {
        handleAdd(input);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Escape") {
      setEditing(false);
      setInput("");
    }
  };

  return (
    <div className="tag-editor">
      {tags.map(tag => {
        const ci = resolveTagColor(tag, tagColorMap);
        const p = TAG_PALETTE[ci];
        return (
          <span key={tag} className="tag-pill" style={{ background: p.bg, color: p.text }}>
            {tag}
            <span className="tag-remove" onClick={() => handleRemove(tag)}>✕</span>
          </span>
        );
      })}
      {!editing ? (
        <button className="tag-add-btn" onClick={() => { setEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }}>
          +
        </button>
      ) : (
        <div className="tag-input-wrapper">
          <input
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); setHighlightIndex(-1); }}
            onKeyDown={handleKeyDown}
            onBlur={() => { setTimeout(() => { setEditing(false); setInput(""); }, 150); }}
            placeholder="输入标签…"
          />
          {(editing && (suggestions.length > 0 || input.trim())) && (
            <div className="tag-autocomplete">
              {suggestions.slice(0, 6).map((s, i) => (
                <div
                  key={s}
                  className={`tag-autocomplete-item ${i === highlightIndex ? "highlighted" : ""}`}
                  onMouseDown={() => handleAdd(s)}
                >
                  {s}
                </div>
              ))}
              {input.trim() && !knownTags.includes(input.trim()) && (
                <div
                  className="tag-autocomplete-item"
                  onMouseDown={() => handleAdd(input)}
                >
                  创建「{input.trim()}」
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tag Management Panel (inline below filter bar) ──

function TagManagementPanel({
  tagsInfo,
  tagColorMap,
  onColorChange,
  onRename,
  onDelete,
  onMove,
}: {
  tagsInfo: TagInfo[];
  tagColorMap: Map<string, number>;
  onColorChange: (tag: string, colorIndex: number) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (tag: string) => void;
  onMove: (tag: string, direction: "up" | "down") => void;
}) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pickerTag, setPickerTag] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerTag) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerTag(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerTag]);

  const handleRenameSubmit = (oldName: string) => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== oldName) {
      onRename(oldName, trimmed);
    }
    setEditingTag(null);
  };

  return (
    <div className="tag-manage-panel">
      <div className="tag-manage-header">
        <span className="tag-manage-title">标签管理</span>
        <span className="tag-manage-hint">用上下箭头排序 · 点击颜色修改 · 点击名称重命名</span>
      </div>
      <div className="tag-manage-list">
        {tagsInfo.map((t, idx) => {
          const ci = resolveTagColor(t.name, tagColorMap);
          const p = TAG_PALETTE[ci];
          return (
            <div key={t.name} className="tag-manage-row">
              <div className="tag-manage-color-wrap" style={{ position: "relative" }}>
                <span
                  className="tag-manage-dot"
                  style={{ background: p.text }}
                  onClick={() => setPickerTag(pickerTag === t.name ? null : t.name)}
                />
                {pickerTag === t.name && (
                  <div className="tag-color-picker" ref={pickerRef}>
                    {TAG_PALETTE.map((c, i) => (
                      <span
                        key={i}
                        className={`tag-color-option ${i === ci ? "selected" : ""}`}
                        style={{ background: c.text }}
                        onClick={() => { onColorChange(t.name, i); setPickerTag(null); }}
                      />
                    ))}
                  </div>
                )}
              </div>
              {editingTag === t.name ? (
                <input
                  className="tag-manage-name-input"
                  value={editValue}
                  autoFocus
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleRenameSubmit(t.name);
                    if (e.key === "Escape") setEditingTag(null);
                  }}
                  onBlur={() => handleRenameSubmit(t.name)}
                />
              ) : (
                <span
                  className="tag-manage-name"
                  onClick={() => { setEditingTag(t.name); setEditValue(t.name); }}
                >
                  {t.name}
                </span>
              )}
              <span className="tag-manage-count">{t.count} 个技能</span>
              <span className="tag-manage-move">
                <button
                  className="tag-move-btn"
                  disabled={idx === 0}
                  onClick={() => onMove(t.name, "up")}
                  title="上移"
                >↑</button>
                <button
                  className="tag-move-btn"
                  disabled={idx === tagsInfo.length - 1}
                  onClick={() => onMove(t.name, "down")}
                  title="下移"
                >↓</button>
              </span>
              {confirmDelete === t.name ? (
                <span className="tag-manage-confirm">
                  <button className="tag-manage-confirm-btn" onClick={() => { onDelete(t.name); setConfirmDelete(null); }}>
                    删除标签
                  </button>
                  <button className="tag-manage-cancel-btn" onClick={() => setConfirmDelete(null)}>
                    取消
                  </button>
                </span>
              ) : (
                <button
                  className="tag-manage-delete"
                  onClick={() => setConfirmDelete(t.name)}
                  title="删除标签"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {tagsInfo.length === 0 && (
          <div className="tag-manage-empty">
            还没有标签。打开任意技能卡片，在详情抽屉的标签区域点击「+」创建第一个标签。
          </div>
        )}
      </div>
    </div>
  );
}

// ── Context Menu (right-click on card) ──

function SkillContextMenu({
  x,
  y,
  skill,
  allTags,
  onTagToggle,
  onTagCreate,
  onClose,
}: {
  x: number;
  y: number;
  skill: Skill;
  allTags: string[];
  onTagToggle: (skillId: string, tag: string, currentTags: string[]) => void;
  onTagCreate: (skillId: string, tag: string, currentTags: string[]) => void;
  onClose: () => void;
}) {
  const [newTag, setNewTag] = useState("");

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newTag.trim()) {
      onTagCreate(skill.id, newTag.trim(), skill.tags);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  // Adjust position to not overflow viewport
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - 300),
  };

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" style={style}>
        <div className="context-menu-label">标签</div>
        {allTags.map(tag => (
          <div
            key={tag}
            className="context-menu-item"
            onClick={() => onTagToggle(skill.id, tag, skill.tags)}
          >
            <span>{tag}</span>
            {skill.tags.includes(tag) && <span className="check">✓</span>}
          </div>
        ))}
        {allTags.length > 0 && <div className="context-menu-divider" />}
        <div className="context-menu-input">
          <input
            autoFocus
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="新建标签…"
          />
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────
// Settings Drawer
// ────────────────────────────────────────

function SettingsDrawer({ state, refresh, onClose }: { state: AppState; refresh: () => Promise<void>; onClose: () => void }) {
  const handleAddTarget = async () => {
    const selected = await open({ directory: true, title: "选择目标目录" });
    if (!selected) return;
    await addTarget(selected as string);
    await refresh();
  };

  const handleRemoveTarget = async (id: string) => {
    await removeTarget(id);
    await refresh();
  };

  return (
    <div className="settings-drawer-backdrop" onClick={onClose}>
      <aside className="settings-drawer" onClick={e => e.stopPropagation()}>
        <div className="settings-drawer-header">
          <h2>设置</h2>
          <button className="settings-drawer-close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-drawer-body">

          <div className="settings-section">
            <div className="settings-section-label">技能根目录</div>
            <div className="settings-path-card">
              <div className="settings-path-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
              </div>
              <div className="settings-path-info">
                <div className="settings-path-name">主库</div>
                <div className="settings-path-value">{state.skillsRoot}</div>
              </div>
              <button className="settings-path-action" onClick={() => openPath(state.skillsRoot)} title="打开">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </button>
            </div>
            <div className="settings-section-hint">所有技能以此目录为唯一事实源</div>
          </div>

          <div className="settings-section">
            <div className="settings-section-label">目标目录</div>
            {state.targets.map(t => (
              <div key={t.id} className="settings-path-card">
                <div className="settings-path-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
                </div>
                <div className="settings-path-info">
                  <div className="settings-path-name">
                    {t.name}
                    {t.isDefault && <span className="settings-default-badge">默认</span>}
                  </div>
                  <div className="settings-path-value">{t.path}</div>
                </div>
                <button className="settings-path-action" onClick={() => openPath(t.path)} title="打开">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
                {!t.isDefault && (
                  <button className="settings-path-action settings-path-action-danger" onClick={() => handleRemoveTarget(t.id)} title="移除">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                )}
              </div>
            ))}
            <button className="settings-add-btn" onClick={handleAddTarget}>+ 添加目标</button>
            <div className="settings-section-hint">技能通过软链接分发到目标目录</div>
          </div>

        </div>
      </aside>
    </div>
  );
}

// ────────────────────────────────────────
// Modals
// ────────────────────────────────────────

function ImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async () => {
    setError(null);
    const selected = await open({
      directory: true,
      title: "选择包含 SKILL.md 的文件夹或 .zip 压缩包",
      filters: [{ name: "技能", extensions: ["zip"] }],
    });
    if (!selected) return;

    setImporting(true);
    try {
      const path = selected as string;
      if (path.endsWith(".zip")) {
        const scan = await scanSkillPackage(path) as { skills?: Array<{ id: string }> };
        const ids = (scan.skills ?? []).map((s: { id: string }) => s.id);
        if (ids.length > 0) {
          await importSkillsFromPackage(path, ids);
        }
      } else {
        await importSkill(path);
      }
      onDone();
    } catch (e) {
      setError(`导入失败：${e}`);
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={e => e.stopPropagation()}>
        <div className="import-modal-header">
          <h3>导入技能</h3>
          <button className="import-modal-close" onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1.5 1.5L12.5 12.5M12.5 1.5L1.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <button
          className="import-zone"
          onClick={handleSelect}
          disabled={importing}
          type="button"
        >
          {importing ? (
            <div className="import-zone-content">
              <div className="import-spinner" />
              <span className="import-zone-label">正在导入…</span>
            </div>
          ) : (
            <div className="import-zone-content">
              <svg className="import-zone-icon" width="32" height="32" viewBox="0 0 32 32" fill="none">
                <path d="M4 13V25C4 26.1 4.9 27 6 27H26C27.1 27 28 26.1 28 25V13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M4 13L7.5 6H24.5L28 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M4 13H11L13 16H19L21 13H28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="import-zone-label">选择文件夹或压缩包</span>
              <span className="import-zone-hint">包含 SKILL.md 的文件夹，或 .zip 压缩包</span>
            </div>
          )}
        </button>

        {error && <p className="import-error">{error}</p>}

        <p className="import-note">导入后进入主库，需再手动分发到目标目录。</p>

        <div className="import-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, working]);

  const handleConfirm = async () => {
    setWorking(true);
    try {
      await request.onConfirm();
      onClose();
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="confirm-backdrop" onClick={working ? undefined : onClose}>
      <section className="confirm-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-kicker">确认操作</div>
        <h3 id="confirm-title">{request.title}</h3>
        <p>{request.body}</p>
        {request.details && request.details.length > 0 && (
          <div className="confirm-details">
            {request.details.map(detail => (
              <div key={detail} className="confirm-detail-row">{detail}</div>
            ))}
          </div>
        )}
        <div className="confirm-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={working}>
            先不操作
          </button>
          <button
            className={`btn ${request.tone === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={handleConfirm}
            disabled={working}
          >
            {working ? "处理中…" : request.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function Toast({
  message,
  onClose,
}: {
  message: ToastMessage;
  onClose: () => void;
}) {
  return (
    <div className={`toast toast-${message.tone}`} role="status" aria-live="polite">
      <div>
        <div className="toast-title">{message.title}</div>
        <div className="toast-message">{message.message}</div>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="关闭提示">×</button>
    </div>
  );
}

// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

function statusClass(s: SkillStatusV2): string {
  if (s === "applied") return "applied";
  if (s === "problem") return "problem";
  return "not-applied";
}

function statusLabel(s: SkillStatusV2): string {
  if (s === "applied") return "已应用";
  if (s === "problem") return "有问题";
  return "未应用";
}

function targetSkillsPath(target: Target): string {
  if (target.isDefault || target.path.endsWith("/skills")) return target.path;
  return `${target.path}/.agents/skills`;
}

function targetSkillPath(target: Target, skill: Skill): string {
  return `${targetSkillsPath(target)}/${skill.name}`;
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

// Stable color index for a tag name (hash → 0..15)
function tagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 16;
}

// 16-color preset palette: { bg, text } for each index
const TAG_PALETTE: { bg: string; text: string }[] = [
  { bg: "#DBEAFE", text: "#1E40AF" },   // 0 天蓝
  { bg: "#D1FAE5", text: "#065F46" },   // 1 薄荷
  { bg: "#FEF3C7", text: "#92400E" },   // 2 琥珀
  { bg: "#FEE2E2", text: "#991B1B" },   // 3 珊瑚
  { bg: "#F3E8FF", text: "#6B21A8" },   // 4 紫藤
  { bg: "#CFFAFE", text: "#155E75" },   // 5 青碧
  { bg: "#FFEDD5", text: "#9A3412" },   // 6 蜜橘
  { bg: "#FCE7F3", text: "#9D174D" },   // 7 樱粉
  { bg: "#E0E7FF", text: "#3730A3" },   // 8 靛蓝
  { bg: "#ECFCCB", text: "#3F6212" },   // 9 青柠
  { bg: "#FEF9C3", text: "#854D0E" },   // 10 奶黄
  { bg: "#CCFBF1", text: "#115E59" },   // 11 翡翠
  { bg: "#F5F3FF", text: "#5B21B6" },   // 12 薰衣草
  { bg: "#FFF1F2", text: "#9F1239" },   // 13 玫瑰
  { bg: "#F3F4F6", text: "#374151" },   // 14 银灰
  { bg: "#E5E7EB", text: "#1F2937" },   // 15 石墨
];

// Resolve tag color: use stored color_index if available, otherwise hash fallback
function resolveTagColor(tag: string, colorMap: Map<string, number>): number {
  const stored = colorMap.get(tag);
  if (stored !== undefined && stored >= 0) return stored % 16;
  return tagColorIndex(tag);
}
