// 影子 — 纯逻辑视图模型（无 React 依赖，便于单测）
// 由 App.tsx 消费；导出交 api/types 测试方直接断言。

import type { OperationReport } from "./types";

export interface ExplainResult {
  tone: "success" | "error" | "info" | "warning";
  title: string;
  lines: string[];
  failedIds: string[];
}

// U01：诚实展示操作报告。有 errors 不全绿；有 skip 不冒成功。
export function explainReport(
  report: Pick<OperationReport, "changed" | "skipped" | "conflicts" | "errors">,
  options?: { plural?: string; verb?: "应用" | "收回" },
): ExplainResult {
  const noun = options?.plural ?? "技能";
  const verb = options?.verb ?? "应用";
  const { changed, skipped, conflicts, errors } = report;
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(...errors);
    if (conflicts.length > 0) lines.push(...conflicts);
    return {
      tone: changed > 0 ? "warning" : "error",
      title:
        changed > 0
          ? `部分完成：成功 ${changed} 个，失败 ${errors.length} 个`
          : `${verb}未完成（${errors.length} 个失败）`,
      lines,
      failedIds: [],
    };
  }
  if (conflicts.length > 0) {
    lines.push(...conflicts);
    return {
      tone: "warning",
      title:
        changed > 0
          ? `已${verb} ${changed} 个，${conflicts.length} 个被跳过（冲突）`
          : `${conflicts.length} 个存在冲突，未${verb}`,
      lines,
      failedIds: [],
    };
  }
  if (changed > 0) {
    return { tone: "success", title: `已${verb} ${changed} 个${noun}`, lines, failedIds: [] };
  }
  if (skipped > 0) {
    const where = verb === "收回" ? "本来就不在目标位置" : "已在目标位置";
    return { tone: "info", title: `无需更改：${skipped} 个${noun}${where}`, lines, failedIds: [] };
  }
  return { tone: "info", title: "没有需要变更的内容", lines, failedIds: [] };
}

export interface FilterInput {
  search: string;
  activeTag: string | null;
  statusFilter?: "applied" | "notApplied" | "problem" | null;
  skillStatusMap?: Map<string, { status: "applied" | "notApplied" | "problem" }>;
}

// U11/U12：搜索 + 标签 + 状态三态筛选（同源集合）。搜索同时匹配名称、描述和标签名。
export function filterSkills<T extends { id: string; displayName: string; description: string; name: string; tags: string[] }>(
  skills: T[],
  input: FilterInput,
): T[] {
  let list = skills;
  if (input.search.trim()) {
    const q = input.search.trim().toLowerCase();
    list = list.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (input.activeTag === "__NO_TAG__") {
    list = list.filter((s) => s.tags.length === 0);
  } else if (input.activeTag) {
    const tag = input.activeTag;
    list = list.filter((s) => s.tags.includes(tag));
  }
  if (input.statusFilter && input.skillStatusMap) {
    const want = input.statusFilter;
    list = list.filter((s) => {
      const st = input.skillStatusMap?.get(s.id as string);
      return (st?.status ?? "notApplied") === want;
    });
  }
  return list;
}

export interface SkillGroup<T> {
  key: string;
  label: string;
  color: string;
  skills: T[];
}

// U11：目标上下文按 problem/applied/notApplied 三态分组，problem 置顶；否则按标签分组
export function groupSkills<T extends { id: string; tags: string[] }>(
  skills: T[],
  input: {
    hasActiveTarget: boolean;
    skillStatusMap?: Map<string, { status: "applied" | "notApplied" | "problem" }>;
    allTags: string[];
    tagColorOf: (tag: string) => { text: string };
  },
): SkillGroup<T>[] {
  if (input.hasActiveTarget) {
    const problem: T[] = [];
    const applied: T[] = [];
    const notApplied: T[] = [];
    for (const skill of skills) {
      const st = input.skillStatusMap?.get(skill.id);
      const status = st?.status ?? "notApplied";
      if (status === "problem") problem.push(skill);
      else if (status === "applied") applied.push(skill);
      else notApplied.push(skill);
    }
    const out: SkillGroup<T>[] = [];
    if (problem.length > 0) out.push({ key: "problem", label: "有问题", color: "#991B1B", skills: problem });
    if (applied.length > 0) out.push({ key: "applied", label: "已应用", color: "#346538", skills: applied });
    if (notApplied.length > 0) out.push({ key: "notApplied", label: "未应用", color: "#A8A5A0", skills: notApplied });
    return out;
  }
  const tagGroups = new Map<string, T[]>();
  const noTag: T[] = [];
  for (const skill of skills) {
    if (skill.tags.length === 0) {
      noTag.push(skill);
      continue;
    }
    let assigned: string | null = null;
    for (const t of input.allTags) {
      if (skill.tags.includes(t)) {
        assigned = t;
        break;
      }
    }
    if (assigned === null) assigned = skill.tags[0] as string;
    if (!tagGroups.has(assigned)) tagGroups.set(assigned, []);
    tagGroups.get(assigned)!.push(skill);
  }
  const out: SkillGroup<T>[] = [];
  for (const tag of input.allTags) {
    const group = tagGroups.get(tag);
    if (group && group.length > 0) {
      out.push({ key: tag, label: tag, color: input.tagColorOf(tag).text, skills: group });
    }
  }
  if (noTag.length > 0) out.push({ key: "__NO_TAG__", label: "无标签", color: "#A8A5A0", skills: noTag });
  return out;
}

// U12：批量作用于筛选结果中状态匹配的子集（problem 不自动覆盖）
export function batchTargets<T extends { id: string }>(
  filtered: T[],
  skillStatusMap: Map<string, { status: "applied" | "notApplied" | "problem" }> | undefined,
  mode: "deploy" | "withdraw",
): T[] {
  return filtered.filter((skill) => {
    const st = skillStatusMap?.get(skill.id);
    const status = st?.status ?? "notApplied";
    if (mode === "deploy") return status === "notApplied";
    return status === "applied";
  });
}

export function batchStats(
  filtered: { id: string }[],
  skillStatusMap: Map<string, { status: "applied" | "notApplied" | "problem" }> | undefined,
) {
  return {
    matched: filtered.length,
    deployable: batchTargets(filtered, skillStatusMap, "deploy").length,
    withdrawable: batchTargets(filtered, skillStatusMap, "withdraw").length,
  };
}

export interface PerSkillOutcome {
  skillId: string;
  displayName: string;
  ok: boolean;
  reason?: string;
}

export type BatchMode = "deploy" | "withdraw";

// U02/S3：批量结果记住本次操作类型，「重试失败项」沿用同一类型，绝不反向执行。
export interface BatchResult {
  mode: BatchMode;
  results: PerSkillOutcome[];
  cancelled: boolean;
}

export function summarizeBatch(results: PerSkillOutcome[], cancelled: boolean) {
  const failed = results.filter((r) => !r.ok);
  return { results, succeeded: results.length - failed.length, failed, cancelled };
}

const MODE_VERB: Record<BatchMode, string> = { deploy: "应用", withdraw: "收回" };

export function batchModeVerb(mode: BatchMode): string {
  return MODE_VERB[mode];
}

// 批量结果的呈现策略：全部成功只弹 toast；有失败才显示持久面板。
export function batchOutcomeView(batch: BatchResult): {
  showPanel: boolean;
  tone: "success" | "warning" | "error" | "info";
  title: string;
  retryLabel: string | null;
  failedIds: string[];
} {
  const sum = summarizeBatch(batch.results, batch.cancelled);
  const verb = batchModeVerb(batch.mode);
  const failedIds = sum.failed.map((f) => f.skillId);
  const cancelNote = batch.cancelled ? "，其余已取消" : "";
  if (sum.failed.length === 0) {
    return {
      showPanel: false,
      tone: batch.cancelled ? "info" : "success",
      title: `已${verb} ${sum.succeeded} 个技能${cancelNote}`,
      retryLabel: null,
      failedIds,
    };
  }
  return {
    showPanel: true,
    tone: sum.succeeded > 0 ? "warning" : "error",
    title: `批量${verb}：${sum.succeeded} 成功，${sum.failed.length} 失败${cancelNote}`,
    retryLabel: `重试${verb}失败的 ${sum.failed.length} 项`,
    failedIds,
  };
}

// 目标是否可写：项目根不存在时阻断应用；默认全局目录缺失时后端会自动创建。
export function targetUsable(target: { isDefault: boolean; targetExists: boolean }): boolean {
  return target.isDefault || target.targetExists;
}

// U05：目标中由本管理器管理（已应用）的链接数
export function managedCountInTarget(statuses: { status: string }[]): number {
  return statuses.filter((s) => s.status === "applied").length;
}

// U10：导入报告 tone（有错不全绿）
export function importTone(r: { changed: number; skipped: number; errors: string[] }) {
  if (r.errors.length > 0) return r.changed > 0 ? "warning" : "error";
  if (r.skipped > 0) return "info";
  return "success";
}

export function importLines(r: { changed: number; skipped: number; errors: string[] }): string[] {
  const lines: string[] = [];
  if (r.changed > 0) lines.push(`新增 ${r.changed} 个技能`);
  if (r.skipped > 0) lines.push(`跳过 ${r.skipped} 个（已存在）`);
  if (r.errors.length > 0) lines.push(...r.errors);
  return lines;
}
