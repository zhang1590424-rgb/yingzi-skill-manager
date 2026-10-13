// Regression tests for the 2026-10 review fixes (P0-1, P0-2, S2, S3, I1, I2, I5, F1, F2).
// FRONTEND component tests driving the real <App/> in jsdom with a scripted Tauri
// invoke. Native acceptance happens separately in the isolated test.app.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.tsx";
import { serdeFixture } from "./test/fixtures.ts";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

type Handler = (args: Record<string, unknown> | undefined) => unknown;

function routes(extra: Record<string, Handler> = {}, fixture = serdeFixture()) {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
    const a = args as Record<string, unknown> | undefined;
    if (extra[cmd]) return Promise.resolve().then(() => extra[cmd](a));
    if (cmd === "get_app_state") return Promise.resolve(fixture);
    if (cmd === "get_all_tags_info") return Promise.resolve([]);
    if (cmd === "get_all_tags") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

const calls = (cmd: string) => mockInvoke.mock.calls.filter(c => c[0] === cmd);
const ok = (changed = 1) => ({ changed, skipped: 0, conflicts: [], errors: [], items: [] });

beforeEach(() => routes());

async function mount() {
  render(<App />);
  await waitFor(() => expect(document.querySelectorAll(".skill-card").length).toBeGreaterThan(0));
}

async function selectTarget(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: /全部技能/ }));
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
}

function card(name: string) {
  return screen.getByText(name, { selector: ".card-title" }).closest(".skill-card") as HTMLElement;
}

async function openDrawer(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(card(name));
  await waitFor(() => expect(document.querySelector(".drawer-panel")).toBeTruthy());
  return document.querySelector(".drawer-panel") as HTMLElement;
}

describe("P0-1 删除确认：取消时零副作用", () => {
  it("点「先不操作」不会调用 delete_skill", async () => {
    const user = userEvent.setup();
    routes({ delete_skill: () => serdeFixture() });
    await mount();
    // Gamma 在任何目标都未应用，允许进入删除确认
    const drawer = await openDrawer(user, "Gamma");
    await user.click(within(drawer).getByRole("button", { name: "删除技能" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("删除「Gamma」？")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "先不操作" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("delete_skill")).toHaveLength(0);
    expect(card("Gamma")).toBeInTheDocument();
  });

  it("按 Esc 关闭确认框也不会删除，且抽屉保持打开", async () => {
    const user = userEvent.setup();
    routes({ delete_skill: () => serdeFixture() });
    await mount();
    const drawer = await openDrawer(user, "Gamma");
    await user.click(within(drawer).getByRole("button", { name: "删除技能" }));
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("delete_skill")).toHaveLength(0);
    expect(document.querySelector(".drawer-panel")).toBeTruthy();
  });

  it("确认后才调用 delete_skill", async () => {
    const user = userEvent.setup();
    const after = serdeFixture();
    after.skills = after.skills.filter(s => s.id !== "gamma");
    routes({ delete_skill: () => after });
    await mount();
    const drawer = await openDrawer(user, "Gamma");
    await user.click(within(drawer).getByRole("button", { name: "删除技能" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(calls("delete_skill")).toHaveLength(1));
    expect(calls("delete_skill")[0][1]).toEqual({ skillId: "gamma" });
  });

  it("仍有启用位置的技能只给提示，不提供删除按钮", async () => {
    const user = userEvent.setup();
    routes({ delete_skill: () => serdeFixture() });
    await mount();
    // Alpha 在「全局」已应用
    const drawer = await openDrawer(user, "Alpha");
    await user.click(within(drawer).getByRole("button", { name: "删除技能" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByRole("button", { name: "永久删除" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "知道了" }));
    expect(calls("delete_skill")).toHaveLength(0);
  });
});

describe("P0-2 详情抽屉收回：按报告提示", () => {
  it("后端返回 errors 时不显示成功提示", async () => {
    const user = userEvent.setup();
    routes({
      withdraw_skill: () => ({ changed: 0, skipped: 0, conflicts: [], errors: ["不是指向主库的软链接，未改动"], items: [] }),
    });
    await mount();
    const drawer = await openDrawer(user, "Alpha");
    const row = within(drawer).getByText("全局").closest(".target-action-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "收回" }));
    await waitFor(() => expect(calls("withdraw_skill")).toHaveLength(1));
    await waitFor(() => {
      const t = document.querySelector(".toast");
      expect(t).toBeTruthy();
      expect(t!.className).toContain("toast-error");
      expect(t!.textContent).toContain("收回未完成");
    });
  });

  it("成功收回显示成功提示", async () => {
    const user = userEvent.setup();
    routes({ withdraw_skill: () => ok() });
    await mount();
    const drawer = await openDrawer(user, "Alpha");
    const row = within(drawer).getByText("全局").closest(".target-action-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "收回" }));
    await waitFor(() => {
      const t = document.querySelector(".toast");
      expect(t?.className).toContain("toast-success");
      expect(t?.textContent).toContain("已收回");
    });
  });
});

describe("S3 重试失败项沿用原操作类型", () => {
  it("批量收回失败后，重试仍然调用 withdraw_skill，不调用 deploy_skill", async () => {
    const user = userEvent.setup();
    routes({
      withdraw_skill: () => ({ changed: 0, skipped: 0, conflicts: [], errors: ["权限拒绝"], items: [] }),
      deploy_skill: () => ok(),
    });
    await mount();
    await selectTarget(user, "全局");
    await user.click(await screen.findByText(/收回筛选中的/));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /收回 \d+ 个技能/ }));
    const retry = await screen.findByRole("button", { name: /重试收回失败的 1 项/ });
    const withdrawBefore = calls("withdraw_skill").length;
    await user.click(retry);
    await waitFor(() => expect(calls("withdraw_skill").length).toBeGreaterThan(withdrawBefore));
    expect(calls("deploy_skill")).toHaveLength(0);
  });

  it("批量全部成功只弹 toast，不显示红色结果面板", async () => {
    const user = userEvent.setup();
    routes({ deploy_skill: () => ok() });
    await mount();
    await selectTarget(user, "全局");
    await user.click(await screen.findByText(/应用筛选中的/));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /应用 \d+ 个技能/ }));
    await waitFor(() => expect(document.querySelector(".toast-success")).toBeTruthy());
    expect(document.querySelector(".batch-result-bar")).toBeNull();
  });
});

describe("S2 写操作失败必须有反馈", () => {
  it("右键切换标签失败时显示持久错误条", async () => {
    const user = userEvent.setup();
    routes({ set_skill_tags: () => { throw new Error("数据库被锁定"); } }, serdeFixture());
    await mount();
    fireEvent.contextMenu(card("Alpha"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: /产品/ }));
    await waitFor(() => {
      const bar = document.querySelector(".inline-error-bar");
      expect(bar?.textContent).toContain("更新标签失败");
      expect(bar?.textContent).toContain("数据库被锁定");
    });
  });
});

describe("I1 卡片键盘可达", () => {
  it("卡片可聚焦，按 Enter 打开详情", async () => {
    await mount();
    const c = card("Gamma");
    expect(c.getAttribute("tabindex")).toBe("0");
    c.focus();
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Enter" });
    await waitFor(() => expect(document.querySelector(".drawer-panel")).toBeTruthy());
  });

  it("目标下拉按钮报告展开状态", async () => {
    const user = userEvent.setup();
    await mount();
    const trigger = screen.getByRole("button", { name: /全部技能/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option").length).toBe(3);
  });
});

describe("I5 标签筛选与状态筛选互不清除", () => {
  it("点标签栏「全部」不会清掉状态筛选", async () => {
    const user = userEvent.setup();
    await mount();
    await selectTarget(user, "全局");
    const statusGroup = screen.getByRole("group", { name: "按状态筛选" });
    await user.click(within(statusGroup).getByRole("button", { name: "已应用" }));
    const tagGroup = screen.getByRole("group", { name: "按标签筛选" });
    await user.click(within(tagGroup).getByRole("button", { name: /产品/ }));
    await user.click(within(tagGroup).getByRole("button", { name: "全部" }));
    expect(within(statusGroup).getByRole("button", { name: "已应用" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("F2 覆盖规则来自后端 canOverwrite", () => {
  it("可覆盖的冲突在卡片和抽屉里都提供「覆盖」；不可覆盖的只给原因", async () => {
    const user = userEvent.setup();
    const fx = serdeFixture();
    // 全局 / Beta：失效软链 → 可覆盖
    fx.workspaces[0].statuses[1].canOverwrite = true;
    // 知识管理 / Beta：同名冲突，但这里标记为不可覆盖，验证前端只看字段不看文案
    fx.workspaces[1].statuses[1].canOverwrite = false;
    routes({}, fx);
    await mount();
    const drawer = await openDrawer(user, "Beta");
    const globalRow = within(drawer).getByText("全局").closest(".target-action-row") as HTMLElement;
    const projRow = within(drawer).getByText("知识管理").closest(".target-action-row") as HTMLElement;
    expect(within(globalRow).getByRole("button", { name: "覆盖" })).toBeInTheDocument();
    expect(within(projRow).queryByRole("button", { name: "覆盖" })).toBeNull();
    expect(within(projRow).getByText("需手动处理，不可一键覆盖")).toBeInTheDocument();
  });
});

describe("F1 项目路径不存在时阻断应用", () => {
  it("选中失效目标显示横幅，批量应用按钮禁用，不调用 deploy_skill", async () => {
    const user = userEvent.setup();
    const fx = serdeFixture();
    fx.targets[1].pathExists = false;
    fx.workspaces[1].targetExists = false;
    routes({ deploy_skill: () => ok() }, fx);
    await mount();
    await user.click(screen.getByRole("button", { name: /全部技能/ }));
    const opt = await screen.findByRole("option", { name: /知识管理/ });
    expect(within(opt).getByText("路径不存在")).toBeInTheDocument();
    await user.click(opt);
    await waitFor(() => expect(document.querySelector(".notice-stack")?.textContent).toContain("项目路径不存在"));
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
    const batch = await screen.findByRole("button", { name: /应用筛选中的/ });
    expect(batch).toBeDisabled();
    expect(calls("deploy_skill")).toHaveLength(0);
  });
});

describe("I2 外部变更后刷新", () => {
  it("窗口重新获得焦点时重新读取状态", async () => {
    await mount();
    const before = calls("get_app_state").length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(calls("get_app_state").length).toBeGreaterThan(before));
  });

  it("刷新按钮重新读取状态并提示", async () => {
    const user = userEvent.setup();
    await mount();
    const before = calls("get_app_state").length;
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    await waitFor(() => expect(calls("get_app_state").length).toBeGreaterThan(before));
    await waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("已重新扫描"));
  });
});

describe("F3 搜索匹配标签名", () => {
  it("输入标签名能找到带该标签的技能", async () => {
    const user = userEvent.setup();
    await mount();
    await user.type(screen.getByLabelText("搜索技能"), "产品");
    await waitFor(() => {
      expect(screen.queryByText("Gamma", { selector: ".card-title" })).toBeNull();
      expect(screen.getByText("Alpha", { selector: ".card-title" })).toBeInTheDocument();
    });
  });
});
