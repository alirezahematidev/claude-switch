/**
 * The account switcher behind the title-bar button and the status bar item.
 * Editor APIs come in through `SwitcherHost` so the flow can be tested
 * without VS Code.
 *
 * A Claude tab keeps the account it started with until it is closed, and the
 * Claude Code extension shows one usage meter per window, fed by every Claude
 * tab in it. So after a switch, tabs still running with another account are
 * closed (when continuing a conversation, whose old tab would otherwise be
 * reused) or offered to be closed.
 *
 * Claude's sidebar works the same way, but it cannot be closed, and the
 * Claude Code extension shows the new account's email there while its
 * conversation keeps running with the old one. Only a window reload restarts
 * it, so its conversation is copied to the new account first and reopens
 * there with its full history.
 */
import * as path from "node:path";

import {
  accountFor,
  formatAgo,
  isClaudeSwitchProfile,
  mergeConversations,
  type InUse,
} from "./accounts";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeConversation } from "./bindings/BridgeConversation";
import type { BridgeOpenConversation } from "./bindings/BridgeOpenConversation";
import { BridgeError, type Bridge } from "./bridge";

type Conversation = BridgeConversation & { directory: string };

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  /** An account color (`blue`, …) or a codicon name. */
  icon?: { color: string } | { codicon: string };
  separator?: boolean;
  value?: T;
}

/**
 * The folder a Claude tab started with: a path, `null` for Claude Code's
 * default (`~/.claude`), or `undefined` when not known.
 */
export type TabAccount = string | null | undefined;

export interface SwitcherHost {
  pick<T>(items: PickItem<T>[], title: string, placeholder: string): Promise<T | undefined>;
  inUse(): InUse;
  /** Writes `CLAUDE_CONFIG_DIR` in the Claude Code extension's setting. */
  setConfigDir(dir: string | undefined): Promise<void>;
  /** Local workspace folders, where the Claude Code extension starts Claude. */
  workspaceDirs(): string[];
  /** Claude tabs in this window that did not start with `dir`. */
  claudeTabsNotUsing(dir: string): TabAccount[];
  /** Closes the tabs `claudeTabsNotUsing(dir)` lists. */
  closeClaudeTabsNotUsing(dir: string): Promise<void>;
  /** Opens the Claude Code extension's link in this window. */
  openClaude(sessionId?: string): Promise<void>;
  /** Reloads this window, which restarts every Claude tab and the sidebar. */
  reloadWindow(): Promise<void>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** The Claude Code extension is installed here (it owns the setting). */
  claudeInstalled(): boolean;
}

type Choice =
  | { kind: "account"; account: BridgeAccount }
  | { kind: "perWindow" }
  | { kind: "openApp" };

type Next =
  | { kind: "continue"; conversation: Conversation }
  | { kind: "chooseConversation" }
  | { kind: "new" }
  | { kind: "switch" };

const OPEN_APP = "Open Claude Switch";
export const CLOSE_TABS = "Close Them";
export const RELOAD = "Reload Window";
/** How long closed tabs' processes get to exit. */
const SETTLE_MS = 3000;
const SETTLE_STEP_MS = 200;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Conversations open in this window's Claude tabs and sidebar. The Claude
 * Code extension starts their processes from the window's extension host,
 * which runs this extension too. Empty when Claude Switch cannot tell (for
 * example, an older version).
 */
export function openInWindow(bridge: Bridge): Promise<BridgeOpenConversation[]> {
  return bridge.openConversations(process.pid).catch(() => []);
}

/**
 * The open conversations that run with another account than `accountId`
 * (`null` for Claude Code's default; `undefined` matches none).
 */
export function openNotUsing(
  open: readonly BridgeOpenConversation[],
  accountId: string | null | undefined,
): BridgeOpenConversation[] {
  return open.filter((c) => c.accountId !== accountId);
}

/** The folders open conversations run with, as `tabsAccountName` takes them. */
export function openAccounts(
  open: readonly BridgeOpenConversation[],
  accounts: readonly BridgeAccount[],
): TabAccount[] {
  return open.map((c) =>
    c.accountId === null ? null : accounts.find((a) => a.id === c.accountId)?.configDir,
  );
}

/**
 * True when some of `open` (the conversations on another account) is not in
 * one of the `tabs` that could be closed: it is in Claude's sidebar.
 */
export function inSidebar(open: readonly unknown[], tabs: readonly unknown[]): boolean {
  return open.length > tabs.length;
}

/**
 * How the account in use reads in titles and tooltips. `accounts` is
 * `undefined` when Claude Switch could not be asked.
 */
export function describeInUse(
  inUse: InUse,
  current: BridgeAccount | undefined,
  accounts?: readonly BridgeAccount[],
): string {
  if (current) return current.name;
  if (inUse.source === "default") return "Claude Code's default account";
  if (accounts && inUse.dir && isClaudeSwitchProfile(inUse.dir)) {
    return "an account removed from Claude Switch";
  }
  return "a folder that is not a Claude Switch account";
}

/** One name for the account(s) a set of tabs uses, for messages. */
export function tabsAccountName(
  tabs: readonly TabAccount[],
  accounts: readonly BridgeAccount[],
): string {
  const names = new Set(
    tabs.map((dir) => {
      if (dir === null) return "Claude Code's default account";
      return dir === undefined ? undefined : accountFor(accounts, dir)?.name;
    }),
  );
  const [only] = names;
  return names.size === 1 && only !== undefined ? only : "another account";
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** "2 Claude tabs here still use Work…" */
export function otherTabsMessage(count: number, name: string, target: string): string {
  const tabs = count === 1 ? "A Claude tab" : `${count} Claude tabs`;
  return (
    `${tabs} in this window still ${plural(count, "uses", "use")} ${name}. ` +
    `${plural(count, "It keeps", "They keep")} running with ${name} until closed, so /usage there ` +
    `and this window's usage meter show ${name}'s limits, not ${target}'s.`
  );
}

/** "The Claude sidebar and a Claude tab here still use Work…" */
export function sidebarMessage(tabs: number, name: string, target: string): string {
  const where =
    tabs === 0
      ? "The Claude sidebar"
      : `The Claude sidebar and ${tabs === 1 ? "a Claude tab" : `${tabs} Claude tabs`}`;
  const count = tabs + 1;
  return (
    `${where} in this window still ${plural(count, "uses", "use")} ${name}, even where it shows ${target}'s email. ` +
    `${plural(count, "It keeps", "They keep")} running with ${name}, so /usage there and this window's ` +
    `usage meter show ${name}'s limits. Reloading the window restarts ${plural(count, "it", "them")} with ${target}, ` +
    `with ${plural(count, "its", "their")} full history.`
  );
}

export class Switcher {
  constructor(
    private readonly bridge: Bridge,
    private readonly host: SwitcherHost,
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {}

  /** Shows a Claude Switch error, offering to open the app where it helps. */
  private async fail(err: unknown, accountId?: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const kind = err instanceof BridgeError ? err.kind : "";
    const helps = kind === "authRequired" || kind === "notRunning" || kind === "protocol";
    const action = await this.host.error(message, ...(helps ? [OPEN_APP] : []));
    if (action === OPEN_APP) await this.openApp(accountId);
  }

  async openApp(accountId?: string): Promise<void> {
    try {
      await this.bridge.ensureRunning();
      await this.bridge.show(accountId);
    } catch (err) {
      await this.host.error(err instanceof Error ? err.message : String(err));
    }
  }

  async run(): Promise<void> {
    if (!this.host.claudeInstalled()) {
      await this.host.error(
        "Install Claude Code's extension first: Claude Switch chooses its account through that extension's settings.",
      );
      return;
    }
    let accounts: BridgeAccount[];
    try {
      accounts = await this.host.withProgress("Connecting to Claude Switch…", async () => {
        await this.bridge.ensureRunning();
        return this.bridge.accounts();
      });
    } catch (err) {
      await this.fail(err);
      return;
    }
    if (accounts.length === 0) {
      const action = await this.host.info("Add an account in Claude Switch first.", OPEN_APP);
      if (action === OPEN_APP) await this.openApp();
      return;
    }

    const inUse = this.host.inUse();
    const current = accountFor(accounts, inUse.dir);
    const choice = await this.host.pick<Choice>(
      [
        ...accounts.map((account) => ({
          label: account.name,
          description: [
            account.detail,
            account.id === current?.id ? "in use" : account.signedIn ? undefined : account.status,
          ]
            .filter(Boolean)
            .join(" · "),
          icon: { color: account.color },
          value: { kind: "account" as const, account },
        })),
        { label: "", separator: true },
        ...(inUse.source === "settings"
          ? [
              {
                label: "Per window",
                description: "each window uses the account it was opened with",
                icon: { codicon: "window" },
                value: { kind: "perWindow" as const },
              },
            ]
          : []),
        {
          label: OPEN_APP,
          icon: { codicon: "link-external" },
          value: { kind: "openApp" as const },
        },
      ],
      `Claude Code account: ${describeInUse(inUse, current, accounts)}`,
      "Choose the account for Claude Code in this editor",
    );
    if (!choice) return;
    if (choice.kind === "openApp") {
      await this.openApp();
      return;
    }
    if (choice.kind === "perWindow") {
      await this.host.setConfigDir(undefined);
      await this.host.info(
        "New Claude tabs use the account their window was opened with. Claude tabs that are already open keep theirs.",
      );
      return;
    }

    const target = choice.account;
    if (!target.signedIn) {
      const action = await this.host.info(
        `${target.name}: ${target.status}. Sign in with Claude Switch first.`,
        OPEN_APP,
      );
      if (action === OPEN_APP) await this.openApp(target.id);
      return;
    }
    if (target.id === current?.id) {
      const others = this.host.claudeTabsNotUsing(target.configDir);
      const open = openNotUsing(await openInWindow(this.bridge), target.id);
      const prefix = `Claude Code uses ${target.name} here. `;
      if (!(await this.offerToMove(others, open, target, accounts, prefix))) {
        await this.host.info(`Claude Code already uses ${target.name} here.`);
      }
      return;
    }
    await this.switchTo(target, accounts);
  }

  private async conversations(): Promise<Conversation[]> {
    const lists = await Promise.all(
      this.host.workspaceDirs().map(async (directory) => ({
        directory,
        conversations: await this.bridge.conversations(directory).catch(() => []),
      })),
    );
    return mergeConversations(lists);
  }

  /**
   * Asks to close Claude tabs that still use another account, or to reload
   * the window when Claude's sidebar does too. False when nothing does.
   */
  private async offerToMove(
    others: readonly TabAccount[],
    open: readonly BridgeOpenConversation[],
    target: BridgeAccount,
    accounts: readonly BridgeAccount[],
    prefix = "",
  ): Promise<boolean> {
    if (inSidebar(open, others)) {
      const name = tabsAccountName(openAccounts(open, accounts), accounts);
      const action = await this.host.info(
        `${prefix}${sidebarMessage(others.length, name, target.name)}`,
        RELOAD,
      );
      if (action === RELOAD) await this.reloadWith(target, open);
      return true;
    }
    if (others.length === 0) return false;
    const name = tabsAccountName(others, accounts);
    const action = await this.host.info(
      `${prefix}${otherTabsMessage(others.length, name, target.name)}`,
      CLOSE_TABS,
    );
    if (action === CLOSE_TABS) await this.host.closeClaudeTabsNotUsing(target.configDir);
    return true;
  }

  /**
   * Copies conversations to `target` so it can resume them. One nothing was
   * written to yet has nothing to copy.
   */
  private async copyTo(
    target: BridgeAccount,
    conversations: readonly BridgeOpenConversation[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const c of conversations) {
      if (c.accountId === target.id || seen.has(c.sessionId)) continue;
      seen.add(c.sessionId);
      try {
        await this.bridge.handOver(c.directory, c.sessionId, c.accountId, target.id);
      } catch (err) {
        if (!(err instanceof BridgeError && err.kind === "notFound")) throw err;
      }
    }
  }

  /**
   * Copies the open conversations to `target`, which the setting already
   * names, then reloads the window: its Claude tabs and sidebar restart with
   * `target` and reopen their conversations.
   */
  private async reloadWith(
    target: BridgeAccount,
    open: readonly BridgeOpenConversation[],
  ): Promise<void> {
    try {
      await this.host.withProgress(`Copying open conversations to ${target.name}…`, () =>
        this.copyTo(target, open),
      );
    } catch (err) {
      await this.fail(err, target.id);
      return;
    }
    await this.host.reloadWindow();
  }

  /**
   * The conversations still open here with another account than `target`,
   * once the processes of the `closed` tabs had time to exit.
   */
  private async leftOpen(
    target: BridgeAccount,
    before: readonly BridgeOpenConversation[],
    closed: number,
  ): Promise<BridgeOpenConversation[]> {
    const expected = Math.max(0, before.length - closed);
    for (let waited = 0; ; waited += SETTLE_STEP_MS) {
      const left = openNotUsing(await openInWindow(this.bridge), target.id);
      if (left.length <= expected || waited >= SETTLE_MS) return left;
      await this.sleep(SETTLE_STEP_MS);
    }
  }

  private async switchTo(target: BridgeAccount, accounts: readonly BridgeAccount[]): Promise<void> {
    const conversations = await this.conversations();
    const latest = conversations[0];
    const others = this.host.claudeTabsNotUsing(target.configDir);
    const othersName = tabsAccountName(others, accounts);
    const open = openNotUsing(await openInWindow(this.bridge), target.id);
    const reopen = `the conversation with ${target.name}, with its full history, in a new tab`;
    const continueDetail = (c: Conversation) => {
      if (inSidebar(open, others) && open.some((o) => o.sessionId === c.sessionId)) {
        return `Reloads this window, so the conversation continues in place with ${target.name}, with its full history`;
      }
      return others.length > 0
        ? `Closes the ${plural(others.length, "Claude tab", `${others.length} Claude tabs`)} here that ${plural(others.length, "uses", "use")} ${othersName}, then reopens ${reopen}`
        : `Reopens ${reopen}`;
    };
    const next = await this.host.pick<Next>(
      [
        ...(latest
          ? [
              {
                label: `Continue this conversation with ${target.name}`,
                description: formatAgo(latest.modifiedAt),
                detail: continueDetail(latest),
                icon: { codicon: "debug-continue" },
                value: { kind: "continue" as const, conversation: latest },
              },
            ]
          : []),
        ...(conversations.length > 1
          ? [
              {
                label: "Continue another conversation…",
                icon: { codicon: "history" },
                value: { kind: "chooseConversation" as const },
              },
            ]
          : []),
        {
          label: `New conversation with ${target.name}`,
          detail: "Opens a new Claude tab",
          icon: { codicon: "add" },
          value: { kind: "new" as const },
        },
        {
          label: "Only switch",
          detail: `Claude tabs opened from now on use ${target.name}, in every window`,
          icon: { codicon: "check" },
          value: { kind: "switch" as const },
        },
      ],
      `Switch to ${target.name}`,
      "Claude tabs keep the account they started with until they are closed",
    );
    if (!next) return;

    switch (next.kind) {
      case "continue":
        await this.continueWith(target, next.conversation, accounts, others, open);
        return;
      case "chooseConversation": {
        const conversation = await this.host.pick<Conversation>(
          conversations.map((c) => ({
            label: `Last active ${formatAgo(c.modifiedAt)}`,
            description: [formatSize(c.sizeBytes), path.basename(c.directory)].join(" · "),
            icon: { codicon: "comment-discussion" },
            value: c,
          })),
          `Continue with ${target.name}`,
          "Choose a conversation from this workspace",
        );
        if (conversation) await this.continueWith(target, conversation, accounts, others, open);
        return;
      }
      case "new":
        await this.host.setConfigDir(target.configDir);
        await this.host.openClaude();
        await this.offerToMove(others, open, target, accounts);
        return;
      case "switch": {
        await this.host.setConfigDir(target.configDir);
        const prefix = `New Claude tabs use ${target.name}. `;
        if (!(await this.offerToMove(others, open, target, accounts, prefix))) {
          await this.host.info(`New Claude tabs use ${target.name}.`);
        }
        return;
      }
    }
  }

  /**
   * Copies the conversation to `target` and switches. When it is open in
   * Claude's sidebar with another account, the window reloads so it
   * continues in place. Otherwise the tabs still on other accounts close (an
   * open tab with this conversation would otherwise be focused instead, with
   * its old account), and it reopens in a new tab.
   */
  private async continueWith(
    target: BridgeAccount,
    conversation: Conversation,
    accounts: readonly BridgeAccount[],
    others: readonly TabAccount[],
    open: readonly BridgeOpenConversation[],
  ): Promise<void> {
    const inPlace =
      inSidebar(open, others) && open.some((c) => c.sessionId === conversation.sessionId);
    try {
      if (conversation.accountId !== target.id || inPlace) {
        await this.host.withProgress(`Copying the conversation to ${target.name}…`, async () => {
          if (conversation.accountId !== target.id) {
            await this.bridge.handOver(
              conversation.directory,
              conversation.sessionId,
              conversation.accountId,
              target.id,
            );
          }
          // Everything open here restarts with the reload.
          if (inPlace) {
            await this.copyTo(
              target,
              open.filter((c) => c.sessionId !== conversation.sessionId),
            );
          }
        });
      }
    } catch (err) {
      await this.fail(err, target.id);
      return;
    }
    await this.host.setConfigDir(target.configDir);
    if (inPlace) {
      await this.host.reloadWindow();
      return;
    }
    await this.host.closeClaudeTabsNotUsing(target.configDir);
    // What still runs with another account is not in a tab.
    const left = await this.leftOpen(target, open, others.length);
    const leftHere = left.some((c) => c.sessionId === conversation.sessionId);
    // The link would only show the sidebar, still on the old account.
    if (!leftHere) await this.host.openClaude(conversation.sessionId);
    if (left.length === 0) return;
    const name = tabsAccountName(openAccounts(left, accounts), accounts);
    const action = await this.host.info(
      leftHere
        ? `This conversation is open in the Claude sidebar, which keeps running it with ${name}. Reload the window to continue it with ${target.name}, with its full history.`
        : sidebarMessage(0, name, target.name),
      RELOAD,
    );
    if (action === RELOAD) await this.reloadWith(target, left);
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
