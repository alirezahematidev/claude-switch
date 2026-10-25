import { describe, expect, it } from "vitest";

import type { InUse } from "../src/accounts";
import type { BridgeAccount } from "../src/bindings/BridgeAccount";
import type { BridgeConversation } from "../src/bindings/BridgeConversation";
import { BridgeError, type Bridge } from "../src/bridge";
import {
  describeInUse,
  otherTabsMessage,
  Switcher,
  tabsAccountName,
  type PickItem,
  type SwitcherHost,
  type TabAccount,
} from "../src/switcher";

const account = (id: string, name: string, extra: Partial<BridgeAccount> = {}): BridgeAccount => ({
  id,
  name,
  color: "blue",
  detail: `${name.toLowerCase()}@example.com`,
  configDir: `/Users/me/.claude-switch/profiles/${id}`,
  signedIn: true,
  status: "Signed in",
  ...extra,
});

const work = account("a", "Work");
const personal = account("b", "Personal", { color: "green" });
const expired = account("c", "Expired", { signedIn: false, status: "Sign-in required" });

const latest: BridgeConversation = {
  sessionId: "5b1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d10",
  accountId: work.id,
  modifiedAt: new Date(Date.now() - 120_000).toISOString(),
  sizeBytes: 48_000,
};
const older: BridgeConversation = {
  sessionId: "9c1f8a5e-3a0c-4c55-9a43-0f3f2b6a9d11",
  accountId: null,
  modifiedAt: new Date(Date.now() - 7_200_000).toISOString(),
  sizeBytes: 2_000,
};

interface Log {
  picks: { title: string; labels: string[] }[];
  details: (string | undefined)[][];
  configDirs: (string | undefined)[];
  opened: (string | undefined)[];
  /** The account each close kept: tabs not using it were closed. */
  closedFor: string[];
  messages: string[];
  handedOver: unknown[][];
  shown: (string | undefined)[];
}

/**
 * A fake editor that answers each quick pick with the item whose label
 * starts with the next entry in `answers`.
 */
function setup({
  answers,
  accounts = [work, personal, expired],
  conversations = [latest, older],
  inUse = { dir: work.configDir, source: "window" },
  otherTabs = [work.configDir],
  handOverError,
  messageAction,
  claudeInstalled = true,
}: {
  answers: string[];
  accounts?: BridgeAccount[];
  conversations?: BridgeConversation[];
  inUse?: InUse;
  /** Claude tabs in the window still on another account. */
  otherTabs?: TabAccount[];
  handOverError?: BridgeError;
  messageAction?: string;
  claudeInstalled?: boolean;
}) {
  const log: Log = {
    picks: [],
    details: [],
    configDirs: [],
    opened: [],
    closedFor: [],
    messages: [],
    handedOver: [],
    shown: [],
  };
  const queue = [...answers];
  const host: SwitcherHost = {
    pick: <T>(items: PickItem<T>[], title: string) => {
      log.picks.push({ title, labels: items.filter((i) => !i.separator).map((i) => i.label) });
      log.details.push(items.filter((i) => !i.separator).map((i) => i.detail));
      const want = queue.shift();
      const item = want ? items.find((i) => !i.separator && i.label.startsWith(want)) : undefined;
      return Promise.resolve(item?.value);
    },
    inUse: () => inUse,
    setConfigDir: (dir) => {
      log.configDirs.push(dir);
      return Promise.resolve();
    },
    workspaceDirs: () => ["/Users/me/code/site"],
    claudeTabsNotUsing: (dir) => otherTabs.filter((t) => t !== dir),
    closeClaudeTabsNotUsing: (dir) => {
      log.closedFor.push(dir);
      return Promise.resolve();
    },
    openClaude: (sessionId) => {
      log.opened.push(sessionId);
      return Promise.resolve();
    },
    info: (message) => {
      log.messages.push(message);
      return Promise.resolve(messageAction);
    },
    error: (message) => {
      log.messages.push(`error: ${message}`);
      return Promise.resolve(messageAction);
    },
    withProgress: (_title, task) => task(),
    claudeInstalled: () => claudeInstalled,
  };
  const bridge = {
    ensureRunning: () => Promise.resolve(),
    accounts: () => Promise.resolve(accounts),
    conversations: () => Promise.resolve(conversations),
    handOver: (...args: unknown[]) => {
      log.handedOver.push(args);
      return handOverError ? Promise.reject(handOverError) : Promise.resolve({ copied: true });
    },
    show: (id?: string) => {
      log.shown.push(id);
      return Promise.resolve();
    },
  } as unknown as Bridge;
  return { switcher: new Switcher(bridge, host), log };
}

describe("Switcher", () => {
  it("continues the latest conversation with another account in place of its tabs", async () => {
    const { switcher, log } = setup({ answers: ["Personal", "Continue this conversation"] });
    await switcher.run();

    expect(log.picks[0]).toEqual({
      title: "Claude Code account: Work",
      labels: ["Work", "Personal", "Expired", "Open Claude Switch"],
    });
    expect(log.picks[1]?.labels).toEqual([
      "Continue this conversation with Personal",
      "Continue another conversation…",
      "New conversation with Personal",
      "Only switch",
    ]);
    expect(log.handedOver).toEqual([
      ["/Users/me/code/site", latest.sessionId, work.id, personal.id],
    ]);
    expect(log.configDirs).toEqual([personal.configDir]);
    // Tabs still on Work close first, so the link opens a tab with Personal
    // instead of focusing the conversation's old tab.
    expect(log.closedFor).toEqual([personal.configDir]);
    expect(log.opened).toEqual([latest.sessionId]);
  });

  it("continues an older conversation from ~/.claude", async () => {
    const { switcher, log } = setup({
      answers: ["Personal", "Continue another", "Last active 2 hours ago"],
      otherTabs: [],
    });
    await switcher.run();
    expect(log.handedOver).toEqual([["/Users/me/code/site", older.sessionId, null, personal.id]]);
    expect(log.opened).toEqual([older.sessionId]);
  });

  it("only switches, or starts a new conversation", async () => {
    const only = setup({ answers: ["Personal", "Only switch"], otherTabs: [] });
    await only.switcher.run();
    expect(only.log.configDirs).toEqual([personal.configDir]);
    expect(only.log.opened).toEqual([]);
    expect(only.log.messages).toEqual(["New Claude tabs use Personal."]);

    const fresh = setup({
      answers: ["Personal", "New conversation"],
      conversations: [],
      otherTabs: [],
    });
    await fresh.switcher.run();
    expect(fresh.log.picks[1]?.labels).toEqual(["New conversation with Personal", "Only switch"]);
    expect(fresh.log.configDirs).toEqual([personal.configDir]);
    expect(fresh.log.opened).toEqual([undefined]);
    expect(fresh.log.handedOver).toEqual([]);
  });

  it("never switches to an account that is not signed in", async () => {
    const { switcher, log } = setup({ answers: ["Expired"], messageAction: "Open Claude Switch" });
    await switcher.run();
    expect(log.messages).toEqual(["Expired: Sign-in required. Sign in with Claude Switch first."]);
    expect(log.configDirs).toEqual([]);
    expect(log.shown).toEqual([expired.id]);
  });

  it("leaves everything as it was when the copy fails", async () => {
    const { switcher, log } = setup({
      answers: ["Personal", "Continue this conversation"],
      handOverError: new BridgeError("authRequired", "This account needs to sign in."),
    });
    await switcher.run();
    expect(log.messages).toEqual(["error: This account needs to sign in."]);
    expect(log.configDirs).toEqual([]);
    expect(log.closedFor).toEqual([]);
    expect(log.opened).toEqual([]);
  });

  it("returns to per-window accounts", async () => {
    const { switcher, log } = setup({
      answers: ["Per window"],
      inUse: { dir: personal.configDir, source: "settings" },
    });
    await switcher.run();
    expect(log.picks[0]?.title).toBe("Claude Code account: Personal");
    expect(log.configDirs).toEqual([undefined]);
  });

  it("needs the Claude Code extension, which owns the setting", async () => {
    const { switcher, log } = setup({ answers: [], claudeInstalled: false });
    await switcher.run();
    expect(log.picks).toEqual([]);
    expect(log.messages[0]).toMatch(/^error: Install Claude Code's extension first/);
  });

  it("does nothing for the account already in use", async () => {
    const { switcher, log } = setup({ answers: ["Work"], otherTabs: [] });
    await switcher.run();
    expect(log.messages).toEqual(["Claude Code already uses Work here."]);
    expect(log.configDirs).toEqual([]);
  });

  it("offers to close tabs that still run with the previous account", async () => {
    const declined = setup({ answers: ["Personal", "Only switch"] });
    await declined.switcher.run();
    expect(declined.log.configDirs).toEqual([personal.configDir]);
    expect(declined.log.messages).toEqual([
      "New Claude tabs use Personal. A Claude tab in this window still uses Work. It keeps running with Work until closed, so /usage there and this window's usage meter show Work's limits, not Personal's.",
    ]);
    expect(declined.log.closedFor).toEqual([]);

    const accepted = setup({
      answers: ["Personal", "New conversation"],
      otherTabs: [work.configDir, work.configDir],
      messageAction: "Close Them",
    });
    await accepted.switcher.run();
    expect(accepted.log.opened).toEqual([undefined]);
    expect(accepted.log.messages[0]).toMatch(/^2 Claude tabs in this window still use Work\./);
    expect(accepted.log.closedFor).toEqual([personal.configDir]);
  });

  it("explains what continuing closes", async () => {
    const two = setup({ answers: ["Personal"], otherTabs: [work.configDir, null] });
    await two.switcher.run();
    expect(two.log.details[1]?.[0]).toBe(
      "Closes the 2 Claude tabs here that use another account, then reopens the conversation with Personal, with its full history, in a new tab",
    );
    const one = setup({ answers: ["Personal"] });
    await one.switcher.run();
    expect(one.log.details[1]?.[0]).toBe(
      "Closes the Claude tab here that uses Work, then reopens the conversation with Personal, with its full history, in a new tab",
    );
    const none = setup({ answers: ["Personal"], otherTabs: [] });
    await none.switcher.run();
    expect(none.log.details[1]?.[0]).toBe(
      "Reopens the conversation with Personal, with its full history, in a new tab",
    );
  });

  it("cleans up old tabs when the account in use is chosen again", async () => {
    const { switcher, log } = setup({
      answers: ["Personal"],
      inUse: { dir: personal.configDir, source: "settings" },
      otherTabs: [work.configDir],
      messageAction: "Close Them",
    });
    await switcher.run();
    expect(log.configDirs).toEqual([]);
    expect(log.messages[0]).toMatch(
      /^Claude Code uses Personal here\. A Claude tab in this window still uses Work\./,
    );
    expect(log.closedFor).toEqual([personal.configDir]);
  });
});

describe("messages about other tabs", () => {
  const accounts = [work, personal];
  it("names the account the tabs use", () => {
    expect(tabsAccountName([work.configDir, work.configDir], accounts)).toBe("Work");
    expect(tabsAccountName([null], accounts)).toBe("Claude Code's default account");
    expect(tabsAccountName([work.configDir, personal.configDir], accounts)).toBe("another account");
    expect(tabsAccountName([undefined], accounts)).toBe("another account");
    expect(tabsAccountName(["/somewhere/else"], accounts)).toBe("another account");
  });

  it("explains why the tabs matter", () => {
    expect(otherTabsMessage(3, "Work", "Personal")).toBe(
      "3 Claude tabs in this window still use Work. They keep running with Work until closed, so /usage there and this window's usage meter show Work's limits, not Personal's.",
    );
  });

  it("describes the account in use", () => {
    const home = process.env.HOME ?? "/";
    const removed = `${home}/.claude-switch/profiles/0b7d4c1e-9a55-4f0e-8a51-2d3c4b5a6f70`;
    const used = { dir: removed, source: "settings" } as const;
    expect(describeInUse(used, undefined, accounts)).toBe("an account removed from Claude Switch");
    // Without Claude Switch's list, it cannot tell.
    expect(describeInUse(used, undefined)).toBe("a folder that is not a Claude Switch account");
    expect(describeInUse({ dir: "/x", source: "settings" }, work, accounts)).toBe("Work");
    expect(describeInUse({ dir: undefined, source: "default" }, undefined, accounts)).toBe(
      "Claude Code's default account",
    );
  });
});
