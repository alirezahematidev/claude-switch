import { describe, expect, it, vi } from "vitest";

import type { LoginProgress } from "../src/bindings/LoginProgress";
import { Helper } from "../src/helper";
import { signIn } from "../src/signin";
import { account, FakeHelperProcess, settle } from "./fake-helper";
import { resetUi, ui } from "./vscode-stub";

vi.mock("vscode", () => import("./vscode-stub.js"));

const SESSION = "s";

const progress = (extra: Partial<LoginProgress> = {}): LoginProgress => ({
  sessionId: SESSION,
  accountId: "a",
  phase: "waiting",
  url: "https://claude.com/cai/oauth/authorize?code=true",
  urlHost: "claude.com",
  awaitingCode: true,
  message: null,
  ...extra,
});

const starting = progress({ phase: "starting", url: null, urlHost: null, awaitingCode: false });

function start(initial: LoginProgress = starting) {
  resetUi();
  const proc = new FakeHelperProcess({ startLogin: { id: SESSION }, loginProgress: initial });
  const helper = new Helper(() => proc);
  let finished = false;
  const result = signIn(helper, account()).finally(() => {
    finished = true;
  });
  return { proc, result, isFinished: () => finished };
}

describe("signIn", () => {
  it("waits for the checked login after Claude Code reports success", async () => {
    const { proc, result, isFinished } = start();
    await settle();
    expect(ui.infos).toEqual([]);
    proc.event("loginProgress", progress());
    await settle();
    expect(ui.infos).toEqual(["Finish signing in to Work in your browser."]);

    // Claude Code prints "Login successful." before it exits and the stored
    // login is checked.
    proc.event("loginProgress", progress({ phase: "succeeded", awaitingCode: false }));
    await settle();
    expect(isFinished()).toBe(false);
    expect(ui.errors).toEqual([]);

    const signedIn = account({ authStatus: "authenticated", verifiedEmail: "me@work.example" });
    proc.event("loginCompleted", signedIn);
    await expect(result).resolves.toEqual(signedIn);
    expect(ui.errors).toEqual([]);
    expect(ui.status).toEqual(["$(check) Work signed in"]);
    expect(ui.infos).toHaveLength(1);
    expect(proc.methods()).toContain("closeSession");
  });

  it("shows the sign-in link sent before it subscribed", async () => {
    start(progress());
    await settle();
    expect(ui.infos).toEqual(["Finish signing in to Work in your browser."]);
    ui.cancel?.();
  });

  it("explains a failed sign-in", async () => {
    const { proc, result } = start();
    await settle();
    proc.event(
      "loginProgress",
      progress({ phase: "failed", awaitingCode: false, message: "Claude Code reported: boom" }),
    );
    await expect(result).resolves.toBeUndefined();
    expect(ui.errors).toEqual(["Work was not signed in: Claude Code reported: boom"]);
  });

  it("asks again when Claude Code refuses an incomplete code", async () => {
    const { proc } = start(progress());
    await settle();
    proc.event("loginProgress", progress({ phase: "verifying" }));
    proc.event("loginProgress", progress({ message: "That code is incomplete." }));
    await settle();
    expect(ui.infos).toEqual([
      "Finish signing in to Work in your browser.",
      "That code is incomplete.",
    ]);
    ui.cancel?.();
  });

  it("closes without an error when cancelled", async () => {
    const { proc, result } = start();
    await settle();
    ui.cancel?.();
    await expect(result).resolves.toBeUndefined();
    await settle();
    expect(ui.errors).toEqual([]);
    expect(proc.methods()).toContain("closeSession");
  });
});
