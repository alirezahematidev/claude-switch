import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { Helper, HelperError, type HelperProcess } from "../src/helper";

/** A helper process that answers through `reply` and records what it got. */
class FakeProcess extends EventEmitter implements HelperProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly received: Record<string, unknown>[] = [];
  ended = false;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        this.received.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
    end: () => {
      this.ended = true;
    },
  };

  /** Sends `text` to the client as the helper's output. */
  say(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  reply(id: unknown, body: Record<string, unknown>): void {
    this.say(`${JSON.stringify({ id, ...body })}\n`);
  }

  kill(): void {
    this.emit("exit", null);
  }
}

function setup() {
  const procs: FakeProcess[] = [];
  const logged: string[] = [];
  const helper = new Helper(
    () => {
      const proc = new FakeProcess();
      procs.push(proc);
      return proc;
    },
    (line) => logged.push(line),
  );
  return { helper, procs, logged };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Helper", () => {
  it("pairs each response with its request, in any order and across chunks", async () => {
    const { helper, procs } = setup();
    const accounts = helper.listAccounts();
    const projects = helper.listProjects();
    const proc = procs[0];
    expect(procs).toHaveLength(1);
    expect(proc?.received).toEqual([
      { id: 1, method: "listAccounts", params: {} },
      { id: 2, method: "listProjects", params: {} },
    ]);
    proc?.say('{"id": 2, "result": [{"id": "p"}]}\n{"id": 1, "res');
    proc?.say('ult": []}\n');
    await expect(projects).resolves.toEqual([{ id: "p" }]);
    await expect(accounts).resolves.toEqual([]);
  });

  it("names parameters like the app's commands", () => {
    const { helper, procs } = setup();
    void helper.startSession({ accountId: "a", kind: "claude", cols: 80, rows: 24 });
    void helper.submitLoginCode("s", "code#state");
    void helper.openConversations(42);
    void helper.handOver("/site", "c", null, "b");
    expect(procs[0]?.received.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "startSession",
        params: { input: { accountId: "a", kind: "claude", cols: 80, rows: 24 } },
      },
      { method: "submitLoginCode", params: { sessionId: "s", code: "code#state" } },
      { method: "open", params: { parentPid: 42 } },
      {
        method: "continue",
        params: { directory: "/site", sessionId: "c", fromAccountId: null, toAccountId: "b" },
      },
    ]);
  });

  it("turns error replies into HelperErrors with the app's kinds", async () => {
    const { helper, procs } = setup();
    const call = helper.refreshAuthStatus("a");
    procs[0]?.reply(1, { error: { kind: "notFound", message: "Account not found" } });
    await expect(call).rejects.toEqual(new HelperError("notFound", "Account not found"));
    const odd = helper.listAccounts();
    procs[0]?.reply(2, { error: "boom" });
    await expect(odd).rejects.toMatchObject({ kind: "io" });
  });

  it("delivers events to their listeners", () => {
    const { helper, procs, logged } = setup();
    const seen: unknown[] = [];
    const sub = helper.on("changed", (scope) => seen.push(scope));
    helper.on("output", () => {
      throw new Error("listener broke");
    });
    void helper.listAccounts();
    procs[0]?.say('{"event": "changed", "data": "accounts"}\n');
    procs[0]?.say('{"event": "output", "data": {"id": "s", "data": "aGk="}}\nnot json\n');
    sub.dispose();
    procs[0]?.say('{"event": "changed", "data": "projects"}\n');
    expect(seen).toEqual(["accounts"]);
    expect(logged).toEqual([
      "listener for output failed: Error: listener broke",
      "unreadable line from the helper (8 characters)",
    ]);
  });

  it("checks the protocol once, and again after a failure", async () => {
    const { helper, procs } = setup();
    const first = helper.ensureRunning();
    procs[0]?.reply(1, { result: { protocol: 99, version: "9.9.9" } });
    await expect(first).rejects.toMatchObject({ kind: "protocol" });
    const second = helper.ensureRunning();
    procs[0]?.reply(2, { result: { protocol: 1, version: "9.9.9" } });
    await expect(second).resolves.toBeUndefined();
    await helper.ensureRunning();
    expect(procs[0]?.received).toHaveLength(2);
  });

  it("fails pending calls when the helper stops, and starts a new one on the next call", async () => {
    const { helper, procs } = setup();
    const exits: unknown[] = [];
    helper.on("exited", (e) => exits.push(e));
    const pending = helper.listAccounts();
    procs[0]?.emit("exit", 1);
    await expect(pending).rejects.toMatchObject({ kind: "notRunning" });
    expect(exits).toEqual([{ code: 1 }]);
    void helper.listAccounts();
    expect(procs).toHaveLength(2);
    // Lines from the old process no longer count.
    procs[0]?.reply(2, { result: [] });
    await tick();
  });

  it("ends the helper's input on dispose, which stops its sessions", () => {
    const { helper, procs } = setup();
    void helper.listAccounts();
    helper.dispose();
    expect(procs[0]?.ended).toBe(true);
  });

  it("logs the helper's own messages", () => {
    const { helper, procs, logged } = setup();
    void helper.listAccounts();
    procs[0]?.stderr.emit("data", Buffer.from("starting\n\nready\n"));
    expect(logged).toEqual(["starting", "ready"]);
  });
});
