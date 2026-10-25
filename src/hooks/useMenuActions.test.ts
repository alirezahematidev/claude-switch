import { describe, expect, it } from "vitest";

import type { SessionInfo } from "@/bindings/SessionInfo";
import { makeAccount, makeProject } from "@/test/tauri";

import { launchContext } from "./useMenuActions";

const a = makeAccount({ id: "a" });
const b = makeAccount({ id: "b" });
const p = makeProject({ id: "p", defaultAccountId: "b" });

const session = { id: "s", accountId: "b", projectId: "p" } as unknown as SessionInfo;

describe("launchContext", () => {
  it("uses the account being viewed", () => {
    expect(launchContext({ kind: "account", accountId: "b" }, undefined, [a, b], [p])).toEqual({
      accountId: "b",
      projectId: null,
    });
  });

  it("uses the project's default account", () => {
    expect(launchContext({ kind: "project", projectId: "p" }, undefined, [a, b], [p])).toEqual({
      accountId: "b",
      projectId: "p",
    });
  });

  it("follows the active terminal tab", () => {
    expect(launchContext({ kind: "terminal" }, session, [a, b], [p])).toEqual({
      accountId: "b",
      projectId: "p",
    });
  });

  it("falls back to the first account, or nothing", () => {
    expect(launchContext({ kind: "home" }, undefined, [a, b], [])).toEqual({
      accountId: "a",
      projectId: null,
    });
    expect(launchContext({ kind: "home" }, undefined, [], [])).toBeNull();
  });
});
