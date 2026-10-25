# Architecture

## Layers

```
React UI (src/features/*)                       presentation
  └─ src/lib/ipc.ts, queries.ts, store/ui.ts    typed services, cache, UI state
       │  invoke / Channel / events (Tauri IPC)
src-tauri/src/commands.rs                       IPC adapters (validated, no logic)
src-tauri/src/desktop.rs                        menus, tray, window/quit lifecycle,
                                                shortcuts, login item, notifications
src-tauri/core/src/core.rs (AppCore)            application services and invariants
  ├─ store.rs + db.rs                           SQLite repositories and migrations
  ├─ pty.rs (PtyManager)                        PTYs, process groups, output buffers
  ├─ cli.rs                                     Claude Code discovery and CLI calls
  ├─ login.rs                                   follows `claude auth login` output
  ├─ editors.rs                                 VS Code-family editor detection
  ├─ env.rs                                     child environment construction
  └─ paths.rs                                   managed directories, path safety
```

The Rust code is a Cargo workspace rooted at `src-tauri/`:

| Crate | Path | |
| --- | --- | --- |
| `claude-switch-core` | `src-tauri/core` | Everything above `commands`: no UI dependency |
| `claude-switch` | `src-tauri` | The Tauri app: `commands`, `desktop`; re-exports the core's modules |
| `claude-switch-helper` | `src-tauri/helper` | The VS Code extension's helper: the core over stdin/stdout |

`AppCore` has no Tauri dependency. UI side effects go through the `UiBridge`
trait (implemented by `desktop::TauriBridge`), so the core is driven directly
by integration tests with a recording bridge and a mock `claude` executable.

Domain types are defined once in Rust and exported to TypeScript with ts-rs
(`src/bindings`, regenerate with `pnpm bindings`).

## Persistence

One authoritative store: SQLite at
`~/Library/Application Support/ClaudeSwitch/claude-switch.sqlite` (mode 0600,
WAL, foreign keys on). Migrations are ordered SQL in `db.rs`, tracked by
`PRAGMA user_version`. A database from a newer app version is refused rather
than modified, and an integrity check runs at open.

| Table | Purpose |
| --- | --- |
| `accounts` | name, label, verified email/org (from the CLI), `config_dir` (UNIQUE), color, notes, order, timestamps, last observed auth status/method/detail and check times |
| `projects` | name, canonical `directory` (UNIQUE), favorite, default account (FK, SET NULL), timestamps |
| `sessions` | account (FK, CASCADE), project (FK, SET NULL), kind, title, cwd, pid, status (CHECK), start/end, exit code/signal, error |
| `settings` | one JSON document; unknown fields ignored, missing fields defaulted |

Session history keeps the newest 2,000 rows. Terminal output is never
persisted.

## Sessions and PTYs

```
start_session ─► AppCore::launch
   1. validate IDs, profile dir (exact managed path), project dir
   2. build environment (env.rs), choose program (claude | login shell | auth login)
   3. INSERT session (starting) + touch last-used, in one transaction
   4. PtyManager::spawn (portable-pty; child is a session/process-group leader)
   5. UPDATE → running (pid)        exit thread ─► handle_exit ─► exited + status probe
```

- **Output:** a reader thread pushes bytes into a 512 KiB ring buffer and the
  attached sink. `attach_session(id, Channel)` replays the buffer, then streams
  raw bytes (an `ArrayBuffer` in JS) to xterm.js. Re-attaching after a webview
  reload therefore works.
- **Input/resize:** `write_session` (text, or byte-valued text for xterm's binary
  events) and `resize_session`.
- **Stop:** SIGHUP to the process group, then SIGTERM, then SIGKILL, waiting
  1.5 s between steps. After the child exits, the group gets a final SIGHUP so
  tools it spawned do not linger.
- **State machine:** `starting → running → stopping → exited`, `starting → failed`,
  and any active state `→ interrupted` (rows left over from a previous run).
  Enforced in `store::transition_session`.
- **Restart** creates a new session with the same account, project and kind; the
  UI swaps the tab in place.

## Authentication flow

`start_login` runs `claude auth login …` in a PTY with the account's
environment. The PTY's output tap feeds `login::LoginParser`, which extracts
the sign-in URL (OSC 8 hyperlink or plain https link), notices the
`Paste code here if prompted` prompt, and recognizes `Login successful` /
`Login failed: …`. Each change is emitted as a `login-progress` event, and
`get_login_progress` returns the current state.

The UI renders this as a sign-in screen (no terminal tab): **Open Sign-In
Page**, **Copy Link**, and a code field. `submit_login_code` writes the code
to that PTY only; it is rejected for any other session, for finished
sign-ins, and for codes containing whitespace or control characters. The raw
output stays available behind *Claude Code output* and opens automatically
when nothing recognizable appears.

When the process exits, `handle_exit` runs `claude auth status --json`,
interprets it (`cli::interpret`), records the observation (using the parser's
failure message when there is one), and emits `LoginCompleted` on success.
Cancelled or failed sign-ins leave the profile in place and mark the account
*failed*.

## Opening a project in an editor

`open_in_editor` launches the `code`/`cursor`/`windsurf` launcher found inside a
known application bundle (`/Applications` or `~/Applications`), with
`--new-window <project>` and the account's sanitized environment, including
`CLAUDE_CONFIG_DIR`. New windows of a running editor inherit the launcher's
environment, so the Claude Code extension and terminals use the account. The
editor ID must be one of the detected editors; the UI cannot choose a program.

## Continuing a conversation in another account

`transcripts.rs` finds conversations by file metadata only:
`<profile>/projects/<folder>/<session-id>.jsonl`, where `<folder>` is the
working directory with every non-alphanumeric UTF-16 unit replaced by `-`
(long names end in a hash and are matched by their unambiguous 200-character
prefix). `list_conversations` scans each registered project in every verified
profile and in `~/.claude` (read only), and lists each session once, from its
newest copy.

`continue_conversation` validates both accounts (the target must be signed
in), copies the transcript byte for byte through a temporary file and a
rename (an existing copy is replaced only if it is a byte prefix of the
source; a diverged copy is a conflict), adds the session's subagent folder and
`file-history/<id>` best effort, then either:
- starts a session with `claude --resume <id> [message]` (the message is
  validated not to look like a flag, and is not repeated on restart), or
- writes the editor's user `settings.json` through `editor_settings.rs`
  (JSONC concrete syntax tree, only the `CLAUDE_CONFIG_DIR` entry of
  `claudeCode.environmentVariables`, backup in
  `ClaudeSwitch/backups/editor-settings`, atomic rename, re-read check), runs
  the editor's launcher on the folder, and sends
  `<scheme>://anthropic.claude-code/open?session=<id>&prompt=<message>` with
  `/usr/bin/open -a <editor app>`.

`open_in_editor` keeps an editor-wide account (set by Claude Switch) in step
with the chosen account, and refuses when the user set `CLAUDE_CONFIG_DIR`
there themselves, since it would silently override the account.

Claude sessions feed their output through `usage_limit.rs`. On Claude Code's
usage-limit wording it sets `SessionInfo.usageLimitReached` (memory only) and
emits `session-updated`; the terminal shows a banner offering the handoff.

## Editor extension and its helper

`vscode-extension/` is a VS Code extension (`extensionKind: ui`, no runtime
dependencies) that works with or without the app, centred on switching the
account Claude Code's extension uses. It adds a status bar item and a
`claudeSwitch.switchAccount` button in `editor/title` (next to Claude Code's)
and the Claude Code sidebar's `view/title`, an Accounts view in the activity
bar (click an account to switch), and Claude terminals per account.

A switch is one step (`switcher.ts`): the conversations open in this window
on another account (from Claude Code's session registry, `open`) are copied
to the new account, the setting is written, their tabs close and reopen with
the new account, and the window reloads when the Claude sidebar holds one
(asking first only if Claude Switch terminals would close). Confirmation is
a status bar message.

Each window's extension host starts `bin/claude-switch-helper`
(`src-tauri/helper`), the core with no UI, and speaks to it over stdin and
stdout, one JSON message per line: requests `{id, method, params}`, responses
`{id, result}` or `{id, error: {kind, message}}`, and events `{event, data}`
(`changed`, `sessionUpdated`, `sessionFinished`, `loginProgress`,
`loginCompleted`, `output` with base64 terminal bytes, `show`). Its methods
mirror the app's IPC commands (`listAccounts`, `createAccount`, `startLogin`,
`submitLoginCode`, `startSession`, `attachSession`, `writeSession`,
`continueConversation`, `openInEditor`, …), plus the editor bridge's methods
below, answered by the same `editor_bridge::respond`. There is no generic
"run" or "read file" method. Closing stdin (the window is gone) stops the
sessions it started.

A Claude session is a `Pseudoterminal` whose output and input go through the
helper's PTY, so the usage-limit detector and the sign-in parser work as in
the app. Sign-in is a notification with **Open Sign-In Page**, **Copy Link**
and **Enter Code**, fed by `loginProgress` events.

**Sharing the database.** The app and any number of helpers (one per VS Code
window) open the same SQLite database (WAL, 5 s busy timeout). Each process
keeps its own sessions; at startup a session left `running` is marked
`interrupted` only if its process is gone, so one process never interrupts
another's. Each process notices the others' commits through `PRAGMA
data_version` (`AppCore::sync_external_changes`, called when the app's window
or a VS Code window gains focus), reloads its settings and announces the
change. The helper logs to `claude-switch-helper.log` and skips the
sign-in checks the app runs at startup.

### The app's socket

The app also answers the editor bridge (`editor_bridge.rs`) on a Unix socket at
`~/.claude-switch/claude-switch.sock` (0600 in the 0700 managed folder, peer
uid checked with `getpeereid`), one JSON request per connection, ≤ 64 KB, 10 s
timeouts. Methods: `status` (app and protocol version), `accounts`,
`conversations {directory}`, `open {parentPid}` (conversations open in the
Claude Code processes that process started, from Claude Code's session
registry, with their account and folder), `continue {directory, sessionId,
fromAccountId?, toAccountId}` (the same copy as the app's handoff, into a
signed-in account only) and `show {accountId?}` (brings the window forward).
The directory is canonicalized and must be an existing folder outside the
app's own; it only selects which conversation folder to read. Protocol types
are generated with ts-rs into `vscode-extension/src/bindings`.

Extensions up to 0.1.2 used it; the current extension asks its helper the
same methods. Either way, the extension does the editor side itself: it writes
`claudeCode.environmentVariables` through VS Code's configuration API (user
settings, machine scope), closes the active Claude tab when continuing the
latest conversation in it (the Claude Code extension would otherwise just
focus the tab with the old account), and opens
`<uriScheme>://anthropic.claude-code/open?session=…&prompt=…` in the window.
The Claude sidebar cannot be closed, and the link only shows a conversation
the sidebar holds there, with its old process. The extension finds it with
`open {parentPid: <its extension host>}` (Claude Code starts its processes
from the same extension host), copies what is open to the new account and
reloads the window, after which Claude Code resumes each tab's and the
sidebar's conversation with the new account.

The app installs the extension with the editor's own `--install-extension
<vsix> --force`; release builds bundle the `.vsix` as a resource
(`tauri.release.json`), debug builds use the one in the repository.

## Frontend

- Server state: TanStack Query with `staleTime: Infinity`. Backend events drive
  invalidation (`state-changed`) and live session updates (`session-updated`);
  nothing polls.
- UI state (view, tabs, dialogs): a small zustand store.
- Terminals stay mounted while hidden, so switching views never loses state.
- Native menu items and the global shortcut arrive as `menu-action` events and
  are handled in `useMenuActions` and the terminal workspace.
- No native form controls or browser tooltips: selects, checkboxes, number
  fields, radio cards, switches, disclosures and tooltips are custom (Radix
  based) components in `src/components/ui`. `Form` submits on Return from any
  field or custom control and moves focus into each new dialog step.
- Quit confirmation (`confirm-quit`) and menu-bar errors (`notice`) are
  in-app dialogs and toasts, not native alerts.

## Lifecycle

| Event | Behavior |
| --- | --- |
| Window close | Hide; sessions continue (default) or quit, per setting |
| ⌘Q, Dock *Quit*, tray *Quit* | Confirm when sessions run, stop all, exit |
| App relaunch | Sessions from a previous run are marked *interrupted* |
| Second launch | Focuses the existing instance |
| Launch at login | Starts hidden (menu bar only), off by default |

## Dependencies

Rust: tauri 2 (+ dialog, opener, notification, global-shortcut, autostart,
single-instance), portable-pty, rusqlite (bundled SQLite), serde, thiserror,
uuid, time, log, libc, ts-rs, jsonc-parser (editing editor settings with
comments intact).
Frontend: React 19, TanStack Query, zustand, Radix primitives, Tailwind 4,
xterm.js 6 (fit, unicode11, web-links, webgl addons), lucide-react, sonner.
