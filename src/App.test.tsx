import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { useUi } from "@/store/ui";
import { renderWithProviders } from "@/test/render";
import {
  backendError,
  callsTo,
  emitEvent,
  makeAccount,
  makeProject,
  makeSettings,
  makeSystemInfo,
  mockCommand,
  resetTauriMocks,
} from "@/test/tauri";

import { App } from "./App";

const initialUi = useUi.getState();

function mockBackend({
  accounts = [makeAccount()],
  settings = makeSettings(),
  system = makeSystemInfo(),
}: {
  accounts?: ReturnType<typeof makeAccount>[];
  settings?: ReturnType<typeof makeSettings>;
  system?: ReturnType<typeof makeSystemInfo>;
} = {}) {
  mockCommand("frontend_ready", null);
  mockCommand("get_settings", settings);
  mockCommand("list_accounts", accounts);
  mockCommand("list_projects", [makeProject()]);
  mockCommand("list_open_sessions", []);
  mockCommand("list_sessions", []);
  mockCommand("get_system_info", system);
}

afterEach(() => {
  resetTauriMocks();
  useUi.setState(initialUi, true);
});

describe("App", () => {
  it("starts onboarding on first run", async () => {
    mockBackend({ accounts: [], settings: makeSettings({ onboardingCompleted: false }) });
    renderWithProviders(<App />);
    expect(
      await screen.findByRole("heading", { name: "Welcome to Claude Switch" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get Started" }));
    expect(await screen.findByRole("heading", { name: "System check" })).toBeInTheDocument();
    expect(await screen.findByText("Claude Code 2.1.236")).toBeInTheDocument();
  });

  it("explains how to install Claude Code when it is missing", async () => {
    mockBackend({
      accounts: [],
      settings: makeSettings({ onboardingCompleted: false }),
      system: makeSystemInfo({
        cli: {
          state: "not_found",
          path: null,
          version: null,
          source: null,
          message: "Claude Code is not installed.",
          searched: ["/opt/homebrew/bin/claude"],
        },
      }),
    });
    renderWithProviders(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Get Started" }));
    expect(await screen.findByText("Claude Code was not found")).toBeInTheDocument();
    expect(screen.getByText(/brew install --cask claude-code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("shows accounts with their status on the overview", async () => {
    mockBackend({
      accounts: [
        makeAccount(),
        makeAccount({
          id: "33333333-3333-4333-8333-333333333333",
          name: "Personal",
          authStatus: "auth_required",
          verifiedEmail: null,
          label: "me@home.example",
        }),
      ],
    });
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    expect(screen.getAllByText("Personal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sign-in required").length).toBeGreaterThan(0);
    expect(screen.getByText("me@home.example")).toBeInTheDocument();
  });

  it("launches a session with the right account and opens a tab", async () => {
    mockBackend();
    mockCommand("start_session", (args: Record<string, unknown> | undefined) => ({
      id: "44444444-4444-4444-8444-444444444444",
      accountId: (args?.input as { accountId: string } | undefined)?.accountId ?? "",
      projectId: null,
      kind: "claude",
      title: "Work",
      workingDir: "/Users/me",
      processId: 123,
      status: "running",
      startedAt: "2026-10-24T12:00:00Z",
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      error: null,
      attached: true,
    }));
    renderWithProviders(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    const call = callsTo("start_session")[0]?.args as { input: Record<string, unknown> };
    expect(call.input.accountId).toBe("11111111-1111-4111-8111-111111111111");
    expect(call.input.kind).toBe("claude");
    expect(useUi.getState().tabs).toEqual(["44444444-4444-4444-8444-444444444444"]);
    expect(useUi.getState().view).toEqual({ kind: "terminal" });
  });

  it("reports environment conflicts by name only", async () => {
    mockBackend({
      system: makeSystemInfo({
        envConflicts: [{ name: "ANTHROPIC_API_KEY", kind: "credential" }],
      }),
    });
    renderWithProviders(<App />);
    expect(await screen.findByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
  });

  it("asks before quitting with running sessions", async () => {
    mockBackend();
    mockCommand("quit_app", null);
    renderWithProviders(<App />);
    await screen.findByRole("heading", { name: "Accounts" });
    act(() => {
      emitEvent("confirm-quit", 2);
    });
    expect(await screen.findByText(/2 Claude Code sessions are still running/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Quit and Stop Sessions" }));
    expect(callsTo("quit_app")[0]?.args).toEqual({ confirmed: true });
  });

  it("shows a recovery screen when the database is unreadable", async () => {
    mockCommand("frontend_ready", null);
    mockCommand(
      "get_settings",
      backendError("dataCorruption", "Application data appears to be corrupted: bad"),
    );
    mockCommand("list_accounts", []);
    renderWithProviders(<App />);
    expect(await screen.findByText("Claude Switch could not start")).toBeInTheDocument();
    expect(screen.getByText(/profiles and logins are stored separately/)).toBeInTheDocument();
  });
});
