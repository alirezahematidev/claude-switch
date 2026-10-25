import { defineConfig } from "@playwright/test";

// Browser-level UI tests against the Vite dev server with a fake backend
// (see e2e/fake-backend.js). Native behavior (PTYs, Keychain, menus) is
// covered by the Rust integration tests and the manual checklist.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 820 },
    // Uses the installed Google Chrome; run `npx playwright install chromium`
    // and remove this line to use Playwright's bundled browser instead.
    channel: "chrome",
    colorScheme: "light",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
