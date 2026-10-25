// Test-only stand-in for the Rust backend, injected by Playwright before the
// app loads. It implements the `__TAURI_INTERNALS__` contract used by
// @tauri-apps/api (invoke, callbacks, channels, events) on top of in-memory
// state, so UI flows can be exercised in a browser. It is never bundled into
// the application.
(() => {
  const seed = window.__FAKE_SEED__ ?? {};
  const callbacks = new Map();
  let nextCallback = 1;
  const listeners = new Map(); // event -> Map<eventId, callbackId>
  let nextEventId = 1;
  const calls = [];
  const channels = new Map(); // sessionId -> { cb, index }
  const logins = new Map(); // sessionId -> LoginProgress
  const SIGN_IN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=e2e";
  const uuid = () => crypto.randomUUID();
  const now = () => new Date().toISOString();

  const state = {
    settings: {
      claudeExecutablePath: null,
      closeBehavior: "keep_running",
      confirmQuitWithRunningSessions: true,
      globalShortcut: null,
      launchAtLogin: false,
      checkAuthOnStartup: true,
      notifyOnSessionExit: true,
      theme: "light",
      terminalFontSize: 13,
      terminalFontFamily: "",
      terminalScrollback: 10000,
      terminalOptionAsMeta: false,
      extraPathEntries: [],
      customEnv: [],
      onboardingCompleted: false,
      preferredEditor: null,
      ...(seed.settings ?? {}),
    },
    accounts: seed.accounts ?? [],
    projects: seed.projects ?? [],
    sessions: (seed.sessions ?? []).map((x) => ({ usageLimitReached: false, ...x })),
    conversations: seed.conversations ?? [],
    editors: (
      seed.editors ?? [
        { id: "vscode", name: "VS Code" },
        { id: "cursor", name: "Cursor" },
      ]
    ).map((e) => ({
      claudeAccount: { mode: "window", accountId: null, detail: null },
      extensionVersion: null,
      ...e,
    })),
    cli: seed.cli ?? {
      state: "found",
      path: "/opt/homebrew/bin/claude",
      version: "2.1.236",
      source: "detected",
      message: null,
      searched: [],
    },
  };

  const fail = (kind, message) => Promise.reject({ kind, message });

  // Real IPC serializes everything, so the UI never shares objects with
  // the backend state.
  const copy = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  function emit(event, payload) {
    const map = listeners.get(event);
    if (!map) return;
    for (const [id, cbId] of map) callbacks.get(cbId)?.({ event, id, payload: copy(payload) });
  }

  function send(sessionId, text) {
    const ch = channels.get(sessionId);
    if (!ch) return;
    const bytes = new TextEncoder().encode(text);
    ch.cb({ message: bytes.buffer, index: ch.index++ });
  }

  function withCounts(account) {
    const running = state.sessions.filter(
      (s) => s.accountId === account.id && s.status === "running",
    ).length;
    return { ...account, runningSessions: running };
  }

  function startSession(input, kind, title) {
    const project = input.projectId ? state.projects.find((p) => p.id === input.projectId) : null;
    const session = {
      id: uuid(),
      accountId: input.accountId,
      projectId: project?.id ?? null,
      kind,
      title,
      workingDir: project?.directory ?? "/Users/tester",
      processId: 4242,
      status: "running",
      startedAt: now(),
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      error: null,
      attached: true,
      usageLimitReached: false,
    };
    state.sessions.push(session);
    const account = state.accounts.find((a) => a.id === input.accountId);
    if (account) account.lastUsedAt = now();
    setTimeout(() => {
      emit("session-updated", session);
      emit("state-changed", "accounts");
    }, 0);
    return session;
  }

  function setLogin(sessionId, patch) {
    const next = { ...logins.get(sessionId), ...patch };
    logins.set(sessionId, next);
    emit("login-progress", next);
  }

  function finishLogin(session, ok = true) {
    session.status = "exited";
    session.exitCode = ok ? 0 : 1;
    session.endedAt = now();
    session.attached = false;
    const account = state.accounts.find((a) => a.id === session.accountId);
    if (ok) {
      Object.assign(account, {
        authStatus: "authenticated",
        authMethod: "claude.ai",
        verifiedEmail: seed.loginEmail ?? "tester@example.com",
        authVerifiedAt: now(),
        authStatusCheckedAt: now(),
      });
    } else {
      Object.assign(account, {
        authStatus: "failed",
        authDetail: "Claude Code didn't accept that code.",
      });
    }
    setLogin(session.id, {
      phase: ok ? "succeeded" : "failed",
      awaitingCode: false,
      message: ok
        ? null
        : "Claude Code didn't accept that code. Copy the whole code from the browser page and try again.",
    });
    emit("session-updated", session);
    emit("state-changed", "accounts");
    if (ok) emit("login-completed", withCounts(account));
  }

  const commands = {
    "plugin:event|listen": ({ event, handler }) => {
      const id = nextEventId++;
      if (!listeners.has(event)) listeners.set(event, new Map());
      listeners.get(event).set(id, handler);
      return id;
    },
    "plugin:event|unlisten": () => null,
    "plugin:window|set_theme": () => null,
    frontend_ready: () => null,
    get_settings: () => state.settings,
    update_settings: ({ patch }) => {
      for (const [k, v] of Object.entries(patch)) {
        state.settings[k] =
          v === "" && (k === "globalShortcut" || k === "claudeExecutablePath") ? null : v;
      }
      return state.settings;
    },
    get_system_info: () => ({
      appVersion: "0.1.0",
      osVersion: "26.2",
      arch: "aarch64",
      cli: state.cli,
      homeDir: "/Users/tester",
      dataDir: "/Users/tester/Library/Application Support/ClaudeSwitch",
      profilesDir: "/Users/tester/.claude-switch/profiles",
      logsDir: "/Users/tester/Library/Application Support/ClaudeSwitch/logs",
      envConflicts: seed.envConflicts ?? [],
      warnings: [],
      orphanedProfiles: [],
      editors: state.editors,
      extensionPackageAvailable: true,
    }),
    refresh_cli_detection: () => state.cli,
    get_diagnostics: () => "Claude Switch diagnostics\n(fake backend)",
    list_accounts: () => state.accounts.map(withCounts),
    create_account: ({ input }) => {
      if (!input.name.trim())
        return fail("invalidInput", "Invalid input: Account name cannot be empty");
      const id = uuid();
      const account = {
        id,
        name: input.name.trim(),
        label: input.label ?? null,
        verifiedEmail: null,
        orgName: null,
        configDir: `/Users/tester/.claude-switch/profiles/${id}`,
        color: input.color,
        notes: input.notes ?? null,
        sortOrder: state.accounts.length,
        createdAt: now(),
        updatedAt: now(),
        lastUsedAt: null,
        authStatus: "not_configured",
        authMethod: null,
        authStatusCheckedAt: null,
        authVerifiedAt: null,
        authDetail: null,
        runningSessions: 0,
      };
      state.accounts.push(account);
      return account;
    },
    update_account: ({ input }) => {
      const a = state.accounts.find((x) => x.id === input.id);
      if (input.name !== undefined) a.name = input.name;
      if (input.color !== undefined) a.color = input.color;
      if (input.label !== undefined) a.label = input.label || null;
      if (input.notes !== undefined) a.notes = input.notes || null;
      return withCounts(a);
    },
    reorder_accounts: ({ ids }) => {
      state.accounts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return state.accounts.map(withCounts);
    },
    delete_account: ({ input }) => {
      state.accounts = state.accounts.filter((a) => a.id !== input.id);
      return null;
    },
    refresh_auth_status: ({ id }) => {
      const a = state.accounts.find((x) => x.id === id);
      a.authStatusCheckedAt = now();
      return withCounts(a);
    },
    start_login: ({ input }) => {
      const account = state.accounts.find((a) => a.id === input.accountId);
      const session = startSession(input, "login", `Sign in · ${account.name}`);
      logins.set(session.id, {
        sessionId: session.id,
        accountId: account.id,
        phase: "starting",
        url: null,
        urlHost: null,
        awaitingCode: false,
        message: null,
      });
      // Claude Code prints the sign-in link and code prompt shortly after start.
      setTimeout(() => {
        setLogin(session.id, {
          phase: "waiting",
          url: SIGN_IN_URL,
          urlHost: "claude.com",
          awaitingCode: true,
        });
        if (seed.autoCompleteLogin) setTimeout(() => finishLogin(session), 400);
      }, 150);
      return session;
    },
    get_login_progress: ({ sessionId }) => {
      const p = logins.get(sessionId);
      return p ?? fail("notFound", "Sign-in was not found.");
    },
    submit_login_code: ({ sessionId, code }) => {
      const session = state.sessions.find((x) => x.id === sessionId);
      setLogin(sessionId, { phase: "verifying" });
      setTimeout(() => finishLogin(session, code === "good-code#state"), 300);
      return logins.get(sessionId);
    },
    open_in_editor: ({ input }) => {
      const project = state.projects.find((p) => p.id === input.projectId);
      if (project) {
        project.lastUsedAt = now();
        project.defaultAccountId = input.accountId;
      }
      state.settings.preferredEditor = input.editorId;
      return { editorAccountChanged: false };
    },
    set_editor_account: ({ input }) => {
      const editor = state.editors.find((e) => e.id === input.editorId);
      editor.claudeAccount = input.accountId
        ? { mode: "account", accountId: input.accountId, detail: null }
        : { mode: "window", accountId: null, detail: null };
      setTimeout(() => emit("state-changed", "system"), 0);
      return null;
    },
    install_editor_extension: ({ editorId }) => {
      const editor = state.editors.find((e) => e.id === editorId);
      editor.extensionVersion = "0.1.0";
      return editor;
    },
    list_conversations: () => state.conversations,
    continue_conversation: ({ input }) => {
      const target = state.accounts.find((a) => a.id === input.toAccountId);
      if (target?.authStatus !== "authenticated")
        return fail("authRequired", "This account needs to sign in before it can be used.");
      const conversation = state.conversations.find((c) => c.sessionId === input.sessionId);
      if (!conversation) return fail("notFound", "Conversation was not found.");
      conversation.accountId = target.id;
      conversation.modifiedAt = now();
      if (input.editorId) {
        const editor = state.editors.find((e) => e.id === input.editorId);
        editor.claudeAccount = { mode: "account", accountId: target.id, detail: null };
        state.settings.preferredEditor = input.editorId;
        setTimeout(() => emit("state-changed", "system"), 0);
        return { session: null, copied: true };
      }
      const project = state.projects.find((p) => p.id === input.projectId);
      const session = startSession(
        { accountId: target.id, projectId: input.projectId },
        "claude",
        project?.name ?? target.name,
      );
      return { session, copied: true };
    },
    list_projects: () => state.projects,
    add_project_via_picker: () => {
      const project = {
        id: uuid(),
        name: "my-app",
        directory: "/Users/tester/code/my-app",
        favorite: false,
        defaultAccountId: null,
        createdAt: now(),
        updatedAt: now(),
        lastUsedAt: now(),
        exists: true,
        runningSessions: 0,
      };
      state.projects.push(project);
      return project;
    },
    update_project: ({ input }) => {
      const p = state.projects.find((x) => x.id === input.id);
      if (input.name !== undefined) p.name = input.name;
      if (input.favorite !== undefined) p.favorite = input.favorite;
      if (input.defaultAccountId !== undefined) p.defaultAccountId = input.defaultAccountId || null;
      return p;
    },
    remove_project: ({ id }) => {
      state.projects = state.projects.filter((p) => p.id !== id);
      return null;
    },
    list_sessions: () => [...state.sessions].reverse(),
    list_open_sessions: () => state.sessions.filter((s) => s.attached),
    start_session: ({ input }) => {
      const account = state.accounts.find((a) => a.id === input.accountId);
      if (!account) return fail("notFound", "Account was not found.");
      const project = state.projects.find((p) => p.id === input.projectId);
      const title =
        input.kind === "shell"
          ? `Shell · ${project?.name ?? "~"}`
          : (project?.name ?? account.name);
      return startSession(input, input.kind, title);
    },
    attach_session: ({ id, onOutput }) => {
      const cbId = onOutput.id;
      channels.set(id, { cb: (msg) => callbacks.get(cbId)?.(msg), index: 0 });
      const s = state.sessions.find((x) => x.id === id);
      send(id, `\x1b[1mE2E fake terminal\x1b[0m session=${s.kind} account=${s.accountId}\r\n$ `);
      return null;
    },
    write_session: ({ id, data }) => {
      send(id, data === "\r" ? "\r\n$ " : data);
      return null;
    },
    resize_session: () => null,
    stop_session: ({ id }) => {
      const s = state.sessions.find((x) => x.id === id);
      Object.assign(s, { status: "exited", exitSignal: "Hangup", endedAt: now() });
      emit("session-updated", s);
      return null;
    },
    restart_session: ({ id }) => {
      const s = state.sessions.find((x) => x.id === id);
      s.attached = false;
      return startSession(s, s.kind, s.title);
    },
    close_session: ({ id }) => {
      const s = state.sessions.find((x) => x.id === id);
      if (s)
        Object.assign(s, { attached: false, status: s.status === "running" ? "exited" : s.status });
      return null;
    },
    open_external_url: () => null,
    reveal_path: () => null,
    pick_claude_executable: () => null,
    quit_app: () => null,
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(callback, once) {
      const id = nextCallback++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        return callback(payload);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      calls.push({
        cmd,
        args: JSON.parse(
          JSON.stringify(args, (_k, v) =>
            v?.id && v?.onmessage !== undefined ? `channel:${v.id}` : v,
          ),
        ),
      });
      const fn = commands[cmd];
      if (!fn) return fail("notFound", `fake backend has no command ${cmd}`);
      return copy(await fn(args));
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      listeners.get(event)?.delete(id);
    },
  };
  /** Simulates Claude Code printing a usage-limit message in a session. */
  function hitLimit(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    send(sessionId, "\x1b[31mYou've hit your session limit \u00b7 resets 5pm\x1b[39m\r\n");
    s.usageLimitReached = true;
    emit("session-updated", s);
  }

  window.__fake = { state, calls, emit, hitLimit };
})();
