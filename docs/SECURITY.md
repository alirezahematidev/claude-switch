# Security

## Assets and threats

| Asset | Threat | Primary control |
| --- | --- | --- |
| Each account's Claude login | Used by the wrong account; leaked | Claude Code keeps logins in the Keychain per profile; Claude Switch never reads them |
| Profile folders | Shared between accounts, redirected, deleted by mistake | UUID-derived paths, exact-path verification, symlink and ownership checks |
| Project folders | Modified or deleted | Never written; removing a project only deletes the database row |
| Conversations | Copied to the wrong place, overwritten, leaked | Copied only on request between verified profiles; never parsed, logged or stored; a diverged copy is never replaced |
| Editor user settings | Corrupted or silently changed | One entry, on request; JSONC edited in place, backup first, atomic replace, re-read check |
| Extension socket | Used by another user or to run arbitrary actions | 0600 socket in the 0700 managed folder, peer uid must match, five fixed methods, input limits; no method runs a program |
| The user's machine | Arbitrary command execution from the UI | No generic exec or file APIs; fixed argv; capability allowlist |
| Logs and diagnostics | Leaking secrets or personal data | Nothing sensitive is logged; mandatory redaction as a second layer |

The webview loads only bundled assets, so the main untrusted inputs are IPC
arguments, terminal output (rendered by xterm.js as text, never HTML), and the
environment the app was launched with.

## Boundaries

1. **Webview → Rust.** The capability file (`src-tauri/capabilities/main.json`)
   grants only the app's own commands (each declared in `build.rs`), plus event
   listen/unlisten, window dragging and theme. No filesystem, shell, HTTP,
   dialog or opener permissions are granted to the webview. Native dialogs are
   opened from Rust, so the UI never supplies a filesystem path:
   - projects are added only through the native folder picker;
   - Finder reveals take an ID (`profile`/`project`) or a fixed managed folder;
   - sessions start in a registered project or the home folder only.
2. **Every ID is re-validated in Rust** (canonical UUID), and the referenced
   record must exist. State changes go through the session state machine.
3. **Rust → processes.** Programs are absolute paths with argv arrays (no
   shell strings). The only programs are the resolved Claude Code executable
   (`claude`, `claude --continue`, `claude --resume <uuid> [message]`,
   `claude auth login|status|logout`), the user's login shell (validated
   against `/etc/shells`), an editor launcher found inside a known VS
   Code–family app bundle (`--new-window <project>`, or `<project>` for a
   handoff), and `/usr/bin/open -a <that editor's app> <link>` with a link
   built in Rust from the session UUID and a percent-encoded message, and the
   editor launcher with `--install-extension <bundled vsix> --force`.
   A login email must look like an address and may not start with `-`; a
   handoff message may not start with `-` or contain control characters
   (≤ 2000 characters).
4. **Editor extension → Rust.** The socket (`editor_bridge.rs`) accepts
   only the current user (file mode and `getpeereid`), one request of at most
   64 KB per connection, and only `status`, `accounts`, `conversations`,
   `continue` and `show`. Unknown parameters are rejected. A directory must be
   absolute, existing and outside Claude Switch's folders; it is canonicalized
   and only selects which conversation folder to read. `continue` is the same
   copy as the in-app handoff (signed-in target, verified profiles, prefix
   rule). `show` takes only an account UUID. A stale socket is replaced only if
   it is a socket nobody answers on; anything else at that path is left alone.
   Other same-user processes can use the socket too, but they could already
   read and write these files directly.
5. **Sign-in codes.** `submit_login_code` only writes to a running
   `claude auth login` session, only before it finishes, and only a single
   token without whitespace or control characters (≤ 4 KB). The sign-in URL
   parsed from Claude Code's output is held in memory, shown only by host, and
   opened only through `open_external_url` (https). Neither is logged.

## Filesystem rules (`paths.rs`)

- Managed folders are created mode 0700. A managed folder that is a symlink or
  owned by someone else is refused.
- A profile path is `profiles_root/<uuid>`, created with `create_dir`, which
  fails if anything exists, so an existing configuration is never reused.
- Before every launch, the stored path must equal the derived path exactly and
  be a real directory. A missing profile blocks the launch; there is never a
  fallback to another folder or to `~/.claude`. Only explicit re-authentication
  recreates a missing profile.
- Deletion requires the account name typed exactly (checked in Rust). It removes
  only a real directory whose canonical parent is the profiles root.
  `remove_dir_all` does not follow inner symlinks.
- Projects are stored by canonical path. `/` and Claude Switch's own folders are
  rejected.

## Conversation handoff

- The UI passes only IDs (project, conversation UUID, accounts, editor) and
  the message. Rust derives every path: both profiles are verified like a
  launch; the source may also be `~/.claude`, which is only read.
- Only `projects/<folder>/` and `file-history/<id>/` in the target profile are
  written: directories 0700, files 0600, via a temporary file and a rename.
  Symlinks are never followed or created, and a symlinked target folder is
  refused.
- An existing transcript in the target is replaced only when it is a byte
  prefix of the source (an earlier state of the same conversation).
- The usage-limit detector keeps only a boolean per session in memory.
- Editor settings: only the `CLAUDE_CONFIG_DIR` entry of
  `claudeCode.environmentVariables` in the editor's user `settings.json` is
  written, on request; the previous file is saved to
  `ClaudeSwitch/backups/editor-settings/` (0600, last 10 kept). Unreadable
  settings are never rewritten.

## Secrets

- SQLite stores no passwords, tokens, cookies, sign-in URLs, terminal output or
  conversations. The login email typed for `--email` is passed to Claude Code
  and not saved. Tests scan the database (including the WAL) for these.
- Custom environment variables cannot use reserved names, auth-affecting names,
  or names that look like secrets (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …).
- Logs never include environment values, CLI output or terminal content. Every
  line also passes through `logging::redact`: URLs are cut to scheme and host,
  and keys, tokens, `key=value` secrets and email addresses are removed. Log
  files are 0600, rotated at 2 MB.
- Diagnostics contain versions, paths, counts, variable *names* and redacted
  logs. They exclude account names, emails and values.
- `open_external_url` accepts only http(s) links and does not log them, since
  terminal links can be sign-in URLs. Handoff messages and editor links are
  not logged either.

## Webview hardening

- CSP: `default-src 'self'`, `script-src 'self'`, `connect-src ipc:
  http://ipc.localhost`, `object-src 'none'`, `base-uri 'none'`, `form-action
  'none'`, `frame-ancestors 'none'`. `style-src` allows inline styles, which
  xterm.js and Radix require.
- `withGlobalTauri: false`; no `eval` or `new Function` (oxlint enforced).
- `freezePrototype` is **off**: xterm.js assigns to built-in prototypes when its
  module loads, which fails under a frozen prototype (verified). The other
  controls above make this acceptable for a webview with no remote content.

## Process hygiene

Each session leads its own process group. Stopping signals the whole group
(SIGHUP, then SIGTERM, then SIGKILL), and quitting stops every session.
Processes that deliberately start a new session (daemonize) can escape the
group; that is inherent to Unix process groups.

## macOS

Hardened Runtime with no entitlement exceptions. The app is not sandboxed: it
must run the user's Claude Code executable and shell in arbitrary project
folders. It needs no administrator privileges and does not change system
security settings.

## Test coverage

`src-tauri/tests/security.rs`, `tests/ipc.rs` (real capability file), `tests/logging_secrets.rs`,
unit tests in `paths.rs`, `env.rs`, `domain.rs`, `logging.rs`, `settings.rs`.
