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
  getSkillFullContent,
  getTargetFingerprint,
  setSkillTags,
  getAllTags,
  getAllTagsInfo,
  renameTag,
  setTagColor,
  deleteTag,
  reorderTags,
  createTag,
} from "./api";
import {
  explainReport,
  filterSkills,
  groupSkills,
  batchTargets,
  batchStats as batchStatsOf,
  batchOutcomeView,
  managedCountInTarget,
  importTone,
  importLines,
  targetUsable,
  type BatchMode,
  type BatchResult,
  type PerSkillOutcome,
} from "./viewModel";
import type {
  AppState,
  Skill,
  Target,
  TargetSkillStatus,
  SkillStatusV2,
  TagInfo,
  OperationReport,
} from "./types";

type ToastTone = "success" | "error" | "info" | "warning";
type ToastMessage = {
  id: number;
  tone: ToastTone;
  text: string;
};

type ConfirmRequest = {
  title: string;
  body: string;
  details?: string[];
  confirmLabel: string;
  tone?: "default" | "danger";
  // 纯信息提示（如“请先收回”）：只显示一个“知道了”按钮。
  infoOnly?: boolean;
  onConfirm: () => Promise<void>;
};

// 单项操作入口（卡片 / 详情抽屉）共用的执行器签名。
type DeployRunner = (skillId: string, target: Target, options?: { confirmOverwrite?: boolean }) => Promise<void>;
type WithdrawRunner = (skillId: string, target: Target) => Promise<void>;

const busyKeyOf = (mode: BatchMode, skillId: string, targetId: string) => `${mode}:${skillId}:${targetId}`;

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  const s = String(error ?? "");
  return s || fallback;
}

// ────────────────────────────────────────
// Focus trap: 打开时聚焦、Tab 在面板内循环、关闭时还焦。
// 抽屉、导入弹窗、确认框、设置抽屉共用，避免三份手写逻辑跑偏。
// ────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function useFocusTrap<T extends HTMLElement>(options?: { initial?: "panel" | "first" }) {
  const ref = useRef<T>(null);
  const initial = options?.initial ?? "first";
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    if (panel) {
      if (initial === "panel") panel.focus({ preventScroll: true });
      else (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus({ preventScroll: true });
    }
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel) return;
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    panel?.addEventListener("keydown", trap);
    return () => {
      panel?.removeEventListener("keydown", trap);
      if (prev && document.contains(prev)) prev.focus?.({ preventScroll: true });
    };
  }, [initial]);
  return ref;
}

// 只有最上层的浮层响应 Esc：确认框打开时，抽屉 / 弹窗不处理 Esc。
function useEscape(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".confirm-dialog")) return;
      handler();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
}

// ────────────────────────────────────────
// App Shell
// ────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await getAppState();
    setState(s);
    setLoading(false);
    return s;
  }, []);

  const initialLoad = useCallback(async () => {
    try {
      await refresh();
    } catch (e) {
      setLoadError(errorText(e, "无法读取本地状态"));
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => { initialLoad(); }, [initialLoad]);

  if (loading) {
    return <div className="app-shell"><div className="empty-state">加载中…</div></div>;
  }

  // U06：首次加载失败，提供重试
  if (loadError || !state) {
    return (
      <div className="app-shell">
        <div className="empty-state">
          <div className="empty-state-title">启动失败</div>
          <div className="empty-state-text">{loadError ?? "无法读取本地状态"}</div>
          <button className="btn btn-primary" onClick={() => { setLoading(true); setLoadError(null); initialLoad(); }}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="main-content">
        <SkillView state={state} refresh={refresh} setAppState={setState} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────
// Skill View (unified: browsing + target operations)
// ────────────────────────────────────────

type ImportDoneResult = {
  state: AppState;
  changed: number;
  skipped: number;
  errors: string[];
};

function SkillView({
  state,
  refresh,
  setAppState,
}: {
  state: AppState;
  refresh: () => Promise<AppState>;
  setAppState: (state: AppState) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [highlightedSkillId, setHighlightedSkillId] = useState<string | null>(null);
  const [exitingSkillId, setExitingSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<SkillStatusV2 | null>(null);
  const targetDropdownRef = useRef<HTMLDivElement>(null);
  const [tagsInfo, setTagsInfo] = useState<TagInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [toastExiting, setToastExiting] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  // U18：持久就近错误条，不自动消失
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  // U20：同步 busy 锁（同 render tick 双击防护）+ 可渲染的 busy 集合（按钮禁用反馈）
  const busyRef = useRef<Set<string>>(new Set());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // U02：批量同步 ref 门 + 取消 + 持久结果（记住操作类型，重试不反向）
  const batchCancelRef = useRef(false);
  const batchRunningRef = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // U14：保留上下文，提供「查看新导入」入口
  const [newImportIds, setNewImportIds] = useState<string[] | null>(null);

  const markBusy = useCallback((key: string, on: boolean) => {
    if (on) busyRef.current.add(key);
    else busyRef.current.delete(key);
    setBusyKeys(new Set(busyRef.current));
  }, []);

  const dismissToast = useCallback(() => {
    setToastExiting(true);
    window.setTimeout(() => {
      setToast(null);
      setToastExiting(false);
    }, 120);
  }, []);

  const showToast = useCallback((msg: Omit<ToastMessage, "id">) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToastExiting(false);
    const id = Date.now();
    setToast({ ...msg, id });
    const duration = msg.tone === "error" || msg.tone === "warning" ? 4200 : 1800;
    toastTimerRef.current = window.setTimeout(dismissToast, duration);
  }, [dismissToast]);

  // U18：错误改为持久内联条，不自动消失
  const showError = useCallback((title: string, error: unknown, fallback: string) => {
    setInlineError(`${title}：${errorText(error, fallback)}`);
  }, []);

  const pauseToast = useCallback(() => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  const resumeToast = useCallback(() => {
    if (toast && !toastExiting) {
      const duration = toast.tone === "error" || toast.tone === "warning" ? 4200 : 1800;
      toastTimerRef.current = window.setTimeout(dismissToast, duration);
    }
  }, [toast, toastExiting, dismissToast]);

  const requestConfirm = useCallback((request: ConfirmRequest) => {
    setConfirmRequest(request);
  }, []);

  // 写操作后刷新：失败时进入“状态暂未核对”，而不是假装已同步。
  const refreshAfterWrite = useCallback(async () => {
    try {
      await refresh();
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [refresh]);

  // S2：所有写操作共用的失败兜底——任何异常都落到持久错误条。
  const guard = useCallback(
    async <T,>(title: string, fallback: string, op: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await op();
      } catch (e) {
        showError(title, e, fallback);
        return undefined;
      }
    },
    [showError],
  );

  const reloadTagsInfo = useCallback(async () => {
    const [tags, info] = await Promise.all([getAllTags(), getAllTagsInfo()]);
    setKnownTags(tags);
    setTagsInfo(info);
  }, []);

  // I2：手动刷新 / 窗口重新获得焦点时重新扫描，覆盖 Finder、终端或 dsh 插件的外部改动。
  const refreshingRef = useRef(false);
  const manualRefresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    if (!opts?.silent) setRefreshing(true);
    try {
      await refresh();
      await reloadTagsInfo();
      setStale(false);
      if (!opts?.silent) showToast({ tone: "info", text: "已重新扫描技能状态" });
    } catch (e) {
      if (!opts?.silent) showError("刷新失败", e, "无法读取本地状态");
      else setStale(true);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [refresh, reloadTagsInfo, showToast, showError]);

  useEffect(() => {
    const onFocus = () => {
      // 批量进行中不打断；静默刷新，不弹提示。
      if (batchRunningRef.current) return;
      manualRefresh({ silent: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (!batchRunningRef.current) manualRefresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, [manualRefresh]);

  // Load all known tags
  useEffect(() => {
    reloadTagsInfo().catch(() => {});
  }, [state.skills, reloadTagsInfo]);

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
    const orderMap = new Map(tagsInfo.map((t, i) => [t.name, t.sortOrder ?? i]));
    tagList.sort((a, b) => {
      const oa = orderMap.get(a) ?? 9999;
      const ob = orderMap.get(b) ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
    return tagList;
  }, [state.skills, tagsInfo]);

  // 目标被移除后自动回到「全部技能」。
  useEffect(() => {
    if (activeTargetId && !state.targets.some(t => t.id === activeTargetId)) {
      setActiveTargetId(null);
      setStatusFilter(null);
    }
  }, [state.targets, activeTargetId]);

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
  const activeTargetUsable = activeTarget ? targetUsable(activeTarget) : true;

  // Close dropdown on outside click
  useEffect(() => {
    if (!targetDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (targetDropdownRef.current && !targetDropdownRef.current.contains(e.target as Node)) {
        setTargetDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [targetDropdownOpen]);

  // U11/U12：搜索 + 标签 + 状态三态筛选（同源集合）
  const filtered = useMemo(
    () => filterSkills(state.skills, { search, activeTag, statusFilter, skillStatusMap: skillStatusMap ?? undefined }),
    [state.skills, search, activeTag, statusFilter, skillStatusMap],
  );

  // U12：批量作用于筛选结果中状态匹配的子集
  const stats = useMemo(
    () => skillStatusMap ? batchStatsOf(filtered, skillStatusMap) : null,
    [filtered, skillStatusMap],
  );

  const selected = useMemo(
    () => state.skills.find(s => s.id === selectedId) ?? null,
    [state.skills, selectedId]
  );

  const handleClose = useCallback(() => setSelectedId(null), []);

  useEffect(() => {
    if (!highlightedSkillId) return;
    const frame = window.requestAnimationFrame(() => {
      const safeId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(highlightedSkillId)
        : highlightedSkillId.replace(/["\\]/g, "\\$&");
      const card = document.querySelector<HTMLElement>(`[data-skill-id="${safeId}"]`);
      card?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
    const timer = window.setTimeout(() => setHighlightedSkillId(null), 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [highlightedSkillId, filtered]);

  // U14：导入后保留筛选/目标上下文，仅高亮新技能并提供「查看新导入」
  const handleImportDone = (result: ImportDoneResult) => {
    const previousIds = new Set(state.skills.map(skill => skill.id));
    const importedSkills = result.state.skills.filter(skill => !previousIds.has(skill.id));
    const focusSkill = importedSkills[0] ?? null;

    setAppState(result.state);
    setShowImport(false);

    if (importedSkills.length > 0) {
      setNewImportIds(importedSkills.map(s => s.id));
    }

    if (focusSkill) {
      setHighlightedSkillId(focusSkill.id);
    }

    const tone = importTone(result);
    const lines = importLines(result);
    showToast({ tone, text: lines.join("，") || "导入完成" });
  };

  const handleSkillDeleted = (skill: Skill, nextState: AppState) => {
    setSelectedId(null);
    setExitingSkillId(skill.id);
    window.setTimeout(() => {
      setAppState(nextState);
      setExitingSkillId(null);
    }, 220);
  };

  const handleContextMenu = (e: React.MouseEvent, skill: Skill) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, skill });
  };

  const handleTagToggle = async (skillId: string, tag: string, currentTags: string[]) => {
    const newTags = currentTags.includes(tag)
      ? currentTags.filter(t => t !== tag)
      : [...currentTags, tag];
    setContextMenu(null);
    await guard("更新标签失败", "请稍后重试。", async () => {
      await setSkillTags(skillId, newTags);
      await refreshAfterWrite();
    });
  };

  const handleTagCreate = async (skillId: string, tag: string, currentTags: string[]) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setContextMenu(null);
    if (currentTags.includes(trimmed)) return;
    await guard("新建标签失败", "请稍后重试。", async () => {
      await setSkillTags(skillId, [...currentTags, trimmed]);
      await refreshAfterWrite();
    });
  };

  const handleTagsChange = useCallback(async (skillId: string, newTags: string[]) => {
    await guard("更新标签失败", "请稍后重试。", async () => {
      await setSkillTags(skillId, newTags);
      await refreshAfterWrite();
    });
  }, [guard, refreshAfterWrite]);

  // ── 单项应用 / 覆盖 / 收回：卡片与详情抽屉共用（E3：消除两份逻辑跑偏） ──

  const runDeploy: DeployRunner = useCallback(async (skillId, target, options) => {
    const key = busyKeyOf("deploy", skillId, target.id);
    if (busyRef.current.has(key)) return;
    const skill = state.skills.find(s => s.id === skillId);
    const name = skill ? `「${skill.displayName}」` : "";
    if (!targetUsable(target)) {
      setInlineError(`「${target.name}」的项目路径不存在：${target.path}。请在设置中移除或重新添加该目标。`);
      return;
    }
    const run = async (expected?: Awaited<ReturnType<typeof getTargetFingerprint>>) => {
      markBusy(key, true);
      try {
        // U03：普通应用一律 overwrite=false；仅显式确认覆盖才 true
        const overwrite = !!options?.confirmOverwrite;
        const report = await deploySkill(
          skillId,
          [{ targetId: target.id, ...(expected ? { expected } : {}) }],
          overwrite,
        );
        await refreshAfterWrite();
        const explained = explainReport(report as OperationReport);
        const detail = explained.lines.length ? `\n${explained.lines.join("\n")}` : "";
        showToast({ tone: explained.tone, text: `${explained.title} ${name}${detail}` });
      } catch (e) {
        showError(options?.confirmOverwrite ? "覆盖失败" : "应用失败", e, "请确认目标目录存在并且当前账户有写入权限。");
      } finally {
        markBusy(key, false);
      }
    };
    if (options?.confirmOverwrite) {
      if (!skill) return;
      // U04：确认前先取指纹；读失败/unknown 则持久报错并禁止覆盖
      let fp: Awaited<ReturnType<typeof getTargetFingerprint>> | null = null;
      try {
        fp = await getTargetFingerprint(skillId, target.id);
      } catch (e) {
        showError("覆盖已取消", e, "无法读取目标位置状态。");
        return;
      }
      if (!fp || fp.kind === "unknown") {
        setInlineError(`无法读取「${target.name}」当前位置状态，为避免误覆盖已取消。请检查目标路径后重试。`);
        return;
      }
      const confirmedFp = fp;
      requestConfirm({
        title: `覆盖「${skill.displayName}」？`,
        body: "目标位置已有冲突或失效内容。覆盖会删除该位置现有内容，并改为指向主库的软链接。",
        details: [
          `目标：${target.name}`,
          `最终路径：${target.skillsPath}/${skill.name}`,
        ],
        confirmLabel: "覆盖技能",
        tone: "danger",
        onConfirm: () => run(confirmedFp),
      });
      return;
    }
    await run(undefined);
  }, [state.skills, markBusy, refreshAfterWrite, showToast, showError, requestConfirm]);

  const runWithdraw: WithdrawRunner = useCallback(async (skillId, target) => {
    const key = busyKeyOf("withdraw", skillId, target.id);
    if (busyRef.current.has(key)) return;
    const skill = state.skills.find(s => s.id === skillId);
    markBusy(key, true);
    try {
      // P0-2：按报告决定色调，失败不再冒充成功
      const report = await withdrawSkill(skillId, [{ targetId: target.id }]);
      await refreshAfterWrite();
      const explained = explainReport(report as OperationReport, { verb: "收回" });
      const detail = explained.lines.length ? `\n${explained.lines.join("\n")}` : "";
      showToast({ tone: explained.tone, text: `${explained.title}${skill ? `「${skill.displayName}」` : ""}${detail}` });
    } catch (e) {
      showError("收回失败", e, "请确认目标中的技能是指向主库的软链接。");
    } finally {
      markBusy(key, false);
    }
  }, [state.skills, markBusy, refreshAfterWrite, showToast, showError]);

  // U02：批量逐项累计执行，支持取消未开始项与「仅重试失败项」（沿用原操作类型）
  const runBatch = async (skills: Skill[], mode: BatchMode) => {
    if (!activeTarget || batchRunningRef.current || skills.length === 0) return;
    const targetId = activeTarget.id;
    batchCancelRef.current = false;
    batchRunningRef.current = true;
    setBatchRunning(true);
    setBatchResult(null);
    const results: PerSkillOutcome[] = [];
    let cancelled = false;
    try {
      for (const skill of skills) {
        if (batchCancelRef.current) { cancelled = true; break; }
        const key = busyKeyOf(mode, skill.id, targetId);
        markBusy(key, true);
        try {
          const rep = mode === "deploy"
            ? await deploySkill(skill.id, [{ targetId }], false) // U03：普通批量一律不覆盖
            : await withdrawSkill(skill.id, [{ targetId }]);
          const problems = [...rep.errors, ...rep.conflicts];
          if (problems.length > 0) {
            results.push({ skillId: skill.id, displayName: skill.displayName, ok: false, reason: problems.join("；") });
          } else {
            results.push({ skillId: skill.id, displayName: skill.displayName, ok: true });
          }
        } catch (e) {
          results.push({ skillId: skill.id, displayName: skill.displayName, ok: false, reason: errorText(e, "未知错误") });
        } finally {
          markBusy(key, false);
        }
      }
      await refreshAfterWrite();
    } finally {
      batchRunningRef.current = false;
      setBatchRunning(false);
      if (results.length > 0) {
        const batch: BatchResult = { mode, results, cancelled };
        const view = batchOutcomeView(batch);
        if (view.showPanel) {
          setBatchResult(batch);
        } else {
          showToast({ tone: view.tone, text: view.title });
        }
      }
    }
  };

  const handleBatchDeploy = () => {
    if (!activeTarget || !skillStatusMap) return;
    const toDeploy = batchTargets(filtered, skillStatusMap, "deploy");
    if (toDeploy.length === 0) return;
    requestConfirm({
      title: "应用当前筛选结果？",
      body: "这个操作只会应用当前筛选结果中尚未应用的技能，不会处理被筛选隐藏的技能。",
      details: [
        `目标：${activeTarget.name}`,
        `范围：当前筛选结果 ${filtered.length} 个技能`,
        `将应用：${toDeploy.length} 个未应用`,
        `目标目录：${activeTarget.skillsPath}`,
      ],
      confirmLabel: `应用 ${toDeploy.length} 个技能`,
      onConfirm: () => runBatch(toDeploy, "deploy"),
    });
  };

  const handleBatchWithdraw = () => {
    if (!activeTarget || !skillStatusMap) return;
    const toWithdraw = batchTargets(filtered, skillStatusMap, "withdraw");
    if (toWithdraw.length === 0) return;
    requestConfirm({
      title: "收回当前筛选结果？",
      body: "这个操作只会收回当前筛选结果中已应用的技能，不会处理被筛选隐藏的技能，也不会删除主库技能。",
      details: [
        `目标：${activeTarget.name}`,
        `范围：当前筛选结果 ${filtered.length} 个技能`,
        `将收回：${toWithdraw.length} 个已应用`,
        `目标目录：${activeTarget.skillsPath}`,
      ],
      confirmLabel: `收回 ${toWithdraw.length} 个技能`,
      tone: "danger",
      onConfirm: () => runBatch(toWithdraw, "withdraw"),
    });
  };

  const handleRetryFailed = () => {
    if (!batchResult) return;
    const failedIds = new Set(batchOutcomeView(batchResult).failedIds);
    const again = state.skills.filter(s => failedIds.has(s.id));
    const mode = batchResult.mode;
    setBatchResult(null);
    runBatch(again, mode);
  };

  // U05：移除目标前检查 managed 链接
  const handleRemoveTarget = async (targetId: string) => {
    const target = state.targets.find(t => t.id === targetId);
    if (!target || target.isDefault) return;
    const statuses = state.targetStatuses.get(targetId) ?? [];
    const managed = managedCountInTarget(statuses);
    if (managed > 0) {
      requestConfirm({
        title: `「${target.name}」仍有 ${managed} 个已应用技能`,
        body: "请先收回这些技能，再移除目标目录，避免遗留软链失去管理。",
        confirmLabel: "知道了",
        infoOnly: true,
        onConfirm: async () => {},
      });
      return;
    }
    requestConfirm({
      title: `移除目标「${target.name}」？`,
      body: "只会从影子中移除这个目标，不会删除项目文件夹或其中的任何文件。",
      details: [`路径：${target.path}`],
      confirmLabel: "移除目标",
      tone: "danger",
      onConfirm: async () => {
        await guard("移除目标失败", "请稍后重试。", async () => {
          const next = await removeTarget(targetId);
          setAppState(next);
          showToast({ tone: "success", text: `已移除目标「${target.name}」` });
        });
      },
    });
  };

  // 切换目标：状态筛选只在目标上下文有意义，切换时重置。
  const handleTargetChange = (targetId: string | null) => {
    setActiveTargetId(targetId);
    setStatusFilter(null);
    setTargetDropdownOpen(false);
  };

  const allIssues = state.issues ?? [];
  const batchView = batchResult ? batchOutcomeView(batchResult) : null;

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
        {/* Row 1: Target + Search + Refresh + Import + Settings */}
        <div className="toolbar-row">
          {state.targets.length > 0 && (
            <TargetDropdown
              targets={state.targets}
              activeTarget={activeTarget}
              open={targetDropdownOpen}
              setOpen={setTargetDropdownOpen}
              onChange={handleTargetChange}
              containerRef={targetDropdownRef}
            />
          )}
          <input
            className="search-input"
            placeholder="搜索技能名称、描述或标签…"
            aria-label="搜索技能"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            className="btn-icon"
            onClick={() => manualRefresh()}
            title="重新扫描（⌘R）"
            aria-label="重新扫描"
            disabled={refreshing || batchRunning}
            aria-busy={refreshing || undefined}
          >
            <svg className={refreshing ? "spin" : undefined} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
          </button>
          <button className="btn-icon" onClick={() => setShowImport(true)} title="导入技能" aria-label="导入技能">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置" aria-label="设置">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>

        {/* Row 2: Tag filter (left) + Status segmented control (right, target context only) */}
        {(allTags.length > 0 || activeTargetId) && (
          <div className="filter-row">
            {allTags.length > 0 && (
              <div className="filter-group" role="group" aria-label="按标签筛选">
                <button
                  className={`filter-chip ${!activeTag ? "active" : ""}`}
                  aria-pressed={!activeTag}
                  onClick={() => setActiveTag(null)}
                >
                  全部
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    className={`filter-chip ${activeTag === tag ? "active" : ""}`}
                    aria-pressed={activeTag === tag}
                    onClick={() => { setActiveTag(activeTag === tag ? null : tag); }}
                  >
                    <span className="filter-chip-dot" style={{ background: TAG_PALETTE[resolveTagColor(tag, tagColorMap)]?.bg }} />
                    {tag}
                  </button>
                ))}
                <button
                  className={`filter-chip no-tag-chip ${activeTag === "__NO_TAG__" ? "active" : ""}`}
                  aria-pressed={activeTag === "__NO_TAG__"}
                  onClick={() => { setActiveTag(activeTag === "__NO_TAG__" ? null : "__NO_TAG__"); }}
                >
                  无标签
                </button>
              </div>
            )}

            {/* U11：状态分段控件（仅目标上下文），与标签筛选互不清除 */}
            {activeTargetId && (
              <div className="status-segment" role="group" aria-label="按状态筛选">
                {([null, "problem", "applied", "notApplied"] as (SkillStatusV2 | null)[]).map(s => (
                  <button
                    key={s ?? "all"}
                    className={`status-segment-item ${statusFilter === s ? "active" : ""}`}
                    aria-pressed={statusFilter === s}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s ? statusLabel(s) : "全部状态"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* V3：提示区——横幅、错误条、批量结果都在文档流中纵向堆叠，互不遮挡 */}
      <div className="notice-stack">
        {state.isIsolated && (
          <div className="stale-banner isolated-banner" role="status">
            隔离测试模式 · 数据根：{state.baseDir}
          </div>
        )}
        {/* F1：失效目标 */}
        {activeTarget && !activeTargetUsable && (
          <div className="stale-banner issue-banner" role="alert">
            <span>「{activeTarget.name}」的项目路径不存在：{shortenPath(activeTarget.path)}。可能已被移动或删除，暂时无法应用技能。</span>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowSettings(true)}>打开设置</button>
          </div>
        )}
        {/* U06：过期态横幅 */}
        {stale && (
          <div className="stale-banner" role="status">
            <span>操作可能已执行，本地状态暂未核对</span>
            <button className="btn btn-secondary btn-sm" onClick={() => manualRefresh()}>重新核对</button>
          </div>
        )}
        {/* U06：后端 issues 横幅 */}
        {allIssues.length > 0 && (
          <div className="stale-banner issue-banner" role="alert">
            <span>
              检测到 {allIssues.length} 个状态问题：{allIssues[0]}
              {allIssues.length > 1 ? `（另有 ${allIssues.length - 1} 个，选择对应目标后查看）` : ""}
            </span>
          </div>
        )}

        {/* U14：查看新导入入口 */}
        {newImportIds && (
          <div className="stale-banner new-import-banner" role="status">
            <span>新导入 {newImportIds.length} 个技能</span>
            <span className="notice-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const id = newImportIds[0];
                  setSelectedId(id);
                  setHighlightedSkillId(id);
                  setNewImportIds(null);
                }}
              >
                查看新导入
              </button>
              <button className="inline-error-close" onClick={() => setNewImportIds(null)} aria-label="关闭">✕</button>
            </span>
          </div>
        )}

        {/* U02：批量部分失败的持久结果（失败列表 + 按原操作重试）；全部成功只弹 toast */}
        {batchResult && batchView && (
          <div className={`batch-result-bar tone-${batchView.tone}`} role="alert">
            <div className="batch-result-head">
              <span className="batch-result-title">{batchView.title}</span>
              <span className="notice-actions">
                {batchView.retryLabel && (
                  <button className="btn btn-secondary btn-sm" onClick={handleRetryFailed} disabled={batchRunning}>
                    {batchView.retryLabel}
                  </button>
                )}
                <button className="inline-error-close" onClick={() => setBatchResult(null)} aria-label="关闭">✕</button>
              </span>
            </div>
            <ul className="batch-result-list">
              {batchResult.results.filter(r => !r.ok).map(r => (
                <li key={r.skillId}>{r.displayName}：{r.reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* U18：持久内联错误条 */}
        {inlineError && (
          <div className="inline-error-bar" role="alert">
            <span>{inlineError}</span>
            <button className="inline-error-close" onClick={() => setInlineError(null)} aria-label="关闭">✕</button>
          </div>
        )}
      </div>

      {/* Content: grid */}
      <SkillGrid
        skills={filtered}
        allSkillsCount={state.skills.length}
        hasFilters={!!search || !!activeTag || !!statusFilter}
        skillStatusMap={skillStatusMap}
        activeTarget={activeTarget}
        activeTargetUsable={activeTargetUsable}
        highlightedSkillId={highlightedSkillId}
        exitingSkillId={exitingSkillId}
        tagColorMap={tagColorMap}
        allTags={allTags}
        busyKeys={busyKeys}
        onSelect={setSelectedId}
        onContextMenu={handleContextMenu}
        onDeploy={runDeploy}
        onWithdraw={runWithdraw}
        onClearFilters={() => { setSearch(""); setActiveTag(null); setStatusFilter(null); }}
        onImport={() => setShowImport(true)}
      />

      {/* Sticky bottom bar: batch actions on filtered results */}
      {activeTarget && stats && (stats.deployable > 0 || stats.withdrawable > 0 || batchRunning) && (
        <div className="sticky-action-bar">
          <span className="sticky-action-label">
            当前筛选结果 {stats.matched} 个技能
            {stats.deployable > 0 && <>：{stats.deployable} 个未应用</>}
            {stats.deployable > 0 && stats.withdrawable > 0 && " · "}
            {stats.withdrawable > 0 && <>{stats.withdrawable} 个已应用</>}
            {!activeTargetUsable && <span className="sticky-action-warn"> · 目标路径不存在，无法应用</span>}
          </span>
          <div className="sticky-action-buttons">
            {batchRunning && (
              <button className="btn btn-secondary btn-sm" onClick={() => { batchCancelRef.current = true; }}>
                取消未开始项
              </button>
            )}
            {stats.deployable > 0 && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleBatchDeploy}
                disabled={batchRunning || !activeTargetUsable}
                aria-busy={batchRunning || undefined}
              >
                {batchRunning ? "处理中…" : `应用筛选中的 ${stats.deployable} 项`}
              </button>
            )}
            {stats.withdrawable > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleBatchWithdraw} disabled={batchRunning}>
                收回筛选中的 {stats.withdrawable} 项
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
          activeTargetId={activeTargetId}
          busyKeys={busyKeys}
          requestConfirm={requestConfirm}
          showToast={showToast}
          showError={showError}
          onClose={handleClose}
          onDeleted={handleSkillDeleted}
          onTagsChange={handleTagsChange}
          onDeploy={runDeploy}
          onWithdraw={runWithdraw}
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
          onDone={handleImportDone}
        />
      )}
      {/* Settings Drawer */}
      {showSettings && (
        <SettingsDrawer
          state={state}
          setAppState={setAppState}
          onClose={() => setShowSettings(false)}
          tagsInfo={tagsInfo}
          setTagsInfo={setTagsInfo}
          reloadTagsInfo={reloadTagsInfo}
          tagColorMap={tagColorMap}
          activeTag={activeTag}
          setActiveTag={setActiveTag}
          requestConfirm={requestConfirm}
          onRemoveTarget={handleRemoveTarget}
          guard={guard}
          showToast={showToast}
        />
      )}
      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onClose={() => setConfirmRequest(null)}
        />
      )}
      {toast && <Toast message={toast} exiting={toastExiting} onMouseEnter={pauseToast} onMouseLeave={resumeToast} />}
    </>
  );
}

// ── Target Dropdown（V2：SVG chevron + aria-expanded + 按钮型选项 + 键盘导航） ──

function TargetDropdown({
  targets,
  activeTarget,
  open,
  setOpen,
  onChange,
  containerRef,
}: {
  targets: Target[];
  activeTarget: Target | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onChange: (targetId: string | null) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options: (Target | null)[] = [null, ...targets];

  const focusItem = (index: number) => {
    const items = containerRef.current?.querySelectorAll<HTMLElement>(".target-dropdown-item");
    if (!items || items.length === 0) return;
    const n = items.length;
    items[((index % n) + n) % n]?.focus();
  };

  const openAndFocus = (index: number) => {
    setOpen(true);
    window.requestAnimationFrame(() => focusItem(index));
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); openAndFocus(0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); openAndFocus(options.length - 1); }
    else if (e.key === "Escape") setOpen(false);
  };

  const onItemKey = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(index + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(index - 1); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };

  const activeMissing = activeTarget && !targetUsable(activeTarget);

  return (
    <div className="target-dropdown" ref={containerRef}>
      <button
        ref={triggerRef}
        className={`target-dropdown-trigger${activeMissing ? " is-missing" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
      >
        <span className="target-dropdown-label">
          {activeTarget ? activeTarget.name : "全部技能"}
        </span>
        <svg className={`target-dropdown-chevron${open ? " open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="target-dropdown-menu" role="listbox" aria-label="选择目标">
          {options.map((t, index) => {
            const isActive = t ? activeTarget?.id === t.id : !activeTarget;
            const missing = t ? !targetUsable(t) : false;
            return (
              <button
                key={t?.id ?? "__all__"}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`target-dropdown-item ${isActive ? "active" : ""}${missing ? " is-missing" : ""}`}
                onClick={() => { onChange(t ? t.id : null); triggerRef.current?.focus(); }}
                onKeyDown={(e) => onItemKey(e, index)}
              >
                <span className="target-dropdown-name">{t ? t.name : "全部技能"}</span>
                {t && (
                  missing
                    ? <span className="target-missing-tag">路径不存在</span>
                    : <span className="target-dropdown-path">{shortenPath(t.path)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Skill Grid ──

function SkillGrid({
  skills,
  allSkillsCount,
  hasFilters,
  skillStatusMap,
  activeTarget,
  activeTargetUsable,
  highlightedSkillId,
  exitingSkillId,
  tagColorMap,
  allTags,
  busyKeys,
  onSelect,
  onContextMenu,
  onDeploy,
  onWithdraw,
  onClearFilters,
  onImport,
}: {
  skills: Skill[];
  allSkillsCount: number;
  hasFilters: boolean;
  skillStatusMap: Map<string, TargetSkillStatus> | null;
  activeTarget: Target | null;
  activeTargetUsable: boolean;
  highlightedSkillId: string | null;
  exitingSkillId: string | null;
  tagColorMap: Map<string, number>;
  allTags: string[];
  busyKeys: Set<string>;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, skill: Skill) => void;
  onDeploy: DeployRunner;
  onWithdraw: WithdrawRunner;
  onClearFilters: () => void;
  onImport: () => void;
}) {
  const hasActiveTarget = !!activeTarget;
  // U19：useMemo 必须在 early return 之前
  const groups = useMemo(() => {
    return groupSkills(skills, {
      hasActiveTarget,
      skillStatusMap: skillStatusMap ?? undefined,
      allTags,
      tagColorOf: (tag) => ({ text: TAG_PALETTE[resolveTagColor(tag, tagColorMap)].text }),
    });
  }, [skills, hasActiveTarget, skillStatusMap, allTags, tagColorMap]);

  if (skills.length === 0) {
    const libraryEmpty = allSkillsCount === 0;
    return (
      <div className="skill-grid-grouped">
        <div className="empty-state">
          <div className="empty-state-title">
            {libraryEmpty ? "主库还没有技能" : "当前筛选没有匹配的技能"}
          </div>
          <div className="empty-state-text">
            {libraryEmpty
              ? "导入包含 SKILL.md 的技能文件夹或 .zip 压缩包后，就可以分发到全局或项目。"
              : hasFilters
                ? "试试换个关键词，或清除标签与状态筛选。"
                : hasActiveTarget
                  ? "当前目标下暂时没有可展示的技能。"
                  : "没有匹配的技能。"}
          </div>
          {libraryEmpty ? (
            <button className="btn btn-primary" onClick={onImport}>导入技能</button>
          ) : hasFilters ? (
            <button className="btn btn-secondary" onClick={onClearFilters}>清除筛选</button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="skill-grid-grouped">
      {groups.map(group => (
        <section key={group.key} className="skill-group" aria-label={`${group.label} ${group.skills.length} 个技能`}>
          <div className="skill-group-header">
            <span className="skill-group-dot" style={{ background: group.color }} />
            <span className="skill-group-title">{group.label}</span>
            <span className="skill-group-count">{group.skills.length} 个技能</span>
          </div>
          <div className="skill-grid">
            {group.skills.map(skill => {
              const status = skillStatusMap?.get(skill.id);
              const exiting = exitingSkillId === skill.id;
              const deployBusy = activeTarget ? busyKeys.has(busyKeyOf("deploy", skill.id, activeTarget.id)) : false;
              const withdrawBusy = activeTarget ? busyKeys.has(busyKeyOf("withdraw", skill.id, activeTarget.id)) : false;
              const open = () => { if (!exiting) onSelect(skill.id); };
              return (
                <div
                  key={skill.id}
                  data-skill-id={skill.id}
                  role="button"
                  tabIndex={exiting ? -1 : 0}
                  aria-label={`${skill.displayName}${status ? `，${statusLabel(status.status)}` : ""}，打开详情`}
                  className={[
                    "skill-card",
                    hasActiveTarget ? "has-target" : "",
                    highlightedSkillId === skill.id ? "highlighted" : "",
                    exiting ? "exiting" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={open}
                  onKeyDown={(e) => {
                    // I1：键盘可打开详情；只响应卡片自身，不拦截内部按钮
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
                  }}
                  onContextMenu={(e) => onContextMenu(e, skill)}
                >
                  <div className="card-header">
                    <div className="card-title">{skill.displayName}</div>
                    <div className="card-status-slot">
                      {hasActiveTarget && status ? (
                        <span className={`card-status-badge ${statusClass(status.status)}`}>
                          <span className={`status-dot ${statusClass(status.status)}`} />
                          {statusLabel(status.status)}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="card-desc">{skill.description}</div>

                  <div className="card-footer">
                    <div className="card-tags">
                      {skill.tags.map(t => {
                        const p = TAG_PALETTE[resolveTagColor(t, tagColorMap)];
                        return (
                          <span key={t} className="tag" style={{ background: p.bg, color: p.text }}>{t}</span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Hover / focus action */}
                  <div className="card-hover-action" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    {activeTarget && status ? (
                      <>
                        {status.status === "applied" && (
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={withdrawBusy}
                            aria-busy={withdrawBusy || undefined}
                            onClick={() => onWithdraw(skill.id, activeTarget)}
                          >
                            {withdrawBusy ? "收回中…" : "收回"}
                          </button>
                        )}
                        {status.status === "notApplied" && (
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={deployBusy || !activeTargetUsable}
                            aria-busy={deployBusy || undefined}
                            title={activeTargetUsable ? undefined : "目标路径不存在"}
                            onClick={() => onDeploy(skill.id, activeTarget)}
                          >
                            {deployBusy ? "应用中…" : "应用"}
                          </button>
                        )}
                        {status.status === "problem" && (
                          status.canOverwrite ? (
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={deployBusy}
                              aria-busy={deployBusy || undefined}
                              onClick={() => onDeploy(skill.id, activeTarget, { confirmOverwrite: true })}
                            >
                              {deployBusy ? "覆盖中…" : "覆盖"}
                            </button>
                          ) : (
                            <button className="btn btn-sm btn-secondary" onClick={() => onSelect(skill.id)}>
                              查看原因
                            </button>
                          )
                        )}
                      </>
                    ) : (
                      <button className="btn btn-sm btn-secondary" tabIndex={-1} onClick={() => onSelect(skill.id)}>
                        详情
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Skill Drawer (overlay) ──

function SkillDrawer({
  skill,
  state,
  knownTags,
  tagColorMap,
  activeTargetId,
  busyKeys,
  requestConfirm,
  showToast,
  showError,
  onClose,
  onDeleted,
  onTagsChange,
  onDeploy,
  onWithdraw,
}: {
  skill: Skill;
  state: AppState;
  knownTags: string[];
  tagColorMap: Map<string, number>;
  activeTargetId: string | null;
  busyKeys: Set<string>;
  requestConfirm: (request: ConfirmRequest) => void;
  showToast: (message: Omit<ToastMessage, "id">) => void;
  showError: (title: string, error: unknown, fallback: string) => void;
  onClose: () => void;
  onDeleted: (skill: Skill, nextState: AppState) => void;
  onTagsChange: (skillId: string, tags: string[]) => Promise<void>;
  onDeploy: DeployRunner;
  onWithdraw: WithdrawRunner;
}) {
  const [deleting, setDeleting] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const drawerRef = useFocusTrap<HTMLDivElement>({ initial: "panel" });

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

  const enabledTargets = targetRows.filter(r => r.status?.status === "applied").map(r => r.target.name);

  const handleClose = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 280);
  }, [onClose]);

  useEscape(handleClose);

  // P0-1：删除走应用内确认框；确认前零副作用。Tauri 中 window.confirm 是异步的，不能用。
  const handleDelete = () => {
    if (enabledTargets.length > 0) {
      requestConfirm({
        title: `「${skill.displayName}」仍在 ${enabledTargets.length} 个位置生效`,
        body: "主库技能有启用位置时不能删除。请先在下方「应用状态」中收回，再删除。",
        details: enabledTargets.map(name => `已应用：${name}`),
        confirmLabel: "知道了",
        infoOnly: true,
        onConfirm: async () => {},
      });
      return;
    }
    requestConfirm({
      title: `删除「${skill.displayName}」？`,
      body: "会从主库永久删除这个技能文件夹及其标签，不可撤销。",
      details: [`主库路径：${skill.path}`],
      confirmLabel: "永久删除",
      tone: "danger",
      onConfirm: async () => {
        setDeleting(true);
        try {
          const nextState = await deleteSkill(skill.id);
          showToast({ tone: "success", text: `已删除「${skill.displayName}」` });
          setClosing(true);
          window.setTimeout(() => onDeleted(skill, nextState), 250);
        } catch (e) {
          setDeleting(false);
          showError("删除失败", e, "该技能可能仍有启用位置，请先收回后再删除。");
        }
      },
    });
  };

  const handleOpenPath = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      showError("无法打开目录", e, path);
    }
  };

  // U15：首次展开拉取全文 SKILL.md
  const toggleContent = async () => {
    const next = !showContent;
    setShowContent(next);
    if (next && fullContent === null && !contentLoading) {
      setContentLoading(true);
      try {
        const r = await getSkillFullContent(skill.id);
        setFullContent(r.content);
      } catch {
        setFullContent("");
      } finally {
        setContentLoading(false);
      }
    }
  };

  return (
    <div className={`drawer-overlay ${closing ? "closing" : ""}`} onClick={handleClose}>
      <div
        ref={drawerRef}
        className={`drawer-panel ${closing ? "closing" : ""}`}
        onClick={e => e.stopPropagation()}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${skill.displayName} 详情`}
      >
        {/* Header */}
        <div className="drawer-header">
          <h2 className="drawer-title">{skill.displayName}</h2>
          <div className="drawer-header-actions">
            <button
              className="drawer-icon-btn"
              onClick={() => handleOpenPath(skill.path)}
              title="打开目录"
              aria-label="在访达中打开技能目录"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button
              className="drawer-icon-btn danger"
              onClick={handleDelete}
              disabled={deleting}
              title="删除技能"
              aria-label="删除技能"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button className="drawer-icon-btn" onClick={handleClose} title="关闭" aria-label="关闭详情">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
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
          onChange={(tags) => onTagsChange(skill.id, tags)}
        />

        {/* Target status with inline actions */}
        <div className="drawer-section">
          <div className="drawer-section-title">应用状态</div>
          {targetRows.map(({ target, status }) => {
            const s = status?.status ?? "notApplied";
            const issue = status?.issue ?? null;
            const isCurrent = target.id === activeTargetId;
            const usable = targetUsable(target);
            const deployBusy = busyKeys.has(busyKeyOf("deploy", skill.id, target.id));
            const withdrawBusy = busyKeys.has(busyKeyOf("withdraw", skill.id, target.id));
            // F2：可否覆盖由后端 canOverwrite 决定，卡片与抽屉共用同一规则
            const canOverwrite = !!status?.canOverwrite;
            return (
              <div key={target.id} className={`target-action-row${isCurrent ? " is-current" : ""}`}>
                <span className="target-action-name">
                  <span className={`status-dot ${statusClass(s)}`} />
                  {target.name}
                  {isCurrent && <span className="target-current-tag">当前</span>}
                  <span className="sr-only">：{statusLabel(s)}</span>
                </span>
                {s === "notApplied" && (
                  usable ? (
                    <button
                      className="row-action-btn apply"
                      disabled={deployBusy}
                      aria-busy={deployBusy || undefined}
                      onClick={() => onDeploy(skill.id, target)}
                    >
                      {deployBusy ? "应用中…" : "应用"}
                    </button>
                  ) : (
                    <span className="target-issue-hint">路径不存在</span>
                  )
                )}
                {s === "applied" && (
                  <button
                    className="row-action-btn withdraw"
                    disabled={withdrawBusy}
                    aria-busy={withdrawBusy || undefined}
                    onClick={() => onWithdraw(skill.id, target)}
                  >
                    {withdrawBusy ? "收回中…" : "收回"}
                  </button>
                )}
                {s === "problem" && (
                  <>
                    <div className="target-issue-reason">{issue ?? "状态异常"}</div>
                    {canOverwrite ? (
                      <button
                        className="row-action-btn apply"
                        disabled={deployBusy}
                        aria-busy={deployBusy || undefined}
                        onClick={() => onDeploy(skill.id, target, { confirmOverwrite: true })}
                      >
                        {deployBusy ? "覆盖中…" : "覆盖"}
                      </button>
                    ) : (
                      <span className="target-issue-hint">需手动处理，不可一键覆盖</span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Content preview - collapsible */}
        {skill.contentPreview && (
          <div className="drawer-section">
            <div className="drawer-collapsible-row">
              <button
                type="button"
                className="drawer-section-title drawer-collapsible"
                aria-expanded={showContent}
                onClick={toggleContent}
              >
                <span>SKILL.md{fullContent ? "（全文）" : "（预览前 4000 字符）"}</span>
                <span className={`drawer-chevron ${showContent ? "open" : ""}`} aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                className="drawer-link-btn"
                onClick={() => handleOpenPath(skill.path)}
              >
                打开原文件
              </button>
            </div>
            {showContent && (
              <div className="markdown-preview">
                {contentLoading ? (
                  <span className="import-zone-hint">读取全文中…</span>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // 外链不在应用窗口内跳转，避免整个界面被替换。
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => { if (!href || !/^https?:|^mailto:/i.test(href)) e.preventDefault(); }}
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {fullContent || skill.contentPreview}
                  </ReactMarkdown>
                )}
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
      // 只关闭输入框，不关闭整个抽屉
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setEditing(false);
      setInput("");
    }
  };

  return (
    <div className="tag-editor">
      {tags.map(tag => {
        const p = TAG_PALETTE[resolveTagColor(tag, tagColorMap)];
        return (
          <span key={tag} className="tag-pill" style={{ background: p.bg, color: p.text }}>
            {tag}
            <button type="button" className="tag-remove" onClick={() => handleRemove(tag)} aria-label={`移除标签 ${tag}`}>✕</button>
          </span>
        );
      })}
      {!editing ? (
        <button
          className="tag-add-btn"
          onClick={() => { setEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }}
          aria-label="添加标签"
          title="添加标签"
        >
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
            aria-label="输入标签名"
          />
          {(editing && (suggestions.length > 0 || input.trim())) && (
            <div className="tag-autocomplete" role="listbox">
              {suggestions.slice(0, 6).map((s, i) => (
                <div
                  key={s}
                  role="option"
                  aria-selected={i === highlightIndex}
                  className={`tag-autocomplete-item ${i === highlightIndex ? "highlighted" : ""}`}
                  onMouseDown={() => handleAdd(s)}
                >
                  {s}
                </div>
              ))}
              {input.trim() && !knownTags.includes(input.trim()) && (
                <div
                  className="tag-autocomplete-item"
                  role="option"
                  aria-selected={false}
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
  useEscape(onClose);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newTag.trim()) {
      onTagCreate(skill.id, newTag.trim(), skill.tags);
    }
  };

  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(x, window.innerWidth - 188)),
    top: Math.max(8, Math.min(y, window.innerHeight - 300)),
  };

  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" style={style} role="menu" aria-label={`${skill.displayName} 标签`}>
        <div className="context-menu-label">标签</div>
        {allTags.map(tag => (
          <button
            key={tag}
            type="button"
            role="menuitemcheckbox"
            aria-checked={skill.tags.includes(tag)}
            className="context-menu-item"
            onClick={() => onTagToggle(skill.id, tag, skill.tags)}
          >
            <span>{tag}</span>
            {skill.tags.includes(tag) && <span className="check">✓</span>}
          </button>
        ))}
        {allTags.length > 0 && <div className="context-menu-divider" />}
        <div className="context-menu-input">
          <input
            autoFocus
            value={newTag}
            onChange={e => setNewTag(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="新建标签，回车确认"
            aria-label="新建标签"
          />
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────
// Settings Drawer
// ────────────────────────────────────────

type Guard = <T>(title: string, fallback: string, op: () => Promise<T>) => Promise<T | undefined>;

function SettingsDrawer({
  state,
  setAppState,
  onClose,
  tagsInfo,
  setTagsInfo,
  reloadTagsInfo,
  tagColorMap,
  activeTag,
  setActiveTag,
  requestConfirm,
  onRemoveTarget,
  guard,
  showToast,
}: {
  state: AppState;
  setAppState: (state: AppState) => void;
  onClose: () => void;
  tagsInfo: TagInfo[];
  setTagsInfo: (tags: TagInfo[]) => void;
  reloadTagsInfo: () => Promise<void>;
  tagColorMap: Map<string, number>;
  activeTag: string | null;
  setActiveTag: (tag: string | null) => void;
  requestConfirm: (request: ConfirmRequest) => void;
  onRemoveTarget: (targetId: string) => void;
  guard: Guard;
  showToast: (message: Omit<ToastMessage, "id">) => void;
}) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pickerTag, setPickerTag] = useState<string | null>(null);
  const [confirmDeleteTag, setConfirmDeleteTag] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [showNewTagInput, setShowNewTagInput] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const panelRef = useFocusTrap<HTMLElement>({ initial: "panel" });

  // U17：设置抽屉 Esc 关闭（确认框打开时不穿透）+ 卸载还焦
  useEscape(onClose);

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

  const handleOpenPath = (path: string) =>
    guard("无法打开目录", path, () => openPath(path));

  const handleAddTarget = () =>
    guard("添加目标失败", "请确认选择的是一个可访问的文件夹。", async () => {
      const selected = await open({ directory: true, title: "选择项目根目录" });
      if (!selected || Array.isArray(selected)) return;
      const next = await addTarget(selected);
      setAppState(next);
      const added = next.targets.find(t => t.path === selected) ?? next.targets[next.targets.length - 1];
      showToast({ tone: "success", text: `已添加目标「${added?.name ?? selected}」` });
    });

  const handleRenameSubmit = async (oldName: string) => {
    const trimmed = editValue.trim();
    // 先退出编辑，避免 Enter 与 blur 重复提交
    setEditingTag(null);
    if (!trimmed || trimmed === oldName) return;
    try {
      const next = await renameTag(oldName, trimmed);
      setAppState(next);
      await reloadTagsInfo();
      if (activeTag === oldName) setActiveTag(trimmed);
    } catch (e) {
      // U16：重命名到已存在标签等被后端拒绝时就近解释
      requestConfirm({
        title: "无法重命名标签",
        body: errorText(e, "请换一个名称。"),
        details: [`目标名称：${trimmed}`],
        confirmLabel: "知道了",
        infoOnly: true,
        onConfirm: async () => {},
      });
    }
  };

  const handleColorChange = (tag: string, colorIndex: number) => {
    setPickerTag(null);
    return guard("修改颜色失败", "请稍后重试。", async () => {
      setTagsInfo(await setTagColor(tag, colorIndex));
    });
  };

  const handleDeleteTag = (tag: string) => {
    setConfirmDeleteTag(null);
    return guard("删除标签失败", "请稍后重试。", async () => {
      const next = await deleteTag(tag);
      setAppState(next);
      await reloadTagsInfo();
      if (activeTag === tag) setActiveTag(null);
    });
  };

  const handleDrop = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const previous = tagsInfo;
    const reordered = [...tagsInfo];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setTagsInfo(reordered);
    const result = await guard("调整顺序失败", "已恢复原顺序。", () => reorderTags(reordered.map(t => t.name)));
    // S2：保存失败时恢复原顺序，界面与数据库保持一致
    setTagsInfo(result ?? previous);
  };

  const handleNewTag = async () => {
    const trimmed = newTagName.trim();
    setShowNewTagInput(false);
    setNewTagName("");
    if (!trimmed) return;
    await guard("新建标签失败", "请稍后重试。", async () => {
      setTagsInfo(await createTag(trimmed));
    });
  };

  return (
    <div className="settings-drawer-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        className="settings-drawer"
        onClick={e => e.stopPropagation()}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="settings-drawer-header">
          <h2 id="settings-title">设置</h2>
          <button className="settings-drawer-close" onClick={onClose} aria-label="关闭设置">✕</button>
        </div>
        <div className="settings-drawer-body">

          <div className="settings-section">
            <div className="settings-section-label">技能根目录</div>
            <div className="settings-path-card">
              <div className="settings-path-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
              </div>
              <div className="settings-path-info">
                <div className="settings-path-name">主库</div>
                <div className="settings-path-value">{state.skillsRoot}</div>
              </div>
              <button className="settings-path-action" onClick={() => handleOpenPath(state.skillsRoot)} title="在访达中打开" aria-label="在访达中打开主库">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-label">目标目录</div>
            {state.targets.map(t => {
              const missing = !targetUsable(t);
              return (
                <div key={t.id} className={`settings-path-card${missing ? " is-missing" : ""}`}>
                  <div className="settings-path-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>
                  </div>
                  <div className="settings-path-info">
                    <div className="settings-path-name">
                      {t.name}
                      {t.isDefault && <span className="settings-default-badge">默认</span>}
                      {missing && <span className="target-missing-tag">路径不存在</span>}
                    </div>
                    <div className="settings-path-value">{t.path}</div>
                  </div>
                  {!missing && (
                    <button className="settings-path-action" onClick={() => handleOpenPath(t.path)} title="在访达中打开" aria-label={`在访达中打开 ${t.name}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </button>
                  )}
                  {!t.isDefault && (
                    <button className="settings-path-action settings-path-action-danger" onClick={() => onRemoveTarget(t.id)} title="移除目标" aria-label={`移除目标 ${t.name}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              );
            })}
            <button className="settings-add-btn" onClick={handleAddTarget}>+ 添加目标</button>
          </div>

          <div className="settings-section">
            <div className="settings-section-label">标签管理</div>
            {tagsInfo.length > 0 ? (
              <div className="settings-tag-list">
                {tagsInfo.map((t, idx) => {
                  const ci = resolveTagColor(t.name, tagColorMap);
                  const p = TAG_PALETTE[ci];
                  return (
                    <div
                      key={t.name}
                      className={`settings-tag-row${dragIdx === idx ? " dragging" : ""}${dropIdx === idx ? " drop-above" : ""}`}
                      draggable
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={e => { e.preventDefault(); setDropIdx(idx); }}
                      onDragLeave={() => setDropIdx(null)}
                      onDrop={e => { e.preventDefault(); if (dragIdx !== null) handleDrop(dragIdx, idx); setDragIdx(null); setDropIdx(null); }}
                      onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                    >
                      <div className="settings-tag-drag-handle" aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                      </div>
                      <div className="settings-tag-color-wrap">
                        <button
                          type="button"
                          className="settings-tag-dot"
                          style={{ background: p.bg, color: p.text }}
                          onClick={() => setPickerTag(pickerTag === t.name ? null : t.name)}
                          aria-label={`修改标签 ${t.name} 的颜色`}
                          aria-expanded={pickerTag === t.name}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>
                        </button>
                        {pickerTag === t.name && (
                          <div className="settings-tag-picker" ref={pickerRef}>
                            {TAG_PALETTE.map((c, i) => (
                              <button
                                key={i}
                                type="button"
                                className={`settings-tag-picker-option ${i === ci ? "selected" : ""}`}
                                style={{ background: c.bg, color: c.text }}
                                onClick={() => handleColorChange(t.name, i)}
                                aria-label={`颜色 ${i + 1}`}
                                aria-pressed={i === ci}
                              >
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="settings-tag-name-area">
                        {editingTag === t.name ? (
                          <input
                            className="settings-tag-name-input"
                            value={editValue}
                            autoFocus
                            aria-label={`重命名标签 ${t.name}`}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleRenameSubmit(t.name);
                              if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setEditingTag(null); }
                            }}
                            onBlur={() => { if (editingTag === t.name) handleRenameSubmit(t.name); }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="settings-tag-name"
                            onClick={() => { setEditingTag(t.name); setEditValue(t.name); }}
                            title="点击重命名"
                          >
                            {t.name}
                          </button>
                        )}
                        <span className="settings-tag-count">{t.count} 个技能</span>
                      </div>
                      <div className="settings-tag-actions">
                        {confirmDeleteTag === t.name ? (
                          <>
                            <button className="settings-tag-action-btn settings-tag-confirm-delete" onClick={() => handleDeleteTag(t.name)}>
                              确认删除
                            </button>
                            <button className="settings-tag-action-btn" onClick={() => setConfirmDeleteTag(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <button
                            className="settings-tag-action-btn settings-tag-action-danger"
                            onClick={() => setConfirmDeleteTag(t.name)}
                            title="删除标签"
                            aria-label={`删除标签 ${t.name}`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="settings-tag-empty">
                还没有标签。在技能详情中为技能添加标签即可自动创建。
              </div>
            )}
            {showNewTagInput ? (
              <div className="settings-tag-new-row">
                <span className="settings-tag-dot" style={{ background: TAG_PALETTE[0].bg, opacity: 0.5 }} aria-hidden="true">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill={TAG_PALETTE[0].text}><circle cx="12" cy="12" r="5"/></svg>
                </span>
                <input
                  className="settings-tag-name-input"
                  placeholder="输入标签名称，回车确认"
                  aria-label="新标签名称"
                  value={newTagName}
                  autoFocus
                  onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleNewTag();
                    if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setShowNewTagInput(false); setNewTagName(""); }
                  }}
                  onBlur={() => { if (showNewTagInput) handleNewTag(); }}
                />
              </div>
            ) : (
              <button className="settings-add-btn" onClick={() => setShowNewTagInput(true)}>+ 新建标签</button>
            )}
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
  onDone: (result: ImportDoneResult) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // U09：ZIP 扫描后先预览勾选，不自动全导
  const [scanned, setScanned] = useState<{
    path: string;
    skills: { id: string; displayName: string; description: string; exists: boolean }[];
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const modalRef = useFocusTrap<HTMLDivElement>();

  const back = useCallback(() => { if (!importing) setScanned(null); }, [importing]);
  const close = useCallback(() => { if (!importing) onClose(); }, [importing, onClose]);
  useEscape(scanned ? back : close);

  const runFolder = async (selected: string) => {
    setImporting(true);
    try {
      const nextState = await importSkill(selected);
      onDone({ state: nextState, changed: 1, skipped: 0, errors: [] });
    } catch (e) {
      setError(`导入失败：${errorText(e, "请确认文件夹中包含 SKILL.md。")}`);
    } finally {
      setImporting(false);
    }
  };

  const handlePickFolder = async () => {
    setError(null);
    try {
      const selected = await open({ directory: true, title: "选择包含 SKILL.md 的文件夹" });
      if (!selected || Array.isArray(selected)) return; // 取消：无后台动作
      await runFolder(selected);
    } catch (e) {
      setError(`无法打开文件选择器：${errorText(e, "请重试。")}`);
    }
  };

  const handlePickZip = async () => {
    setError(null);
    let selected: string | null = null;
    try {
      const picked = await open({ directory: false, multiple: false, filters: [{ name: "压缩包", extensions: ["zip"] }] });
      if (!picked || Array.isArray(picked)) return;
      selected = picked;
    } catch (e) {
      setError(`无法打开文件选择器：${errorText(e, "请重试。")}`);
      return;
    }
    setImporting(true);
    try {
      const scan = await scanSkillPackage(selected);
      const list = (scan.skills ?? []).map(s => ({
        id: s.id,
        displayName: s.displayName || s.name,
        description: s.description || "",
        exists: !!s.exists,
      }));
      if (list.length === 0) {
        setError("压缩包里没有找到 SKILL.md。");
        return;
      }
      setScanned({ path: selected, skills: list });
      // 已存在的同名技能默认不勾选（导入时会被跳过）
      setSelectedIds(new Set(list.filter(s => !s.exists).map(s => s.id)));
    } catch (e) {
      setError(`扫描失败：${errorText(e, "请确认压缩包未损坏。")}`);
    } finally {
      setImporting(false);
    }
  };

  const handleImportSelected = async () => {
    if (!scanned) return;
    setImporting(true);
    try {
      const result = await importSkillsFromPackage(scanned.path, Array.from(selectedIds));
      onDone(result);
    } catch (e) {
      setError(`导入失败：${errorText(e, "请稍后重试。")}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={scanned ? undefined : close}>
      <div className="modal import-modal" ref={modalRef} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="import-title" aria-busy={importing || undefined}>
        <div className="import-modal-header">
          <h3 id="import-title">导入技能</h3>
          <button className="import-modal-close" onClick={scanned ? back : close} aria-label={scanned ? "返回" : "关闭"} disabled={importing}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M1.5 1.5L12.5 12.5M12.5 1.5L1.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {!scanned ? (
          <>
            <div className="import-actions">
              <button className="import-zone" onClick={handlePickFolder} disabled={importing} type="button">
                <span className="import-zone-label">选择文件夹</span>
                <span className="import-zone-hint">包含 SKILL.md 的技能目录</span>
              </button>
              <button className="import-zone" onClick={handlePickZip} disabled={importing} type="button">
                <span className="import-zone-label">选择 .zip 压缩包</span>
                <span className="import-zone-hint">扫描后可勾选再导入</span>
              </button>
            </div>
            {importing && <div className="import-zone-hint" role="status">正在处理…</div>}
          </>
        ) : (
          <>
            <div className="import-preview-list">
              {scanned.skills.map(s => (
                <label key={s.id} className={`import-preview-item${s.exists ? " is-existing" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    disabled={importing}
                    onChange={(e) => {
                      const next = new Set(selectedIds);
                      if (e.target.checked) next.add(s.id); else next.delete(s.id);
                      setSelectedIds(next);
                    }}
                  />
                  <span className="import-preview-name">{s.displayName}</span>
                  {s.exists && <span className="target-missing-tag">已存在，将跳过</span>}
                  <span className="import-zone-hint">{s.description}</span>
                </label>
              ))}
            </div>
            <div className="import-modal-footer">
              <button className="btn btn-secondary" onClick={back} disabled={importing}>返回</button>
              <button className="btn btn-primary" onClick={handleImportSelected} disabled={importing || selectedIds.size === 0} aria-busy={importing || undefined}>
                {importing ? "导入中…" : `导入选中 ${selectedIds.size} 项`}
              </button>
            </div>
          </>
        )}

        {error && <p className="import-error" role="alert">{error}</p>}
        <p className="import-note">导入后进入主库，需再手动分发到目标目录。</p>
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
  // 默认聚焦第一个按钮（「先不操作」）：误按回车不会执行危险操作
  const dialogRef = useFocusTrap<HTMLElement>();

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
    } finally {
      setWorking(false);
      onClose();
    }
  };

  return (
    <div className="confirm-backdrop" onClick={working ? undefined : onClose}>
      <section
        className="confirm-dialog"
        ref={dialogRef}
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <div className="confirm-kicker">{request.infoOnly ? "提示" : "确认操作"}</div>
        <h3 id="confirm-title">{request.title}</h3>
        <p id="confirm-body">{request.body}</p>
        {request.details && request.details.length > 0 && (
          <div className="confirm-details">
            {request.details.map(detail => (
              <div key={detail} className="confirm-detail-row">{detail}</div>
            ))}
          </div>
        )}
        <div className="confirm-actions">
          {request.infoOnly ? (
            <button className="btn btn-primary" onClick={onClose}>
              {request.confirmLabel}
            </button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose} disabled={working}>
                先不操作
              </button>
              <button
                className={`btn ${request.tone === "danger" ? "btn-danger" : "btn-primary"}`}
                onClick={handleConfirm}
                disabled={working}
                aria-busy={working || undefined}
              >
                {working ? "处理中…" : request.confirmLabel}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Toast({
  message,
  exiting,
  onMouseEnter,
  onMouseLeave,
}: {
  message: ToastMessage;
  exiting: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <div
      className={`toast toast-${message.tone}${exiting ? " toast-exiting" : ""}`}
      role={message.tone === "error" || message.tone === "warning" ? "alert" : "status"}
      aria-live={message.tone === "error" || message.tone === "warning" ? "assertive" : "polite"}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="toast-text">{message.text}</span>
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
