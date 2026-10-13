import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Make the app believe it is inside Tauri so api.ts calls invoke() instead of
// returning the browser mockState. Individual tests script invoke responses.
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
