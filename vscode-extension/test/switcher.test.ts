import { describe, expect, it } from "vitest";

import type { InUse } from "../src/accounts";
import type { BridgeAccount } from "../src/bindings/BridgeAccount";
import type { BridgeConversation } from "../src/bindings/BridgeConversation";
import type { BridgeOpenConversation } from "../src/bindings/BridgeOpenConversation";
import { HelperError } from "../src/helper";
import {
  describeInUse,
  stillUsingMessage,
  Switcher,
  tabsAccountName,
  type PickItem,
  type SwitcherBackend,
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

const site = "/Users/me/code/site";
const openOn = (
  conversation: BridgeConversation,
  accountId = conversation.accountId,
): BridgeOpenConversation => ({ sessionId: conversation.sessionId, accountId, directory: site });

interface Log {
  picks: { title: string; labels: string[] }[];
  configDirs: (string | undefined)[];
  opened: (string | undefined)[];
  /** The account each close kept: tabs not using it were closed. */
  closedFor: string[];
  messages: string[];
  notices: string[];
  handedOver: unknown[][];
  signedIn: string[];
  added: number;
  reloads: number;
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
  otherTabs = [],
  open = [],
  handOverError,
  messageAction,
  signInSucceeds = true,
  terminals = false,
  claudeInstalled = true,
}: {
  answers: string[];
  accounts?: BridgeAccount[];
  conversations?: BridgeConversation[];
  inUse?: InUse;
  /** Claude tabs in the window still on another account. */
  otherTabs?: TabAccount[];
  /**
   * Conversations open in the window's Claude processes, as Claude Switch
   * reports them on each call (the last answer repeats).
   */
  open?: BridgeOpenConversation[][];
  handOverError?: HelperError;
  messageAction?: string;
  signInSucceeds?: boolean;
  /** Claude Switch terminals are open. */
  terminals?: boolean;
  claudeInstalled?: boolean;
}) {
  const log: Log = {
    picks: [],
    configDirs: [],
    opened: [],
    closedFor: [],
    messages: [],
    notices: [],
    handedOver: [],
    signedIn: [],
    added: 0,
    reloads: 0,
  };
  let list = accounts;
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
    workspaceDirs: () => [site],
    claudeTabsNotUsing: (dir) => otherTabs.filter((t) => t !== dir),
    closeClaudeTabsNotUsing: (dir) => {
      log.closedFor.push(dir);
      return Promise.resolve();
    },
    openClaude: (sessionId) => {
      log.opened.push(sessionId);
      return Promise.resolve();
    },
    reloadWindow: () => {
      log.reloads++;
      return Promise.resolve();
    },
    sessionTerminalsOpen: () => terminals,
    notify: (message) => log.notices.push(message),
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
    addAccount: () => {
      log.added++;
      return Promise.resolve();
    },
    signIn: (id) => {
      log.signedIn.push(id);
      if (signInSucceeds) {
        list = list.map((a) => (a.id === id ? { ...a, signedIn: true, status: "Signed in" } : a));
      }
      return Promise.resolve(signInSucceeds);
    },
  };
  const backend: SwitcherBackend = {
    ensureRunning: () => Promise.resolve(),
    accounts: () => Promise.resolve(list),
    conversations: () => Promise.resolve(conversations),
    openConversations: () => Promise.resolve((open.length > 1 ? open.shift() : open[0]) ?? []),
    handOver: (...args: unknown[]) => {
      log.handedOver.push(args);
      return handOverError ? Promise.reject(handOverError) : Promise.resolve({ copied: true });
    },
  };
  return { switcher: new Switcher(backend, host, () => Promise.resolve()), log };
}

describe("Switcher", () => {
  it("switches in one step when nothing is open here", async () => {
    const { switcher, log } = setup({ answers: ["Personal"] });
    await switcher.run();
    expect(log.picks).toEqual([
      {
        title: "Switch Claude Code account",
        labels: ["Work", "Personal", "Expired", "Add Account…"],
      },
    ]);
    expect(log.configDirs).toEqual([personal.configDir]);
    expect(log.messages).toEqual([]);
    expect(log.notices).toEqual(["Claude Code: Personal"]);
  });

  it("moves the conversation of a tab on the old account along", async () => {
    const { switcher, log } = setup({
      answers: ["Personal"],
      otherTabs: [work.configDir],
      // Before the switch, while the closed tab's process exits, then gone.
      open: [[openOn(latest)], [openOn(latest)], []],
    });
    await switcher.run();
    expect(log.handedOver).toEqual([[site, latest.sessionId, work.id, personal.id]]);
    expect(log.configDirs).toEqual([personal.configDir]);
    expect(log.closedFor).toEqual([personal.configDir]);
    expect(log.opened).toEqual([latest.sessionId]);
    expect(log.reloads).toBe(0);
    expect(log.messages).toEqual([]);
  });

  it("reloads the window for the Claude sidebar", async () => {
    const quiet = setup({ answers: ["Personal"], open: [[openOn(latest)]] });
    await quiet.switcher.run();
    expect(quiet.log.handedOver).toEqual([[site, latest.sessionId, work.id, personal.id]]);
    expect(quiet.log.configDirs).toEqual([personal.configDir]);
    expect(quiet.log.reloads).toBe(1);
    expect(quiet.log.opened).toEqual([]);
    expect(quiet.log.messages).toEqual([]);

    // A reload would end Claude Switch terminals: ask first.
    const asked = setup({ answers: ["Personal"], open: [[openOn(latest)]], terminals: true });
    await asked.switcher.run();
    expect(asked.log.messages).toEqual([
      "Reload the window to switch the Claude sidebar to Personal? Claude Switch terminals will close.",
    ]);
    expect(asked.log.reloads).toBe(0);
    expect(asked.log.configDirs).toEqual([personal.configDir]);

    const accepted = setup({
      answers: ["Personal"],
      open: [[openOn(latest)]],
      terminals: true,
      messageAction: "Reload Window",
    });
    await accepted.switcher.run();
    expect(accepted.log.reloads).toBe(1);
  });

  it("reopens a closed tab's conversation and reloads for the sidebar", async () => {
    const tab = openOn(latest);
    const sidebar = openOn(older, work.id);
    const { switcher, log } = setup({
      answers: ["Personal"],
      otherTabs: [work.configDir],
      open: [[tab, sidebar], [sidebar]],
    });
    await switcher.run();
    expect(log.handedOver).toHaveLength(2);
    expect(log.opened).toEqual([latest.sessionId]);
    expect(log.reloads).toBe(1);
  });

  it("signs an account in first, then switches to it", async () => {
    const signed = setup({ answers: ["Expired"] });
    await signed.switcher.run();
    expect(signed.log.signedIn).toEqual([expired.id]);
    expect(signed.log.configDirs).toEqual([expired.configDir]);

    const cancelled = setup({ answers: ["Expired"], signInSucceeds: false });
    await cancelled.switcher.run();
    expect(cancelled.log.configDirs).toEqual([]);
  });

  it("says so when the account is already in use", async () => {
    const { switcher, log } = setup({
      answers: ["Personal"],
      inUse: { dir: personal.configDir, source: "settings" },
    });
    await switcher.run();
    expect(log.configDirs).toEqual([]);
    expect(log.notices).toEqual(["Claude Code already uses Personal"]);
  });

  it("moves what still uses the old account when the account in use is chosen", async () => {
    const { switcher, log } = setup({
      answers: [],
      inUse: { dir: personal.configDir, source: "settings" },
      otherTabs: [work.configDir],
      open: [[openOn(latest)], []],
    });
    await switcher.switchTo(personal.id);
    expect(log.picks).toEqual([]);
    expect(log.configDirs).toEqual([]);
    expect(log.closedFor).toEqual([personal.configDir]);
    expect(log.opened).toEqual([latest.sessionId]);
  });

  it("leaves everything as it was when the copy fails", async () => {
    const { switcher, log } = setup({
      answers: ["Personal"],
      otherTabs: [work.configDir],
      open: [[openOn(latest)]],
      handOverError: new HelperError("conflict", "Personal has a different copy."),
    });
    await switcher.run();
    expect(log.messages).toEqual(["error: Personal has a different copy."]);
    expect(log.configDirs).toEqual([]);
    expect(log.closedFor).toEqual([]);
    expect(log.reloads).toBe(0);

    const signedOut = setup({
      answers: ["Personal"],
      open: [[openOn(latest)]],
      handOverError: new HelperError("authRequired", "Personal needs to sign in."),
      messageAction: "Sign In",
    });
    await signedOut.switcher.run();
    expect(signedOut.log.signedIn).toEqual([personal.id]);
  });

  it("offers to add an account", async () => {
    const none = setup({ answers: [], accounts: [], messageAction: "Add Account" });
    await none.switcher.run();
    expect(none.log.messages).toEqual(["Add a Claude Code account first."]);
    expect(none.log.added).toBe(1);

    const picked = setup({ answers: ["Add Account"] });
    await picked.switcher.run();
    expect(picked.log.added).toBe(1);
    expect(picked.log.configDirs).toEqual([]);
  });

  it("needs the Claude Code extension, which owns the setting", async () => {
    const { switcher, log } = setup({ answers: [], claudeInstalled: false });
    await switcher.run();
    expect(log.picks).toEqual([]);
    expect(log.messages).toEqual(["error: Install Claude Code's VS Code extension first."]);
  });

  it("returns to per-window accounts", async () => {
    const { switcher, log } = setup({ answers: [] });
    await switcher.perWindow();
    expect(log.configDirs).toEqual([undefined]);
    expect(log.notices).toEqual(["Claude Code: each window's own account"]);
  });

  it("continues a chosen conversation in the panel", async () => {
    const panel = setup({ answers: ["Last active 2 hours ago"] });
    const conversation = await panel.switcher.pickConversation();
    expect(conversation?.sessionId).toBe(older.sessionId);
    if (!conversation) return;
    await panel.switcher.continueInPanel(personal.id, conversation);
    expect(panel.log.handedOver).toEqual([[site, older.sessionId, null, personal.id]]);
    expect(panel.log.configDirs).toEqual([personal.configDir]);
    expect(panel.log.closedFor).toEqual([personal.configDir]);
    expect(panel.log.opened).toEqual([older.sessionId]);

    // Open in the sidebar: it continues there after a reload.
    const sidebar = setup({ answers: [], open: [[openOn(latest)]] });
    await sidebar.switcher.continueInPanel(personal.id, { ...latest, directory: site });
    expect(sidebar.log.reloads).toBe(1);
    expect(sidebar.log.opened).toEqual([]);

    const empty = setup({ answers: [], conversations: [] });
    expect(await empty.switcher.pickConversation()).toBeUndefined();
    expect(empty.log.messages).toEqual(["This workspace has no Claude Code conversations yet."]);
  });
});

describe("messages", () => {
  const accounts = [work, personal];
  it("names the account the tabs use", () => {
    expect(tabsAccountName([work.configDir, work.configDir], accounts)).toBe("Work");
    expect(tabsAccountName([null], accounts)).toBe("Claude Code's default account");
    expect(tabsAccountName([work.configDir, personal.configDir], accounts)).toBe("another account");
    expect(tabsAccountName([undefined], accounts)).toBe("another account");
  });

  it("says what still uses the old account, in a few words", () => {
    expect(stillUsingMessage(1, false, "Work")).toBe("A Claude tab still uses Work.");
    expect(stillUsingMessage(2, false, "Work")).toBe("2 Claude tabs still use Work.");
    expect(stillUsingMessage(0, true, "Work")).toBe("The Claude sidebar still uses Work.");
    expect(stillUsingMessage(1, true, "Work")).toBe(
      "The Claude sidebar and a Claude tab still use Work.",
    );
  });

  it("describes the account in use", () => {
    const home = process.env.HOME ?? "/";
    const removed = `${home}/.claude-switch/profiles/0b7d4c1e-9a55-4f0e-8a51-2d3c4b5a6f70`;
    const used = { dir: removed, source: "settings" } as const;
    expect(describeInUse(used, undefined, accounts)).toBe("an account removed from Claude Switch");
    expect(describeInUse(used, undefined)).toBe("a folder that is not a Claude Switch account");
    expect(describeInUse({ dir: "/x", source: "settings" }, work, accounts)).toBe("Work");
    expect(describeInUse({ dir: undefined, source: "default" }, undefined, accounts)).toBe(
      "Claude Code's default account",
    );
  });
});
