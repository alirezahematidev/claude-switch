/**
 * What the extension's commands do, with VS Code's own UI (quick picks,
 * input boxes, terminals).
 */
import * as path from "node:path";
import * as vscode from "vscode";

import type { Account } from "./bindings/Account";
import type { SessionInfo } from "./bindings/SessionInfo";
import type { Helper } from "./helper";
import { ACCOUNT_COLORS, AUTH_STATUS, colorLabel, isSignedIn, validateAccountName } from "./model";
import { signIn } from "./signin";
import type { Conversation, Switcher } from "./switcher";
import { openSessionTerminal } from "./terminal";
import type { AccountsView, Node } from "./views";

const SWITCH = "Switch Account…";

export interface ActionsHost {
  /** The message placed after a conversation continues. */
  continueMessage(): string | undefined;
  /** Claude Code's VS Code extension is installed. */
  claudeInstalled(): boolean;
}

export class Actions {
  constructor(
    private readonly helper: Helper,
    private readonly accounts: AccountsView,
    private readonly switcher: Switcher,
    private readonly host: ActionsHost,
  ) {}

  /** Runs `task`, showing its error instead of throwing. */
  async guard(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (err) {
      await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  private async pickAccount(
    title: string,
    accounts: readonly Account[],
  ): Promise<Account | undefined> {
    if (accounts.length === 0) {
      const action = await vscode.window.showInformationMessage(
        "Add a Claude Code account first.",
        "Add Account",
      );
      if (action) await this.addAccount();
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: account.name,
        description: isSignedIn(account)
          ? (account.verifiedEmail ?? account.label ?? undefined)
          : AUTH_STATUS[account.authStatus].label,
        account,
      })),
      { title },
    );
    return picked?.account;
  }

  /** The account a command acts on: its tree item's, or one picked now. */
  private async accountFor(
    node: Node | undefined,
    title: string,
    filter: (a: Account) => boolean = () => true,
  ): Promise<Account | undefined> {
    if (node?.kind === "account") return node.account;
    if (this.accounts.accounts.length === 0) await this.accounts.refresh();
    return this.pickAccount(title, this.accounts.accounts.filter(filter));
  }

  /** `account` once signed in (signing it in first if needed). */
  private async signedIn(account: Account): Promise<Account | undefined> {
    return isSignedIn(account) ? account : signIn(this.helper, account);
  }

  async addAccount(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Add Claude Code account",
      prompt: "Name, for example Work or Personal",
      validateInput: validateAccountName,
    });
    if (name === undefined) return;
    const used = new Set(this.accounts.accounts.map((a) => a.color));
    const color = ACCOUNT_COLORS.find((c) => !used.has(c)) ?? "blue";
    const account = await this.helper.createAccount({ name: name.trim(), color });
    await signIn(this.helper, account);
  }

  async signIn(node?: Node): Promise<boolean> {
    const account = await this.accountFor(node, "Sign in");
    return account !== undefined && (await signIn(this.helper, account)) !== undefined;
  }

  async signInById(accountId: string): Promise<boolean> {
    await this.accounts.refresh();
    const account = this.accounts.accounts.find((a) => a.id === accountId);
    return account !== undefined && (await signIn(this.helper, account)) !== undefined;
  }

  /** Makes Claude Code's extension use an account. */
  async useAccount(node?: Node): Promise<void> {
    if (node?.kind === "account") {
      await this.switcher.switchTo(node.account.id);
    } else {
      await this.switcher.run();
    }
  }

  /** Asks Claude Code again whether each account is signed in. */
  async checkAll(): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Checking accounts…" },
      () =>
        Promise.all(
          this.accounts.accounts.map((a) => this.helper.refreshAuthStatus(a.id).catch(() => a)),
        ),
    );
  }

  async editAccount(node?: Node): Promise<void> {
    const account = await this.accountFor(node, "Edit account");
    if (!account) return;
    const index = this.accounts.accounts.findIndex((a) => a.id === account.id);
    const count = this.accounts.accounts.length;
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Rename…", action: "rename" as const },
        { label: "Color…", action: "color" as const },
        ...(index > 0 ? [{ label: "Move Up", action: "up" as const }] : []),
        ...(index >= 0 && index < count - 1
          ? [{ label: "Move Down", action: "down" as const }]
          : []),
      ],
      { title: account.name },
    );
    switch (choice?.action) {
      case "rename": {
        const name = await vscode.window.showInputBox({
          title: `Rename ${account.name}`,
          value: account.name,
          validateInput: validateAccountName,
        });
        if (name !== undefined) {
          await this.helper.updateAccount({ id: account.id, name: name.trim() });
        }
        return;
      }
      case "color": {
        const picked = await vscode.window.showQuickPick(
          ACCOUNT_COLORS.map((color) => ({
            label: colorLabel(color),
            description: color === account.color ? "current" : undefined,
            color,
          })),
          { title: `Color for ${account.name}` },
        );
        if (picked) await this.helper.updateAccount({ id: account.id, color: picked.color });
        return;
      }
      case "up":
      case "down": {
        const ids = this.accounts.accounts.map((a) => a.id);
        const to = choice.action === "up" ? index - 1 : index + 1;
        [ids[index], ids[to]] = [ids[to] ?? account.id, account.id];
        await this.helper.reorderAccounts(ids);
        return;
      }
      case undefined:
        return;
    }
  }

  async removeAccount(node?: Node): Promise<void> {
    const account = await this.accountFor(node, "Remove account");
    if (!account) return;
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "Remove",
          detail: "Keeps its profile folder, with its sign-in and history.",
          deleteData: false,
        },
        {
          label: "Remove and delete its data",
          detail: "Signs out and deletes its profile folder. This cannot be undone.",
          deleteData: true,
        },
      ],
      { title: `Remove ${account.name}` },
    );
    if (!choice) return;
    let confirmation = "";
    if (choice.deleteData) {
      const typed = await vscode.window.showInputBox({
        title: `Delete ${account.name}'s data`,
        prompt: `Type ${account.name} to confirm`,
        validateInput: (v) => (v.trim() === account.name ? undefined : `Type ${account.name}`),
      });
      if (typed === undefined) return;
      confirmation = typed.trim();
    }
    await this.helper.deleteAccount({
      id: account.id,
      deleteProfileData: choice.deleteData,
      signOutFirst: choice.deleteData,
      confirmation,
    });
  }

  /** The folder a new session runs in: the active file's, or one picked. */
  private async folder(): Promise<string | undefined | null> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (f) => f.uri.scheme === "file",
    );
    const active = vscode.window.activeTextEditor?.document.uri;
    const current = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (current && current.uri.scheme === "file") return current.uri.fsPath;
    if (folders.length === 0) return null;
    if (folders.length === 1) return folders[0]?.uri.fsPath ?? null;
    const picked = await vscode.window.showWorkspaceFolderPick();
    return picked?.uri.fsPath;
  }

  /** Runs Claude Code with an account in a terminal. */
  async newSession(node?: Node): Promise<void> {
    const picked = await this.accountFor(node, "New Claude terminal");
    const account = picked && (await this.signedIn(picked));
    if (!account) return;
    const directory = await this.folder();
    if (directory === undefined) return;
    const projectId = directory ? (await this.helper.addProject(directory)).id : undefined;
    openSessionTerminal(
      this.helper,
      account,
      `Claude · ${account.name}`,
      (cols, rows) =>
        this.helper.startSession({
          accountId: account.id,
          ...(projectId ? { projectId } : {}),
          kind: "claude",
          cols,
          rows,
        }),
      { onUsageLimit: (session) => void this.guard(() => this.onUsageLimit(session)) },
    );
  }

  /** Continues one of this workspace's conversations with another account. */
  async continueConversation(given?: Conversation, inTerminal = false): Promise<void> {
    const conversation = given ?? (await this.switcher.pickConversation());
    if (!conversation) return;
    if (this.accounts.accounts.length === 0) await this.accounts.refresh();
    const others = this.accounts.accounts.filter((a) => a.id !== conversation.accountId);
    const picked = await this.pickAccount("Continue with", others);
    const target = picked && (await this.signedIn(picked));
    if (!target) return;
    if (!inTerminal && this.host.claudeInstalled()) {
      await this.switcher.continueInPanel(target.id, conversation);
      return;
    }
    const project = await this.helper.addProject(conversation.directory);
    const message = this.host.continueMessage();
    openSessionTerminal(
      this.helper,
      target,
      `Claude · ${target.name}`,
      async (cols, rows) => {
        const result = await this.helper.continueConversation({
          projectId: project.id,
          sessionId: conversation.sessionId,
          ...(conversation.accountId ? { fromAccountId: conversation.accountId } : {}),
          toAccountId: target.id,
          ...(message ? { message } : {}),
          cols,
          rows,
        });
        if (!result.session) throw new Error("The session did not start.");
        return result.session;
      },
      { onUsageLimit: (session) => void this.guard(() => this.onUsageLimit(session)) },
    );
  }

  /** Offers to continue a terminal's conversation after a usage limit. */
  async onUsageLimit(session: SessionInfo): Promise<void> {
    const name =
      this.accounts.accounts.find((a) => a.id === session.accountId)?.name ?? "This account";
    const action = await vscode.window.showWarningMessage(`${name} hit its usage limit.`, SWITCH);
    if (action !== SWITCH) return;
    const latest = (await this.helper.conversations(session.workingDir)).find(
      (c) => c.accountId === session.accountId,
    );
    if (!latest) {
      await vscode.window.showErrorMessage(
        `No conversation of ${name} found in ${path.basename(session.workingDir)}.`,
      );
      return;
    }
    await this.continueConversation({ ...latest, directory: session.workingDir }, true);
  }

  async chooseClaudeExecutable(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: "Choose the Claude Code executable",
    });
    const file = picked?.[0];
    if (!file) return;
    const status = await this.helper.setClaudeExecutable(file.fsPath);
    if (status.state !== "found") {
      await vscode.window.showErrorMessage(status.message ?? "That is not a usable Claude Code.");
    }
    await this.accounts.refresh();
  }

  async showDiagnostics(): Promise<void> {
    const text = await this.helper.diagnostics();
    const doc = await vscode.workspace.openTextDocument({ content: text, language: "plaintext" });
    await vscode.window.showTextDocument(doc);
  }
}
