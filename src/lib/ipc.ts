/**
 * Typed wrappers around every Tauri command. This is the only module that
 * calls `invoke`; the rest of the UI goes through `api`.
 *
 * Types come from `src/bindings`, generated from the Rust definitions, so the
 * frontend never re-declares domain models.
 */
import { Channel, invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Account } from "@/bindings/Account";
import type { AppSettings } from "@/bindings/AppSettings";
import type { ChangeScope } from "@/bindings/ChangeScope";
import type { CliStatus } from "@/bindings/CliStatus";
import type { ContinueConversationInput } from "@/bindings/ContinueConversationInput";
import type { ContinueConversationResult } from "@/bindings/ContinueConversationResult";
import type { Conversation } from "@/bindings/Conversation";
import type { CreateAccountInput } from "@/bindings/CreateAccountInput";
import type { DeleteAccountInput } from "@/bindings/DeleteAccountInput";
import type { EditorInfo } from "@/bindings/EditorInfo";
import type { ErrorKind } from "@/bindings/ErrorKind";
import type { ListSessionsInput } from "@/bindings/ListSessionsInput";
import type { LoginProgress } from "@/bindings/LoginProgress";
import type { Notice } from "@/bindings/Notice";
import type { OpenInEditorInput } from "@/bindings/OpenInEditorInput";
import type { OpenInEditorResult } from "@/bindings/OpenInEditorResult";
import type { Project } from "@/bindings/Project";
import type { RevealTarget } from "@/bindings/RevealTarget";
import type { SessionInfo } from "@/bindings/SessionInfo";
import type { SetEditorAccountInput } from "@/bindings/SetEditorAccountInput";
import type { SettingsPatch } from "@/bindings/SettingsPatch";
import type { StartLoginInput } from "@/bindings/StartLoginInput";
import type { StartSessionInput } from "@/bindings/StartSessionInput";
import type { SystemInfo } from "@/bindings/SystemInfo";
import type { UpdateAccountInput } from "@/bindings/UpdateAccountInput";
import type { UpdateProjectInput } from "@/bindings/UpdateProjectInput";

const ERROR_KINDS: readonly ErrorKind[] = [
  "claudeNotInstalled",
  "executableNotFound",
  "unsupportedCliVersion",
  "invalidConfigDir",
  "authRequired",
  "authFailed",
  "isolationUnsupported",
  "projectDirMissing",
  "permissionDenied",
  "ptyCreation",
  "processStart",
  "processTermination",
  "database",
  "invalidInput",
  "dataCorruption",
  "notFound",
  "conflict",
  "io",
];

/** An error returned by the backend, with a stable category. */
export class IpcError extends Error {
  readonly kind: ErrorKind | "unknown";

  constructor(kind: ErrorKind | "unknown", message: string) {
    super(message);
    this.name = "IpcError";
    this.kind = kind;
  }
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

export function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw;
  if (typeof raw === "object" && raw !== null && "message" in raw) {
    const message = String(raw.message);
    const kind = "kind" in raw ? (raw as { kind: unknown }).kind : undefined;
    return new IpcError(isErrorKind(kind) ? kind : "unknown", message);
  }
  if (typeof raw === "string") return new IpcError("unknown", raw);
  return new IpcError("unknown", "Something went wrong.");
}

export function errorMessage(raw: unknown): string {
  return toIpcError(raw).message;
}

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toIpcError(raw);
  }
}

export const api = {
  // System
  getSystemInfo: () => call<SystemInfo>("get_system_info"),
  refreshCliDetection: () => call<CliStatus>("refresh_cli_detection"),
  getDiagnostics: () => call<string>("get_diagnostics"),
  openExternalUrl: (url: string) => call<null>("open_external_url", { url }),
  revealPath: (target: RevealTarget) => call<null>("reveal_path", { target }),
  pickClaudeExecutable: () => call<CliStatus | null>("pick_claude_executable"),
  quitApp: (confirmed = false) => call<null>("quit_app", { confirmed }),
  frontendReady: () => call<null>("frontend_ready"),

  // Settings
  getSettings: () => call<AppSettings>("get_settings"),
  updateSettings: (patch: SettingsPatch) => call<AppSettings>("update_settings", { patch }),

  // Accounts
  listAccounts: () => call<Account[]>("list_accounts"),
  createAccount: (input: CreateAccountInput) => call<Account>("create_account", { input }),
  updateAccount: (input: UpdateAccountInput) => call<Account>("update_account", { input }),
  reorderAccounts: (ids: string[]) => call<Account[]>("reorder_accounts", { ids }),
  deleteAccount: (input: DeleteAccountInput) => call<null>("delete_account", { input }),
  refreshAuthStatus: (id: string) => call<Account>("refresh_auth_status", { id }),
  startLogin: (input: StartLoginInput) => call<SessionInfo>("start_login", { input }),
  getLoginProgress: (sessionId: string) => call<LoginProgress>("get_login_progress", { sessionId }),
  submitLoginCode: (sessionId: string, code: string) =>
    call<LoginProgress>("submit_login_code", { sessionId, code }),

  // Projects
  listProjects: () => call<Project[]>("list_projects"),
  addProjectViaPicker: () => call<Project | null>("add_project_via_picker"),
  updateProject: (input: UpdateProjectInput) => call<Project>("update_project", { input }),
  removeProject: (id: string) => call<null>("remove_project", { id }),
  openInEditor: (input: OpenInEditorInput) => call<OpenInEditorResult>("open_in_editor", { input }),
  setEditorAccount: (input: SetEditorAccountInput) => call<null>("set_editor_account", { input }),
  installEditorExtension: (editorId: string) =>
    call<EditorInfo>("install_editor_extension", { editorId }),

  // Conversations
  listConversations: () => call<Conversation[]>("list_conversations"),
  continueConversation: (input: ContinueConversationInput) =>
    call<ContinueConversationResult>("continue_conversation", { input }),

  // Sessions
  listSessions: (input: ListSessionsInput) => call<SessionInfo[]>("list_sessions", { input }),
  listOpenSessions: () => call<SessionInfo[]>("list_open_sessions"),
  startSession: (input: StartSessionInput) => call<SessionInfo>("start_session", { input }),
  attachSession: (id: string, onOutput: Channel<ArrayBuffer>) =>
    call<null>("attach_session", { id, onOutput }),
  writeSession: (id: string, data: string, binary = false) =>
    call<null>("write_session", { id, data, binary }),
  resizeSession: (id: string, cols: number, rows: number) =>
    call<null>("resize_session", { id, cols, rows }),
  stopSession: (id: string) => call<null>("stop_session", { id }),
  restartSession: (id: string, cols: number, rows: number) =>
    call<SessionInfo>("restart_session", { id, cols, rows }),
  closeSession: (id: string) => call<null>("close_session", { id }),
};

/** Backend event names (see `desktop::events` in Rust). */
export const events = {
  stateChanged: "state-changed",
  sessionUpdated: "session-updated",
  loginCompleted: "login-completed",
  menuAction: "menu-action",
  focusSession: "focus-session",
  loginProgress: "login-progress",
  confirmQuit: "confirm-quit",
  notice: "notice",
} as const;

export interface EventPayloads {
  "state-changed": ChangeScope;
  "session-updated": SessionInfo;
  "login-completed": Account;
  "menu-action": string;
  "focus-session": string;
  "login-progress": LoginProgress;
  "confirm-quit": number;
  notice: Notice;
}

export function onEvent<K extends keyof EventPayloads>(
  name: K,
  handler: (payload: EventPayloads[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloads[K]>(name, (event) => {
    handler(event.payload);
  });
}

/**
 * Subscribes to a backend event and returns a synchronous cleanup function,
 * for use in effects. Teardown errors (for example during shutdown) are
 * ignored.
 */
export function subscribe<K extends keyof EventPayloads>(
  name: K,
  handler: (payload: EventPayloads[K]) => void,
): () => void {
  const pending = onEvent(name, handler);
  return () => {
    pending.then((unlisten) => unlisten()).catch(() => undefined);
  };
}

export { Channel };
