# Contributing to Claude Switch

Thanks for helping. Bug reports, fixes, docs and tests are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go through [private reporting](SECURITY.md), not issues.

## Before you start

- **Bugs:** search the [issues](https://github.com/alirezahematidev/claude-switch/issues)
  first, then open one with the bug template. *Settings → Troubleshooting →
  Copy Diagnostics* gives a report that is already stripped of names, emails,
  tokens and environment values.
- **Features and larger changes:** open an issue first so we can agree on the
  approach before you write the code. Changes that touch the security
  boundaries (see below) especially need this.
- **Small fixes** (typos, obvious bugs, tests) can go straight to a pull
  request.

## Development setup

You need macOS 13 or later, Node.js 20.19+, pnpm 12, Rust (stable, 1.85+) and
the Xcode Command Line Tools. Claude Code is optional: the test suites use a
mock `claude` executable and never sign in.

```bash
pnpm install
pnpm app:dev                                # run the app (Vite + Tauri)
CLAUDE_SWITCH_HOME=/tmp/cs pnpm app:dev     # debug builds only: sandboxed data folder
```

Use `CLAUDE_SWITCH_HOME` while developing so you don't touch your real
accounts and profiles.

The [README](README.md#development) lists every script, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Make the change, with tests. Rust tests live next to the code and in
   `src-tauri/tests/`; UI tests are `*.test.tsx` next to components; the VS
   Code extension has its own tests in `vscode-extension/test/`.
3. Run the checks CI runs:

   ```bash
   pnpm verify      # types, oxlint, oxfmt, unit tests, rustfmt, clippy, Rust tests
   pnpm test:e2e    # Playwright flows and layout sweep (uses installed Google Chrome)
   ```

   `pnpm format` and `pnpm rust:fmt` fix formatting.
4. Open a pull request and fill in the template.

Some changes need an extra step:

- **Rust types shared with the UI or the extension:** run `pnpm bindings` and
  commit the regenerated files in `src/bindings/` and
  `vscode-extension/src/bindings/`. Don't edit those files by hand.
- **Database:** append a new migration in `src-tauri/src/db.rs`. Never edit a
  migration that has shipped.
- **New IPC command:** declare it in `src-tauri/build.rs` and allow it in
  `src-tauri/capabilities/main.json`.
- **UI layout:** check the screenshots `pnpm test:e2e` writes to
  `e2e-screens/`.
- **User-visible behavior:** update the README, and `docs/` where relevant.

## Security-sensitive areas

Claude Switch handles separate sign-ins side by side, so a small slip can let
one account's data reach another. Changes in these places get a closer
review, and should update [docs/SECURITY.md](docs/SECURITY.md) when they
change a rule:

- `src-tauri/capabilities/`, `build.rs`, `commands.rs`: what the webview can call.
- `paths.rs`, `env.rs`: profile folders and the environment given to Claude Code.
- `editor_bridge.rs`: the local socket the VS Code extension uses.
- `transcripts.rs`, `editor_settings.rs`: copying conversations and editing
  editor settings.
- `logging.rs`: redaction.

The ground rules: the UI passes IDs, never paths; programs run with fixed
argument arrays, never shell strings; nothing secret is stored or logged.

## Pull requests

- Keep each pull request to one change; split unrelated work.
- Use a short, imperative title, ideally with a
  [Conventional Commits](https://www.conventionalcommits.org/) prefix:
  `fix: keep sessions when the window closes`, `feat: …`, `docs: …`.
  Pull requests are squash-merged, so the title becomes the commit message.
- CI (`verify`) must pass and a maintainer must approve before merging.
- Don't bump versions; that happens at release time
  ([docs/RELEASE.md](docs/RELEASE.md)).

## License

Claude Switch is released under the [MIT License](LICENSE). By contributing,
you agree that your contributions are released under the same license.
