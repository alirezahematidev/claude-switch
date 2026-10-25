/**
 * Test doubles for the Tauri APIs. `invoke` is routed to per-command
 * handlers so tests assert on exactly what the UI sends to the backend.
 */
import { vi } from "vitest";

import type { Account } from "@/bindings/Account";
import type { AppSettings } from "@/bindings/AppSettings";
import type { Conversation } from "@/bindings/Conversation";
import type { EditorInfo } from "@/bindings/EditorInfo";
import type { ErrorKind } from "@/bindings/ErrorKind";
import type { Project } from "@/bindings/Project";
import type { SystemInfo } from "@/bindings/SystemInfo";

type Handler = (args: Record<string, unknown> | undefined) => unknown;

const REJECT = Symbol("reject");

/**
 * A handler result that makes `invoke` reject with the given backend error
 * payload. Tauri rejects with plain `{ kind, message }` objects, not Errors.
 */
export function backendError(kind: ErrorKind, message: string) {
  return { [REJECT]: { kind, message } };
}

function rejection(value: unknown): { kind: ErrorKind; message: string } | null {
  if (typeof value === "object" && value !== null && REJECT in value) {
    return (value as { [REJECT]: { kind: ErrorKind; message: string } })[REJECT];
  }
  return null;
}

export const invokeHandlers = new Map<string, Handler>();

type EventHandler = (event: { payload: unknown }) => void;
const eventHandlers = new Map<string, Set<EventHandler>>();

/** Delivers a backend event to every subscribed component. */
export function emitEvent(name: string, payload: unknown): void {
  for (const handler of eventHandlers.get(name) ?? []) handler({ payload });
}
export const invokeCalls: { command: string; args: Record<string, unknown> | undefined }[] = [];

vi.mock("@tauri-apps/api/core", () => {
  class Channel {
    onmessage: (message: unknown) => void = () => undefined;
  }
  return {
    Channel,
    invoke: vi.fn((command: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ command, args });
      const handler = invokeHandlers.get(command);
      const result = handler ? handler(args) : backendError("notFound", `No mock for ${command}`);
      const error = rejection(result);
      // Mirrors Tauri, which rejects with the serialized error payload.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return error ? Promise.reject(error) : Promise.resolve(result);
    }),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: EventHandler) => {
    const set = eventHandlers.get(name) ?? new Set<EventHandler>();
    set.add(handler);
    eventHandlers.set(name, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme: () => Promise.resolve() }),
}));

export function mockCommand(command: string, handler: unknown): void {
  invokeHandlers.set(command, typeof handler === "function" ? (handler as Handler) : () => handler);
}

export function resetTauriMocks(): void {
  invokeHandlers.clear();
  invokeCalls.length = 0;
  eventHandlers.clear();
}

export function callsTo(command: string) {
  return invokeCalls.filter((c) => c.command === command);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Work",
    label: null,
    verifiedEmail: "me@work.example",
    orgName: "Work Org",
    configDir: "/Users/me/.claude-switch/profiles/11111111-1111-4111-8111-111111111111",
    color: "blue",
    notes: null,
    sortOrder: 0,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    lastUsedAt: null,
    authStatus: "authenticated",
    authMethod: "claude.ai",
    authStatusCheckedAt: "2026-10-01T10:00:00Z",
    authVerifiedAt: "2026-10-01T10:00:00Z",
    authDetail: null,
    runningSessions: 0,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "website",
    directory: "/Users/me/code/website",
    favorite: false,
    defaultAccountId: null,
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    lastUsedAt: null,
    exists: true,
    runningSessions: 0,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    claudeExecutablePath: null,
    closeBehavior: "keep_running",
    confirmQuitWithRunningSessions: true,
    globalShortcut: null,
    launchAtLogin: false,
    checkAuthOnStartup: true,
    notifyOnSessionExit: true,
    theme: "system",
    terminalFontSize: 13,
    terminalFontFamily: "",
    terminalScrollback: 10000,
    terminalOptionAsMeta: false,
    extraPathEntries: [],
    customEnv: [],
    onboardingCompleted: true,
    preferredEditor: null,
    ...overrides,
  };
}

export function makeSystemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    appVersion: "0.1.0",
    osVersion: "26.2",
    arch: "aarch64",
    cli: {
      state: "found",
      path: "/opt/homebrew/bin/claude",
      version: "2.1.236",
      source: "detected",
      message: null,
      searched: [],
    },
    homeDir: "/Users/me",
    dataDir: "/Users/me/Library/Application Support/ClaudeSwitch",
    profilesDir: "/Users/me/.claude-switch/profiles",
    logsDir: "/Users/me/Library/Application Support/ClaudeSwitch/logs",
    envConflicts: [],
    warnings: [],
    orphanedProfiles: [],
    editors: [makeEditor()],
    extensionPackageAvailable: true,
    ...overrides,
  };
}

export function makeEditor(overrides: Partial<EditorInfo> = {}): EditorInfo {
  return {
    id: "vscode",
    name: "VS Code",
    claudeAccount: { mode: "window", accountId: null, detail: null },
    extensionVersion: null,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    sessionId: "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10",
    projectId: "22222222-2222-4222-8222-222222222222",
    accountId: "11111111-1111-4111-8111-111111111111",
    modifiedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    sizeBytes: 48_000,
    ...overrides,
  };
}
