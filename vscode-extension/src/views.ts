/**
 * The Claude Switch view: your accounts, one click to switch to one.
 */
import * as vscode from "vscode";

import { ACCOUNT_THEME_COLORS, sameDir } from "./accounts";
import type { Account } from "./bindings/Account";
import type { SystemInfo } from "./bindings/SystemInfo";
import type { Helper } from "./helper";
import { AUTH_STATUS, accountSubtitle, isSignedIn } from "./model";

export type Node =
  | { kind: "account"; account: Account }
  | { kind: "notice"; label: string; detail: string; command?: vscode.Command };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AccountsView implements vscode.TreeDataProvider<Node> {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  accounts: Account[] = [];
  info: SystemInfo | undefined;
  private error: string | undefined;

  constructor(
    private readonly helper: Helper,
    /** The profile Claude Code's extension uses here. */
    private readonly inUse: () => string | undefined,
  ) {}

  async refresh(): Promise<void> {
    try {
      const [accounts, info] = await Promise.all([
        this.helper.listAccounts(),
        this.helper.systemInfo(),
      ]);
      this.accounts = accounts;
      this.info = info;
      this.error = undefined;
    } catch (err) {
      this.error = message(err);
    }
    this.changes.fire();
  }

  /** Only what stops switching from working. */
  private notice(): Node | undefined {
    if (this.error) {
      return {
        kind: "notice",
        label: "Claude Switch is not running",
        detail: this.error,
        command: { title: "Retry", command: "claudeSwitch.refresh" },
      };
    }
    const cli = this.info?.cli;
    if (cli && cli.state !== "found") {
      return {
        kind: "notice",
        label: cli.state === "not_found" ? "Claude Code not found" : "Claude Code unusable",
        detail: cli.message ?? "Install Claude Code, or choose its executable.",
        command: { title: "Choose", command: "claudeSwitch.chooseClaudeExecutable" },
      };
    }
    return undefined;
  }

  getChildren(): Node[] {
    const notice = this.notice();
    return [
      ...(notice ? [notice] : []),
      ...this.accounts.map((account): Node => ({ kind: "account", account })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "notice") {
      const item = new vscode.TreeItem(node.label);
      item.tooltip = node.detail;
      item.iconPath = new vscode.ThemeIcon("warning");
      item.command = node.command;
      return item;
    }
    const { account } = node;
    const used = this.inUse();
    const current = used !== undefined && sameDir(used, account.configDir);
    const signedIn = isSignedIn(account);
    const item = new vscode.TreeItem(account.name);
    item.id = account.id;
    item.description = signedIn
      ? (accountSubtitle(account) ?? undefined)
      : AUTH_STATUS[account.authStatus].label;
    item.tooltip = [
      accountSubtitle(account),
      signedIn ? undefined : (account.authDetail ?? AUTH_STATUS[account.authStatus].description),
      current
        ? "Claude Code uses this account"
        : signedIn
          ? "Click to switch to it"
          : "Click to sign in",
    ]
      .filter(Boolean)
      .join("\n");
    const color = ACCOUNT_THEME_COLORS[account.color];
    item.iconPath = new vscode.ThemeIcon(
      current ? "pass-filled" : signedIn ? "circle-filled" : "circle-outline",
      color ? new vscode.ThemeColor(color) : undefined,
    );
    item.command = {
      title: signedIn ? "Switch" : "Sign In",
      command: signedIn ? "claudeSwitch.useAccount" : "claudeSwitch.signIn",
      arguments: [node],
    };
    item.contextValue = `account ${signedIn ? "signedIn" : "signedOut"}`;
    return item;
  }

  dispose(): void {
    this.changes.dispose();
  }
}
