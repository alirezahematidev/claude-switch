/**
 * Switching the account Claude Code's extension uses, in one step: pick an
 * account, and the conversations open in this window follow it. Editor APIs
 * come in through `SwitcherHost` so the flow can be tested without VS Code.
 *
 * A Claude tab, and Claude's sidebar, keep the account they started with
 * until they restart. So a switch copies each conversation open here on
 * another account to the new one, closes its tab and reopens it with the new
 * account. The sidebar cannot be closed: the window reloads instead, and it
 * reopens its conversation with the new account.
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
import { HelperError, type Helper } from "./helper";

/** What the switcher asks of Claude Switch's helper. */
export type SwitcherBackend = Pick<
  Helper,
  "ensureRunning" | "accounts" | "conversations" | "openConversations" | "handOver"
>;

export type Conversation = BridgeConversation & { directory: string };

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
  /** Claude Switch terminals are running here (a reload would end them). */
  sessionTerminalsOpen(): boolean;
  /** A short confirmation that goes away by itself. */
  notify(message: string): void;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** The Claude Code extension is installed here (it owns the setting). */
  claudeInstalled(): boolean;
  /** Adds an account (asks for its name). */
  addAccount(): Promise<void>;
  /** Signs an account in; true once it is. */
  signIn(accountId: string): Promise<boolean>;
}

type Choice = { kind: "account"; account: BridgeAccount } | { kind: "add" };

export const SIGN_IN = "Sign In";
export const ADD_ACCOUNT = "Add Account";
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
 * which runs this extension too. Empty when Claude Switch cannot tell.
 */
export function openInWindow(
  backend: Pick<SwitcherBackend, "openConversations">,
): Promise<BridgeOpenConversation[]> {
  return backend.openConversations(process.pid).catch(() => []);
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

/** "2 Claude tabs still use Work." or "The Claude sidebar still uses Work." */
export function stillUsingMessage(tabs: number, sidebar: boolean, name: string): string {
  const parts = [
    ...(sidebar ? ["The Claude sidebar"] : []),
    ...(tabs > 0 ? [tabs === 1 ? "a Claude tab" : `${tabs} Claude tabs`] : []),
  ];
  const where = parts.join(" and ");
  const one = parts.length === 1 && (sidebar || tabs === 1);
  return `${where.charAt(0).toUpperCase()}${where.slice(1)} still ${one ? "uses" : "use"} ${name}.`;
}

export class Switcher {
  constructor(
    private readonly bridge: SwitcherBackend,
    private readonly host: SwitcherHost,
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {}

  /** Shows an error, offering to sign in where that helps. */
  private async fail(err: unknown, accountId?: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const signIn = err instanceof HelperError && err.kind === "authRequired" && accountId;
    const action = await this.host.error(message, ...(signIn ? [SIGN_IN] : []));
    if (action === SIGN_IN && accountId) await this.host.signIn(accountId);
  }

  /**
   * The accounts, once Claude Code's extension and an account are there;
   * `undefined` after saying what is missing.
   */
  private async load(): Promise<BridgeAccount[] | undefined> {
    if (!this.host.claudeInstalled()) {
      await this.host.error("Install Claude Code's VS Code extension first.");
      return undefined;
    }
    let accounts: BridgeAccount[];
    try {
      await this.bridge.ensureRunning();
      accounts = await this.bridge.accounts();
    } catch (err) {
      await this.fail(err);
      return undefined;
    }
    if (accounts.length === 0) {
      const action = await this.host.info("Add a Claude Code account first.", ADD_ACCOUNT);
      if (action === ADD_ACCOUNT) await this.host.addAccount();
      return undefined;
    }
    return accounts;
  }

  /** Picks an account and switches to it. */
  async run(): Promise<void> {
    const accounts = await this.load();
    if (!accounts) return;
    const current = accountFor(accounts, this.host.inUse().dir);
    const choice = await this.host.pick<Choice>(
      [
        ...accounts.map((account) => ({
          label: account.name,
          description: [
            account.detail,
            account.id === current?.id ? "current" : account.signedIn ? undefined : account.status,
          ]
            .filter(Boolean)
            .join(" · "),
          icon: { color: account.color },
          value: { kind: "account" as const, account },
        })),
        { label: "", separator: true },
        { label: "Add Account…", icon: { codicon: "add" }, value: { kind: "add" as const } },
      ],
      "Switch Claude Code account",
      "Claude Code in VS Code uses the account you choose",
    );
    if (!choice) return;
    if (choice.kind === "add") {
      await this.host.addAccount();
      return;
    }
    await this.switchTo(choice.account.id);
  }

  /**
   * Makes Claude Code use `accountId`, moving the conversations open here on
   * another account along with it.
   */
  async switchTo(accountId: string): Promise<void> {
    let accounts = await this.load();
    let target = accounts?.find((a) => a.id === accountId);
    if (!accounts || !target) return;
    if (!target.signedIn) {
      if (!(await this.host.signIn(target.id))) return;
      accounts = await this.bridge.accounts();
      target = accounts.find((a) => a.id === accountId);
      if (!target?.signedIn) return;
    }
    const switching = accountFor(accounts, this.host.inUse().dir)?.id !== target.id;
    const tabs = this.host.claudeTabsNotUsing(target.configDir);
    const open = openNotUsing(await openInWindow(this.bridge), target.id);
    if (!switching && tabs.length === 0 && open.length === 0) {
      this.host.notify(`Claude Code already uses ${target.name}`);
      return;
    }
    try {
      await this.host.withProgress(`Switching to ${target.name}…`, () => this.copyTo(target, open));
    } catch (err) {
      await this.fail(err, target.id);
      return;
    }
    if (switching) await this.host.setConfigDir(target.configDir);
    let left = open;
    if (tabs.length > 0) {
      await this.host.closeClaudeTabsNotUsing(target.configDir);
      left = await this.leftOpen(target, open, tabs.length);
      // The closed tabs' conversations reopen with the new account.
      for (const c of open) {
        if (!left.some((l) => l.sessionId === c.sessionId)) await this.host.openClaude(c.sessionId);
      }
    }
    if (left.length > 0 && (await this.reloadForSidebar(target))) return;
    this.host.notify(`Claude Code: ${target.name}`);
  }

  /**
   * Reloads the window so the Claude sidebar restarts with `target`; asks
   * first when that would end Claude Switch terminals. True if reloading.
   */
  private async reloadForSidebar(target: BridgeAccount): Promise<boolean> {
    if (this.host.sessionTerminalsOpen()) {
      const action = await this.host.info(
        `Reload the window to switch the Claude sidebar to ${target.name}? Claude Switch terminals will close.`,
        RELOAD,
      );
      if (action !== RELOAD) return false;
    }
    await this.host.reloadWindow();
    return true;
  }

  /** Uses each window's own account again (removes the setting's entry). */
  async perWindow(): Promise<void> {
    await this.host.setConfigDir(undefined);
    this.host.notify("Claude Code: each window's own account");
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
        if (!(err instanceof HelperError && err.kind === "notFound")) throw err;
      }
    }
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

  /** Picks one of this workspace's conversations. */
  async pickConversation(): Promise<Conversation | undefined> {
    const conversations = await this.conversations();
    if (conversations.length === 0) {
      await this.host.info("This workspace has no Claude Code conversations yet.");
      return undefined;
    }
    return this.host.pick<Conversation>(
      conversations.map((c) => ({
        label: `Last active ${formatAgo(c.modifiedAt)}`,
        description: [formatSize(c.sizeBytes), path.basename(c.directory)].join(" · "),
        icon: { codicon: "comment-discussion" },
        value: c,
      })),
      "Continue a conversation",
      "Choose a conversation from this workspace",
    );
  }

  /**
   * Continues `conversation` with `accountId` in Claude Code's panel: copies
   * it, switches, and reopens it there.
   */
  async continueInPanel(accountId: string, conversation: Conversation): Promise<void> {
    const accounts = await this.load();
    const target = accounts?.find((a) => a.id === accountId);
    if (!accounts || !target) return;
    if (!target.signedIn && !(await this.host.signIn(target.id))) return;
    const open = openNotUsing(await openInWindow(this.bridge), target.id);
    const inPlace =
      inSidebar(open, this.host.claudeTabsNotUsing(target.configDir)) &&
      open.some((c) => c.sessionId === conversation.sessionId);
    try {
      await this.host.withProgress(`Copying the conversation to ${target.name}…`, async () => {
        await this.copyTo(target, [conversation]);
        if (inPlace) await this.copyTo(target, open);
      });
    } catch (err) {
      await this.fail(err, target.id);
      return;
    }
    await this.host.setConfigDir(target.configDir);
    // Open in the sidebar: it continues there once the window reloads.
    if (inPlace && (await this.reloadForSidebar(target))) return;
    await this.host.closeClaudeTabsNotUsing(target.configDir);
    await this.host.openClaude(conversation.sessionId);
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
