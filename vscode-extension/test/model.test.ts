import { describe, expect, it } from "vitest";

import type { Account } from "../src/bindings/Account";
import type { SessionInfo } from "../src/bindings/SessionInfo";
import {
  accountSubtitle,
  OutputDecoder,
  sessionEnded,
  validateAccountName,
  validateLoginCode,
} from "../src/model";

const account = (extra: Partial<Account> = {}): Account => ({
  id: "a",
  name: "Work",
  label: null,
  verifiedEmail: "work@example.com",
  orgName: null,
  configDir: "/Users/me/.claude-switch/profiles/a",
  color: "blue",
  notes: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
  authStatus: "authenticated",
  authMethod: "claude.ai",
  authStatusCheckedAt: null,
  authVerifiedAt: null,
  authDetail: null,
  runningSessions: 0,
  ...extra,
});

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s",
  accountId: "a",
  projectId: null,
  kind: "claude",
  title: "Work · site",
  workingDir: "/site",
  processId: null,
  status: "exited",
  startedAt: "",
  endedAt: null,
  exitCode: 0,
  exitSignal: null,
  error: null,
  attached: true,
  usageLimitReached: false,
  ...extra,
});

describe("accounts", () => {
  it("shows the email, or the label until Claude Code reports one", () => {
    expect(accountSubtitle(account())).toBe("work@example.com");
    expect(accountSubtitle(account({ verifiedEmail: null, label: "me@work" }))).toBe("me@work");
    expect(accountSubtitle(account({ verifiedEmail: null }))).toBeNull();
  });

  it("checks names and sign-in codes", () => {
    expect(validateAccountName("  Work ")).toBeUndefined();
    expect(validateAccountName("   ")).toMatch(/Enter a name/);
    expect(validateAccountName("x".repeat(257))).toMatch(/256/);
    expect(validateLoginCode("abc#state")).toBeUndefined();
    expect(validateLoginCode("")).toMatch(/Paste the code/);
    expect(validateLoginCode("ab cd")).toMatch(/no spaces/);
    expect(validateLoginCode("ab\u0003")).toMatch(/no spaces/);
  });
});

describe("sessions", () => {
  it("says how a session ended", () => {
    expect(sessionEnded(session())).toBe("Claude Code finished.");
    expect(sessionEnded(session({ exitCode: 1 }))).toBe("Claude Code ended (exit code 1).");
    expect(sessionEnded(session({ kind: "shell", exitCode: null, exitSignal: "SIGHUP" }))).toBe(
      "The shell ended (SIGHUP).",
    );
    expect(
      sessionEnded(
        session({ status: "failed", exitCode: null, error: "Claude Code was not found" }),
      ),
    ).toBe("Claude Code could not start: Claude Code was not found");
  });

  it("decodes terminal output, completing characters split between chunks", () => {
    const decoder = new OutputDecoder();
    const bytes = Buffer.from("café ·", "utf8");
    const first = bytes.subarray(0, 4).toString("base64");
    const rest = bytes.subarray(4).toString("base64");
    expect(decoder.push(first)).toBe("caf");
    expect(decoder.push(rest)).toBe("é ·");
  });
});
