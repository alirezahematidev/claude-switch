# Building, signing and notarizing

## Build

```bash
pnpm install --frozen-lockfile
pnpm verify           # must pass
pnpm test:e2e
pnpm app:build        # → src-tauri/target/release/bundle/{macos,dmg}/
                      #   (packages vscode-extension first and bundles the .vsix)
```

Universal binary (Apple silicon + Intel):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm ext:package
pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.release.json
```

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
pnpm ext:package
pnpm tauri build --target universal-apple-darwin --config src-tauri/tauri.release.json
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
VERSION=0.1.0
gh release create "v$VERSION" \
  "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Claude Switch_${VERSION}_universal.dmg" \
  --title "Claude Switch $VERSION" --notes "…"
```

## Versioning

Bump `version` in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` together. Database changes need a new migration
appended in `src-tauri/src/db.rs`; never edit a shipped one. Older app versions
refuse a newer database instead of corrupting it.
