import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useUi, type ContinueContext } from "@/store/ui";
import { renderWithProviders } from "@/test/render";
import {
  backendError,
  callsTo,
  makeAccount,
  makeConversation,
  makeEditor,
  makeProject,
  makeSettings,
  makeSystemInfo,
  mockCommand,
  resetTauriMocks,
} from "@/test/tauri";

import { ContinueConversationDialog } from "./ContinueDialog";
import { DEFAULT_MESSAGE, formatBytes, pickConversation } from "./handoff";

const work = makeAccount();
const personal = makeAccount({
  id: "33333333-3333-4333-8333-333333333333",
  name: "Personal",
  color: "green",
});
const website = makeProject();
const api = makeProject({
  id: "44444444-4444-4444-8444-444444444444",
  name: "api",
  directory: "/Users/me/code/api",
});
const latest = makeConversation({
  projectId: api.id,
  sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
});
const inWebsite = makeConversation({
  sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
  modifiedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
});

function mockBackend({
  accounts = [work, personal],
  conversations = [latest, inWebsite],
  editors = [makeEditor()],
  preferredEditor = null as string | null,
} = {}) {
  mockCommand("list_accounts", accounts);
  mockCommand("list_projects", [website, api]);
  mockCommand("list_conversations", conversations);
  mockCommand("get_settings", makeSettings({ preferredEditor }));
  mockCommand("get_system_info", makeSystemInfo({ editors }));
  mockCommand("continue_conversation", (args: Record<string, unknown> | undefined) => {
    const input = args?.input as { editorId?: string };
    return {
      copied: true,
      session: input.editorId
        ? null
        : {
            id: "99999999-9999-4999-8999-999999999999",
            accountId: personal.id,
            projectId: website.id,
            kind: "claude",
            title: "website",
            workingDir: website.directory,
            processId: 1,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            exitCode: null,
            exitSignal: null,
            error: null,
            attached: true,
            usageLimitReached: false,
          },
    };
  });
}

async function selectedConversation() {
  const group = await screen.findByRole("radiogroup", { name: "Conversation" });
  return within(group).getByRole("radio", { checked: true });
}

function open(context: ContinueContext) {
  const view = renderWithProviders(<ContinueConversationDialog />);
  act(() => {
    useUi.getState().openDialog("continueConversation", context);
  });
  return view;
}

/** Starts over with a fresh query cache and different backend data. */
function reopen(
  view: { unmount: () => void },
  context: ContinueContext,
  data: Parameters<typeof mockBackend>[0],
) {
  view.unmount();
  act(() => {
    useUi.getState().closeDialog("continueConversation");
  });
  resetTauriMocks();
  mockBackend(data);
  return open(context);
}

beforeEach(() => {
  useUi.setState({ tabs: [], activeTabId: null, view: { kind: "home" } });
});
afterEach(() => {
  act(() => {
    useUi.getState().closeDialog("continueConversation");
    useUi.getState().closeDialog("signInAccountId");
  });
  resetTauriMocks();
});

describe("ContinueConversationDialog", () => {
  it("continues the session's conversation with another account in a new tab", async () => {
    mockBackend();
    open({ projectId: website.id, accountId: work.id, destination: "terminal" });

    // The newest conversation from the session's project is preselected,
    // and the other signed-in account is the target.
    const selected = await selectedConversation();
    expect(selected).toHaveTextContent("website");
    expect(selected).toHaveTextContent("Work");
    expect(screen.getByRole("combobox", { name: "Continue with" })).toHaveTextContent("Personal");
    expect(screen.getByRole("radio", { name: "Claude Switch" })).toBeChecked();

    const message = screen.getByRole("textbox", { name: "Message" });
    expect(message).toHaveValue(DEFAULT_MESSAGE);
    await userEvent.type(message, "{Enter}");

    await waitFor(() => {
      expect(callsTo("continue_conversation")).toHaveLength(1);
    });
    const args = callsTo("continue_conversation")[0]?.args as
      | { input: Record<string, unknown> }
      | undefined;
    const input = args?.input;
    expect(input).toMatchObject({
      projectId: website.id,
      sessionId: inWebsite.sessionId,
      fromAccountId: work.id,
      toAccountId: personal.id,
      message: DEFAULT_MESSAGE,
    });
    expect(input).not.toHaveProperty("editorId");
    await waitFor(() => {
      expect(useUi.getState().tabs).toContain("99999999-9999-4999-8999-999999999999");
    });
    expect(useUi.getState().dialogs.continueConversation).toBeNull();
  });

  it("says what changes in the editor before continuing there", async () => {
    mockBackend({ preferredEditor: "vscode" });
    open({});

    // Newest overall; the editor the user already works in.
    expect(await selectedConversation()).toHaveTextContent("api");
    expect(screen.getByRole("radio", { name: "VS Code" })).toBeChecked();
    const note = screen.getByText("VS Code will use Personal").closest("[role=status]");
    expect(note).toHaveTextContent("new Claude tabs in every window");
    expect(note).toHaveTextContent("Tabs already open keep their account");
    expect(screen.getByText(/press Return there to send it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(callsTo("continue_conversation")).toHaveLength(1);
    });
    expect(callsTo("continue_conversation")[0]?.args).toMatchObject({
      input: { sessionId: latest.sessionId, toAccountId: personal.id, editorId: "vscode" },
    });
  });

  it("warns before replacing a folder the user set, and blocks unreadable settings", async () => {
    mockBackend({
      preferredEditor: "vscode",
      editors: [
        makeEditor({
          claudeAccount: { mode: "custom", accountId: null, detail: "/Users/me/.claude-work" },
        }),
      ],
    });
    const view = open({});
    const note = (await screen.findByText("VS Code will use Personal")).closest("[role=status]");
    expect(note).toHaveTextContent("/Users/me/.claude-work");
    expect(note).toHaveTextContent("a backup is kept");

    reopen(
      view,
      {},
      {
        preferredEditor: "vscode",
        editors: [
          makeEditor({
            claudeAccount: { mode: "unreadable", accountId: null, detail: "bad JSON" },
          }),
        ],
      },
    );
    expect(await screen.findByText("VS Code's settings could not be read")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    // Claude Switch's terminal still works.
    await userEvent.click(screen.getByRole("radio", { name: "Claude Switch" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("offers sign-in when the other account's login has expired", async () => {
    mockBackend();
    mockCommand("continue_conversation", backendError("authRequired", "needs sign-in"));
    open({ projectId: website.id, accountId: work.id, destination: "terminal" });
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Personal needs to sign in again.");
    await userEvent.click(within(alert).getByRole("button", { name: "Sign In" }));
    expect(useUi.getState().dialogs.signInAccountId).toBe(personal.id);
    expect(useUi.getState().dialogs.continueConversation).toBeNull();
  });

  it("only offers signed-in accounts other than the conversation's own", async () => {
    mockBackend({
      accounts: [
        work,
        personal,
        makeAccount({
          id: "55555555-5555-4555-8555-555555555555",
          name: "Expired",
          authStatus: "auth_required",
        }),
      ],
    });
    open({ projectId: website.id, accountId: work.id, destination: "terminal" });
    await userEvent.click(await screen.findByRole("combobox", { name: "Continue with" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Personal", "ExpiredSign-in required"]);
    expect(options[1]).toHaveAttribute("aria-disabled", "true");
  });

  it("explains what is missing", async () => {
    mockBackend({ accounts: [work] });
    const view = open({});
    expect(await screen.findByText("Add another account first")).toBeInTheDocument();

    reopen(view, {}, { conversations: [] });
    expect(await screen.findByText("No conversations yet")).toBeInTheDocument();
  });
});

describe("handoff helpers", () => {
  it("prefers the context's project and account", () => {
    const list = [latest, inWebsite, makeConversation({ sessionId: "c", accountId: personal.id })];
    expect(pickConversation(list, {})).toBe(latest);
    expect(pickConversation(list, { projectId: website.id })).toBe(inWebsite);
    expect(
      pickConversation(list, { projectId: website.id, accountId: personal.id })?.sessionId,
    ).toBe("c");
    expect(pickConversation(list, { projectId: "none" })).toBe(latest);
  });

  it("formats sizes", () => {
    expect(formatBytes(820)).toBe("820 B");
    expect(formatBytes(14_336)).toBe("14 KB");
    expect(formatBytes(1_300_000)).toBe("1.2 MB");
  });
});
