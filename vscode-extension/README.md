# Claude Switch for VS Code

Switch Claude Code between your accounts in one click. Each account stays
signed in, and the conversation you have open moves with you.

## Get started

1. Open **Claude Switch** in the activity bar and **Add Account** (Work,
   Personal, …).
2. Sign in: Claude Code opens your browser. If the page shows a code, choose
   **Enter Code** and paste it.
3. Repeat for each account.

## Switch

Click the account in the **status bar** (or the button next to Claude Code's
in the title bar, or an account in the Claude Switch view) and pick another.

That's it. Claude Code uses the new account from then on, in every window.
A conversation open in a Claude tab is copied to the new account and
reopens there with its full history. When it is in Claude's sidebar, the
window reloads to do the same.

If something still runs with the old account, the status bar turns yellow;
click it to move it over.

## Also

- **New Claude Terminal** (the terminal button on an account) runs Claude Code
  with that account in a terminal. When it reports a usage limit, Claude
  Switch offers to continue with another account.
- **Continue a Conversation with Another Account…** picks up an older
  conversation of this workspace.
- **Use Each Window's Own Account** goes back to the account each window was
  opened with.

## Good to know

- Each account is a separate Claude Code profile
  (`~/.claude-switch/profiles/<id>`, used as `CLAUDE_CONFIG_DIR`) with its own
  login, settings and history. Sign-in is Claude Code's own; Claude Switch
  never sees passwords or tokens.
- A Claude subscription or a Console API key is isolated per account; other
  sign-in methods may be shared by every profile
  ([details](https://github.com/alirezahematidev/claude-switch#how-isolation-works-and-where-it-stops)).
- Claude Code's own **Logout** command and plan details keep using the
  account the window was opened with.
- Works with or without the [Claude Switch app](https://github.com/alirezahematidev/claude-switch)
  for macOS; both show the same accounts.
- macOS, local windows only. Needs [Claude Code](https://code.claude.com) and
  its VS Code extension.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeSwitch.showStatusBar` | `true` | Account in the status bar |
| `claudeSwitch.showInEditorTitle` | `true` | Button in the editor title bar |
| `claudeSwitch.continueMessage` | `Continue where you left off.` | Placed in the message box when a conversation moves to another account |

Claude Switch is not affiliated with or endorsed by Anthropic. Claude and
Claude Code are trademarks of Anthropic.
