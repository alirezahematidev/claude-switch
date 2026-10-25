/**
 * Claude Switch for VS Code: a title-bar button and a status bar item that
 * show and switch the account the Claude Code extension uses, and continue a
 * conversation with another account (for example after a usage limit).
 *
 * Accounts come from the Claude Switch app over its local socket. The
 * account is chosen through the Claude Code extension's documented
 * `claudeCode.environmentVariables` setting, and conversations reopen
 * through its documented `…://anthropic.claude-code/open` link.
 */
import * as vscode from "vscode";

import {
  ACCOUNT_THEME_COLORS,
  accountFor,
  claudeLink,
  configDirInUse,
  withConfigDir,
  type InUse,
} from "./accounts";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import { Bridge, BridgeError, defaultSocketPath } from "./bridge";
import { describeInUse, Switcher, type PickItem, type SwitcherHost } from "./switcher";

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

function activeClaudeTab(): vscode.Tab | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CLAUDE_PANEL)
    ? tab
    : undefined;
}

function icon(spec: PickItem<unknown>["icon"]): vscode.ThemeIcon | undefined {
  if (!spec) return undefined;
  if ("codicon" in spec) return new vscode.ThemeIcon(spec.codicon);
  const color = ACCOUNT_THEME_COLORS[spec.color];
  return new vscode.ThemeIcon("circle-filled", color ? new vscode.ThemeColor(color) : undefined);
}

const host: SwitcherHost = {
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
  claudeTabActive() {
    return activeClaudeTab() !== undefined;
  },
  async closeActiveClaudeTab() {
    const tab = activeClaudeTab();
    if (tab) await vscode.window.tabGroups.close(tab);
    // Let the Claude Code extension release the conversation first.
    await new Promise((resolve) => setTimeout(resolve, 400));
  },
  async openClaude(sessionId) {
    const message = sessionId ? settings().get<string>("continueMessage", "") : undefined;
    const link = claudeLink(vscode.env.uriScheme, sessionId, message);
    await vscode.env.openExternal(vscode.Uri.parse(link));
  },
  async info(message, ...actions) {
    return vscode.window.showInformationMessage(message, ...actions);
  },
  async error(message, ...actions) {
    return vscode.window.showErrorMessage(message, ...actions);
  },
  withProgress(title, task) {
    return Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => task()),
    );
  },
};

class AccountStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "claudeSwitch.account",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private generation = 0;

  constructor(private readonly bridge: Bridge) {
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
    try {
      await this.bridge.status();
      accounts = await this.bridge.accounts();
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
    }
    if (generation !== this.generation) return;
    const current = accounts ? accountFor(accounts, used.dir) : undefined;

    this.item.text = `$(account) ${current?.name ?? (used.source === "default" ? "Claude: default" : "Claude")}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Claude Code account:** `);
    tooltip.appendText(
      `${describeInUse(used, current)}${current?.detail ? ` (${current.detail})` : ""}`,
    );
    tooltip.appendMarkdown("\n\n");
    tooltip.appendText(
      used.source === "settings"
        ? "Chosen for new Claude tabs in every window."
        : used.source === "window"
          ? "The account this window was opened with."
          : "Claude Code's own folder (~/.claude).",
    );
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
  const bridge = new Bridge(() => settings().get<string>("socketPath", "") || defaultSocketPath());
  const switcher = new Switcher(bridge, host);
  // Profiles live on this Mac; in a remote window Claude Code runs elsewhere.
  const remote = vscode.env.remoteName !== undefined;

  let status: AccountStatus | undefined;

  context.subscriptions.push(
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
  const accountStatus = new AccountStatus(bridge);
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
  );
  refresh();
}

export function deactivate(): void {}
