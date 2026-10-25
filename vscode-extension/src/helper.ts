/**
 * Client for Claude Switch's helper (`src-tauri/helper`): the app's core,
 * started as a child process of this window's extension host and spoken to
 * over stdin and stdout, one JSON message per line. Requests carry an `id`;
 * events (account changes, terminal output, sign-in progress) do not.
 *
 * The helper shares the desktop app's database and profiles, so the app is
 * not needed, and both show the same accounts when it is installed.
 */
import { spawn } from "node:child_process";

import { isRecord } from "./accounts";
import type { Account } from "./bindings/Account";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeConversation } from "./bindings/BridgeConversation";
import type { BridgeHandOver } from "./bindings/BridgeHandOver";
import type { BridgeOpenConversation } from "./bindings/BridgeOpenConversation";
import type { ChangeScope } from "./bindings/ChangeScope";
import type { CliStatus } from "./bindings/CliStatus";
import type { ContinueConversationInput } from "./bindings/ContinueConversationInput";
import type { ContinueConversationResult } from "./bindings/ContinueConversationResult";
import type { CreateAccountInput } from "./bindings/CreateAccountInput";
import type { DeleteAccountInput } from "./bindings/DeleteAccountInput";
import type { LoginProgress } from "./bindings/LoginProgress";
import type { OpenInEditorInput } from "./bindings/OpenInEditorInput";
import type { OpenInEditorResult } from "./bindings/OpenInEditorResult";
import type { Project } from "./bindings/Project";
import type { SessionInfo } from "./bindings/SessionInfo";
import type { StartLoginInput } from "./bindings/StartLoginInput";
import type { StartSessionInput } from "./bindings/StartSessionInput";
import type { SystemInfo } from "./bindings/SystemInfo";
import type { UpdateAccountInput } from "./bindings/UpdateAccountInput";

/** The protocol version this extension speaks. */
export const PROTOCOL = 1;

/** An error from the helper (`kind` as in its `ErrorKind`) or from running it. */
export class HelperError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

/** Events the helper sends, by name. */
export interface HelperEvents {
  changed: ChangeScope;
  sessionUpdated: SessionInfo;
  sessionFinished: { session: SessionInfo; accountName: string };
  loginProgress: LoginProgress;
  loginCompleted: Account;
  /** Terminal output of session `id`, base64. */
  output: { id: string; data: string };
  /** Something asked to show an account (or all of them). */
  show: { accountId: string | null };
  /** The helper exited; its sessions are gone. Sent by this client. */
  exited: { code: number | null };
}

type Listener<K extends keyof HelperEvents> = (data: HelperEvents[K]) => void;

/** The child process, as far as this client uses it (tests supply a fake). */
export interface HelperProcess {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): unknown;
}

export function spawnHelper(path: string, version: string): HelperProcess {
  return spawn(path, ["--app-version", version], { stdio: ["pipe", "pipe", "pipe"] });
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

function isErrorPayload(value: unknown): value is { kind: string; message: string } {
  return isRecord(value) && typeof value.kind === "string" && typeof value.message === "string";
}

export class Helper {
  private proc: HelperProcess | undefined;
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private ready: Promise<void> | undefined;

  constructor(
    private readonly start: () => HelperProcess,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  on<K extends keyof HelperEvents>(event: K, listener: Listener<K>): { dispose(): void } {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    // Each event's data is shaped by the helper's protocol for that name.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const wrapped = listener as (data: unknown) => void;
    set.add(wrapped);
    return { dispose: () => set.delete(wrapped) };
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(data);
      } catch (err) {
        this.log(`listener for ${event} failed: ${String(err)}`);
      }
    }
  }

  private spawn(): HelperProcess {
    const proc = this.start();
    this.proc = proc;
    this.buffer = "";
    proc.stdout?.on("data", (chunk) => {
      this.receive(proc, chunk.toString());
    });
    proc.stderr?.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) this.log(line);
    });
    const gone = (code: number | null, message: string) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.ready = undefined;
      for (const p of this.pending.values()) p.reject(new HelperError("notRunning", message));
      this.pending.clear();
      this.emit("exited", { code });
    };
    proc.on("exit", (code) => {
      gone(code, "Claude Switch's helper stopped.");
    });
    proc.on("error", (err) => {
      gone(null, `Claude Switch's helper could not run: ${err.message}`);
    });
    return proc;
  }

  private receive(proc: HelperProcess, chunk: string): void {
    if (this.proc !== proc) return;
    this.buffer += chunk;
    for (let end = this.buffer.indexOf("\n"); end !== -1; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`unreadable line from the helper (${line.length} characters)`);
        continue;
      }
      if (!isRecord(message)) continue;
      if (typeof message.event === "string") {
        this.emit(message.event, message.data);
        continue;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending || typeof message.id !== "number") continue;
      this.pending.delete(message.id);
      if (message.error !== undefined && message.error !== null) {
        pending.reject(
          isErrorPayload(message.error)
            ? new HelperError(message.error.kind, message.error.message)
            : new HelperError("io", "Claude Switch's helper reported an error."),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  /** Sends one request, starting the helper if needed. */
  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const proc = this.proc ?? this.spawn();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      // Results are shaped by the bindings generated from the Rust types.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      try {
        if (!proc.stdin) throw new Error("no input");
        proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        reject(new HelperError("notRunning", "Claude Switch's helper is not running."));
      }
    });
  }

  /** Starts the helper and checks it speaks this protocol. */
  ensureRunning(): Promise<void> {
    this.ready ??= this.call<{ protocol: number; version: string }>("hello")
      .then((hello) => {
        if (hello.protocol !== PROTOCOL) {
          throw new HelperError(
            "protocol",
            `Claude Switch's helper speaks protocol ${hello.protocol}, not ${PROTOCOL}. Reinstall the extension.`,
          );
        }
      })
      .catch((err: unknown) => {
        this.ready = undefined;
        throw err;
      });
    return this.ready;
  }

  /** Stops the helper; it stops the sessions it started. */
  dispose(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    proc?.stdin?.end();
  }

  // System
  systemInfo = () => this.call<SystemInfo>("systemInfo");
  diagnostics = () => this.call<string>("diagnostics");
  refreshCli = () => this.call<CliStatus>("refreshCli");
  sync = () => this.call<boolean>("sync");
  setClaudeExecutable = (path: string) => this.call<CliStatus>("setClaudeExecutable", { path });

  // Accounts
  listAccounts = () => this.call<Account[]>("listAccounts");
  createAccount = (input: CreateAccountInput) => this.call<Account>("createAccount", { input });
  updateAccount = (input: UpdateAccountInput) => this.call<Account>("updateAccount", { input });
  reorderAccounts = (ids: string[]) => this.call<Account[]>("reorderAccounts", { ids });
  deleteAccount = (input: DeleteAccountInput) => this.call<null>("deleteAccount", { input });
  refreshAuthStatus = (id: string) => this.call<Account>("refreshAuthStatus", { id });
  startLogin = (input: StartLoginInput) => this.call<SessionInfo>("startLogin", { input });
  loginProgress = (sessionId: string) => this.call<LoginProgress>("loginProgress", { sessionId });
  submitLoginCode = (sessionId: string, code: string) =>
    this.call<LoginProgress>("submitLoginCode", { sessionId, code });

  // Projects
  listProjects = () => this.call<Project[]>("listProjects");
  addProject = (directory: string) => this.call<Project>("addProject", { directory });
  removeProject = (id: string) => this.call<null>("removeProject", { id });
  openInEditor = (input: OpenInEditorInput) =>
    this.call<OpenInEditorResult>("openInEditor", { input });

  // Sessions
  startSession = (input: StartSessionInput) => this.call<SessionInfo>("startSession", { input });
  attachSession = (id: string) => this.call<null>("attachSession", { id });
  writeSession = (id: string, data: string) => this.call<null>("writeSession", { id, data });
  resizeSession = (id: string, cols: number, rows: number) =>
    this.call<null>("resizeSession", { id, cols, rows });
  stopSession = (id: string) => this.call<null>("stopSession", { id });
  restartSession = (id: string, cols: number, rows: number) =>
    this.call<SessionInfo>("restartSession", { id, cols, rows });
  closeSession = (id: string) => this.call<null>("closeSession", { id });

  // Conversations
  continueConversation = (input: ContinueConversationInput) =>
    this.call<ContinueConversationResult>("continueConversation", { input });

  // The editor bridge's methods, which the account switcher uses.
  accounts = () => this.call<BridgeAccount[]>("accounts");
  conversations = (directory: string) =>
    this.call<BridgeConversation[]>("conversations", { directory });
  openConversations = (parentPid: number) =>
    this.call<BridgeOpenConversation[]>("open", { parentPid });
  handOver = (
    directory: string,
    sessionId: string,
    fromAccountId: string | null,
    toAccountId: string,
  ) => this.call<BridgeHandOver>("continue", { directory, sessionId, fromAccountId, toAccountId });
}
