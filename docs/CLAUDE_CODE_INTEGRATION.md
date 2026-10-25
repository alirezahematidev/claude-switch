# Claude Code integration

What Claude Switch relies on, how it was verified, and where isolation ends.
Verified on 2026-10-24 with Claude Code **2.1.236** (Homebrew cask) on macOS
26.2 (arm64), plus Anthropic's documentation at code.claude.com.

## Commands used

Only documented CLI commands, always spawned directly with an argv array:

| Purpose | Command |
| --- | --- |
| Version | `claude --version` → `2.1.236 (Claude Code)` |
| Status | `claude auth status --json` (exit 0 signed in, 1 not) |
| Sign in | `claude auth login --claudeai` or `--console`, optional `--email <addr>` |
| Sign out (before deleting a profile) | `claude auth logout` |
| Session | `claude` (optionally `--continue`) in a PTY |
| Continue a conversation in another account | `claude --resume <session-id> [message]` in a PTY |

`auth status --json` fields read: `loggedIn`, `authMethod`, `apiProvider`,
`email`, `orgName`, and `configDirectory` (Claude Code 2.1.268+). Documented
`authMethod` values: `none`, `claude.ai`, `oauth_token`, `api_key`,
`api_key_helper`, `third_party`. Unknown fields and values are tolerated.

The status check never sends a model request. It runs once per account at
launch (can be disabled), after a sign-in or Claude session ends, and when the
user presses *Check status*. There is no background polling.

## Verified behavior

All checks used throwaway profile folders; no real account was signed in or
out.

1. **Empty `CLAUDE_CONFIG_DIR` reports signed out**, even on a machine with an
   existing global claude.ai login: `{"loggedIn": false, "authMethod": "none"}`.
2. **The Keychain entry is keyed to the folder path.** Setting
   `CLAUDE_CONFIG_DIR=~/.claude` (the default location, set explicitly) also
   reports signed out. Anthropic documents this: Claude Code "keys the macOS
   Keychain entry to that directory too, so a session with a different
   `CLAUDE_CONFIG_DIR` reads a different entry."
   *Consequence:* a profile path must never change. Claude Switch derives it
   from the account UUID once and never moves or renames it.
3. **`USER` is required.** With `HOME` and `PATH` but no `USER`, Claude Code
   reports signed out for every profile, including signed-in ones. It uses `USER`
   as the Keychain account name. Child environments always include `USER`
   (falling back to the password database).
4. **The CLI writes into the selected profile** (`.claude.json`, `backups/`) and
   nowhere else in our tests (`tests/real_cli.rs`).
5. **The interactive CLI runs in our PTY** and exits cleanly on SIGHUP to its
   process group.

6. **`claude auth login` output** (2.1.236), captured in a PTY with a fake
   `open` so no browser launched:
   ```text
   Opening browser to sign in…
   If the browser didn't open, visit: ESC]8;;<url>BEL ESC[94m<url>ESC[39m ESC]8;;BEL
   Paste code here if prompted >
   ```
   It opens the browser through `open` on `PATH` (with a `localhost` callback
   URL) and prints a manual URL whose page shows a long `code#state` string to
   paste. A wrong code prints `Login failed: Request failed with status code
   400` and the process exits. The sign-in screen relies on these strings; they
   are not a documented API, so the raw output stays one click away and opens
   automatically when no link is recognized.

7. **Conversations live in the profile.** A session in folder `<cwd>` writes
   `<CLAUDE_CONFIG_DIR>/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl`
   (the canonical path, for example `/private/tmp/…`). This happens even when
   the request fails for lack of a login. `claude -p --resume <id>` in another
   profile prints `No conversation found with session ID: <id>`; after the file
   is copied into that profile's matching folder, the lookup succeeds (the
   unauthenticated test profile then stops at `Not logged in`).
   Anthropic documents `claude -r "<id>" "query"` (resume, then send a
   prompt). The folder layout itself is not a documented API.
8. **Usage-limit wording** (2.1.236): `You've hit your <session|weekly|Opus|
   Sonnet|…> limit · resets …`, `Usage limit reached …`, `You're out of usage
   credits`. Only used to offer the handoff; a miss just hides the banner.

Automated re-check: `cargo test --test real_cli -- --ignored` (includes the
sign-in parser and the conversation handoff against the real CLI).

## Continuing a conversation in another account

Claude Switch copies the conversation's files byte for byte; it never parses
them:

| Copied | From → to |
| --- | --- |
| Transcript | `projects/<folder>/<id>.jsonl` (replaced only if the existing copy is a byte prefix of the source) |
| Subagent and tool output | `projects/<folder>/<id>/` (missing or newer files) |
| `/rewind` checkpoints | `file-history/<id>/` (missing or newer files) |

Long folder names (over 200 characters) end in a hash Claude Switch does not
reproduce; the folder is found by its prefix when that is unambiguous, and the
target uses the same name. The source can be any account or `~/.claude`, which
is only read. The target must be a signed-in account.

**VS Code family.** Documented (code.claude.com/docs/en/vs-code): the
`environmentVariables` extension setting sets variables for the Claude
process, and "a `CLAUDE_CONFIG_DIR` entry applies only when its value is an
absolute path"; the URI handler `vscode://anthropic.claude-code/open` takes
`session` ("a session ID to resume … must belong to the workspace currently
open in VS Code. If the session isn't found, a fresh conversation starts") and
`prompt` ("pre-filled but not submitted"), and opens in the focused window.
Checked in the extension's code (2.1.310): the entry replaces the window's own
`CLAUDE_CONFIG_DIR`, the setting is machine-scoped (user settings only) and is
read again for each new Claude tab, so it switches every window's new tabs
while running tabs keep their process. Claude Switch therefore focuses the
project's window with the editor's launcher before sending the link.
Also checked in 2.1.310's code and logs: when the setting's
`CLAUDE_CONFIG_DIR` changes, the extension refreshes every webview's account
(the new email shows) but leaves running processes alone, the Claude sidebar
included; the sidebar is a webview view kept alive while hidden, so it cannot
be closed; the link only reveals a session the sidebar holds, with its old
process; and after a window reload, restored tabs and the sidebar resume
their session (`resume: <id>`) with the setting's folder. Each process is a
child of the window's extension host and is listed in
`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` with `sessionId` and `cwd`. Claude
Switch writes only that one entry, keeps a backup, and shows the state in
Settings → Editors. The Claude Switch VS Code extension uses the same setting
(through VS Code's configuration API, which refuses to write it unless the
Claude Code extension is installed) and the same link, sent from the window
itself. It refuses to override a `CLAUDE_CONFIG_DIR` the user set
there when merely opening a folder; the handoff dialog states that it will
replace it.

## Isolation by sign-in method

| Method | `authMethod` | Isolated | Source |
| --- | --- | --- | --- |
| Claude subscription | `claude.ai` | Yes | Verified (items 1–2); documented |
| Console, API key created at sign-in | `api_key` | Yes | Documented ("each directory has its own … claude.ai login or API key"); not verified locally (no Console account) |
| Console without API key (2.1.242+) | not documented | **No** | Documented: "Separate directories don't keep two Claude Console sign-ins without an API key apart" (stored as an Anthropic profile in `~/.config/anthropic`) |
| Anthropic profile / WIF | varies | **No** | Documented: profiles live in `~/.config/anthropic` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `oauth_token` | **No** if from env | Removed from child env; may still come from settings |
| `apiKeyHelper` | `api_key_helper` | **No** (may be global) | — |
| Bedrock / Vertex / Foundry | `third_party` | **No** | Credentials come from the cloud provider |

Claude Switch records `authenticated` only for `claude.ai` and `api_key`.
Anything else that is signed in is recorded as **unsupported isolation** with an
explanation. If Claude Code reports a `configDirectory` different from the
profile, that is also unsupported isolation (for example a managed setting
overriding `CLAUDE_CONFIG_DIR`).

Existence checks only (contents are never read):
- `~/.config/anthropic` (or `$ANTHROPIC_CONFIG_DIR`): warning that Anthropic
  profiles are shared and some outrank each account's login.
- `/Library/Application Support/ClaudeCode/managed-settings.json` or the
  `com.anthropic.claudecode` managed preferences: warning that policy may force
  a login method or organization or override the configuration folder.

## Environment precedence

Anthropic's documented credential order (highest first): cloud provider
switches (`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`), `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic
profiles, then the `/login` subscription credential.

Children therefore get an **allowlisted** environment (see `src-tauri/src/env.rs`):
`HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, locale, proxy and CA variables,
`SSH_AUTH_SOCK`, `EDITOR`/`VISUAL`; a deterministic `PATH`; validated custom
variables; `TERM`/`COLORTERM` for terminals; and `CLAUDE_CONFIG_DIR` last.
Everything else is dropped. Inherited variables that affect authentication are
reported by name in the UI. Examples: `ANTHROPIC_*`, `CLAUDE_CODE_*`,
`CLAUDE_CONFIG_DIR`, `AWS_BEARER_TOKEN_BEDROCK`, and `CLAUDECODE` (which makes
Claude Code think it is nested in another session).

Limitations that remain:
- A profile's own `settings.json` `env` block, and managed settings, can still
  set credentials; the resulting `authMethod` is reported.
- Shell sessions source the user's shell profile, which may export anything.
- Commands Claude Code runs use a snapshot of the user's login shell
  environment (Claude Code behavior).

## Profile path

`~/.claude-switch/profiles/<uuid>`, mode 0700, never derived from a name.
Profiles live outside `~/Library/Application Support` because that path
contains a space. `CLAUDE_CONFIG_DIR` flows into `${CLAUDE_PLUGIN_ROOT}` and hook
commands, which plugins often leave unquoted.

## Things deliberately not done

- No custom OAuth, token refresh, or credential storage.
- No reading, copying, parsing or migrating credential files or Keychain items.
- No scraping of account pages; email/organization come only from
  `claude auth status`. Subscription plan and usage are not displayed; a
  usage-limit message in a session only offers the handoff.
- Conversation files are copied, never parsed or shown, and never stored in
  the app's database.
- No use of `claude setup-token` or long-lived tokens.
