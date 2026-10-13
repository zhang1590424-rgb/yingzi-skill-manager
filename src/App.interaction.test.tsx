// Click-interaction tests driving the real <App/> in jsdom with a scripted
// Tauri invoke. FRONTEND component tests, not native acceptance.
//
// Act-policy (strict, no console/stderr filtering):
//  - every bare DOM .click() is wrapped in `await act(...)`
//  - every deferred promise resolve() is wrapped in `await act(async () => ...)`
//    so the resulting React state updates flush inside act scope.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.tsx";
import { serdeFixture } from "./test/fixtures.ts";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setDefaultRoutes() {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
    if (cmd === "get_all_tags_info") return Promise.resolve([]);
    if (cmd === "get_all_tags") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}
beforeEach(setDefaultRoutes);

async function mount(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".skill-card").length).toBeGreaterThan(0));
}

async function selectGlobal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("全部技能"));
  await user.click(await screen.findByText("全局"));
  await waitFor(() => expect(document.querySelector(".sticky-action-bar")).toBeTruthy());
}

describe("Hook order (U19): search filters to zero, clearing restores results", () => {
  it("0→nonzero transition in one mounted instance does not crash", async () => {
    const user = userEvent.setup();
    await mount(user);
    const search = screen.getByLabelText("搜索技能");
    await user.type(search, "zzz-no-match");
    // Filtered to zero: cards disappear.
    await waitFor(() => expect(screen.queryByText("Gamma")).toBeNull());
    // Clear search → results return (the 0→nonzero transition that used to crash).
    await user.clear(search);
    await waitFor(() => expect(screen.getAllByText(/Gamma/).length).toBeGreaterThan(0));
  });
});

describe("normal deploy", () => {
  it("普通「应用」calls deploy_skill with overwrite=false (U03)", async () => {
    const user = userEvent.setup();
    await mount(user);
    await selectGlobal(user);
    const gammaCard = screen.getByText("Gamma").closest(".skill-card")!;
    await user.click(within(gammaCard as HTMLElement).getByText("应用"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("deploy_skill", expect.objectContaining({ overwrite: false })));
  });

  it("double-click 应用 fires deploy_skill only once (U18)", async () => {
    const user = userEvent.setup();
    await mount(user);
    await selectGlobal(user);
    const gammaCard = screen.getByText("Gamma").closest(".skill-card")!;
    const btn = within(gammaCard as HTMLElement).getByText("应用");
    await act(async () => { btn.click(); btn.click(); });
    await waitFor(() => {
      const c = mockInvoke.mock.calls.filter(x => x[0] === "deploy_skill");
      expect(c.length).toBeLessThanOrEqual(1);
    });
  });

  it("partial failure does NOT show a success toast (U01)", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
      if (cmd === "get_all_tags_info" || cmd === "get_all_tags") return Promise.resolve([]);
      if (cmd === "deploy_skill") return Promise.resolve({ changed: 1, skipped: 0, conflicts: [], errors: ["无权限"], items: [] });
      return Promise.reject(new Error(cmd));
    });
    await mount(user);
    await selectGlobal(user);
    const gammaCard = screen.getByText("Gamma").closest(".skill-card")!;
    await user.click(within(gammaCard as HTMLElement).getByText("应用"));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("deploy_skill", expect.anything()));
    await waitFor(() => {
      const t = document.querySelector(".toast");
      expect(t).toBeTruthy();
      expect(t!.className).not.toContain("success");
    });
  });
});

describe("batch flow", () => {
  it("disables buttons & shows cancel while a batch runs", async () => {
    const user = userEvent.setup();
    const pend = deferred<any>();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
      if (cmd === "get_all_tags_info" || cmd === "get_all_tags") return Promise.resolve([]);
      if (cmd === "deploy_skill") return pend.promise;
      return Promise.reject(new Error(cmd));
    });
    await mount(user);
    await selectGlobal(user);
    await user.click(screen.getByText(/应用筛选中的/));
    // confirm dialog
    await screen.findByText("应用当前筛选结果？");
    await user.click(screen.getByText(/应用 \d+ 个技能/)); // primary confirm button
    // While pending: action buttons disabled, cancel visible.
    await waitFor(() => expect(screen.getByText("取消未开始项")).toBeInTheDocument());
    const bar = document.querySelector(".sticky-action-bar")!;
    expect(bar.querySelector("button[disabled]")).toBeTruthy();
    await act(async () => { pend.resolve({ changed: 1, skipped: 0, conflicts: [], errors: [], items: [] }); });
  });

  it("cancel stops remaining skills from being deployed", async () => {
    const user = userEvent.setup();
    const pend = deferred<any>();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
      if (cmd === "get_all_tags_info" || cmd === "get_all_tags") return Promise.resolve([]);
      if (cmd === "deploy_skill") return pend.promise;
      return Promise.reject(new Error(cmd));
    });
    await mount(user);
    await selectGlobal(user);
    await user.click(screen.getByText(/应用筛选中的/));
    await screen.findByText("应用当前筛选结果？");
    await user.click(screen.getByText(/应用 \d+ 个技能/));
    await waitFor(() => screen.getByText("取消未开始项"));
    await user.click(screen.getByText("取消未开始项"));
    await act(async () => { pend.resolve({ changed: 1, skipped: 0, conflicts: [], errors: [], items: [] }); });
    await waitFor(() => expect(mockInvoke.mock.calls.filter(c => c[0] === "deploy_skill").length).toBeLessThanOrEqual(1));
  });

  it("after partial failure offers 'retry failed only' and re-runs just those", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
      if (cmd === "get_all_tags_info" || cmd === "get_all_tags") return Promise.resolve([]);
      if (cmd === "deploy_skill") {
        return Promise.resolve({ changed: 1, skipped: 0, conflicts: [], errors: ["boom"], items: [] });
      }
      return Promise.reject(new Error(cmd));
    });
    await mount(user);
    await selectGlobal(user);
    await user.click(screen.getByText(/应用筛选中的/));
    await screen.findByText("应用当前筛选结果？");
    await user.click(screen.getByText(/应用 \d+ 个技能/));
    // partial failure bar with retry button (label names the original operation)
    const retry = await screen.findByText(/重试应用失败的 \d+ 项/);
    const before = mockInvoke.mock.calls.filter(c => c[0] === "deploy_skill").length;
    await user.click(retry);
    await waitFor(() => {
      const after = mockInvoke.mock.calls.filter(c => c[0] === "deploy_skill").length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe("error surface", () => {
  it("inline error persists until dismissed (not auto-dismissed)", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
      if (cmd === "get_all_tags_info" || cmd === "get_all_tags") return Promise.resolve([]);
      if (cmd === "deploy_skill") return Promise.reject(new Error("权限拒绝"));
      return Promise.reject(new Error(cmd));
    });
    await mount(user);
    await selectGlobal(user);
    const gammaCard = screen.getByText("Gamma").closest(".skill-card")!;
    await user.click(within(gammaCard as HTMLElement).getByText("应用"));
    await waitFor(() => expect(document.querySelector(".inline-error-bar")).toBeTruthy());
    // still there after a beat (no auto-dismiss)
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(document.querySelector(".inline-error-bar")).toBeTruthy();
  });
});

describe("Esc layering", () => {
  it("pressing Esc closes the drawer", async () => {
    const user = userEvent.setup();
    await mount(user);
    await user.click(screen.getByText("Gamma").closest(".skill-card")!);
    await waitFor(() => expect(document.querySelector(".drawer-panel")).toBeTruthy());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".drawer-panel")).toBeNull());
  });
});

describe("ZIP scan import", () => {
  it("opens the import modal with folder/zip zones", async () => {
    const user = userEvent.setup();
    await mount(user);
    await user.click(screen.getByTitle("导入技能"));
    await screen.findByText("导入技能");
    expect(screen.getByText("选择 .zip 压缩包")).toBeTruthy();
  });
});
