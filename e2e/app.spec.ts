import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const fakeBackend = fileURLToPath(new URL("./fake-backend.js", import.meta.url));

interface Seed {
  settings?: Record<string, unknown>;
  accounts?: Record<string, unknown>[];
  projects?: Record<string, unknown>[];
  conversations?: Record<string, unknown>[];
  envConflicts?: { name: string; kind: string }[];
}

interface Fake {
  __fake: {
    calls: { cmd: string; args: unknown }[];
    state: { sessions: { id: string }[] };
    emit: (e: string, p: unknown) => void;
    hitLimit: (id: string) => void;
  };
}

async function open(page: Page, seed: Seed = {}) {
  await page.addInitScript((s) => {
    (window as unknown as { __FAKE_SEED__: Seed }).__FAKE_SEED__ = s;
  }, seed);
  await page.addInitScript({ path: fakeBackend });
  await page.goto("/");
}

const account = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Work",
  label: null,
  verifiedEmail: "me@work.example",
  orgName: "Acme",
  configDir: "/Users/tester/.claude-switch/profiles/11111111-1111-4111-8111-111111111111",
  color: "blue",
  notes: null,
  sortOrder: 0,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  lastUsedAt: "2026-10-24T09:00:00Z",
  authStatus: "authenticated",
  authMethod: "claude.ai",
  authStatusCheckedAt: "2026-10-24T09:00:00Z",
  authVerifiedAt: "2026-10-24T09:00:00Z",
  authDetail: null,
  runningSessions: 0,
  ...overrides,
});

const project = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "website",
  directory: "/Users/tester/code/website",
  favorite: true,
  defaultAccountId: null,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  lastUsedAt: "2026-10-24T09:00:00Z",
  exists: true,
  runningSessions: 0,
};

test("first run: onboarding through sign-in", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Welcome to Claude Switch" })).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/01-welcome.png" });
  await page.getByRole("button", { name: "Get Started" }).click();
  await expect(page.getByText("Claude Code 2.1.236")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "How accounts stay separate" })).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/02-isolation.png" });
  await page.getByRole("button", { name: "Add an Account" }).click();
  await page.getByLabel("Name").fill("Work");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to “Work”" })).toBeVisible();
  await page.getByRole("button", { name: "Start Sign-In" }).click();
  await expect(page.getByText("Waiting for you to sign in")).toBeVisible();
  await expect(page.getByRole("button", { name: /open sign-in page/i })).toBeEnabled();
  await page.screenshot({ path: "e2e-screens/flows/03-sign-in-waiting.png" });
  await page.getByLabel("Authorization code").fill("good-code#state");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Work is signed in")).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/03-signed-in.png" });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Open a project" })).toBeVisible();
  await page.getByRole("button", { name: "Finish Without Launching" }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
});

test("overview, launching a session, and the terminal", async ({ page }) => {
  await open(page, {
    settings: { onboardingCompleted: true },
    accounts: [
      account(),
      account({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Personal",
        color: "violet",
        verifiedEmail: null,
        label: "me@home.example",
        authStatus: "auth_required",
        sortOrder: 1,
      }),
    ],
    projects: [project],
    envConflicts: [{ name: "ANTHROPIC_API_KEY", kind: "credential" }],
  });
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await expect(page.getByText(/ANTHROPIC_API_KEY/)).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/04-overview.png" });

  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("tab", { name: /Work/ })).toBeVisible();
  // The terminal is attached to the session's output channel…
  await expect(page.locator(".xterm")).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/05-terminal.png" });
  // …and keystrokes reach the session (renderer-independent: WebGL draws to
  // a canvas, so the DOM has no text to assert on).
  await page.locator(".xterm").click();
  await page.keyboard.type("hi");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __fake: { calls: { cmd: string; args: { data?: string } }[] } }
        ).__fake.calls
          .filter((c) => c.cmd === "write_session")
          .map((c) => c.args.data)
          .join(""),
      ),
    )
    .toBe("hi");
  const attached = await page.evaluate(() =>
    (window as unknown as { __fake: { calls: { cmd: string }[] } }).__fake.calls.some(
      (c) => c.cmd === "attach_session",
    ),
  );
  expect(attached).toBe(true);

  const start = await page.evaluate(() =>
    (
      window as unknown as { __fake: { calls: { cmd: string; args: unknown }[] } }
    ).__fake.calls.find((c) => c.cmd === "start_session"),
  );
  expect(start?.args).toMatchObject({
    input: { accountId: "11111111-1111-4111-8111-111111111111", kind: "claude" },
  });
});

test("account page, quick switcher, and settings", async ({ page }) => {
  await open(page, {
    settings: { onboardingCompleted: true },
    accounts: [account()],
    projects: [project],
  });
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: /^Work/ })
    .click();
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  await expect(page.getByText("/Users/tester/.claude-switch/profiles/1111")).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/06-account.png", fullPage: true });

  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: /website/ })
    .click();
  await expect(page.getByRole("heading", { name: "website" })).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/07-project.png" });

  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/08-settings.png" });

  await page.evaluate(() => {
    (window as unknown as { __fake: { emit: (e: string, p: unknown) => void } }).__fake.emit(
      "menu-action",
      "quick-switch",
    );
  });
  await expect(page.getByRole("combobox")).toBeVisible();
  await page.keyboard.type("web");
  await page.screenshot({ path: "e2e-screens/flows/09-quick-switch.png" });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "website" })).toBeVisible();
});

test("dark theme renders", async ({ page }) => {
  await open(page, {
    settings: { onboardingCompleted: true, theme: "dark" },
    accounts: [account()],
    projects: [project],
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: "e2e-screens/flows/10-dark.png" });
});

test("after a usage limit, the conversation continues with another account", async ({ page }) => {
  const work = account();
  const personal = account({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Personal",
    color: "violet",
    sortOrder: 1,
  });
  const conversation = {
    sessionId: "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10",
    projectId: project.id,
    accountId: work.id,
    modifiedAt: new Date().toISOString(),
    sizeBytes: 182_000,
  };
  await open(page, {
    settings: { onboardingCompleted: true },
    accounts: [work, personal],
    projects: [project],
    conversations: [conversation],
  });

  // Work's session in the project runs into its limit.
  await page
    .getByRole("navigation", { name: "Sidebar" })
    .getByRole("button", { name: /website/ })
    .click();
  await page.getByRole("button", { name: "Open Claude Code" }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.evaluate(() => {
    const fake = (window as unknown as Fake).__fake;
    fake.hitLimit(fake.state.sessions[0]?.id ?? "");
  });
  const bar = page.getByRole("status").filter({ hasText: "usage limit for Work" });
  await expect(bar).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/11-usage-limit.png" });

  await bar.getByRole("button", { name: "Continue in Another Account" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "Continue with" })).toContainText("Personal");
  await expect(dialog.getByRole("radio", { name: "Claude Switch" })).toBeChecked();
  await page.screenshot({ path: "e2e-screens/flows/12-continue-dialog.png" });
  // Focus starts on the conversation; Return continues.
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab")).toHaveCount(2);
  const call = await page.evaluate(() =>
    (window as unknown as Fake).__fake.calls.find((c) => c.cmd === "continue_conversation"),
  );
  expect(call?.args).toMatchObject({
    input: {
      projectId: project.id,
      sessionId: conversation.sessionId,
      fromAccountId: work.id,
      toAccountId: personal.id,
      message: "Continue where you left off.",
    },
  });

  // From the menu: back to Work, in VS Code this time.
  await page.evaluate(() => {
    (window as unknown as Fake).__fake.emit("menu-action", "continue-conversation");
  });
  await dialog.getByRole("radio", { name: "VS Code" }).click();
  await expect(dialog.getByText("VS Code will use Work")).toBeVisible();
  await page.screenshot({ path: "e2e-screens/flows/13-continue-in-editor.png" });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Opened in VS Code with Work")).toBeVisible();
});
