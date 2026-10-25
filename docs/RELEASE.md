# Building, signing and notarizing

## Build

```bash
pnpm install --frozen-lockfile
pnpm verify           # must pass
pnpm test:e2e
pnpm app:build        # → src-tauri/target/release/bundle/{macos,dmg}/
                      #   (packages vscode-extension first and bundles the .vsix)
```

`pnpm ext:package` builds the extension's helper (`src-tauri/helper`) for both
architectures into one binary (`lipo`), so it needs both Rust targets too, and
packages it in `vscode-extension/claude-switch-vscode.vsix`. The helper is a
plain executable inside the extension, ad-hoc signed as the Rust toolchain
builds it; for distribution, sign it with the Developer ID too (see below).

Universal release (Apple silicon + Intel), with the version to release:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once
pnpm app:release 0.2.0
# → src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_0.2.0_universal.dmg
# → src-tauri/target/universal-apple-darwin/release/bundle/claude-switch-vscode-0.2.0.vsix
```

`pnpm app:release <version>` ([scripts/release.mjs](../scripts/release.mjs))
writes the version into every manifest (see [Versioning](#versioning)),
packages the VS Code extension with it, then runs
`pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.release.json`.
Arguments after the version go to `tauri build` (for example `--verbose`).
Instead of a version you can pass `patch`, `minor` or `major` to bump the
current one; `node scripts/release.mjs --resolve minor` prints the result
without changing anything. Commit the version change with the release.

In Claude Code, `/release <patch | minor | major | version>`
([.claude/skills/release](../.claude/skills/release/SKILL.md)) does the whole
release: checks that `main` is clean and level with GitHub, installs the Rust
targets, runs `pnpm app:release`, commits and pushes the version change, then
creates the GitHub release with the DMG, the extension's `.vsix` (for people
who only use VS Code) and release notes. It asks before publishing an
unsigned build. Publishing the extension to the VS Code Marketplace is a
separate step (see [VS Code Marketplace](#vs-code-marketplace-and-open-vsx)). Run `pnpm verify` and `pnpm test:e2e` first.

An unsigned build runs locally. Other Macs will block it with Gatekeeper.
Don't ask users to disable Gatekeeper; sign and notarize instead.

## Prerequisites for distribution

- Apple Developer Program membership.
- A **Developer ID Application** certificate in your login keychain
  (Xcode → Settings → Accounts → Manage Certificates, or developer.apple.com).
  Check with:
  ```bash
  security find-identity -v -p codesigning
  # "Developer ID Application: Your Name (TEAMID)"
  ```
- Notarization credentials, one of:
  - App Store Connect API key (recommended for CI): `APPLE_API_ISSUER`,
    `APPLE_API_KEY` (key ID), `APPLE_API_KEY_PATH` (path to the `.p8`).
  - Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password),
    `APPLE_TEAM_ID`.

## Sign and notarize

The Tauri CLI signs (Hardened Runtime, `src-tauri/Entitlements.plist`),
notarizes and staples when these variables are set:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_API_ISSUER=... APPLE_API_KEY=... APPLE_API_KEY_PATH=~/keys/AuthKey_XXXX.p8
pnpm app:release 0.2.0
```

For CI without a keychain, also set `APPLE_CERTIFICATE` (base64 of the `.p12`)
and `APPLE_CERTIFICATE_PASSWORD`; Tauri imports it into a temporary keychain.

The identity is read from the environment, so `signingIdentity` stays `null` in
`tauri.conf.json` and no certificate details are committed.

## Verify

```bash
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Claude Switch.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements - "$APP"          # expect no exception entitlements
spctl --assess --type execute --verbose "$APP"  # "accepted, source=Notarized Developer ID"
xcrun stapler validate "$APP"
```

Then run the [manual checklist](MANUAL_TESTING.md) on a clean Mac or user account.

## Publish

The README sends users to the latest GitHub release for the `.dmg`. Attach
the signed, notarized universal build to a release tagged with the version:

```bash
VERSION=0.2.0
gh release create "v$VERSION" \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_${VERSION}_universal.dmg" \
  --title "Claude Switch $VERSION" --notes "…"
```

### VS Code Marketplace and Open VSX

The extension contains a macOS binary (the helper), so it is published for
macOS only (`darwin-arm64` and `darwin-x64`, the same universal binary in
each); the Marketplace then does not offer it on Windows or Linux.

Once:

1. Create a publisher at <https://marketplace.visualstudio.com/manage> (a
   Microsoft account). Its ID must equal `"publisher"` in
   `vscode-extension/package.json` and the prefix of `EXTENSION_ID` in
   `src-tauri/core/src/editors.rs` (the app finds the installed extension by
   it); change both together. `claude-switch` is taken by someone else.
2. Create an Azure DevOps personal access token with the **Marketplace →
   Manage** scope and *All accessible organizations*, then
   `npx vsce login <publisher>`.

Each release, after `pnpm app:release`:

```bash
pnpm ext:publish        # builds, then: vsce publish --target darwin-arm64 darwin-x64
```

Cursor and Windsurf install extensions from [Open VSX](https://open-vsx.org)
instead. With a namespace and token from open-vsx.org:

```bash
cd vscode-extension
npx ovsx publish --target darwin-arm64 darwin-x64 -p <token>
```

The listing uses `vscode-extension/README.md`, `icon.png` and `LICENSE`.
"Claude" and "Claude Code" are Anthropic's trademarks; the README says the
extension is not affiliated with Anthropic.

## Versioning

The version lives in `package.json`, `vscode-extension/package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`;
`pnpm app:release <version>` sets all of them. Versions are `MAJOR.MINOR.PATCH`
(macOS bundle versions are numeric). Database changes need a new migration
appended in `src-tauri/src/db.rs`; never edit a shipped one. Older app versions
refuse a newer database instead of corrupting it.

## Icons and social preview

The SVG sources live in `assets/`; the PNG, `.icns` and `.ico` files are
generated from them with the Tauri CLI. Generate into a temporary folder and
copy only the files the app uses (the CLI also writes Windows Store, Android
and iOS icons, which this project doesn't ship):

```bash
OUT=$(mktemp -d)
pnpm tauri icon assets/app-icon.svg -o "$OUT/app"          # app, Dock, Finder, DMG
cp "$OUT"/app/{32x32,64x64,128x128,128x128@2x}.png "$OUT"/app/icon.{icns,ico,png} src-tauri/icons/
pnpm tauri icon assets/tray-template.svg --png 44 -o "$OUT/tray"   # menu bar (template image)
cp "$OUT/tray/44x44.png" src-tauri/icons/tray-template.png
pnpm tauri icon assets/extension-icon.svg --png 128 -o "$OUT/ext"  # VS Code extension
cp "$OUT/ext/128x128.png" vscode-extension/icon.png
```

The repository's social preview (1280×640, under 1 MB) is rendered from
`assets/social-preview.html` with Chrome, then uploaded in the repository's
**Settings → General → Social preview** (GitHub has no API for it):

```bash
pnpm exec playwright screenshot --channel chrome --viewport-size=1280,640 \
  "file://$PWD/assets/social-preview.html" assets/social-preview.png
```
