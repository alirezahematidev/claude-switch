/**
 * The account switcher behind the title-bar button and the status bar item.
 * Editor APIs come in through `SwitcherHost` so the flow can be tested
 * without VS Code.
 */
import * as path from "node:path";

import { accountFor, formatAgo, mergeConversations, type InUse } from "./accounts";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeConversation } from "./bindings/BridgeConversation";
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

export interface SwitcherHost {
  pick<T>(items: PickItem<T>[], title: string, placeholder: string): Promise<T | undefined>;
  inUse(): InUse;
  /** Writes `CLAUDE_CONFIG_DIR` in the Claude Code extension's setting. */
  setConfigDir(dir: string | undefined): Promise<void>;
  /** Local workspace folders, where the Claude Code extension starts Claude. */
  workspaceDirs(): string[];
  /** True if the active editor tab is a Claude Code conversation. */
  claudeTabActive(): boolean;
  closeActiveClaudeTab(): Promise<void>;
  /** Opens the Claude Code extension's link in this window. */
  openClaude(sessionId?: string): Promise<void>;
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
  | { kind: "continue"; conversation: Conversation; closeTab: boolean }
  | { kind: "chooseConversation" }
  | { kind: "new" }
  | { kind: "switch" };

const OPEN_APP = "Open Claude Switch";

export function describeInUse(inUse: InUse, current: BridgeAccount | undefined): string {
  if (current) return current.name;
  if (inUse.source === "default") return "Claude Code's default account";
  return "a folder that is not a Claude Switch account";
}

export class Switcher {
  constructor(
    private readonly bridge: Bridge,
    private readonly host: SwitcherHost,
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
      `Claude Code account: ${describeInUse(inUse, current)}`,
      "Choose the account for Claude Code in this editor",
    );
    if (!choice) return;
    if (choice.kind === "openApp") {
      await this.openApp();
      return;
    }
    if (choice.kind === "perWindow") {
      await this.host.setConfigDir(undefined);
      await this.host.info("New Claude tabs use the account their window was opened with.");
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
      await this.host.info(`Claude Code already uses ${target.name} here.`);
      return;
    }
    await this.switchTo(target);
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

  private async switchTo(target: BridgeAccount): Promise<void> {
    const conversations = await this.conversations();
    const latest = conversations[0];
    const closeTab = latest !== undefined && this.host.claudeTabActive();
    const next = await this.host.pick<Next>(
      [
        ...(latest
          ? [
              {
                label: `Continue this conversation with ${target.name}`,
                description: formatAgo(latest.modifiedAt),
                detail: closeTab
                  ? "Closes this tab and reopens the conversation, with its full history"
                  : "Reopens the conversation, with its full history, in a new tab",
                icon: { codicon: "debug-continue" },
                value: { kind: "continue" as const, conversation: latest, closeTab },
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
      "Claude tabs that are already open keep their account",
    );
    if (!next) return;

    switch (next.kind) {
      case "continue":
        await this.continueWith(target, next.conversation, next.closeTab);
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
        if (conversation) await this.continueWith(target, conversation, false);
        return;
      }
      case "new":
        await this.host.setConfigDir(target.configDir);
        await this.host.openClaude();
        return;
      case "switch":
        await this.host.setConfigDir(target.configDir);
        await this.host.info(`New Claude tabs use ${target.name}.`);
        return;
    }
  }

  private async continueWith(
    target: BridgeAccount,
    conversation: Conversation,
    closeTab: boolean,
  ): Promise<void> {
    try {
      if (conversation.accountId !== target.id) {
        await this.host.withProgress(`Copying the conversation to ${target.name}…`, () =>
          this.bridge.handOver(
            conversation.directory,
            conversation.sessionId,
            conversation.accountId,
            target.id,
          ),
        );
      }
    } catch (err) {
      await this.fail(err, target.id);
      return;
    }
    await this.host.setConfigDir(target.configDir);
    if (closeTab) await this.host.closeActiveClaudeTab();
    await this.host.openClaude(conversation.sessionId);
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
