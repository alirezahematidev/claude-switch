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
  workspace, with its full history, to that account, closes its tab, and
  reopens it in a new tab with "Continue where you left off." in the message
  box. Press Return to send it.
- **Continue another conversation…** does the same for an older one.
- **New conversation** opens a new Claude tab with that account.
- **Only switch**: Claude tabs you open from now on use that account.

## What changes

The account is set through the Claude Code extension's own setting,
`claudeCode.environmentVariables` (`CLAUDE_CONFIG_DIR`), which VS Code keeps
in your user settings. So it applies to new Claude tabs in **every** window;
tabs that are already open keep their account. Choose **Per window** to go
back to each window using the account it was opened with.

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
