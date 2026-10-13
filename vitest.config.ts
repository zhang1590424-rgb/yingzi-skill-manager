import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Only collect Vitest/RTL specs under src/. scripts/test-adapter.test.ts uses
    // Node's built-in runner and must NOT be picked up here.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
