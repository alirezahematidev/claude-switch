import { describe, expect, it } from "vitest";

import type { InUse } from "../src/accounts";
import type { BridgeAccount } from "../src/bindings/BridgeAccount";
import type { BridgeConversation } from "../src/bindings/BridgeConversation";
import { BridgeError, type Bridge } from "../src/bridge";
import { Switcher, type PickItem, type SwitcherHost } from "../src/switcher";

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
  configDirs: (string | undefined)[];
  opened: (string | undefined)[];
  closedTab: number;
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
  claudeTab = true,
  handOverError,
  messageAction,
  claudeInstalled = true,
}: {
  answers: string[];
  accounts?: BridgeAccount[];
  conversations?: BridgeConversation[];
  inUse?: InUse;
  claudeTab?: boolean;
  handOverError?: BridgeError;
  messageAction?: string;
  claudeInstalled?: boolean;
}) {
  const log: Log = {
    picks: [],
    configDirs: [],
    opened: [],
    closedTab: 0,
    messages: [],
    handedOver: [],
    shown: [],
  };
  const queue = [...answers];
  const host: SwitcherHost = {
    pick: <T>(items: PickItem<T>[], title: string) => {
      log.picks.push({ title, labels: items.filter((i) => !i.separator).map((i) => i.label) });
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
    claudeTabActive: () => claudeTab,
    closeActiveClaudeTab: () => {
      log.closedTab++;
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
  it("continues the latest conversation with another account in place of this tab", async () => {
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
    expect(log.closedTab).toBe(1);
    expect(log.opened).toEqual([latest.sessionId]);
  });

  it("continues an older conversation from ~/.claude without closing tabs", async () => {
    const { switcher, log } = setup({
      answers: ["Personal", "Continue another", "Last active 2 hours ago"],
    });
    await switcher.run();
    expect(log.handedOver).toEqual([["/Users/me/code/site", older.sessionId, null, personal.id]]);
    expect(log.closedTab).toBe(0);
    expect(log.opened).toEqual([older.sessionId]);
  });

  it("only switches, or starts a new conversation", async () => {
    const only = setup({ answers: ["Personal", "Only switch"] });
    await only.switcher.run();
    expect(only.log.configDirs).toEqual([personal.configDir]);
    expect(only.log.opened).toEqual([]);
    expect(only.log.messages).toEqual(["New Claude tabs use Personal."]);

    const fresh = setup({ answers: ["Personal", "New conversation"], conversations: [] });
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
    expect(log.closedTab).toBe(0);
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
    const { switcher, log } = setup({ answers: ["Work"] });
    await switcher.run();
    expect(log.messages).toEqual(["Claude Code already uses Work here."]);
    expect(log.configDirs).toEqual([]);
  });
});
