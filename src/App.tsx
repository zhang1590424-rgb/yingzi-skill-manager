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
  adoptSkillFromTarget,
  removeUnmanagedSkill,
  addProject,
  removeProject,
  addGlobalDir,
  removeGlobalDir,
  openPath,
  importSkillsFromPackage,
  scanSkillPackage,
  setSkillTags,
  getAllTags,
} from "./api";
import type {
  AppState,
  Skill,
  Target,
  TargetSkillStatus,
  ViewKey,
  SkillStatusV2,
} from "./types";

// ────────────────────────────────────────
// App Shell
// ────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<ViewKey>("skills");
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
      <Sidebar view={view} onViewChange={setView} />
      <div className="main-content">
        <div className="drag-area" />
        {view === "skills" && <SkillView state={state} refresh={refresh} />}
        {view === "targets" && <TargetView state={state} refresh={refresh} />}
        {view === "settings" && <SettingsView state={state} refresh={refresh} />}
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Sidebar
// ────────────────────────────────────────

const NAV_ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: "skills", label: "技能" },
  { key: "targets", label: "目标" },
  { key: "settings", label: "设置" },
];

function Sidebar({ view, onViewChange }: { view: ViewKey; onViewChange: (v: ViewKey) => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-label">影子</div>
      {NAV_ITEMS.map(item => (
        <div
          key={item.key}
          className={`sidebar-item ${view === item.key ? "active" : ""}`}
          onClick={() => onViewChange(item.key)}
        >
          {item.label}
        </div>
      ))}
    </aside>
  );
}

// ────────────────────────────────────────
// Skill View
// ────────────────────────────────────────

function SkillView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);

  // Load all known tags
  useEffect(() => {
    getAllTags().then(setKnownTags);
  }, [state.skills]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    state.skills.forEach(s => s.tags.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [state.skills]);

  const filtered = useMemo(() => {
    let list = state.skills;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s =>
        s.displayName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
      );
    }
    if (activeTag) {
      list = list.filter(s => s.tags.includes(activeTag));
    }
    return list;
  }, [state.skills, search, activeTag]);

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

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-row">
          <input
            className="search-input"
            placeholder="搜索技能…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="btn btn-primary" onClick={() => setShowImport(true)}>
            导入技能
          </button>
        </div>
        {allTags.length > 0 && (
          <div className="filter-row">
            <button
              className={`filter-chip ${!activeTag ? "active" : ""}`}
              onClick={() => setActiveTag(null)}
            >
              全部
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                className={`filter-chip ${activeTag === tag ? "active" : ""}`}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content: grid always visible */}
      <SkillGrid skills={filtered} onSelect={setSelectedId} onContextMenu={handleContextMenu} />

      {/* Drawer overlay */}
      {selected && (
        <SkillDrawer
          skill={selected}
          state={state}
          knownTags={knownTags}
          onClose={handleClose}
          onDeploy={() => setShowDeploy(true)}
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
      {showDeploy && selected && (
        <DeployModal
          skill={selected}
          targets={state.targets}
          onClose={() => setShowDeploy(false)}
          onDone={refresh}
        />
      )}
    </>
  );
}

// ── Skill Grid ──

function SkillGrid({
  skills,
  onSelect,
  onContextMenu,
}: {
  skills: Skill[];
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, skill: Skill) => void;
}) {
  if (skills.length === 0) {
    return <div className="empty-state">暂无技能</div>;
  }
  return (
    <div className="skill-grid">
      {skills.map((skill, i) => (
        <div
          key={skill.id}
          className="skill-card"
          style={{ animationDelay: `${i * 60}ms` }}
          onClick={() => onSelect(skill.id)}
          onContextMenu={(e) => onContextMenu(e, skill)}
        >
          <div className="card-title">{skill.displayName}</div>
          <div className="card-desc">{skill.description}</div>
          <div className="card-meta">
            {skill.enabledCount > 0 && (
              <span className="tag tag-applied">已应用 {skill.enabledCount}</span>
            )}
            {skill.issueCount > 0 && (
              <span className="tag tag-problem">问题 {skill.issueCount}</span>
            )}
            {skill.enabledCount === 0 && skill.issueCount === 0 && (
              <span className="tag tag-not-applied">未应用</span>
            )}
            {skill.tags.map(t => (
              <span key={t} className={`tag tag-color-${tagColorIndex(t)}`}>{t}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Skill Drawer (overlay) ──

function SkillDrawer({
  skill,
  state,
  knownTags,
  onClose,
  onDeploy,
  refresh,
}: {
  skill: Skill;
  state: AppState;
  knownTags: string[];
  onClose: () => void;
  onDeploy: () => void;
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
    drawerRef.current?.focus();
  }, []);

  const handleDelete = async () => {
    if (!confirm(`确定要删除技能「${skill.displayName}」吗？此操作不可撤销。`)) return;
    setDeleting(true);
    await deleteSkill(skill.id);
    onClose();
    window.location.reload();
  };

  const handleWithdrawAll = async () => {
    const deployedTargets = targetRows
      .filter(r => r.status?.status === "applied")
      .map(r => ({
        agentId: r.target.kind === "global" ? r.target.id.replace("global-", "") : undefined,
        projectId: r.target.kind === "project" ? r.target.id.replace("project-", "") : undefined,
      }));
    if (deployedTargets.length === 0) return;
    await withdrawSkill(skill.id, deployedTargets);
    await refresh();
  };

  const handleTagsChange = async (newTags: string[]) => {
    await setSkillTags(skill.id, newTags);
    await refresh();
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
          <span className="drawer-close" onClick={handleClose}>✕</span>
        </div>

        {/* Description */}
        <div className="drawer-desc">{skill.description}</div>

        {/* Tags */}
        <TagEditor
          tags={skill.tags}
          knownTags={knownTags}
          onChange={handleTagsChange}
        />

        {/* Actions */}
        <div className="drawer-section">
          <div className="drawer-actions">
            <button className="btn btn-primary" onClick={onDeploy}>应用到…</button>
            <div className="drawer-actions-row">
              <button className="btn btn-secondary" onClick={handleWithdrawAll}>收回全部</button>
              <button className="btn btn-secondary" onClick={() => openPath(skill.path)}>打开目录</button>
              <button
                className="btn btn-sm btn-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                删除
              </button>
            </div>
          </div>
        </div>

        {/* Target status */}
        <div className="drawer-section">
          <div className="drawer-section-title">应用状态</div>
          {targetRows.map(({ target, status }) => {
            const s = status?.status ?? "notApplied";
            return (
              <div key={target.id} className={`target-status-row ${statusClass(s)}`}>
                <span>
                  <span className={`status-dot ${statusClass(s)}`} />
                  {" "}{target.name}
                </span>
                <span className={`status-label ${statusClass(s)}`}>
                  {statusLabel(s)}
                </span>
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
  onChange,
}: {
  tags: string[];
  knownTags: string[];
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
      {tags.map(tag => (
        <span key={tag} className={`tag-pill tag-color-${tagColorIndex(tag)}`}>
          {tag}
          <span className="tag-remove" onClick={() => handleRemove(tag)}>✕</span>
        </span>
      ))}
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
// Target View
// ────────────────────────────────────────

function TargetView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(
    state.targets[0]?.id ?? null
  );
  const [showBatchApply, setShowBatchApply] = useState(false);

  const selectedTarget = state.targets.find(t => t.id === selectedTargetId) ?? null;
  const statuses = selectedTargetId ? (state.targetStatuses.get(selectedTargetId) ?? []) : [];

  // Sort: applied first, then problem, then not-applied
  const sortedStatuses = useMemo(() => {
    return [...statuses].sort((a, b) => {
      const order: Record<SkillStatusV2, number> = { applied: 0, problem: 1, notApplied: 2 };
      return order[a.status] - order[b.status];
    });
  }, [statuses]);

  const handleDeploy = async (skillId: string) => {
    if (!selectedTarget) return;
    try {
      const target = {
        agentId: selectedTarget.kind === "global" ? selectedTarget.id.replace("global-", "") : undefined,
        projectId: selectedTarget.kind === "project" ? selectedTarget.id.replace("project-", "") : undefined,
      };
      await deploySkill(skillId, [target], true);
      await refresh();
    } catch (e: any) {
      alert(e?.message || e);
    }
  };

  const handleWithdraw = async (skillId: string) => {
    if (!selectedTarget) return;
    try {
      const target = {
        agentId: selectedTarget.kind === "global" ? selectedTarget.id.replace("global-", "") : undefined,
        projectId: selectedTarget.kind === "project" ? selectedTarget.id.replace("project-", "") : undefined,
      };
      await withdrawSkill(skillId, [target]);
      await refresh();
    } catch (e: any) {
      alert(e?.message || e);
    }
  };

  const handleAdopt = async (skillName: string) => {
    if (!selectedTarget) return;
    try {
      const agentId = selectedTarget.kind === "global" ? selectedTarget.id.replace("global-", "") : undefined;
      const projectId = selectedTarget.kind === "project" ? selectedTarget.id.replace("project-", "") : undefined;
      await adoptSkillFromTarget(agentId, projectId, skillName);
      await refresh();
    } catch (e: any) {
      alert(e?.message || e);
    }
  };

  const handleRemoveUnmanaged = async (targetPath: string) => {
    if (!confirm("确认移除此非托管技能？该操作不可恢复。")) return;
    try {
      await removeUnmanagedSkill(targetPath);
      await refresh();
    } catch (e: any) {
      alert(e?.message || e);
    }
  };

  return (
    <div className="target-view">
      {/* Left: target list */}
      <div className="target-list">
        <div className="target-list-header">
          <h3>目标</h3>
        </div>
        <div className="target-list-items">
          {state.targets.map(target => (
            <div
              key={target.id}
              className={`target-item ${target.id === selectedTargetId ? "active" : ""}`}
              onClick={() => setSelectedTargetId(target.id)}
            >
              <div className="target-name">
                <span className={`status-dot ${target.exists ? "applied" : "problem"}`} />
                {target.name}
              </div>
              <div className="target-path">{shortenPath(target.path)}</div>
              <div className="target-stats">
                {target.appliedCount} 已应用 / {target.totalCount - target.appliedCount} 未应用
              </div>
            </div>
          ))}
          {state.targets.length === 0 && (
            <div className="empty-state" style={{ padding: "24px" }}>
              暂无目标，请在设置中添加
            </div>
          )}
        </div>
      </div>

      {/* Right: target detail */}
      {selectedTarget ? (
        <div className="target-detail">
          <div className="target-detail-header">
            <h2>{selectedTarget.name}</h2>
            <div className="meta">{selectedTarget.path}</div>
          </div>
          <div className="target-skills-list">
            {sortedStatuses.map(s => (
              <div
                key={s.id}
                className={`target-skill-row ${statusClass(s.status)}`}
              >
                <div className="skill-info">
                  <span className="skill-name">{s.displayName}</span>
                  <span className="skill-desc">
                    {s.issue || s.description}
                  </span>
                </div>
                <div className="skill-actions">
                  <span className={`status-dot ${statusClass(s.status)}`} />
                  {s.status === "applied" && (
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => handleWithdraw(s.skillId)}
                    >
                      收回
                    </button>
                  )}
                  {s.status === "notApplied" && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleDeploy(s.skillId)}
                    >
                      应用
                    </button>
                  )}
                  {s.status === "problem" && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleDeploy(s.skillId)}
                    >
                      覆盖
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="target-detail-footer">
            <button
              className="btn btn-primary"
              onClick={() => setShowBatchApply(true)}
            >
              批量应用…
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => openPath(selectedTarget.path)}
            >
              打开目录
            </button>
          </div>
        </div>
      ) : (
        <div className="target-detail">
          <div className="empty-state">选择一个目标查看详情</div>
        </div>
      )}

      {/* Batch apply modal */}
      {showBatchApply && selectedTarget && (
        <BatchApplyModal
          target={selectedTarget}
          skills={state.skills}
          currentStatuses={statuses}
          onClose={() => setShowBatchApply(false)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────
// Settings View
// ────────────────────────────────────────

function SettingsView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const handleAddProject = async () => {
    const selected = await open({ directory: true, title: "选择项目目录" });
    if (!selected) return;
    await addProject(selected as string);
    await refresh();
  };

  const handleAddGlobalDir = async () => {
    const selected = await open({ directory: true, title: "选择全局目录" });
    if (!selected) return;
    await addGlobalDir(selected as string);
    await refresh();
  };

  const handleRemoveProject = async (id: string) => {
    await removeProject(id);
    await refresh();
  };

  const handleRemoveGlobalDir = async (id: string) => {
    await removeGlobalDir(id);
    await refresh();
  };

  return (
    <div className="settings-view">
      <h2>设置</h2>

      <div className="settings-section">
        <h3>技能根目录</h3>
        <div className="settings-row">
          <span className="path">{state.skillsRoot}</span>
          <button className="btn btn-sm btn-secondary" onClick={() => openPath(state.skillsRoot)}>
            打开
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>全局目录</h3>
        {state.targets
          .filter(t => t.kind === "global")
          .map(t => (
            <div key={t.id} className="settings-row">
              <span className="path">{t.path}</span>
              <div style={{ display: "flex", gap: "6px" }}>
                <button className="btn btn-sm btn-secondary" onClick={() => openPath(t.path)}>
                  打开
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleRemoveGlobalDir(t.id.replace("global-", ""))}
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        <button
          className="btn btn-secondary"
          style={{ marginTop: "8px" }}
          onClick={handleAddGlobalDir}
        >
          + 添加全局目录
        </button>
      </div>

      <div className="settings-section">
        <h3>项目</h3>
        {state.targets
          .filter(t => t.kind === "project")
          .map(t => (
            <div key={t.id} className="settings-row">
              <div>
                <div style={{ fontWeight: 500, fontSize: "12px" }}>{t.name}</div>
                <span className="path">{t.path}</span>
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button className="btn btn-sm btn-secondary" onClick={() => openPath(t.path)}>
                  打开
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => handleRemoveProject(t.id.replace("project-", ""))}
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        <button
          className="btn btn-secondary"
          style={{ marginTop: "8px" }}
          onClick={handleAddProject}
        >
          + 添加项目
        </button>
      </div>
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

  const handleSelect = async () => {
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
      alert(`导入失败：${e}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>导入技能</h3>
        <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "16px" }}>
          选择包含 SKILL.md 的文件夹，或 .zip 压缩包。技能将导入到主库后再分发。
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="btn btn-primary"
            onClick={handleSelect}
            disabled={importing}
          >
            {importing ? "导入中…" : "选择文件夹或压缩包"}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function DeployModal({
  skill,
  targets,
  onClose,
  onDone,
}: {
  skill: Skill;
  targets: Target[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deploying, setDeploying] = useState(false);

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeploy = async () => {
    if (checked.size === 0) return;
    setDeploying(true);
    const deployTargets = targets
      .filter(t => checked.has(t.id))
      .map(t => ({
        agentId: t.kind === "global" ? t.id.replace("global-", "") : undefined,
        projectId: t.kind === "project" ? t.id.replace("project-", "") : undefined,
      }));
    await deploySkill(skill.id, deployTargets, true);
    await onDone();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>应用「{skill.displayName}」到…</h3>
        <div style={{ marginBottom: "16px" }}>
          {targets.map(t => (
            <label
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 0",
                fontSize: "12px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={checked.has(t.id)}
                onChange={() => toggle(t.id)}
              />
              <span style={{ fontWeight: 500 }}>{t.name}</span>
              <span style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: "10px" }}>
                {shortenPath(t.path)}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="btn btn-primary"
            onClick={handleDeploy}
            disabled={checked.size === 0 || deploying}
          >
            {deploying ? "应用中…" : `应用到 ${checked.size} 个目标`}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

function BatchApplyModal({
  target,
  skills,
  currentStatuses,
  onClose,
  onDone,
}: {
  target: Target;
  skills: Skill[];
  currentStatuses: TargetSkillStatus[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  // Only show skills not already applied
  const notApplied = useMemo(() => {
    const appliedIds = new Set(
      currentStatuses.filter(s => s.status === "applied").map(s => s.skillId)
    );
    return skills.filter(s => !appliedIds.has(s.id));
  }, [skills, currentStatuses]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    notApplied.forEach(s => s.tags.forEach(t => tags.add(t)));
    return Array.from(tags).sort();
  }, [notApplied]);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [activeFilterTag, setActiveFilterTag] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);

  const toggle = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTagFilter = (tag: string) => {
    if (activeFilterTag === tag) {
      // Deactivate: uncheck skills that belong to this tag (that aren't in other active selections)
      setActiveFilterTag(null);
      const tagSkillIds = new Set(notApplied.filter(s => s.tags.includes(tag)).map(s => s.id));
      setChecked(prev => {
        const next = new Set(prev);
        tagSkillIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      // Activate: check all skills with this tag
      setActiveFilterTag(tag);
      const tagSkillIds = notApplied.filter(s => s.tags.includes(tag)).map(s => s.id);
      setChecked(prev => {
        const next = new Set(prev);
        tagSkillIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleDeploy = async () => {
    if (checked.size === 0) return;
    setDeploying(true);
    const deployTarget = {
      agentId: target.kind === "global" ? target.id.replace("global-", "") : undefined,
      projectId: target.kind === "project" ? target.id.replace("project-", "") : undefined,
    };
    for (const skillId of checked) {
      await deploySkill(skillId, [deployTarget], true);
    }
    await onDone();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>批量应用到「{target.name}」</h3>
        {notApplied.length === 0 ? (
          <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            所有技能已应用到此目标
          </p>
        ) : (
          <>
            {allTags.length > 0 && (
              <div className="batch-tag-filter">
                {allTags.map(tag => (
                  <span
                    key={tag}
                    className={`batch-tag-chip ${activeFilterTag === tag ? "active" : ""}`}
                    onClick={() => handleTagFilter(tag)}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div className="batch-skill-list">
              {notApplied.map(skill => (
                <div
                  key={skill.id}
                  className="batch-skill-item"
                  onClick={() => toggle(skill.id)}
                >
                  <div className={`batch-checkbox ${checked.has(skill.id) ? "checked" : ""}`} />
                  <span className="batch-skill-name">{skill.displayName}</span>
                  <div className="batch-skill-tags">
                    {skill.tags.map(t => <span key={t}>{t}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="batch-actions">
          <span className="batch-count">
            {checked.size > 0 ? `已选 ${checked.size} 个` : `${notApplied.length} 个可应用`}
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn-secondary" onClick={onClose}>取消</button>
            <button
              className="btn-primary"
              onClick={handleDeploy}
              disabled={checked.size === 0 || deploying}
            >
              {deploying ? "应用中…" : `应用 ${checked.size} 个`}
            </button>
          </div>
        </div>
      </div>
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

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

// Stable color index for a tag name (hash → 0..5)
function tagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}
