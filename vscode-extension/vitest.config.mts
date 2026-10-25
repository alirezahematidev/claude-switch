import { defineConfig } from "vitest/config";

// Run with `vitest run --root vscode-extension`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
