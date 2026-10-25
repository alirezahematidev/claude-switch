# Manual test checklist

These checks need real Claude accounts, a browser, and macOS UI. They cannot run
in CI. Use two accounts you control (A and B), ideally on different
organizations or plans. Record the Claude Code version (`claude --version`).

## 1. Install and first run
- [ ] Release `.app` opens (signed builds: no Gatekeeper warning).
- [ ] First run shows the welcome guide; the system check finds Claude Code and
      shows its version.
- [ ] With `ANTHROPIC_API_KEY` exported in a terminal and the app started from
      that terminal (`open -a "Claude Switch"` does not pass env; use
      `.../Contents/MacOS/claude-switch`), the environment warning lists it by
      name, never by value.

## 2. Isolation with real logins (subscription)
- [ ] Add account A and start sign-in. The sign-in screen shows the host
      (claude.com), the browser opens by itself, and **Open Sign-In Page** /
      **Copy Link** work. Finish in the browser (including the email link);
      the screen turns green and A shows **Signed in** with A's email.
- [ ] Repeat, but complete sign-in from the copied link in a different
      browser so the page shows a code: paste it and press Return; it signs in.
      A wrong code shows the "didn't accept that code" message and **Try Again**.
- [ ] Add account B, sign in as B. B shows B's email; **A still shows Signed in**.
- [ ] Start a Claude session for A and run `/status`: email is A's.
- [ ] At the same time start a session for B: `/status` shows B; A's session still
      shows A.
- [ ] Quit and reopen Claude Switch: both accounts still signed in, with no
      new sign-in required.
- [ ] Keychain Access shows separate *Claude Code-credentials…* items for A and B.
      Note any Keychain permission prompt and when it appeared.
- [ ] Your normal `claude` in Terminal (no `CLAUDE_CONFIG_DIR`) is unaffected.

## 3. Expiry, failure and cancellation
- [ ] In A's session run `/logout`, exit. A becomes **Sign-in required** (checked
      after exit), with the last verified time kept. B unaffected.
- [ ] Start sign-in and close the tab before finishing: A shows **Sign-in
      failed** ("cancelled"); retry works.
- [ ] If possible, revoke a session from claude.ai settings, then press *Check
      status*. Record what `claude auth status` reports.

## 4. Console accounts (if available)
- [ ] Sign in with *Anthropic Console* and choose **Create an API key**. Account
      shows **Signed in** (`api_key`) and a second Console account stays separate.
- [ ] Sign in with Console **without** an API key (Claude Code 2.1.242+). Expect
      **Limited isolation**, or document the actual `authMethod` reported.

## 5. Terminal
- [ ] Typing, paste (⌘V), copy selection (⌘C), scrollback, resize the window
      (Claude Code redraws), ⌘K clears, ⇧↩ inserts a newline in Claude Code.
- [ ] Persian/Unicode: `echo "سلام دنیا ✓ 你好"` in a shell renders (no bidi
      reordering; xterm.js limitation).
- [ ] Clicking a URL in the terminal opens the browser.
- [ ] Close a running tab: confirmation, process gone (`ps -ax | grep claude`),
      including tools it started.
- [ ] Exit Claude Code: the tab shows the exit code with *Restart*/*Close*.

## 6. Projects and editors
- [ ] Add a project with the folder picker; open it with A and with B at the same
      time; each `/status` shows the right account and folder.
- [ ] Favorite, rename, remove the project: folder contents unchanged
      (`git status` clean, `CLAUDE.md` untouched).
- [ ] Rename the folder in Finder: project shows *Folder missing*; launch is
      refused with a clear error.
- [ ] **Open in VS Code** with account A (VS Code already running with other
      windows): a new window opens on the folder; in its terminal
      `echo $CLAUDE_CONFIG_DIR` shows A's profile and `claude` → `/status` shows
      A; the Claude Code extension panel is signed in as A.
- [ ] Repeat with account B on another folder: B's window uses B while A's
      window keeps A. With the folder already open, note that VS Code focuses
      the existing window (documented limitation).

## 7. Continuing in another account
- [ ] In a project, start a Claude session for A and have a short exchange
      ("remember the word pineapple"). Open **Continue in Another Account**
      (⇧⌘C): the conversation is first, from A, "just now".
- [ ] Continue with B in Claude Switch: a new tab opens with B, the history is
      shown, and Claude answers the sent message knowing the word. `/status`
      shows B. A's tab and transcript are unchanged.
- [ ] Hand it back from B to A: A continues with B's later messages.
- [ ] If A actually reaches a usage limit: the tab shows the yellow usage
      limit banner; **Continue in Another Account** preselects that
      conversation.
- [ ] In VS Code (opened with A from Claude Switch), chat in the Claude panel,
      then continue that conversation with B in VS Code: Claude Switch shows
      what changes; VS Code's user `settings.json` gains one
      `CLAUDE_CONFIG_DIR` entry (comments intact), a backup appears in
      `~/Library/Application Support/ClaudeSwitch/backups/editor-settings`,
      the project's window comes forward and a new Claude tab shows the
      conversation with the message prefilled; sending it answers as B.
      Note whether VS Code asked to allow the link.
- [ ] Another VS Code window: a new Claude tab uses B too; the old tab still A.
- [ ] Settings → Editors shows VS Code using B; switching to *Per window*
      removes the entry; opening a folder with A then gives A again.
- [ ] With your own `CLAUDE_CONFIG_DIR` entry in VS Code settings, **Open in
      VS Code** refuses with an explanation and does not change the file.
- [ ] A conversation from your normal `claude` (no Claude Switch) in a
      registered project is listed as "Default folder (~/.claude)" and can be
      continued; nothing in `~/.claude` changes.

## 8. VS Code extension
- [ ] Settings → Editors → **Install** for VS Code: the row shows *Installed
      (0.1.0)*; VS Code shows the account button next to Claude Code's in the
      editor title bar and the account name in the status bar (no reload).
- [ ] The status bar shows the right account for a window opened from Claude
      Switch with A, for one opened normally (*Claude: default*), and after
      choosing B (all windows).
- [ ] In a Claude tab with a conversation, click the button → B → **Continue
      this conversation**: the tab closes, a new one opens with the history and
      "Continue where you left off." in the box; sending it answers as B
      (`/status`). `settings.json` has one `CLAUDE_CONFIG_DIR` entry.
- [ ] With `claudeCode.preferredLocation` set to `sidebar`, chat in the Claude
      sidebar as A, then click the button → B → **Continue this
      conversation**: its detail says the window reloads; after the reload the
      sidebar shows the same conversation and answers as B (`/status`,
      `/usage`). With **Only switch** instead, the status bar turns yellow and
      the message offers **Reload Window**, with the same result.
- [ ] **New conversation** and **Only switch** behave as described; **Per
      window** removes the entry.
- [ ] Choosing a signed-out account offers **Open Claude Switch**, which opens
      that account's page.
- [ ] Quit Claude Switch, then use the button: the app starts in the menu bar
      and the switcher opens.
- [ ] Cursor or Windsurf (if installed, with Claude Code's extension): install
      and switch work there too.
- [ ] A remote (SSH) window: the button explains it is for local windows.

## 9. macOS integration
- [ ] Menu bar icon: per-account *New Claude Session* and recent projects work
      with the window closed.
- [ ] With two or more accounts the menu bar icon offers *Continue in Another
      Account…*, which opens the window and the dialog.
- [ ] Accounts menu ⌘1–⌘9, ⌘P switcher, ⌘T/⇧⌘T, ⌘W, ⇧⌘[ / ⇧⌘].
- [ ] Global shortcut set in Settings brings the app forward from another app;
      an invalid or taken shortcut shows an error and is not saved.
- [ ] Closing the window keeps sessions running; Dock click reopens it.
- [ ] ⌘Q with sessions running asks for confirmation; *Quit and Stop Sessions*
      leaves no `claude` processes.
- [ ] Notification appears when a background session ends (window unfocused).
- [ ] *Open at login*: log out and in, app starts hidden in the menu bar;
      turning it off removes `~/Library/LaunchAgents/Claude Switch.plist`.

## 10. Removal
- [ ] Remove an account keeping data: profile folder remains; Settings counts it
      as left over.
- [ ] Remove with data and *Sign out first*: `claude auth logout` runs, the
      Keychain item disappears, the folder is deleted.

## 11. Diagnostics
- [ ] *Copy Diagnostics*: no names, emails, tokens, URLs with paths, or terminal
      text. Log file at `~/Library/Application Support/ClaudeSwitch/logs` likewise.
