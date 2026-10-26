import { describe, expect, it, vi } from "vitest";

import type { SessionInfo } from "../src/bindings/SessionInfo";
import { Helper } from "../src/helper";
import { openSessionTerminal } from "../src/terminal";
import { account, FakeHelperProcess, settle, type Answers } from "./fake-helper";
import { resetUi, ui } from "./vscode-stub";

vi.mock("vscode", () => import("./vscode-stub.js"));

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  accountId: "a",
  projectId: null,
  kind: "claude",
  title: "Claude · Work",
  workingDir: "/site",
  processId: 42,
  status: "running",
  startedAt: "",
  endedAt: null,
  exitCode: null,
  exitSignal: null,
  error: null,
  attached: true,
  usageLimitReached: false,
  ...extra,
});

/** A terminal whose session starts when the test says so. */
function open(answers: Answers = {}) {
  resetUi();
  const proc = new FakeHelperProcess(answers);
  const helper = new Helper(() => proc);
  let launch = (_s: SessionInfo) => undefined as void;
  const begin = vi.fn(
    () =>
      new Promise<SessionInfo>((resolve) => {
        launch = resolve;
      }),
  );
  openSessionTerminal(helper, account(), "Claude · Work", begin, { onUsageLimit: () => undefined });
  const pty = ui.terminals[0]?.pty;
  if (!pty) throw new Error("no terminal");
  pty.open({ columns: 80, rows: 24 });
  return { proc, pty, begin, launch: (s: SessionInfo) => launch(s) };
}

describe("a session terminal", () => {
  it("starts the session with the terminal's size", async () => {
    const { proc, begin, launch } = open();
    expect(begin).toHaveBeenCalledWith(80, 24);
    launch(session());
    await settle();
    expect(proc.calls).toEqual([{ method: "attachSession", params: { id: "s1" } }]);
  });

  it("stops a session that started after the terminal closed", async () => {
    const { proc, pty, launch } = open();
    pty.close();
    launch(session());
    await settle();
    expect(proc.calls).toEqual([{ method: "closeSession", params: { id: "s1" } }]);
  });

  it("sends a size change made while the session started", async () => {
    const { proc, pty, launch } = open();
    pty.setDimensions?.({ columns: 120, rows: 40 });
    launch(session());
    await settle();
    expect(proc.calls).toContainEqual({
      method: "resizeSession",
      params: { id: "s1", cols: 120, rows: 40 },
    });
  });

  it("starts one new session however often Return is pressed after it ended", async () => {
    const { proc, pty, launch } = open({ restartSession: session({ id: "s2" }) });
    launch(session());
    await settle();
    proc.event("sessionUpdated", session({ status: "exited", exitCode: 0 }));
    pty.handleInput?.("\r");
    pty.handleInput?.("\r");
    await settle();
    expect(proc.methods().filter((m) => m === "restartSession")).toHaveLength(1);
    expect(proc.calls).toContainEqual({ method: "attachSession", params: { id: "s2" } });
  });
});
