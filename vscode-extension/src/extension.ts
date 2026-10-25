/**
 * Claude Switch for VS Code: a title-bar button and a status bar item that
 * show and switch the account the Claude Code extension uses, and continue a
 * conversation with another account (for example after a usage limit).
 *
 * Accounts come from the Claude Switch app over its local socket. The
 * account is chosen through the Claude Code extension's documented
 * `claudeCode.environmentVariables` setting, and conversations reopen
 * through its documented `…://anthropic.claude-code/open` link.
 *
 * That setting reaches the Claude Code processes the extension starts (one
 * per Claude tab, and one for its sidebar) when they start. The extension's
 * own account features (its Logout command, plan details) keep using the
 * `CLAUDE_CONFIG_DIR` the window was opened with, which it reads once;
 * nothing can change that for a running window.
 */
import * as vscode from "vscode";

import {
  ACCOUNT_THEME_COLORS,
  accountFor,
  claudeLink,
  configDirInUse,
  isClaudeSwitchProfile,
  sameDir,
  withConfigDir,
  type InUse,
} from "./accounts";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeOpenConversation } from "./bindings/BridgeOpenConversation";
import { Bridge, BridgeError, defaultSocketPath } from "./bridge";
import {
  describeInUse,
  inSidebar,
  openAccounts,
  openInWindow,
  openNotUsing,
  otherTabsMessage,
  sidebarMessage,
  Switcher,
  tabsAccountName,
  type PickItem,
  type SwitcherHost,
  type TabAccount,
} from "./switcher";

const CLAUDE_SECTION = "claudeCode";
const ENV_SETTING = "environmentVariables";
const CLAUDE_PANEL = "claudeVSCodePanel";
const CLAUDE_EXTENSION = "anthropic.claude-code";

function settings() {
  return vscode.workspace.getConfiguration("claudeSwitch");
}

function inUse(): InUse {
  const value = vscode.workspace.getConfiguration(CLAUDE_SECTION).get<unknown>(ENV_SETTING);
  return configDirInUse(value, process.env);
}

/** The account this window was opened with, when the setting chose another. */
function windowAccount(used: InUse): InUse | undefined {
  if (used.source !== "settings") return undefined;
  const opened = configDirInUse(undefined, process.env);
  if (opened.dir !== undefined && used.dir !== undefined && sameDir(opened.dir, used.dir)) {
    return undefined;
  }
  return opened;
}

function isClaudeTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CLAUDE_PANEL);
}

function openClaudeTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter(isClaudeTab));
}

function sameAccount(started: TabAccount, dir: string | undefined): boolean {
  if (started === undefined) return false;
  if (started === null || dir === undefined) return started === null && dir === undefined;
  return sameDir(started, dir);
}

/**
 * The account each Claude tab in this window started with. Claude Code
 * starts a tab's process with the account in use when the tab opens, and
 * keeps it until the tab closes.
 */
class ClaudeTabs implements vscode.Disposable {
  private readonly started = new Map<vscode.Tab, string | null>();
  private readonly subscription: vscode.Disposable;
  readonly changed = new vscode.EventEmitter<void>();

  constructor() {
    // Restored tabs start their process once this window is up.
    for (const tab of openClaudeTabs()) this.record(tab);
    this.subscription = vscode.window.tabGroups.onDidChangeTabs((e) => {
      let changed = false;
      for (const tab of e.opened.filter(isClaudeTab)) {
        this.record(tab);
        changed = true;
      }
      for (const tab of e.closed) changed = this.started.delete(tab) || changed;
      if (changed) this.changed.fire();
    });
  }

  private record(tab: vscode.Tab): void {
    this.started.set(tab, inUse().dir ?? null);
  }

  /** Open Claude tabs that did not start with `dir`, with what they started with. */
  notUsing(dir: string | undefined, includeUnknown: boolean): [vscode.Tab, TabAccount][] {
    return openClaudeTabs()
      .map((tab): [vscode.Tab, TabAccount] => [tab, this.started.get(tab)])
      .filter(([, started]) =>
        started === undefined ? includeUnknown : !sameAccount(started, dir),
      );
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function icon(spec: PickItem<unknown>["icon"]): vscode.ThemeIcon | undefined {
  if (!spec) return undefined;
  if ("codicon" in spec) return new vscode.ThemeIcon(spec.codicon);
  const color = ACCOUNT_THEME_COLORS[spec.color];
  return new vscode.ThemeIcon("circle-filled", color ? new vscode.ThemeColor(color) : undefined);
}

function createHost(tabs: ClaudeTabs): SwitcherHost {
  return {
    async pick<T>(items: PickItem<T>[], title: string, placeholder: string) {
      type Item = vscode.QuickPickItem & { value?: T };
      const picked = await vscode.window.showQuickPick<Item>(
        items.map((item) =>
          item.separator
            ? { label: item.label, kind: vscode.QuickPickItemKind.Separator }
            : {
                label: item.label,
                description: item.description,
                detail: item.detail,
                iconPath: icon(item.icon),
                value: item.value,
              },
        ),
        { title, placeHolder: placeholder, matchOnDescription: true },
      );
      return picked?.value;
    },
    inUse,
    claudeInstalled() {
      return vscode.extensions.getExtension(CLAUDE_EXTENSION) !== undefined;
    },
    async setConfigDir(dir) {
      const config = vscode.workspace.getConfiguration(CLAUDE_SECTION);
      const current = config.inspect<unknown>(ENV_SETTING)?.globalValue;
      // Machine-scoped: VS Code stores it in user settings.
      await config.update(
        ENV_SETTING,
        withConfigDir(current, dir),
        vscode.ConfigurationTarget.Global,
      );
    },
    workspaceDirs() {
      return (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath);
    },
    claudeTabsNotUsing(dir) {
      return tabs.notUsing(dir, true).map(([, started]) => started);
    },
    async closeClaudeTabsNotUsing(dir) {
      const closing = tabs.notUsing(dir, true).map(([tab]) => tab);
      if (closing.length === 0) return;
      await vscode.window.tabGroups.close(closing);
      // Let the Claude Code extension release those conversations first.
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    async openClaude(sessionId) {
      const message = sessionId ? settings().get<string>("continueMessage", "") : undefined;
      const link = claudeLink(vscode.env.uriScheme, sessionId, message);
      await vscode.env.openExternal(vscode.Uri.parse(link));
    },
    async reloadWindow() {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    },
    async info(message, ...actions) {
      return vscode.window.showInformationMessage(message, ...actions);
    },
    async error(message, ...actions) {
      return vscode.window.showErrorMessage(message, ...actions);
    },
    withProgress(title, task) {
      return Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () =>
          task(),
        ),
      );
    },
  };
}

class AccountStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "claudeSwitch.account",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private generation = 0;

  constructor(
    private readonly bridge: Bridge,
    private readonly tabs: ClaudeTabs,
  ) {
    this.item.name = "Claude Code Account";
    this.item.command = "claudeSwitch.switchAccount";
  }

  /** Re-reads the account in use. Never starts Claude Switch. */
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    if (!settings().get<boolean>("showStatusBar", true)) {
      this.item.hide();
      return;
    }
    const used = inUse();
    let accounts: BridgeAccount[] | undefined;
    let open: BridgeOpenConversation[] = [];
    try {
      await this.bridge.status();
      accounts = await this.bridge.accounts();
      open = await openInWindow(this.bridge);
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
    }
    if (generation !== this.generation) return;
    const current = accounts ? accountFor(accounts, used.dir) : undefined;
    const removed =
      accounts !== undefined &&
      !current &&
      used.dir !== undefined &&
      isClaudeSwitchProfile(used.dir);
    // Only tabs this extension saw open: it cannot tell for the others.
    const others = this.tabs.notUsing(used.dir, false).map(([, started]) => started);
    const tabsElsewhere = this.tabs.notUsing(used.dir, true);
    // Conversations here on another account: all of them when the folder in
    // use is not a Claude Switch account.
    const elsewhere = openNotUsing(
      open,
      current?.id ?? (used.dir === undefined ? null : undefined),
    );
    const sidebar = inSidebar(elsewhere, tabsElsewhere);
    const warn = removed || others.length > 0 || sidebar;

    const name = current?.name ?? (used.source === "default" ? "Claude: default" : "Claude");
    this.item.text = `${warn ? "$(warning)" : "$(account)"} ${name}`;
    this.item.backgroundColor = warn
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Claude Code account:** `);
    tooltip.appendText(
      `${describeInUse(used, current, accounts)}${current?.detail ? ` (${current.detail})` : ""}`,
    );
    tooltip.appendMarkdown("\n\n");
    tooltip.appendText(
      used.source === "settings"
        ? "Chosen for new Claude tabs in every window."
        : used.source === "window"
          ? "The account this window was opened with."
          : "Claude Code's own folder (~/.claude).",
    );
    const opened = windowAccount(used);
    if (opened) {
      const openedName = describeInUse(
        opened,
        accounts ? accountFor(accounts, opened.dir) : undefined,
        accounts,
      );
      tooltip.appendText(
        `\n\nThis window was opened with ${openedName}: Claude Code's own account actions here (its Logout command, plan details) still apply to that account.`,
      );
    }
    if (removed) {
      tooltip.appendText(
        "\n\nClaude Code still starts new tabs with this account's old profile folder. Choose another account.",
      );
    }
    if (sidebar && accounts) {
      const otherName = tabsAccountName(openAccounts(elsewhere, accounts), accounts);
      tooltip.appendText(`\n\n${sidebarMessage(tabsElsewhere.length, otherName, name)}`);
    } else if (others.length > 0) {
      const otherName = accounts ? tabsAccountName(others, accounts) : "another account";
      tooltip.appendText(`\n\n${otherTabsMessage(others.length, otherName, name)}`);
    }
    if (!accounts) tooltip.appendText("\n\nClaude Switch is not running.");
    tooltip.appendMarkdown("\n\nClick to switch accounts.");
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function notInRemote() {
  return vscode.window.showInformationMessage(
    "Claude Switch chooses accounts for local windows only. In remote windows Claude Code runs on the remote machine.",
  );
}

export function activate(context: vscode.ExtensionContext): void {
  // Profiles live on this Mac; in a remote window Claude Code runs elsewhere.
  const remote = vscode.env.remoteName !== undefined;

  const bridge = new Bridge(() => settings().get<string>("socketPath", "") || defaultSocketPath());
  const tabs = new ClaudeTabs();
  const switcher = new Switcher(bridge, createHost(tabs));
  let status: AccountStatus | undefined;

  context.subscriptions.push(
    tabs,
    vscode.commands.registerCommand("claudeSwitch.switchAccount", async () => {
      if (remote) {
        await notInRemote();
        return;
      }
      try {
        await switcher.run();
      } catch (err) {
        await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
      await status?.refresh();
    }),
    vscode.commands.registerCommand("claudeSwitch.openApp", () => switcher.openApp()),
  );

  if (remote) return;
  const accountStatus = new AccountStatus(bridge, tabs);
  status = accountStatus;
  const refresh = () => {
    accountStatus.refresh().catch(() => undefined);
  };
  context.subscriptions.push(
    accountStatus,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CLAUDE_SECTION}.${ENV_SETTING}`) ||
        e.affectsConfiguration("claudeSwitch")
      ) {
        refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refresh();
    }),
    tabs.changed.event(refresh),
  );
  refresh();
}

export function deactivate(): void {}
