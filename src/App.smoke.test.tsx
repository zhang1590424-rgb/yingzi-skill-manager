// Minimal mount smoke test: the real <App/> boots against a scripted Tauri
// invoke and renders the skill grid without crashing.
import { it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App.tsx";
import { serdeFixture } from "./test/fixtures.ts";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "get_app_state") return Promise.resolve(serdeFixture());
    if (cmd === "get_all_tags_info") return Promise.resolve([]);
    if (cmd === "get_all_tags") return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
});

it("boots and renders the skill grid with a search box", async () => {
  render(<App />);
  await waitFor(() => expect(screen.getByLabelText("搜索技能")).toBeInTheDocument());
  await waitFor(() =>
    expect(document.querySelectorAll(".skill-card").length).toBeGreaterThan(0),
  );
  expect(screen.getByText("全部技能")).toBeInTheDocument();
});
