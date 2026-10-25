import { describe, expect, it } from "vitest";

import {
  accountFor,
  claudeLink,
  configDirFromSetting,
  configDirInUse,
  formatAgo,
  mergeConversations,
  withConfigDir,
} from "../src/accounts";
import type { BridgeAccount } from "../src/bindings/BridgeAccount";

const work: BridgeAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Work",
  color: "blue",
  detail: "me@work.example",
  configDir: "/Users/me/.claude-switch/profiles/11111111-1111-4111-8111-111111111111",
  signedIn: true,
  status: "Signed in",
};

describe("the Claude Code setting", () => {
  it("is read the way the Claude Code extension reads it", () => {
    expect(configDirFromSetting(undefined)).toBeUndefined();
    expect(
      configDirFromSetting([
        { name: "FOO", value: "1" },
        { name: "CLAUDE_CONFIG_DIR", value: "relative" },
        { name: "CLAUDE_CONFIG_DIR", value: "/first" },
        { name: "CLAUDE_CONFIG_DIR", value: "/second" },
        "junk",
      ]),
    ).toBe("/second");
    expect(configDirFromSetting({ CLAUDE_CONFIG_DIR: "/obj" })).toBe("/obj");
  });

  it("changes only its own entry", () => {
    const proxy = { name: "HTTPS_PROXY", value: "http://proxy" };
    expect(withConfigDir(undefined, "/b")).toEqual([{ name: "CLAUDE_CONFIG_DIR", value: "/b" }]);
    expect(withConfigDir([proxy, { name: "CLAUDE_CONFIG_DIR", value: "/a" }], "/b")).toEqual([
      proxy,
      { name: "CLAUDE_CONFIG_DIR", value: "/b" },
    ]);
    expect(withConfigDir([proxy, { name: "CLAUDE_CONFIG_DIR", value: "/a" }], undefined)).toEqual([
      proxy,
    ]);
    expect(withConfigDir([{ name: "CLAUDE_CONFIG_DIR", value: "/a" }], undefined)).toBeUndefined();
    expect(withConfigDir({ CLAUDE_CONFIG_DIR: "/a", X: "1" }, "/b")).toEqual({
      X: "1",
      CLAUDE_CONFIG_DIR: "/b",
    });
    expect(withConfigDir({ CLAUDE_CONFIG_DIR: "/a" }, undefined)).toBeUndefined();
  });

  it("decides which account is in use", () => {
    const setting = [{ name: "CLAUDE_CONFIG_DIR", value: work.configDir }];
    expect(configDirInUse(setting, { CLAUDE_CONFIG_DIR: "/window" })).toEqual({
      dir: work.configDir,
      source: "settings",
    });
    expect(configDirInUse(undefined, { CLAUDE_CONFIG_DIR: "/window" })).toEqual({
      dir: "/window",
      source: "window",
    });
    expect(configDirInUse([], {})).toEqual({ dir: undefined, source: "default" });
    expect(accountFor([work], `${work.configDir}/`)).toBe(work);
    expect(accountFor([work], "/elsewhere")).toBeUndefined();
    expect(accountFor([work], undefined)).toBeUndefined();
  });
});

describe("conversations", () => {
  it("are merged across folders, newest copy first", () => {
    const merged = mergeConversations([
      {
        directory: "/a",
        conversations: [
          { sessionId: "s1", accountId: "x", modifiedAt: "2026-10-25T10:00:00Z", sizeBytes: 1 },
          { sessionId: "s2", accountId: "x", modifiedAt: "2026-10-25T08:00:00Z", sizeBytes: 1 },
        ],
      },
      {
        directory: "/b",
        conversations: [
          { sessionId: "s3", accountId: null, modifiedAt: "2026-10-25T09:00:00Z", sizeBytes: 1 },
        ],
      },
    ]);
    expect(merged.map((c) => [c.sessionId, c.directory])).toEqual([
      ["s1", "/a"],
      ["s3", "/b"],
      ["s2", "/a"],
    ]);
  });

  it("formats recency", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(formatAgo("2026-10-25T11:59:50Z", now)).toBe("just now");
    expect(formatAgo("2026-10-25T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatAgo("2026-10-24T11:00:00Z", now)).toBe("yesterday");
  });
});

describe("the Claude Code link", () => {
  it("follows the documented form", () => {
    expect(claudeLink("vscode")).toBe("vscode://anthropic.claude-code/open");
    expect(claudeLink("cursor", "abc", "Continue where you left off.")).toBe(
      "cursor://anthropic.claude-code/open?session=abc&prompt=Continue%20where%20you%20left%20off.",
    );
    // Characters that would change the query are dropped from the message.
    expect(claudeLink("vscode", "abc", "a&b=c #1 + 50%?")).toBe(
      "vscode://anthropic.claude-code/open?session=abc&prompt=a%20b%20c%201%2050",
    );
    expect(claudeLink("vscode", "abc", "   ")).toBe(
      "vscode://anthropic.claude-code/open?session=abc",
    );
  });
});
