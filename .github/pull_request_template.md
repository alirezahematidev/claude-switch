## Summary

<!-- What does this change, and why? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Tests added or changed, and anything you checked by hand (macOS version, Claude Code version). -->

## Checklist

- [ ] `pnpm verify` passes
- [ ] `pnpm test:e2e` passes (for UI changes; checked the screenshots in `e2e-screens/`)
- [ ] Ran `pnpm bindings` if Rust types shared with the UI or extension changed
- [ ] Updated the README or `docs/` for user-visible changes
- [ ] Updated `docs/SECURITY.md` if this changes a security rule (IPC, paths, environment, socket, logging)
- [ ] No tokens, emails, sign-in links or personal paths in code, tests or screenshots
