# Claude Switch

[![CI](https://github.com/alirezahematidev/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/alirezahematidev/claude-switch/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/alirezahematidev/claude-switch)](https://github.com/alirezahematidev/claude-switch/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local-first macOS app for keeping several Claude Code accounts signed in at
the same time and opening any of them with one click.

Without it, switching accounts means `/logout`, a fresh sign-in, and waiting for
an email link every time. Claude Switch gives each account its own Claude Code
profile (via Claude Code's supported `CLAUDE_CONFIG_DIR`), so every account
signs in once and stays signed in. Sessions run in the real Claude Code CLI
inside an integrated terminal.

- One isolated profile per account: separate login, settings, history, plugins.
- One-click launch, per account and per project, with many sessions at once.
- Official sign-in only: `claude auth login` in a terminal tab. Claude Switch
  never sees passwords, tokens, or sign-in links.
- Honest status: each account shows what `claude auth status` last reported,
  including when a login is **not** isolated.
- Hit a usage limit? **Continue in Another Account** hands the conversation,
  with its full history, to another account, in Claude Switch or in VS Code.
- A **VS Code extension** puts an account switcher in VS Code's title bar and
  status bar (also Cursor and Windsurf).
- Local only: no server, no analytics, no telemetry.

## Requirements

- macOS 13 or later (Apple silicon or Intel).
- Claude Code installed:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash   # or: brew install --cask claude-code
  ```

  Claude Switch finds it in the usual locations (`~/.local/bin`, Homebrew,
  `/usr/local/bin`, npm/nvm/volta/bun prefixes). You can also choose the
  executable in **Settings → Claude Code**.

## Install

1. Download the `.dmg` from the
   [latest release](https://github.com/alirezahematidev/claude-switch/releases/latest)
   (`Claude Switch_<version>_universal.dmg`, one file for Apple silicon and
   Intel).
2. Open it and drag **Claude Switch** into **Applications**.
3. Start Claude Switch from Applications or Spotlight.

To update, download the new `.dmg` and replace the app. Accounts, sign-ins and
projects are kept: they live outside the app, in `~/.claude-switch` and
`~/Library/Application Support/ClaudeSwitch`.

To build the app yourself instead, see [Development](#development)
(`pnpm app:build` writes the `.dmg` to `src-tauri/target/release/bundle/dmg/`).

## Getting started

1. Open Claude Switch. The first-run guide checks your setup and explains how
   isolation works.
2. **Add an account** and give it a name (Work, Personal, …).
3. **Sign in.** Claude Switch runs `claude auth login` for that account and
   shows a sign-in screen: Claude Code opens your browser (or press **Open
   Sign-In Page**), you finish there, including any email link, and the screen
   turns green. If the browser shows an authorization code instead of
   returning, paste it into the code field and press Return.
4. Repeat for every account you use.
5. **Add a project** folder and press **Open** next to any account, or use the
   account's **New Session** button.
6. **Open in VS Code** (or Cursor/Windsurf) from a project page with the
   selected account: the new editor window, its Claude Code extension, and its
   terminals use that account's profile.
7. **Out of usage?** Choose **Continue in Another Account** (⇧⌘C, the menu-bar
   icon, a project's page, or the banner that appears in a terminal tab when
   Claude Code reports a limit). Pick the conversation and the account to
   continue with, then open it in Claude Switch or in VS Code. See
   [Continuing in another account](#continuing-in-another-account).

| Action | Shortcut |
| --- | --- |
| Switch account (palette) | ⌘P |
| Select account 1–9 | ⌘1 – ⌘9 |
| New Claude session / shell | ⌘T / ⇧⌘T |
| Add account / project | ⇧⌘N / ⌘O |
| Close tab, next/previous tab | ⌘W, ⇧⌘] / ⇧⌘[ |
| Clear terminal | ⌘K |
| Newline in Claude Code | ⇧↩ |
| Continue in another account | ⇧⌘C |

The menu-bar icon starts sessions for any account (and recent projects) without
opening the window. A global shortcut can be set in **Settings → Keyboard**.

## How isolation works, and where it stops

Every account has a permanent folder `~/.claude-switch/profiles/<uuid>`. Each
session is started with `CLAUDE_CONFIG_DIR` set to that folder and a deliberately
minimal environment. Claude Code keeps settings, history and plugins there, and
keys its macOS Keychain login entry to that exact folder path.

| Sign-in method | Isolated per account? |
| --- | --- |
| Claude subscription (Pro, Max, Team, Enterprise) | **Yes** (verified) |
| Anthropic Console, with an API key created at sign-in | Yes (documented by Anthropic) |
| Anthropic Console **without** an API key | **No**: stored as an Anthropic profile outside the folder |
| Anthropic profiles / Workload Identity Federation | **No** |
| Bedrock, Vertex AI, Foundry, `apiKeyHelper`, `ANTHROPIC_API_KEY` | **No** |

When Claude Code reports a credential that isn't scoped to the profile, the
account shows **Limited isolation** and explains why. Details:
[docs/CLAUDE_CODE_INTEGRATION.md](docs/CLAUDE_CODE_INTEGRATION.md).

Other things to know:

- **Logins expire.** Claude Code refreshes them itself. If one expires or is
  revoked, the account shows *Sign-in required*; sign in again. Other accounts
  are unaffected.
- **Project settings still apply.** A project's own `CLAUDE.md` and `.claude/`
  settings are read whichever account you use. Claude Switch never edits them.
- **Organization policy wins.** Managed settings can force a login method or
  organization, or override the configuration folder; Claude Switch warns when
  managed settings are present.
- **Sessions and quitting.** Closing the window keeps sessions running (the app
  stays in the Dock and menu bar); this is configurable. Quitting stops every
  session, after a confirmation.

## Continuing in another account

Claude Code keeps each conversation as a file in the account's profile.
Claude Switch copies that file (with its subagent output and `/rewind`
checkpoints) into the other account's profile and resumes it there with
`claude --resume <id>`, so the second account sees the whole history: every
message, tool call and result, including the prompt that ran into the limit.
The optional message ("Continue where you left off.") is sent as the next
prompt in Claude Switch, or placed in the message box in VS Code. The original
copy is only read.

- **In Claude Switch** the conversation opens in a new tab with the other
  account. Nothing else changes.
- **In VS Code** (or Cursor/Windsurf), Claude Switch sets the Claude Code
  extension's account in your *user* settings
  (`claudeCode.environmentVariables` → `CLAUDE_CONFIG_DIR`), focuses the
  project's window, and opens the conversation in a new Claude tab. This
  applies to new Claude tabs in **every** window of that editor (VS Code only
  reads the setting from user settings); tabs already open keep their account
  until you close them (see [Switching accounts inside
  VS Code](#switching-accounts-inside-vs-code)). A backup of `settings.json`
  is saved first, and **Settings → Editors** shows the setting and switches it
  back to *Per window*.

What moves and what does not:
- Moves: the conversation history. Files Claude changed are already in your
  project folder, and the project's `CLAUDE.md` and `.claude/` apply to every
  account.
- Does not move: each profile's own user `CLAUDE.md`, settings, MCP servers,
  plugins and auto-memory. The request that hit the limit never got an
  answer, so Claude picks up from that step.
- The second account reads the history fresh (no prompt cache), so its first
  reply uses more of its own allowance on long conversations.
- Conversations are listed for projects added to Claude Switch (from any
  account, or from Claude Code's default `~/.claude`), started in the project
  folder itself.

## Switching accounts inside VS Code

Install the Claude Switch extension from **Settings → Editors → Install**
(VS Code, VS Code Insiders, Cursor or Windsurf; it ships with the app). Then,
in the editor:

- The **account button** sits in the editor title bar next to Claude Code's
  own button (and in the Claude Code sidebar); the **status bar** shows the
  account Claude Code uses there. Both open the switcher.
- Pick an account, then **Continue this conversation** (copies the latest
  conversation of the workspace with its full history, closes the window's
  Claude tabs that still use another account, and reopens it with the new
  one), **New conversation**, or **Only switch**.
- **Per window** returns to each window using the account it was opened with.

A Claude tab keeps the account it started with until it is closed: its
replies and `/usage` count against that account. Claude Code's extension
also shows a single usage meter per window, fed by every Claude tab in it.
So after a switch, Claude Switch offers to close the window's tabs that still
use the previous account, and the status bar turns yellow while any are
open. Claude Code's own **Logout** command and plan details keep using the
account the window was opened with; to change those as well, open the folder
from Claude Switch with the other account.

The extension talks only to Claude Switch on this Mac, through a socket that
only your user can open (`~/.claude-switch/claude-switch.sock`); it starts the
app in the background when needed. It chooses the account through the Claude
Code extension's documented setting, so the same rules apply as above: every
window's new Claude tabs, open tabs unchanged. Local windows only. Details:
[vscode-extension/README.md](vscode-extension/README.md).

Removing an account in Claude Switch also returns any editor set to it to
*Per window*. Deleting its profile data waits until no Claude Code process
uses it any more (close its Claude tabs in VS Code first); otherwise a
running process would keep the login and write the folder back.

## Privacy

The app database (`~/Library/Application Support/ClaudeSwitch/claude-switch.sqlite`)
holds account names, labels, colors, project paths and session times. It never
stores passwords, tokens, cookies, sign-in links, terminal output or
conversations. Conversations are copied between profiles only when you ask,
and never read into the app. Logs are redacted. See [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

**"Claude Code was not found".** Install it (above), or choose the executable in
Settings. GUI apps don't see your shell's `PATH`; Claude Switch checks the
standard install locations and lists them under *Locations checked*.

**An account shows "Sign-in required" or "Sign-in failed".** Choose *Sign In*
on the account. If the browser shows a code instead of returning, paste it into
the code field. *Claude Code output* on the sign-in screen shows the raw CLI
output if something unexpected happens.

**VS Code still uses another account.** The account applies to new editor
windows. If the folder is already open in VS Code, close that window and open
it again from Claude Switch.

**An account shows "Limited isolation".** Claude Code is using a credential from
outside the profile (an environment variable, Anthropic profile, cloud provider,
or `apiKeyHelper`). Remove that source or accept that accounts share it.

**"Some environment variables are not passed to Claude Code".** Variables such
as `ANTHROPIC_API_KEY` or `CLAUDE_CONFIG_DIR` exist in the app's environment.
They are removed from every session on purpose. Variables in your shell profile
still apply inside shells.

**A tool Claude Code needs isn't found.** Add its folder in **Settings →
Environment → Additional PATH folders**.

**Startup error about the database.** Your Claude Code logins are stored
separately and are safe. Quit, move `claude-switch.sqlite` out of
`~/Library/Application Support/ClaudeSwitch`, and reopen.

**Report a problem.** **Settings → Troubleshooting → Copy Diagnostics** copies
a report without names, emails, tokens, environment values or terminal output.

## Development

Prerequisites: Node.js 20.19+, pnpm 12, Rust (stable), Xcode Command Line Tools.
Linting uses oxlint (type-aware, via oxlint-tsgolint) and formatting uses oxfmt.

```bash
pnpm install
pnpm app:dev                 # run the app (Vite + Tauri)
CLAUDE_SWITCH_HOME=/tmp/cs pnpm app:dev   # debug builds only: sandboxed data
pnpm verify                  # types, oxlint, oxfmt check, unit tests, rustfmt, clippy, Rust tests
pnpm format                  # oxfmt
pnpm test:e2e                # Playwright flows + layout sweep (uses installed Google Chrome)
pnpm bindings                # regenerate src/bindings (and the extension's protocol types)
pnpm ext:package             # build vscode-extension/claude-switch-vscode.vsix
pnpm app:build               # release .app and .dmg, with the extension inside
```

`pnpm test:e2e` also runs a layout sweep (`e2e/layout.spec.ts`) that opens every
screen with stress data at 900×560, 1280×820 and 1600×1000 and fails on
horizontal overflow or elements escaping their containers. Screenshots land in
`e2e-screens/` for review.

Real-CLI smoke tests (need Claude Code installed; never sign in):
`cargo test --manifest-path src-tauri/Cargo.toml --test real_cli -- --ignored`.

| Path | Contents |
| --- | --- |
| `src-tauri/src` | Rust backend: `core` (services), `pty`, `cli`, `env`, `paths`, `db`/`store`, `commands` (IPC), `desktop` (menus, tray, lifecycle) |
| `src-tauri/tests` | Integration, security, IPC and real-CLI tests (mock `claude` executable) |
| `src` | React UI (`features/*`), typed IPC layer (`lib/ipc.ts`), generated types (`bindings/`) |
| `e2e` | Playwright flows and layout sweep with a fake backend |
| `vscode-extension` | The VS Code extension (TypeScript, no runtime dependencies) and its tests |
| `docs` | Architecture, security, Claude Code integration, testing, release, status |

Further reading: [Architecture](docs/ARCHITECTURE.md) ·
[Security](docs/SECURITY.md) · [Claude Code integration](docs/CLAUDE_CODE_INTEGRATION.md) ·
[Manual test checklist](docs/MANUAL_TESTING.md) · [Release, signing and notarization](docs/RELEASE.md) ·
[Project status](docs/STATUS.md)

## Contributing

Bug reports, fixes and ideas are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
for setup and the pull request checklist, and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as
described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE). Claude Switch is an independent tool. It is not made by or affiliated with
Anthropic.
