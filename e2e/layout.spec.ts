import { expect, test, type Page } from "@playwright/test";
/**
 * Layout regression sweep: every screen, with stress data (long names,
 * emails and paths, many accounts, projects and tabs), at the minimum,
 * default and large window sizes. Each screen is checked for horizontal
 * overflow and for elements escaping their containers, and a screenshot is
 * saved to e2e-screens/layout/ for review.
 */
import { fileURLToPath } from "node:url";

const fakeBackend = fileURLToPath(new URL("./fake-backend.js", import.meta.url));

const LONG_NAME = "Enterprise Production — Platform Engineering (EU)";
const LONG_EMAIL = "firstname.lastname+claude-code@subsidiary.example-company.com";
const LONG_PATH =
  "/Users/tester/code/clients/acme-corporation/international/monorepo-platform-services-and-developer-tools";

const STATUSES = [
  "authenticated",
  "auth_required",
  "not_configured",
  "failed",
  "unknown",
  "unsupported_isolation",
] as const;
const COLORS = [
  "blue",
  "violet",
  "green",
  "orange",
  "pink",
  "teal",
  "amber",
  "red",
  "sky",
  "slate",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function accounts() {
  return Array.from({ length: 12 }, (_, i) => ({
    id: uuid(i + 1),
    name: i === 0 ? LONG_NAME : i === 1 ? "Personal" : `Client account ${i}`,
    label: i === 2 ? LONG_EMAIL : null,
    verifiedEmail: i === 0 ? LONG_EMAIL : i === 1 ? "me@home.example" : null,
    orgName: i === 0 ? "Acme International Platform Engineering Organization" : null,
    configDir: `/Users/tester/.claude-switch/profiles/${uuid(i + 1)}`,
    color: COLORS[i % COLORS.length],
    notes: i === 0 ? "Used for production incidents.\nRotate monthly." : null,
    sortOrder: i,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    lastUsedAt: i < 4 ? "2026-10-24T09:00:00Z" : null,
    authStatus: STATUSES[i % STATUSES.length],
    authMethod:
      i % STATUSES.length === 0 ? "claude.ai" : i % STATUSES.length === 5 ? "third_party" : null,
    authStatusCheckedAt: "2026-10-24T09:00:00Z",
    authVerifiedAt: i % 3 === 0 ? "2026-10-24T09:00:00Z" : null,
    authDetail:
      i % STATUSES.length === 5
        ? "Claude Code is using a cloud provider (Bedrock, Vertex AI, or Foundry). Those credentials come from outside this profile, so accounts are not isolated."
        : null,
    runningSessions: 0,
  }));
}

function projects() {
  return Array.from({ length: 15 }, (_, i) => ({
    id: uuid(100 + i),
    name: i === 0 ? "acme-international-monorepo-platform-services-and-tools" : `project-${i}`,
    directory: i === 0 ? LONG_PATH : `/Users/tester/code/project-${i}`,
    favorite: i < 3,
    defaultAccountId: uuid(1),
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    lastUsedAt: "2026-10-24T09:00:00Z",
    exists: i !== 4,
    runningSessions: 0,
  }));
}

function sessions() {
  return Array.from({ length: 12 }, (_, i) => ({
    id: uuid(500 + i),
    accountId: uuid((i % 4) + 1),
    projectId: i % 2 === 0 ? uuid(100) : null,
    kind: i % 5 === 4 ? "shell" : "claude",
    title: i === 0 ? "acme-international-monorepo-platform-services-and-tools" : `Session ${i}`,
    workingDir: LONG_PATH,
    processId: 1000 + i,
    status: i < 6 ? "running" : i % 3 === 0 ? "failed" : "exited",
    startedAt: "2026-10-24T08:00:00Z",
    endedAt: i < 6 ? null : "2026-10-24T09:30:00Z",
    exitCode: i < 6 ? null : i % 2,
    exitSignal: null,
    error: i % 3 === 0 && i >= 6 ? "Could not start the process: permission denied" : null,
    attached: i < 6,
  }));
}

function conversations() {
  return Array.from({ length: 9 }, (_, i) => ({
    sessionId: `00000000-0000-4000-9000-${(i + 1).toString(16).padStart(12, "0")}`,
    projectId: uuid(100 + (i % 3)),
    accountId: i === 4 ? null : uuid((i % 4) + 1),
    modifiedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    sizeBytes: 1200 * (i + 1) ** 3,
  }));
}

const SIZES = [
  { name: "min", width: 900, height: 560 },
  { name: "default", width: 1280, height: 820 },
  { name: "large", width: 1600, height: 1000 },
] as const;

async function open(page: Page, seed: Record<string, unknown>) {
  await page.addInitScript((s) => {
    (window as unknown as { __FAKE_SEED__: unknown }).__FAKE_SEED__ = s;
  }, seed);
  await page.addInitScript({ path: fakeBackend });
  await page.goto("/");
}

const stressSeed = {
  settings: { onboardingCompleted: true, theme: "light" },
  accounts: accounts(),
  projects: projects(),
  sessions: sessions(),
  conversations: conversations(),
  editors: [
    {
      id: "vscode",
      name: "VS Code",
      claudeAccount: { mode: "account", accountId: uuid(1), detail: null },
    },
    {
      id: "cursor",
      name: "Cursor",
      claudeAccount: { mode: "custom", accountId: null, detail: `${LONG_PATH}/.claude-config` },
      extensionVersion: "0.0.9",
    },
  ],
  envConflicts: [
    { name: "ANTHROPIC_API_KEY", kind: "credential" },
    { name: "ANTHROPIC_BASE_URL", kind: "provider" },
    { name: "CLAUDE_CONFIG_DIR", kind: "config_dir" },
    { name: "CLAUDECODE", kind: "nested_session" },
  ],
};

/** Finds elements that overflow the window or escape a non-clipping parent. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (document.documentElement.scrollWidth > vw + 1) {
      problems.push(`page scrolls horizontally (${document.documentElement.scrollWidth} > ${vw})`);
    }
    const describe = (el: Element) => {
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const cls = (el.getAttribute("class") ?? "").split(" ").slice(0, 4).join(".");
      return `<${el.tagName.toLowerCase()} ${cls}> "${text}"`;
    };
    const clips = (el: Element | null): boolean => {
      for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
        const s = getComputedStyle(cur);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") return true;
      }
      return false;
    };
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (el.closest(".xterm, svg, [data-sonner-toaster], .sr-only")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.display === "contents")
        continue;
      if (style.position === "fixed") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if ((rect.right > vw + 1 || rect.left < -1) && !clips(el.parentElement)) {
        problems.push(
          `${describe(el)} is outside the window (${Math.round(rect.left)}–${Math.round(rect.right)})`,
        );
      }
      if (rect.bottom > vh + 1 && !clips(el.parentElement)) {
        problems.push(`${describe(el)} is below the window (${Math.round(rect.bottom)})`);
      }
      // Text wider than its own box without ellipsis or clipping.
      if (
        style.display !== "inline" &&
        style.overflowX === "visible" &&
        style.textOverflow !== "ellipsis" &&
        el.scrollWidth > el.clientWidth + 2 &&
        el.clientWidth > 0 &&
        el.children.length === 0
      ) {
        problems.push(
          `${describe(el)} text overflows its box (${el.scrollWidth} > ${el.clientWidth})`,
        );
      }
      // A child sticking out of a parent that does not clip.
      const parent = el.parentElement;
      if (
        parent &&
        style.position !== "absolute" &&
        !el.matches("[data-radix-popper-content-wrapper] *")
      ) {
        const ps = getComputedStyle(parent);
        const pr = parent.getBoundingClientRect();
        if (
          ps.overflowX === "visible" &&
          ps.display !== "inline" &&
          pr.width > 0 &&
          rect.right > pr.right + 1.5
        ) {
          problems.push(
            `${describe(el)} sticks out of its parent by ${Math.round(rect.right - pr.right)}px`,
          );
        }
      }
    }
    return Array.from(new Set(problems));
  });
}

async function check(page: Page, size: string, name: string) {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `e2e-screens/layout/${size}-${name}.png` });
  const problems = await layoutProblems(page);
  expect(problems, `${name} at ${size}`).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`layout at ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("main screens", async ({ page }) => {
      await open(page, stressSeed);
      const sidebar = page.getByRole("navigation", { name: "Sidebar" });
      await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
      await check(page, size.name, "overview");

      await sidebar.getByRole("button", { name: new RegExp(`^${escapeRegex(LONG_NAME)}`) }).click();
      await expect(page.getByRole("heading", { name: LONG_NAME, level: 1 })).toBeVisible();
      await check(page, size.name, "account");

      await page.getByRole("button", { name: "More actions" }).click();
      await check(page, size.name, "account-menu");
      await page.keyboard.press("Escape");

      await sidebar
        .getByRole("button", { name: /^acme-international/ })
        .first()
        .click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("acme-international");
      await check(page, size.name, "project");

      await page.getByRole("button", { name: "Choose editor" }).click();
      await check(page, size.name, "project-editor-menu");
      await page.keyboard.press("Escape");

      await page.getByRole("combobox", { name: "Account" }).click();
      await check(page, size.name, "project-account-select");
      await page.keyboard.press("Escape");

      await sidebar.getByRole("button", { name: "All sessions" }).click();
      await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
      await check(page, size.name, "sessions");

      await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await check(page, size.name, "settings");
      await page.getByRole("heading", { name: "Editors" }).scrollIntoViewIfNeeded();
      await check(page, size.name, "settings-editors");
      await page.getByRole("combobox", { name: "Cursor: Claude Code account" }).click();
      await check(page, size.name, "settings-editor-account-select");
      await page.keyboard.press("Escape");
      await page.mouse.move(size.width - 200, size.height / 2);
      await page.mouse.wheel(0, 1800);
      await check(page, size.name, "settings-middle");
      await page.mouse.wheel(0, 4000);
      await check(page, size.name, "settings-bottom");
    });

    test("terminal tabs", async ({ page }) => {
      await open(page, stressSeed);
      const sidebar = page.getByRole("navigation", { name: "Sidebar" });
      await sidebar
        .getByRole("button", { name: /^acme-international/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Open Claude Code" }).click();
      await expect(page.locator('[role="tabpanel"]:not(.hidden) .xterm')).toBeVisible();
      await check(page, size.name, "terminal");

      await page.evaluate(() => {
        const fake = (
          window as unknown as {
            __fake: { state: { sessions: { id: string }[] }; hitLimit: (id: string) => void };
          }
        ).__fake;
        fake.hitLimit(fake.state.sessions.at(-1)?.id ?? "");
      });
      const bar = page.getByRole("status").filter({ hasText: "reported a usage limit" });
      await expect(bar).toBeVisible();
      await check(page, size.name, "terminal-usage-limit");

      await bar.getByRole("button", { name: "Continue in Another Account" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("radiogroup", { name: "Conversation" })).toBeVisible();
      await check(page, size.name, "dialog-continue");
      await dialog.getByRole("radio", { name: "Cursor" }).click();
      await expect(dialog.getByText(/a backup is kept/)).toBeVisible();
      await check(page, size.name, "dialog-continue-editor");
      await dialog.getByRole("combobox", { name: "Continue with" }).click();
      await check(page, size.name, "dialog-continue-accounts");
    });

    test("dialogs", async ({ page }) => {
      await open(page, stressSeed);
      await page.getByRole("button", { name: "Add Account", exact: true }).click();
      await check(page, size.name, "dialog-add-account");
      await page.getByLabel("Name").fill(LONG_NAME);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Start Sign-In" })).toBeVisible();
      await check(page, size.name, "dialog-sign-in-setup");
      await page.keyboard.press("Enter");
      await expect(page.getByText("Waiting for you to sign in")).toBeVisible();
      await expect(page.getByRole("button", { name: /open sign-in page/i })).toBeEnabled();
      await check(page, size.name, "dialog-sign-in-waiting");
      await page.getByRole("button", { name: "Claude Code output" }).click();
      await check(page, size.name, "dialog-sign-in-output");
      await page.getByLabel("Authorization code").fill("wrong");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog").getByText(/Sign-in didn.t complete/)).toBeVisible();
      await check(page, size.name, "dialog-sign-in-failed");
      await page.getByRole("button", { name: "Close", exact: true }).first().click();

      const sidebar = page.getByRole("navigation", { name: "Sidebar" });
      await sidebar
        .getByRole("button", { name: new RegExp(`^${escapeRegex(LONG_NAME)}`) })
        .first()
        .click();
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /remove/i }).click();
      await page.getByRole("radio", { name: /delete profile data/i }).click();
      await check(page, size.name, "dialog-delete");
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /edit/i }).click();
      await check(page, size.name, "dialog-edit");
      await page.keyboard.press("Escape");

      await page.evaluate(() => {
        (window as unknown as { __fake: { emit: (e: string, p: unknown) => void } }).__fake.emit(
          "menu-action",
          "quick-switch",
        );
      });
      await expect(page.getByRole("combobox")).toBeVisible();
      await check(page, size.name, "quick-switch");
      await page.keyboard.type("acme");
      await check(page, size.name, "quick-switch-filtered");
      await page.keyboard.press("Escape");

      await page.evaluate(() => {
        (window as unknown as { __fake: { emit: (e: string, p: unknown) => void } }).__fake.emit(
          "confirm-quit",
          3,
        );
      });
      await expect(page.getByText(/3 Claude Code sessions/)).toBeVisible();
      await check(page, size.name, "dialog-quit");
    });

    test("onboarding", async ({ page }) => {
      await open(page, {
        settings: { onboardingCompleted: false, theme: "light" },
        envConflicts: stressSeed.envConflicts,
        cli: {
          state: "not_found",
          path: null,
          version: null,
          source: null,
          message: "Claude Code is not installed, or it could not be found in the usual locations.",
          searched: ["/Users/tester/.local/bin/claude", "/opt/homebrew/bin/claude"],
        },
      });
      await check(page, size.name, "onboarding-welcome");
      await page.getByRole("button", { name: "Get Started" }).click();
      await expect(page.getByText("Claude Code was not found")).toBeVisible();
      await check(page, size.name, "onboarding-system-check");
    });
  });
}

test("dark theme screens", async ({ page }) => {
  await open(page, { ...stressSeed, settings: { onboardingCompleted: true, theme: "dark" } });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await check(page, "dark", "overview");
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await sidebar
    .getByRole("button", { name: /^acme-international/ })
    .first()
    .click();
  await check(page, "dark", "project");
  await page.getByRole("button", { name: "Open Claude Code" }).click();
  await check(page, "dark", "terminal");
  await sidebar.getByRole("button", { name: "Settings", exact: true }).click();
  await check(page, "dark", "settings");
});

test("the layout check catches real overflow", async ({ page }) => {
  await open(page, stressSeed);
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const wide = document.createElement("div");
    wide.style.width = "3000px";
    wide.textContent = "too wide";
    const text = document.createElement("div");
    text.style.width = "40px";
    text.style.whiteSpace = "nowrap";
    text.textContent = "this text cannot fit in forty pixels";
    main?.prepend(wide, text);
  });
  const problems = await layoutProblems(page);
  expect(problems.some((p) => p.includes("too wide"))).toBe(true);
  expect(problems.some((p) => p.includes("text overflows its box"))).toBe(true);
});
