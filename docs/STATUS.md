# Project status

Last updated 2026-10-25. Claude Code tested: 2.1.236. macOS tested: 26.2 (arm64).

## Phases

| Phase | State | Evidence |
| --- | --- | --- |
| 1. Repository and architecture | Done | Tauri 2.12 + React 19 + TS 6 (strict) + Vite 8 + Tailwind 4; pnpm; oxlint (type-aware) and oxfmt; rustfmt, Clippy (`-D warnings`); docs in `docs/` |
| 2. Account profiles | Done | SQLite migrations, CRUD, reorder, removal with confirmation; UUID-derived 0700 profile folders; path, symlink and ownership checks |
| 3. Authentication | Done; real-account sign-in needs manual verification | `claude auth login/status/logout` integration; sign-in screen (link button + code field) driven by a parser tested against the real CLI; status model; isolation classification |
| 4. Process and terminal | Done | portable-pty manager with process-group stop, ring-buffer reattach, xterm.js (WebGL + DOM fallback), tabs, restart, exit codes |
| 5. Projects | Done | Native folder picker, favorites, recents, default account, missing-folder handling, never modifies folders; open in VS Code / Cursor / Windsurf with an account |
| 6. macOS integration | Done; needs manual pass | App menu with account switching (⌘1–9, ⌘P), menu-bar (tray) quick launch, global shortcut, notifications, launch at login (off by default), window/quit lifecycle, single instance |
| 7. Hardening and release | Done except signing | Security, IPC and lifecycle tests; release `.app` builds and launches; signing and notarization documented. A Developer ID certificate is needed to produce a signed build |
| 8. Continue in another account | Done; real two-account handoff needs manual verification | Conversation copy between profiles (verified against the real CLI), resume in a terminal or in VS Code's extension, editor-wide account setting with backup, usage-limit banner |
| 9. VS Code extension | Done; needs a manual pass in VS Code with the Claude Code extension | Title-bar and status-bar account switcher, continue/new/switch flows, local socket to the app (tested, and queried live against a running app), installed from Settings; activation and the settings write checked in an isolated VS Code 1.143 |

## Automated verification

Run `pnpm verify` (and `pnpm test:e2e`). All passing at the time of writing:

| Suite | Count | Covers |
| --- | --- | --- |
| Rust unit tests | 159 | paths, env construction and filtering, settings validation, domain validation and state machine, repositories, migrations, CLI parsing and status interpretation, sign-in output parser, editor detection and links, conversation copy (prefix rule, symlinks, long names), editor settings editing (comments kept, backups, symlinked files), usage-limit wording, logging redaction, error mapping |
| `tests/sessions.rs` | 32 | Real PTYs with a mock `claude`: distinct profiles, correct `CLAUDE_CONFIG_DIR` per process, concurrency, stop isolation, process-group cleanup, SIGKILL escalation, exit codes, restart, login success/failure/retry, sign-in screen state and code submission, expiry → sign-in required, unsupported isolation, restart persistence, quit stops all, missing CLI/project/profile, version probe never uses `$HOME`, profile data still used by a Claude Code process outside the app is not deleted |
| `tests/bridge.rs` | 3 | Extension socket: accounts and handoff for any folder, only fixed methods, unknown parameters, relative/missing/managed folders and signed-out targets refused, oversized requests, 0600 socket, stale sockets replaced but nothing else |
| `tests/editors.rs` | 9 | Fake VS Code bundle: extension installed with the editor's own CLI, launched with the project, the account's profile and the user's login-shell environment (no API keys), removing an account releases editors set to it, a setting left by a removed account is replaced, unknown editors and missing folders refused, handoff into the editor (settings entry, backup, link), editor-wide account kept in step, a user's own folder never overridden, unreadable settings never rewritten |
| `tests/handoff.rs` | 5 | Conversation copied and resumed with another account (`--resume <id> <message>`, message not repeated on restart), handing back updates the earlier copy, diverged copies refused, `~/.claude` only read, unusable targets and bad input copy nothing, usage-limit message flags the session |
| `tests/security.rs` | 12 | Malformed/unknown IDs, hostile names, managed and symlinked paths, swapped profile symlink, auth-affecting custom env, flag injection via email, capability file contents |
| `tests/ipc.rs` | 4 (+ handoff commands) | Real handlers through Tauri's invoke pipeline with the real config and capabilities: argument shapes, error payloads, denied plugin and shell commands |
| `tests/logging_secrets.rs` | 1 | Full login and session with a secret in the environment: nothing sensitive in logs or diagnostics |
| `tests/real_cli.rs` (ignored by default) | 4 | Installed Claude Code: fresh profile is *not signed in* despite an existing global login; real CLI runs in the PTY and stops cleanly; the sign-in screen parses the real `claude auth login` output and a rejected code; a conversation copied to another profile is found by `--resume` (and is not before) |
| Vitest + Testing Library | 73 + 26 (extension) | IPC error mapping and argument shapes, UI store, accelerators, formatters, custom controls (checkbox, number field, stepper, segmented), delete confirmation and Return-to-submit, sign-in screen (link, code via Return, success, failure), open in editor, continue-in-another-account dialog (preselection, editor notice, sign-in prompt, empty states), editor account setting and extension install; extension: setting read/write like the Claude Code extension, link format, socket client (errors, timeouts, launching the app, protocol check), switcher flows (continue, older conversation, new, only switch, per window, signed-out and missing-extension refusals, failed copy changes nothing), quit confirmation, onboarding, overview, launching, environment warnings, corruption screen |
| Playwright (fake backend) | 19 | Flows (first run through sign-in, terminal input, pages, quick switcher, dark theme, usage limit → continue in another account in a tab and in VS Code) and a layout sweep (including the limit banner, handoff dialog and editor settings) of every screen with stress data at three window sizes, checked for overflow, plus a self-test of the checker |

Manually verified here: the release build launches, renders under the production
CSP, detects Claude Code with a minimal GUI `PATH`, and creates its folders with
mode 0700.

## Not yet verified (needs a person and real accounts)

See [MANUAL_TESTING.md](MANUAL_TESTING.md). In particular:
- Browser and magic-link sign-in for two real accounts, and their coexistence
  across app restarts.
- Keychain prompts (if any) on first use of each profile.
- Console sign-in, with and without an API key (no Console account was available).
- Menu bar, tray, global shortcut, notifications and launch at login, driven by
  hand (they are implemented and compile, but the UI automation used here
  cannot drive native menus).
- VS Code with a real account: that a new window opened from Claude Switch
  gives the Claude Code extension the account's profile (relies on VS Code
  passing the launcher's environment to new windows).
- Continuing a real conversation with a second signed-in account: the reply
  uses the history (verified here only up to Claude Code finding the copied
  conversation, with unauthenticated profiles).
- The VS Code extension picking up the account from user settings for a new
  tab, and the documented `vscode://anthropic.claude-code/open?session=…` link
  opening the conversation in the project's window (behavior checked in the
  extension's code, 2.1.310, not with a real account).
- The extension in a real VS Code with the Claude Code extension: the button
  next to Claude Code's, closing the old tab and reopening the conversation
  with the other account (only the settings write and activation were
  exercised in VS Code; the flows are unit tested).
- Signed and notarized distribution build.

## Known limitations

- **Isolation depends on the sign-in method.** Only claude.ai subscription
  logins (verified) and Console API keys (documented) are profile-scoped.
  Other sources are flagged *Limited isolation*. See
  [CLAUDE_CODE_INTEGRATION.md](CLAUDE_CODE_INTEGRATION.md).
- **Status is "as last observed".** `claude auth status` may report a token
  that the server has since revoked; the next request then fails, and Claude
  Code asks to sign in.
- **Profile paths are permanent.** Moving or renaming `~/.claude-switch`
  invalidates every login, because Claude Code keys Keychain entries to the
  path. The app refuses symlinked or relocated profile folders.
- **Terminal text shaping.** xterm.js has no bidirectional text support;
  Persian/Arabic renders with font fallback, left to right.
- **Shell sessions** source the user's shell profile, which may export
  credentials that override the account (reported only for Claude sessions,
  through `authMethod`).
- **Daemonized children** that start their own session can outlive a stopped
  session (inherent to process groups).
- **`freezePrototype` is disabled** because xterm.js requires mutable built-in
  prototypes. See [SECURITY.md](SECURITY.md).
- **Unsigned builds** are blocked by Gatekeeper on other Macs until signed and
  notarized ([RELEASE.md](RELEASE.md)).
- **Editors and already-open folders.** If a folder is already open in VS Code,
  the editor focuses that window, which keeps the account it was opened with.
- **Continuing in another account** relies on Claude Code's conversation
  folder layout, which is not a documented API (verified on 2.1.236; the
  real-CLI test catches a change). Only conversations of registered projects,
  started in the project folder, are listed. Each profile's own settings,
  MCP servers, plugins and auto-memory are not copied. In VS Code the account
  setting applies to every window, and Claude tabs already open keep their
  account. The usage-limit banner depends on Claude Code's wording, and appears
  only in project sessions.
- **Claude tabs keep their account.** In VS Code, each Claude tab runs with
  the account in use when it opened, and Claude Code's extension shows one
  usage meter per window, fed by every tab in it. After a switch, old tabs
  (and that meter, while they are open) still reflect the previous account;
  the extension offers to close them and flags them in the status bar. Claude
  Code's own Logout command and plan details use the account the window was
  opened with, which Claude Code reads once per window.
- **The VS Code extension** knows the conversation from file times, not from
  the tab: "Continue this conversation" takes the workspace's most recently
  written one and closes the active Claude tab. With several Claude tabs busy
  at once, use "Continue another conversation…". It needs the app installed
  and works in local windows only. Messages lose `& = # + % ?` (kept out of
  the link).
- **Sign-in screen parsing** depends on Claude Code's current output wording
  (not a documented API). If it changes, the screen falls back to showing the
  raw output, where sign-in still works.

## Possible next steps

- Code-split the frontend bundle (~1 MB; it loads from disk, so not urgent).
- Optional per-account custom environment variables.
- A "Repair profile" action for profiles whose folder was deleted outside the
  app (today: re-authenticate).
- Universal (arm64 + x86_64) release in CI with signing secrets.
