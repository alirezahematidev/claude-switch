/**
 * Client for Claude Switch's local socket (see `editor_bridge.rs`): one JSON
 * request per connection, one JSON line back. The socket only accepts the
 * current user, and only offers these methods.
 */
import { execFile } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { isRecord } from "./accounts";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeConversation } from "./bindings/BridgeConversation";
import type { BridgeHandOver } from "./bindings/BridgeHandOver";
import type { BridgeOpenConversation } from "./bindings/BridgeOpenConversation";
import type { BridgeStatus } from "./bindings/BridgeStatus";

/** The protocol version this extension speaks. */
export const PROTOCOL = 1;
export const APP_BUNDLE_ID = "dev.claudeswitch.desktop";
const REQUEST_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 15_000;

/** An error from Claude Switch (`kind` as in its `ErrorKind`) or the connection. */
export class BridgeError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function defaultSocketPath(): string {
  return path.join(os.homedir(), ".claude-switch", "claude-switch.sock");
}

function isErrorPayload(value: unknown): value is { kind: string; message: string } {
  return isRecord(value) && typeof value.kind === "string" && typeof value.message === "string";
}

/** Sends one request and resolves with its result. */
export function request<T>(
  socket: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new BridgeError("timeout", "Claude Switch did not answer in time."));
      });
    }, timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => {
      conn.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      finish(() => {
        let reply: unknown;
        try {
          reply = JSON.parse(buffer.slice(0, end));
        } catch {
          reply = undefined;
        }
        if (!isRecord(reply)) {
          reject(new BridgeError("io", "Claude Switch sent an unreadable reply."));
        } else if (reply.error !== undefined && reply.error !== null) {
          const err = isErrorPayload(reply.error)
            ? new BridgeError(reply.error.kind, reply.error.message)
            : new BridgeError("io", "Claude Switch reported an error.");
          reject(err);
        } else {
          // Replies are shaped by the bindings generated from the Rust protocol types.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          resolve(reply.result as T);
        }
      });
    });
    conn.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => {
        const notRunning = err.code === "ENOENT" || err.code === "ECONNREFUSED";
        reject(
          notRunning
            ? new BridgeError("notRunning", "Claude Switch is not running.")
            : new BridgeError("io", `Could not reach Claude Switch: ${err.message}`),
        );
      });
    });
    conn.on("end", () => {
      finish(() => {
        reject(new BridgeError("io", "Claude Switch closed the connection."));
      });
    });
  });
}

/** Starts Claude Switch in the background (menu bar only). */
export function launchApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", ["-g", "-b", APP_BUNDLE_ID, "--args", "--background"], (err) => {
      if (err) {
        reject(
          new BridgeError(
            "notInstalled",
            "Claude Switch could not be opened. Install it in Applications first.",
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Typed access to Claude Switch, starting it on demand. */
export class Bridge {
  constructor(
    private readonly socket: () => string,
    private readonly launch: () => Promise<void> = launchApp,
  ) {}

  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return request<T>(this.socket(), method, params);
  }

  /** Checks Claude Switch is running and speaks this protocol. */
  async status(): Promise<BridgeStatus> {
    const status = await this.call<BridgeStatus>("status");
    if (status.protocol !== PROTOCOL) {
      throw new BridgeError(
        "protocol",
        `This extension needs a different version of Claude Switch (it has ${status.appVersion}). Reinstall the extension from Claude Switch's Settings.`,
      );
    }
    return status;
  }

  /** Starts Claude Switch if needed and waits until it answers. */
  async ensureRunning(): Promise<void> {
    try {
      await this.status();
      return;
    } catch (err) {
      if (!(err instanceof BridgeError) || err.kind !== "notRunning") throw err;
    }
    await this.launch();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    for (;;) {
      await sleep(300);
      try {
        await this.status();
        return;
      } catch (err) {
        const waiting = err instanceof BridgeError && err.kind === "notRunning";
        if (!waiting || Date.now() > deadline) throw err;
      }
    }
  }

  accounts(): Promise<BridgeAccount[]> {
    return this.call("accounts");
  }

  conversations(directory: string): Promise<BridgeConversation[]> {
    return this.call("conversations", { directory });
  }

  /**
   * Conversations open in the Claude Code processes `parentPid` started,
   * with the account each runs with.
   */
  openConversations(parentPid: number): Promise<BridgeOpenConversation[]> {
    return this.call("open", { parentPid });
  }

  handOver(
    directory: string,
    sessionId: string,
    fromAccountId: string | null,
    toAccountId: string,
  ): Promise<BridgeHandOver> {
    return this.call("continue", { directory, sessionId, fromAccountId, toAccountId });
  }

  async show(accountId?: string): Promise<void> {
    await this.call("show", accountId ? { accountId } : {});
  }
}
