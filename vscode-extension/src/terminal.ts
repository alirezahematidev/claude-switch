/**
 * A Claude Switch session in a VS Code terminal. The helper runs Claude Code
 * (or a shell) in its own PTY, with the account's profile and environment,
 * exactly as the desktop app does; this terminal shows its output and sends
 * keystrokes and size changes back. Because the output passes through the
 * helper, it can tell when Claude Code reports a usage limit.
 */
import * as vscode from "vscode";

import { ACCOUNT_THEME_COLORS } from "./accounts";
import type { Account } from "./bindings/Account";
import type { SessionInfo } from "./bindings/SessionInfo";
import type { Helper } from "./helper";
import { isActive, OutputDecoder, sessionEnded } from "./model";

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export interface TerminalCallbacks {
  /** Claude Code reported a usage limit in this session. */
  onUsageLimit(session: SessionInfo): void;
}

/** Terminals open now, so a window reload can ask first. */
const openTerminals = new Set<SessionPty>();

export function sessionTerminalsOpen(): boolean {
  return openTerminals.size > 0;
}

function message(text: string, color = DIM): string {
  return `\r\n${color}${text}${RESET}\r\n`;
}

class SessionPty implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<void>();
  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;
  private session: SessionInfo | undefined;
  private decoder = new OutputDecoder();
  private size = { cols: 120, rows: 30 };
  private ended = false;
  /** A session is being started (or restarted). */
  private starting = false;
  private closed = false;
  private limitReported = false;
  private readonly subscriptions: { dispose(): void }[] = [];

  constructor(
    private readonly helper: Helper,
    private readonly begin: (cols: number, rows: number) => Promise<SessionInfo>,
    private readonly callbacks: TerminalCallbacks,
  ) {}

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    openTerminals.add(this);
    if (dimensions) this.size = { cols: dimensions.columns, rows: dimensions.rows };
    this.subscriptions.push(
      this.helper.on("output", ({ id, data }) => {
        if (id === this.session?.id) this.writer.fire(this.decoder.push(data));
      }),
      this.helper.on("sessionUpdated", (session) => {
        if (session.id === this.session?.id) this.update(session);
      }),
      this.helper.on("exited", () => {
        if (this.session && !this.ended) {
          this.ended = true;
          this.writer.fire(message("Claude Switch stopped, and this session with it.", RED));
        }
      }),
    );
    void this.start(() => this.begin(this.size.cols, this.size.rows));
  }

  private async start(launch: () => Promise<SessionInfo>): Promise<void> {
    this.starting = true;
    const launched = { ...this.size };
    try {
      const session = await launch();
      if (this.closed) {
        // Closed while it started: nothing would show it or stop it.
        this.helper.closeSession(session.id).catch(() => undefined);
        return;
      }
      this.session = session;
      this.decoder = new OutputDecoder();
      this.ended = false;
      this.limitReported = false;
      await this.helper.attachSession(session.id);
      // Resized while it started.
      if (this.size.cols !== launched.cols || this.size.rows !== launched.rows) {
        this.helper
          .resizeSession(session.id, this.size.cols, this.size.rows)
          .catch(() => undefined);
      }
      this.update(session);
    } catch (err) {
      this.ended = true;
      this.writer.fire(message(err instanceof Error ? err.message : String(err), RED));
    } finally {
      this.starting = false;
    }
  }

  private update(session: SessionInfo): void {
    this.session = session;
    if (session.usageLimitReached && !this.limitReported) {
      this.limitReported = true;
      this.callbacks.onUsageLimit(session);
    }
    if (!this.ended && !isActive(session)) {
      this.ended = true;
      this.writer.fire(
        message(`${sessionEnded(session)} Press Return to start it again, or close this terminal.`),
      );
    }
  }

  handleInput(data: string): void {
    const session = this.session;
    if (!session) return;
    if (this.ended) {
      // Once: another Return while it restarts would start a second session.
      if (data === "\r" && !this.starting) {
        void this.start(() =>
          this.helper.restartSession(session.id, this.size.cols, this.size.rows),
        );
      }
      return;
    }
    this.helper.writeSession(session.id, data).catch(() => undefined);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.size = { cols: dimensions.columns, rows: dimensions.rows };
    const session = this.session;
    if (session && !this.ended) {
      this.helper
        .resizeSession(session.id, dimensions.columns, dimensions.rows)
        .catch(() => undefined);
    }
  }

  close(): void {
    this.closed = true;
    openTerminals.delete(this);
    for (const s of this.subscriptions) s.dispose();
    const session = this.session;
    if (session) this.helper.closeSession(session.id).catch(() => undefined);
    this.writer.dispose();
    this.closer.dispose();
  }
}

/** Opens a terminal for a session `begin` starts once the terminal has a size. */
export function openSessionTerminal(
  helper: Helper,
  account: Account,
  title: string,
  begin: (cols: number, rows: number) => Promise<SessionInfo>,
  callbacks: TerminalCallbacks,
): vscode.Terminal {
  const color = ACCOUNT_THEME_COLORS[account.color];
  const terminal = vscode.window.createTerminal({
    name: title,
    pty: new SessionPty(helper, begin, callbacks),
    iconPath: new vscode.ThemeIcon("account"),
    color: color ? new vscode.ThemeColor(color) : undefined,
    isTransient: true,
  });
  terminal.show();
  return terminal;
}
