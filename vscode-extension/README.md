# Claude Switch for VS Code

Switch the account Claude Code uses in this editor, and pick up a conversation
with another account when one runs into a usage limit.

Needs the Claude Switch app on this Mac, with your
accounts added and signed in there. The extension starts it in the background
when needed.

## Use

- **Title bar:** the account button next to Claude Code's own button, in the
  editor title bar and in the Claude Code sidebar.
- **Status bar:** shows the account Claude Code uses here. Click it to switch.
- **Command Palette:** *Claude Switch: Switch Claude Code Account*.

Choose an account, then:

- **Continue this conversation** copies the latest conversation of this
  workspace, with its full history, to that account, closes the Claude tabs in
  this window that still use another account, and reopens the conversation in
  a new tab with "Continue where you left off." in the message box. Press
  Return to send it. When the conversation is open in the Claude sidebar,
  which cannot be closed, the window reloads instead and the sidebar
  continues it with that account.
- **Continue another conversation…** does the same for an older one.
- **New conversation** opens a new Claude tab with that account.
- **Only switch**: Claude tabs you open from now on use that account.

After **New conversation** or **Only switch**, Claude Switch offers to close
the Claude tabs in this window that still use the previous account, or to
reload the window when the Claude sidebar still uses it. The status bar turns
yellow while such tabs, or such a sidebar, are open.

## What changes

The account is set through the Claude Code extension's own setting,
`claudeCode.environmentVariables` (`CLAUDE_CONFIG_DIR`), which VS Code keeps
in your user settings. So it applies to new Claude tabs in **every** window.
Choose **Per window** to go back to each window using the account it was
opened with.

What keeps the previous account:

- **Claude tabs that are already open.** Each runs its own Claude Code
  process, started with the account in use when the tab opened. Its replies,
  and `/usage` typed there, use that account until the tab is closed.
- **The Claude sidebar.** Its conversation runs the same way, even though
  Claude Code then shows the new account's email there. It cannot be closed,
  so Claude Switch copies its conversation to the new account and offers to
  reload the window, which restarts it there with its full history.
- **The usage meter.** Claude Code's extension shows one usage meter per
  window, fed by every Claude tab in it, so it mixes accounts while old tabs
  are open. Close them (Claude Switch offers to) and the meter follows the
  new account.
- **Claude Code's own account actions.** Its **Logout** command and plan
  details use the account the window was opened with (Claude Code reads it
  once per window). To have those use another account too, open the folder
  from Claude Switch with that account.

Conversations are copied by Claude Switch from one account's profile to the
other's; the original stays as it is. Each account keeps its own settings,
MCP servers and plugins.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `claudeSwitch.showInEditorTitle` | `true` | Button in the editor title bar |
| `claudeSwitch.showStatusBar` | `true` | Account in the status bar |
| `claudeSwitch.continueMessage` | `Continue where you left off.` | Message placed in the box when continuing |
| `claudeSwitch.socketPath` | (empty) | Claude Switch's socket, for development builds |

Local windows only: in remote windows (SSH, containers, WSL) Claude Code runs
on the other machine.
