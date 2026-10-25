import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Bridge, BridgeError, PROTOCOL, request } from "../src/bridge";

const servers: net.Server[] = [];
const dirs: string[] = [];

/** A stand-in for Claude Switch's socket. */
function serve(handler: (request: Record<string, unknown>) => unknown): string {
  // Socket paths are limited to 104 bytes on macOS.
  const dir = fs.mkdtempSync("/tmp/csx");
  dirs.push(dir);
  const socket = path.join(dir, "s.sock");
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const reply = handler(JSON.parse(buffer) as Record<string, unknown>);
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(socket);
  servers.push(server);
  return socket;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("request", () => {
  it("sends one line and returns the result", async () => {
    const seen: Record<string, unknown>[] = [];
    const socket = serve((req) => {
      seen.push(req);
      return { id: req.id, result: [{ id: "a" }] };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(request(socket, "conversations", { directory: "/x" })).resolves.toEqual([
      { id: "a" },
    ]);
    expect(seen).toEqual([{ id: 1, method: "conversations", params: { directory: "/x" } }]);
  });

  it("turns error replies and missing sockets into BridgeErrors", async () => {
    const socket = serve((req) => ({
      id: req.id,
      error: { kind: "authRequired", message: "This account needs to sign in." },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(request(socket, "continue")).rejects.toMatchObject({
      kind: "authRequired",
      message: "This account needs to sign in.",
    });
    const missing = path.join(os.tmpdir(), "no-such-claude-switch.sock");
    await expect(request(missing, "status")).rejects.toMatchObject({ kind: "notRunning" });
  });

  it("gives up on a silent server", async () => {
    const dir = fs.mkdtempSync("/tmp/csx");
    dirs.push(dir);
    const socket = path.join(dir, "s.sock");
    const server = net.createServer(() => undefined);
    server.listen(socket);
    servers.push(server);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(request(socket, "status", {}, 100)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("Bridge", () => {
  it("starts Claude Switch when it is not running, then waits for it", async () => {
    const dir = fs.mkdtempSync("/tmp/csx");
    dirs.push(dir);
    const socket = path.join(dir, "s.sock");
    let launched = 0;
    const bridge = new Bridge(
      () => socket,
      async () => {
        launched++;
        // The app comes up a moment later.
        setTimeout(() => {
          const server = net.createServer((conn) => {
            conn.once("data", () => {
              conn.end(
                `${JSON.stringify({ id: 1, result: { appVersion: "0.1.0", protocol: PROTOCOL } })}\n`,
              );
            });
          });
          server.listen(socket);
          servers.push(server);
        }, 200);
      },
    );
    await bridge.ensureRunning();
    expect(launched).toBe(1);
    await bridge.ensureRunning();
    expect(launched).toBe(1);
  });

  it("refuses a Claude Switch that speaks another protocol", async () => {
    const socket = serve((req) => ({
      id: req.id,
      result: { appVersion: "9.0.0", protocol: PROTOCOL + 1 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const err = await new Bridge(() => socket).status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ kind: "protocol" });
  });
});
