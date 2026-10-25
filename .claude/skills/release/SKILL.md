---
name: release
description: Builds a universal (Apple silicon + Intel) Claude Switch release for a new version and publishes it as a GitHub release with the DMG and the VS Code extension. Use only when the user runs /release with patch, minor, major or an explicit MAJOR.MINOR.PATCH version.
argument-hint: "<patch | minor | major | MAJOR.MINOR.PATCH>"
disable-model-invocation: true
allowed-tools: Bash(node scripts/release.mjs:*), Bash(rustup target add:*), Bash(pnpm app:release:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git fetch:*), Bash(git ls-remote:*), Bash(git describe:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git push origin main), Bash(gh auth status), Bash(gh release:*), Bash(ls:*)
---

# Release Claude Switch

Release `$ARGUMENTS`: `patch`, `minor` or `major` (bumped from the version in
`package.json`), or an explicit `MAJOR.MINOR.PATCH`.

Work from the repository root. Run the steps strictly in order, one command
at a time, and stop at the first failure: report what failed and its output,
and do not continue, retry with other flags, or skip ahead. Shell variables do
not carry over between commands, so write the resolved version (`<version>`
below) literally into every command.

## 0. Check before changing anything

1. Resolve the version; this changes nothing:
   ```bash
   node scripts/release.mjs --resolve $ARGUMENTS
   ```
   It prints the version, for example `0.2.0`. That is `<version>` from here
   on. If it prints an error, stop and show it.
2. The working tree is clean and on `main`, level with GitHub:
   ```bash
   git status --porcelain
   git rev-parse --abbrev-ref HEAD
   git fetch origin main --tags
   git rev-parse HEAD origin/main
   ```
   Stop and tell the user if there are uncommitted changes, the branch is not
   `main`, or the two hashes differ.
3. The release does not exist yet. This must print nothing:
   ```bash
   git ls-remote --tags origin refs/tags/v<version>
   ```
4. GitHub CLI is signed in: `gh auth status`.
5. Signing: if `APPLE_SIGNING_IDENTITY` is not set in the environment, the DMG
   will be unsigned and other Macs will block it. Ask the user whether to
   publish an unsigned build before going on, and stop if they say no.

## 1. Install the Rust targets

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

## 2 and 3. Package the extension and build, with release.mjs

```bash
pnpm app:release <version>
```

`scripts/release.mjs` sets `<version>` in `package.json`,
`vscode-extension/package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, then runs, in order:

1. `pnpm ext:package`
2. `pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.release.json`

Do not run `pnpm ext:package` on its own before this: it would package the
extension with the previous version.

The build takes several minutes: run it in the background and wait until it
finishes. If it fails, put the version files back (the tree was clean before)
with `git checkout -- package.json vscode-extension/package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`
and stop.

Then confirm the DMG and the extension exist:

```bash
ls -l "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_<version>_universal.dmg"
ls -l "src-tauri/target/universal-apple-darwin/release/bundle/claude-switch-vscode-<version>.vsix"
```

## 4. Commit the version and publish the release

### 4a. Commit and push the version change

Commit only the version files, so the release tag includes them:

```bash
git add package.json vscode-extension/package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): v<version>"
git push origin main
git rev-parse HEAD
```

The last command prints `<sha>`, the commit to tag.

### 4b. Write the release notes

List the commits since the previous release (`HEAD~1` skips the release
commit itself):

```bash
git describe --tags --abbrev=0 HEAD~1
git log --no-merges --pretty=format:'- %s' <previous tag>..HEAD~1
```

If there is no previous tag, use `git log --no-merges --pretty=format:'- %s' HEAD~1`.
Write short notes for people who use the app, not for developers:

- `## What's new` and `## Fixes` sections, each a short list in plain
  language. Merge related commits; leave out chores, CI, tests and docs
  unless users notice them. Drop an empty section.
- End with: `Download **Claude Switch_<version>_universal.dmg** below (Apple silicon and Intel), open it, and drag Claude Switch into Applications. Only use VS Code? Install **claude-switch-vscode-<version>.vsix** with Extensions → … → Install from VSIX…; it works without the app.`
- If the user agreed to an unsigned build in step 0, add:
  `This build is not signed with an Apple Developer ID.`

### 4c. Create the release

With the notes in place of `<notes>`. Keep the closing `EOF` at the very
start of its line:

```bash
gh release create v<version> \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_<version>_universal.dmg" \
  "src-tauri/target/universal-apple-darwin/release/bundle/claude-switch-vscode-<version>.vsix" \
  --title "Claude Switch <version>" --target <sha> --notes "$(cat <<'EOF'
<notes>
EOF
)"
```

## 5. Report

Reply with the release URL that `gh` printed, the version, the DMG's and the extension's sizes,
and whether the build was signed. If a step failed, say which one, what it
printed, and what is already done (for example: built and pushed, release not
created yet).
