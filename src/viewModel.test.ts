// Contract tests for src/viewModel.ts (pure logic). Owned by the adapter/test side.
// These pin the U-numbered behaviors from the rectification matrix; they are
// FRONTEND unit tests, not native acceptance.
import { describe, it, expect } from "vitest";
import {
  explainReport,
  filterSkills,
  groupSkills,
  batchTargets,
  batchStats,
  batchOutcomeView,
  summarizeBatch,
  managedCountInTarget,
  importTone,
  importLines,
  targetUsable,
} from "./viewModel.ts";
import type { Skill } from "./types.ts";

function skill(id: string, tags: string[] = []): Skill {
  return {
    id, name: id, displayName: id, description: `${id} desc`,
    path: `/skills/${id}`, tags, enabledCount: 0, issueCount: 0, contentPreview: "",
  };
}

function statusMap(entries: Record<string, "applied" | "notApplied" | "problem">) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, { status: v }]));
}

describe("U01 explainReport — errors 非空绝不报 success", () => {
  it("all failed → error tone, no success title", () => {
    const r = explainReport({ changed: 0, skipped: 0, conflicts: [], errors: ["目标不存在", "无权限"] });
    expect(r.tone).toBe("error");
    expect(r.title).toContain("失败");
    expect(r.tone).not.toBe("success");
  });

  it("partial success + errors → warning, not success", () => {
    const r = explainReport({ changed: 2, skipped: 0, conflicts: [], errors: ["proj: 无权限"] });
    expect(r.tone).toBe("warning");
    expect(r.title).toContain("部分");
    expect(r.tone).not.toBe("success");
  });

  it("pure changed → success", () => {
    const r = explainReport({ changed: 3, skipped: 0, conflicts: [], errors: [] });
    expect(r.tone).toBe("success");
    expect(r.title).toContain("3");
  });

  it("changed=0 && skipped>0 → info 无需更改", () => {
    const r = explainReport({ changed: 0, skipped: 2, conflicts: [], errors: [] });
    expect(r.tone).toBe("info");
    expect(r.title).toContain("无需更改");
  });

  it("conflicts without overwrite → warning, lists conflicts", () => {
    const r = explainReport({ changed: 0, skipped: 0, conflicts: ["alpha 已存在同名内容"], errors: [] });
    expect(r.tone).toBe("warning");
    expect(r.lines).toContain("alpha 已存在同名内容");
  });
});

describe("U02 summarizeBatch — 失败子集可重试", () => {
  it("splits succeeded vs failed", () => {
    const sum = summarizeBatch([
      { skillId: "a", displayName: "A", ok: true },
      { skillId: "b", displayName: "B", ok: false, reason: "无权限" },
      { skillId: "c", displayName: "C", ok: true },
    ], false);
    expect(sum.succeeded).toBe(2);
    expect(sum.failed.map(f => f.skillId)).toEqual(["b"]);
    expect(sum.cancelled).toBe(false);
  });
});

describe("U11 groupSkills — problem 独立置顶，不并入已应用", () => {
  const skills = [skill("a"), skill("b"), skill("c")];
  const map = statusMap({ a: "applied", b: "problem", c: "notApplied" });

  it("problem 是第一组且不与 applied 合并", () => {
    const groups = groupSkills(skills, {
      hasActiveTarget: true, skillStatusMap: map, allTags: [], tagColorOf: () => ({ text: "#000" }),
    });
    expect(groups[0].key).toBe("problem");
    expect(groups.find(g => g.key === "problem")!.skills.map(s => s.id)).toEqual(["b"]);
    expect(groups.find(g => g.key === "applied")!.skills.map(s => s.id)).toEqual(["a"]);
  });

  it("无 active target 时按标签归组，无标签独立成组", () => {
    const tagged = [skill("x", ["产品"]), skill("y", []), skill("z", ["产品"])];
    const groups = groupSkills(tagged, {
      hasActiveTarget: false, skillStatusMap: undefined, allTags: ["产品"], tagColorOf: () => ({ text: "#000" }),
    });
    expect(groups.find(g => g.key === "产品")!.skills.map(s => s.id).sort()).toEqual(["x", "z"]);
    expect(groups.find(g => g.key === "__NO_TAG__")!.skills.map(s => s.id)).toEqual(["y"]);
  });
});

describe("U12 filterSkills + batchTargets — 同一集合驱动计数", () => {
  const skills = [skill("alpha", ["产品"]), skill("beta", ["产品"]), skill("gamma", [])];

  it("search + tag + status 共同作用", () => {
    const map = statusMap({ alpha: "notApplied", beta: "applied", gamma: "problem" });
    const out = filterSkills(skills, { search: "al", activeTag: "产品", statusFilter: "notApplied", skillStatusMap: map });
    expect(out.map(s => s.id)).toEqual(["alpha"]);
  });

  it("__NO_TAG__ 筛出无标签", () => {
    const out = filterSkills(skills, { search: "", activeTag: "__NO_TAG__", statusFilter: null, skillStatusMap: undefined });
    expect(out.map(s => s.id)).toEqual(["gamma"]);
  });

  it("batch deploy 排除 problem 与 applied，只收 notApplied", () => {
    const map = statusMap({ a: "notApplied", b: "problem", c: "applied", d: "notApplied" });
    const list = [skill("a"), skill("b"), skill("c"), skill("d")];
    const deployable = batchTargets(list, map, "deploy").map(s => s.id);
    expect(deployable.sort()).toEqual(["a", "d"]);
    const withdrawable = batchTargets(list, map, "withdraw").map(s => s.id);
    expect(withdrawable).toEqual(["c"]);
  });

  it("batchStats 计数 = deployable + withdrawable + matched", () => {
    const map = statusMap({ a: "notApplied", b: "applied" });
    const st = batchStats([skill("a"), skill("b")], map);
    expect(st.matched).toBe(2);
    expect(st.deployable).toBe(1);
    expect(st.withdrawable).toBe(1);
  });
});

describe("U05 managedCountInTarget — 有受管链接时禁止移除目标", () => {
  it("counts applied only", () => {
    expect(managedCountInTarget([
      { status: "applied" }, { status: "problem" }, { status: "notApplied" }, { status: "applied" },
    ])).toBe(2);
  });
});

describe("U10 importTone/importLines — 不静默成功", () => {
  it("errors>0 && changed>0 → warning", () => {
    expect(importTone({ changed: 1, skipped: 0, errors: ["损坏"] })).toBe("warning");
  });
  it("errors only → error", () => {
    expect(importTone({ changed: 0, skipped: 0, errors: ["损坏"] })).toBe("error");
  });
  it("skipped>0 → info, 不 success", () => {
    expect(importTone({ changed: 0, skipped: 1, errors: [] })).toBe("info");
  });
  it("lines list skipped + errors", () => {
    expect(importLines({ changed: 2, skipped: 1, errors: ["损坏"] })).toEqual(["新增 2 个技能", "跳过 1 个（已存在）", "损坏"]);
  });
});

describe("P0-2 explainReport 收回文案", () => {
  it("收回失败 → error，标题写明收回", () => {
    const r = explainReport({ changed: 0, skipped: 0, conflicts: [], errors: ["不是软链接"] }, { verb: "收回" });
    expect(r.tone).toBe("error");
    expect(r.title).toContain("收回未完成");
  });
  it("收回成功 → success", () => {
    const r = explainReport({ changed: 1, skipped: 0, conflicts: [], errors: [] }, { verb: "收回" });
    expect(r.tone).toBe("success");
    expect(r.title).toBe("已收回 1 个技能");
  });
  it("收回时 skipped → info，说明本来就不在目标位置", () => {
    const r = explainReport({ changed: 0, skipped: 1, conflicts: [], errors: [] }, { verb: "收回" });
    expect(r.tone).toBe("info");
    expect(r.title).toContain("本来就不在目标位置");
  });
});

describe("S3/I4 batchOutcomeView — 记住操作类型，全成功不弹面板", () => {
  const okA = { skillId: "a", displayName: "A", ok: true };
  const badB = { skillId: "b", displayName: "B", ok: false, reason: "x" };

  it("全部成功：不显示面板，toast success", () => {
    const v = batchOutcomeView({ mode: "deploy", results: [okA], cancelled: false });
    expect(v.showPanel).toBe(false);
    expect(v.tone).toBe("success");
    expect(v.retryLabel).toBeNull();
  });

  it("收回部分失败：warning 面板，重试文案写明“收回”", () => {
    const v = batchOutcomeView({ mode: "withdraw", results: [okA, badB], cancelled: false });
    expect(v.showPanel).toBe(true);
    expect(v.tone).toBe("warning");
    expect(v.retryLabel).toBe("重试收回失败的 1 项");
    expect(v.failedIds).toEqual(["b"]);
  });

  it("全部失败：error 面板", () => {
    const v = batchOutcomeView({ mode: "deploy", results: [badB], cancelled: false });
    expect(v.tone).toBe("error");
    expect(v.title).toContain("0 成功，1 失败");
  });

  it("取消且无失败：info，标题注明已取消", () => {
    const v = batchOutcomeView({ mode: "deploy", results: [okA], cancelled: true });
    expect(v.showPanel).toBe(false);
    expect(v.tone).toBe("info");
    expect(v.title).toContain("其余已取消");
  });
});

describe("F1 targetUsable", () => {
  it("默认全局目录即使不存在也可用（后端会自动创建）", () => {
    expect(targetUsable({ isDefault: true, targetExists: false })).toBe(true);
  });
  it("项目目录不存在时不可用", () => {
    expect(targetUsable({ isDefault: false, targetExists: false })).toBe(false);
    expect(targetUsable({ isDefault: false, targetExists: true })).toBe(true);
  });
});

describe("F3 搜索匹配标签", () => {
  it("按标签名搜索", () => {
    const list = [skill("alpha", ["飞书"]), skill("beta", ["产品"])];
    expect(filterSkills(list, { search: "飞书", activeTag: null }).map(s => s.id)).toEqual(["alpha"]);
  });
});
