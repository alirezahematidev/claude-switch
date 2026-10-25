# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub:
[**Report a vulnerability**](https://github.com/alirezahematidev/claude-switch/security/advisories/new)
(the repository's *Security* tab → *Report a vulnerability*).

Include what you can of:

- what an attacker can do, and what they need first (local user, a crafted
  project folder, a malicious terminal program, …);
- steps or a proof of concept;
- the Claude Switch version, macOS version and Claude Code version
  (`claude --version`).

Do not include real tokens, sign-in links or conversation content. If you need
to show one, use a made-up value.

This is a volunteer project. Reports are acknowledged as soon as possible,
normally within a week. A fix, an advisory and a credit (if you want one) follow
once the issue is confirmed. Please give us a reasonable time to ship a fix
before you publish details.

## Supported versions

Only the [latest release](https://github.com/alirezahematidev/claude-switch/releases/latest)
gets security fixes.

## Scope

In scope: the Claude Switch app (Rust backend, webview, IPC, the local socket)
and the bundled VS Code extension. Examples: one account's login or
conversations reaching another account's profile, files written outside the
managed folders, command execution from the webview or the socket, secrets in
logs or diagnostics.

Out of scope:

- Claude Code itself, the Claude Code VS Code extension, and Anthropic's
  services. Report those to Anthropic.
- Attacks that already need the same macOS user's full access (that user can
  read the profile folders directly).
- Unsigned or self-built copies of the app being blocked or flagged by
  Gatekeeper.

How the app is designed to resist these attacks, and the limits it accepts, is
described in [docs/SECURITY.md](docs/SECURITY.md).
