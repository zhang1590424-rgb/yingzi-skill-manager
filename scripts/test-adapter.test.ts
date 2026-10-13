// Adapter contract tests: transformState against a realistic serde payload.
// Run with Node's built-in runner (strips types on Node 22):
//   node --experimental-strip-types --test scripts/test-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { transformState, type RawAppState } from "../src/transform.ts";

function raw(overrides: Partial<RawAppState> = {}): RawAppState {
  return {
    baseDir: "/x/.skills-manager",
    skillsRoot: "/x/.skills-manager/skills",
    databasePath: "/x/.skills-manager/app.db",
    configPath: "/x/.skills-manager/config.json",
    targets: [
      { id: "agents", name: "全局", path: "/x/.agents", isDefault: true, pathExists: true },
      { id: "p1", name: "项目", path: "/x/proj", isDefault: false, pathExists: false },
    ],
    skills: [
      { id: "a", name: "a", displayName: "A", description: "da", path: "/x/.skills-manager/skills/a", tags: ["产品"], enabledCount: 1, issueCount: 0, contentPreview: "# A" },
    ],
    workspaces: [
      {
        targetId: "agents",
        targetName: "全局",
        targetPath: "/x/.agents",
        skillsPath: "/x/.agents/skills",
        targetExists: true,
        rootExists: true,
        statuses: [
          { id: "agents-a", skillId: "a", skillName: "a", displayName: "A", description: "da", targetId: "agents", targetName: "全局", status: "enabled", targetPath: "/x/.agents/skills/a", issue: null, linkTarget: "/x/.skills-manager/skills/a", rootExists: true },
          { id: "agents-b", skillId: "b", skillName: "b", displayName: "B", description: "db", targetId: "agents", targetName: "全局", status: "broken", targetPath: "/x/.agents/skills/b", issue: "软链失效", linkTarget: "/x/missing", rootExists: true },
          { id: "agents-c", skillId: "c", skillName: "c", displayName: "C", description: "dc", targetId: "agents", targetName: "全局", status: "disabled", targetPath: "/x/.agents/skills/c", issue: null, linkTarget: null, rootExists: true },
        ],
      },
    ],
    issues: ["全局 / B：软链失效"],
    isIsolated: false,
    ...overrides,
  };
}

test("maps all 7 raw statuses to the 3 UI states", () => {
  const s = transformState(raw());
  const byId = Object.fromEntries((s.targetStatuses.get("agents") ?? []).map(x => [x.skillId, x.status]));
  assert.equal(byId.a, "applied");   // enabled → applied
  assert.equal(byId.c, "notApplied"); // disabled → notApplied
  assert.equal(byId.b, "problem");   // broken → problem
});

test("透传 issue/linkTarget/rootExists from raw status (U05)", () => {
  const s = transformState(raw());
  const b = s.targetStatuses.get("agents")!.find(x => x.skillId === "b")!;
  assert.equal(b.issue, "软链失效");
  assert.equal(b.linkTarget, "/x/missing");
  assert.equal(b.rootExists, true);
});

test("Target 展平 skillsPath/targetExists/rootExists/pathExists (U13)", () => {
  const s = transformState(raw());
  const agents = s.targets.find(t => t.id === "agents")!;
  assert.equal(agents.skillsPath, "/x/.agents/skills");
  assert.equal(agents.targetExists, true);
  assert.equal(agents.rootExists, true);
  assert.equal(agents.pathExists, true);
});

test("issues 与 isIsolated 透传", () => {
  const s = transformState(raw({ isIsolated: true, issues: ["x"] }));
  assert.deepEqual(s.issues, ["x"]);
  assert.equal(s.isIsolated, true);
});

test("default-safe on missing optional fields", () => {
  const s = transformState(raw({ issues: undefined as never, isIsolated: undefined as never }));
  assert.deepEqual(s.issues, []);
  assert.equal(s.isIsolated, false);
});

test("problem counts are independent of enabled (no green on broken)", () => {
  const s = transformState(raw());
  const statuses = s.targetStatuses.get("agents")!;
  assert.equal(statuses.filter(x => x.status === "problem").length, 1);
  assert.equal(statuses.filter(x => x.status === "applied").length, 1);
  assert.equal(statuses.filter(x => x.status === "notApplied").length, 1);
});

test("all raw status strings route to problem except enabled/disabled", () => {
  for (const st of ["unmanaged", "conflict", "pathMissing", "invalid"] as const) {
    const s = transformState(raw({
      workspaces: [{
        targetId: "agents", targetName: "全局", targetPath: "/x/.agents",
        skillsPath: "/x/.agents/skills", targetExists: true, rootExists: true,
        statuses: [{ id: `x-${st}`, skillId: "x", skillName: "x", displayName: "X", description: "", targetId: "agents", targetName: "全局", status: st, targetPath: "/x", issue: "i", linkTarget: null, rootExists: true }],
      }],
    }));
    assert.equal(s.targetStatuses.get("agents")![0].status, "problem");
  }
});

test("canOverwrite 透传；缺省时按不可覆盖处理（fail-closed）", () => {
  const base = raw();
  base.workspaces[0].statuses[1] = { ...base.workspaces[0].statuses[1], canOverwrite: true };
  const s = transformState(base);
  const list = s.targetStatuses.get("agents")!;
  assert.equal(list.find(x => x.skillId === "b")!.canOverwrite, true);
  // a / c 的原始数据没有 canOverwrite 字段（模拟旧后端）
  assert.equal(list.find(x => x.skillId === "a")!.canOverwrite, false);
  assert.equal(list.find(x => x.skillId === "c")!.canOverwrite, false);
});
