/**
 * Claude Switch for VS Code: several Claude Code accounts, each signed in
 * once, and one click to switch the account Claude Code uses.
 *
 * * The status bar and a title-bar button show the account in use and switch
 *   it; the conversations open in this window follow the switch.
 * * The Claude Switch view lists the accounts: click one to switch, add and
 *   sign in accounts, or run Claude Code with one in a terminal.
 *
 * Everything runs in Claude Switch's helper (`helper.ts`), the desktop app's
 * own core started as a child process, on the app's database and profiles.
 *
 * Claude Code's extension takes its account from its documented
 * `claudeCode.environmentVariables` setting, and conversations reopen through
 * its documented `…://anthropic.claude-code/open` link. That setting reaches
 * the Claude Code processes the extension starts (one per Claude tab, and one
 * for its sidebar) when they start.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  ACCOUNT_THEME_COLORS,
  accountFor,
  claudeLink,
  configDirInUse,
  isClaudeSwitchProfile,
  isRecord,
  sameDir,
  withConfigDir,
  type InUse,
} from "./accounts";
import { Actions } from "./actions";
import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeOpenConversation } from "./bindings/BridgeOpenConversation";
import type { ChangeScope } from "./bindings/ChangeScope";
import { Helper, HelperError, spawnHelper } from "./helper";
import {
  describeInUse,
  inSidebar,
  openAccounts,
  openInWindow,
  openNotUsing,
  stillUsingMessage,
  Switcher,
  tabsAccountName,
  type PickItem,
  type SwitcherHost,
  type TabAccount,
} from "./switcher";
import { sessionTerminalsOpen } from "./terminal";
import { AccountsView, type Node } from "./views";

const CLAUDE_SECTION = "claudeCode";
const ENV_SETTING = "environmentVariables";
const CLAUDE_PANEL = "claudeVSCodePanel";
const CLAUDE_EXTENSION = "anthropic.claude-code";
/** This extension's IDs before its own Marketplace publisher. */
const LEGACY_EXTENSIONS = ["claude-switch.claude-switch-vscode"];

function settings() {
  return vscode.workspace.getConfiguration("claudeSwitch");
}

function inUse(): InUse {
  const value = vscode.workspace.getConfiguration(CLAUDE_SECTION).get<unknown>(ENV_SETTING);
  return configDirInUse(value, process.env);
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

interface Manage {
  addAccount(): Promise<void>;
  signIn(accountId: string): Promise<boolean>;
}

function createHost(tabs: ClaudeTabs, manage: Manage): SwitcherHost {
  return {
    ...manage,
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
    claudeInstalled,
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
    sessionTerminalsOpen,
    notify(message) {
      vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000);
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

/** The account Claude Code uses here; warns while something still uses another. */
class AccountStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    "claudeSwitch.account",
    vscode.StatusBarAlignment.Right,
    100,
  );
  private generation = 0;
  /** Clicking moves what still uses another account to this one. */
  fixFor: string | undefined;

  constructor(
    private readonly helper: Helper,
    private readonly tabs: ClaudeTabs,
  ) {
    this.item.name = "Claude Code Account";
    this.item.command = "claudeSwitch.statusBarClicked";
  }

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
      await this.helper.ensureRunning();
      accounts = await this.helper.accounts();
      open = await openInWindow(this.helper);
    } catch (err) {
      if (!(err instanceof HelperError)) throw err;
    }
    if (generation !== this.generation) return;
    const current = accounts ? accountFor(accounts, used.dir) : undefined;
    const removed =
      accounts !== undefined &&
      !current &&
      used.dir !== undefined &&
      isClaudeSwitchProfile(used.dir);
    // Only tabs this extension saw open: it cannot tell for the others.
    const tabs = this.tabs.notUsing(used.dir, false).map(([, started]) => started);
    // Conversations here on another account: all of them when the folder in
    // use is not a Claude Switch account.
    const elsewhere = openNotUsing(
      open,
      current?.id ?? (used.dir === undefined ? null : undefined),
    );
    const sidebar = inSidebar(elsewhere, this.tabs.notUsing(used.dir, true));
    const stale = tabs.length > 0 || sidebar;
    this.fixFor = stale ? current?.id : undefined;

    const name = current?.name ?? (used.source === "default" ? "Claude: default" : "Claude");
    this.item.text = `${removed || stale ? "$(warning)" : "$(account)"} ${name}`;
    this.item.backgroundColor =
      removed || stale ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const lines = [
      `Claude Code: ${describeInUse(used, current, accounts)}${current?.detail ? ` (${current.detail})` : ""}`,
    ];
    if (removed) lines.push("This account was removed from Claude Switch.");
    if (stale && accounts) {
      const other = tabsAccountName(sidebar ? openAccounts(elsewhere, accounts) : tabs, accounts);
      lines.push(`${stillUsingMessage(tabs.length, sidebar, other)} Click to switch it.`);
    } else {
      lines.push(accounts ? "Click to switch account." : "Claude Switch is not running.");
    }
    this.item.tooltip = lines.join("\n");
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

async function showAccounts(): Promise<void> {
  await vscode.commands.executeCommand("claudeSwitch.accounts.focus");
}

function claudeInstalled(): boolean {
  return vscode.extensions.getExtension(CLAUDE_EXTENSION) !== undefined;
}

/** Calls `fn` once events stop arriving for a moment. */
function debounced(fn: () => void, ms = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/** The helper inside the extension; `CLAUDE_SWITCH_HELPER` for development. */
function helperPath(context: vscode.ExtensionContext): string {
  const override = process.env.CLAUDE_SWITCH_HELPER;
  if (override) return override;
  const bundled = context.asAbsolutePath(path.join("bin", "claude-switch-helper"));
  // A .vsix does not always keep the executable bit.
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(bundled, 0o755);
    } catch {
      // Starting it then reports the problem.
    }
  }
  return bundled;
}

/** Every command, so non-macOS and remote windows can explain themselves. */
const COMMANDS = [
  "claudeSwitch.switchAccount",
  "claudeSwitch.statusBarClicked",
  "claudeSwitch.useAccount",
  "claudeSwitch.addAccount",
  "claudeSwitch.signIn",
  "claudeSwitch.editAccount",
  "claudeSwitch.removeAccount",
  "claudeSwitch.newSession",
  "claudeSwitch.continueConversation",
  "claudeSwitch.perWindow",
  "claudeSwitch.refresh",
  "claudeSwitch.chooseClaudeExecutable",
  "claudeSwitch.showDiagnostics",
  "claudeSwitch.showLog",
];

/**
 * Offers to uninstall an earlier copy of this extension, which registers the
 * same commands and buttons.
 */
function offerToRemoveLegacy(): void {
  const legacy = LEGACY_EXTENSIONS.find((id) => vscode.extensions.getExtension(id));
  if (!legacy) return;
  void (async () => {
    const action = await vscode.window.showWarningMessage(
      "An older Claude Switch extension is also installed. Uninstall it?",
      "Uninstall",
    );
    if (action !== "Uninstall") return;
    await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", legacy);
    const reload = await vscode.window.showInformationMessage(
      "Reload the window to finish.",
      "Reload Window",
    );
    if (reload) await vscode.commands.executeCommand("workbench.action.reloadWindow");
  })();
}

export function activate(context: vscode.ExtensionContext): void {
  // Before registering commands: the earlier copy may hold the same ones.
  offerToRemoveLegacy();
  // Profiles live on this Mac; in a remote window Claude Code runs elsewhere.
  if (vscode.env.remoteName !== undefined || process.platform !== "darwin") {
    const reason =
      process.platform === "darwin"
        ? "Claude Switch works in local windows only."
        : "Claude Switch works on macOS only.";
    for (const id of COMMANDS) {
      context.subscriptions.push(
        vscode.commands.registerCommand(id, () => vscode.window.showInformationMessage(reason)),
      );
    }
    return;
  }

  const output = vscode.window.createOutputChannel("Claude Switch", { log: true });
  const manifest: unknown = context.extension.packageJSON;
  const version =
    isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "";
  const helper = new Helper(
    () => spawnHelper(helperPath(context), version),
    (line) => output.info(line),
  );
  const tabs = new ClaudeTabs();
  const accountsView = new AccountsView(helper, () => inUse().dir);
  // Filled in below; the switcher's host needs the actions and vice versa.
  let actions: Actions | undefined;
  const switcher = new Switcher(
    helper,
    createHost(tabs, {
      addAccount: async () => actions?.addAccount(),
      signIn: async (id) => (await actions?.signInById(id)) ?? false,
    }),
  );
  const all = new Actions(helper, accountsView, switcher, {
    continueMessage: () => settings().get<string>("continueMessage", "") || undefined,
    claudeInstalled,
  });
  actions = all;
  const status = new AccountStatus(helper, tabs);

  const refresh = debounced(() => {
    void accountsView.refresh();
    void status.refresh();
  });
  const onChange = (scope: ChangeScope) => {
    if (scope === "accounts" || scope === "settings" || scope === "system") refresh();
  };
  const run =
    (task: (node?: Node) => Promise<unknown>) =>
    (node?: Node): Promise<void> =>
      all.guard(() => task(node));
  const switched = (task: (node?: Node) => Promise<unknown>) =>
    run(async (node) => {
      await task(node);
      await status.refresh();
    });

  context.subscriptions.push(
    output,
    { dispose: () => helper.dispose() },
    tabs,
    status,
    accountsView,
    vscode.window.registerTreeDataProvider("claudeSwitch.accounts", accountsView),
    helper.on("changed", onChange),
    helper.on("show", () => void showAccounts()),
    helper.on("exited", ({ code, started }) => {
      output.warn(`helper exited (code ${code ?? "none"})`);
      // A helper that could not start would only fail again, over and over;
      // the requests that started it already show why.
      if (started) refresh();
    }),
    vscode.commands.registerCommand(
      "claudeSwitch.switchAccount",
      switched(() => switcher.run()),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.statusBarClicked",
      switched(() => (status.fixFor ? switcher.switchTo(status.fixFor) : switcher.run())),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.useAccount",
      switched((n) => all.useAccount(n)),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.perWindow",
      switched(() => switcher.perWindow()),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.addAccount",
      run(() => all.addAccount()),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.signIn",
      run((n) => all.signIn(n)),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.editAccount",
      run((n) => all.editAccount(n)),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.removeAccount",
      run((n) => all.removeAccount(n)),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.newSession",
      run((n) => all.newSession(n)),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.continueConversation",
      switched(() => all.continueConversation()),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.refresh",
      run(async () => {
        await helper.sync().catch(() => undefined);
        await all.checkAll();
        refresh();
      }),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.chooseClaudeExecutable",
      run(() => all.chooseClaudeExecutable()),
    ),
    vscode.commands.registerCommand(
      "claudeSwitch.showDiagnostics",
      run(() => all.showDiagnostics()),
    ),
    vscode.commands.registerCommand("claudeSwitch.showLog", () => output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CLAUDE_SECTION}.${ENV_SETTING}`) ||
        e.affectsConfiguration("claudeSwitch")
      ) {
        refresh();
      }
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      // The app, or another window's helper, may have changed something.
      helper.sync().catch(() => undefined);
      void status.refresh();
    }),
    tabs.changed.event(() => void status.refresh()),
  );
  helper.ensureRunning().catch((err: unknown) => {
    output.error(`Claude Switch's helper did not start: ${String(err)}`);
  });
  refresh();
}

export function deactivate(): void {}
