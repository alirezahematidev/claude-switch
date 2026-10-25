import { afterEach, describe, expect, it } from "vitest";

import { backendError, callsTo, mockCommand, resetTauriMocks } from "@/test/tauri";

import { api, IpcError, toIpcError } from "./ipc";

afterEach(resetTauriMocks);

describe("toIpcError", () => {
  it("keeps the backend error kind and message", () => {
    const err = toIpcError({
      kind: "projectDirMissing",
      message: "The project directory is missing: /x",
    });
    expect(err).toBeInstanceOf(IpcError);
    expect(err.kind).toBe("projectDirMissing");
    expect(err.message).toBe("The project directory is missing: /x");
  });

  it("falls back to unknown for unexpected shapes", () => {
    expect(toIpcError({ kind: "bogus", message: "m" }).kind).toBe("unknown");
    expect(toIpcError("plain string").message).toBe("plain string");
    expect(toIpcError(42).message).toBe("Something went wrong.");
  });
});

describe("api", () => {
  it("wraps structured inputs under the argument name the command expects", async () => {
    mockCommand("start_session", { id: "s" });
    await api.startSession({ accountId: "a", kind: "claude", cols: 80, rows: 24 });
    expect(callsTo("start_session")[0]?.args).toEqual({
      input: { accountId: "a", kind: "claude", cols: 80, rows: 24 },
    });
  });

  it("sends terminal input as text with an explicit binary flag", async () => {
    mockCommand("write_session", null);
    await api.writeSession("s", "ls\r");
    await api.writeSession("s", "\x1b[M", true);
    expect(callsTo("write_session").map((c) => c.args)).toEqual([
      { id: "s", data: "ls\r", binary: false },
      { id: "s", data: "\x1b[M", binary: true },
    ]);
  });

  it("reveals paths by ID, never by raw path", async () => {
    mockCommand("reveal_path", null);
    await api.revealPath({ kind: "profile", accountId: "a" });
    expect(callsTo("reveal_path")[0]?.args).toEqual({
      target: { kind: "profile", accountId: "a" },
    });
  });

  it("rejects with IpcError", async () => {
    mockCommand("list_accounts", backendError("database", "Database error: locked"));
    await expect(api.listAccounts()).rejects.toMatchObject({ kind: "database" });
  });
});
