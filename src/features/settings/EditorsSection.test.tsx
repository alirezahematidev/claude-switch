import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import {
  callsTo,
  makeAccount,
  makeEditor,
  makeSystemInfo,
  mockCommand,
  resetTauriMocks,
} from "@/test/tauri";

import { EditorsSection } from "./SettingsView";

afterEach(resetTauriMocks);

const work = makeAccount();
const personal = makeAccount({ id: "33333333-3333-4333-8333-333333333333", name: "Personal" });

describe("EditorsSection", () => {
  it("chooses the Claude Code extension's account for every window", async () => {
    mockCommand("list_accounts", [work, personal]);
    mockCommand("get_system_info", makeSystemInfo({ editors: [makeEditor()] }));
    mockCommand("set_editor_account", null);
    renderWithProviders(<EditorsSection />);

    expect(
      await screen.findByText("Claude Code uses the account each window was opened with."),
    ).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "VS Code: Claude Code account" });
    expect(select).toHaveTextContent("Per window");
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Personal" }));
    await waitFor(() => {
      expect(callsTo("set_editor_account")[0]?.args).toEqual({
        input: { editorId: "vscode", accountId: personal.id },
      });
    });
  });

  it("returns to per-window accounts and shows a folder set by the user", async () => {
    mockCommand("list_accounts", [work, personal]);
    mockCommand(
      "get_system_info",
      makeSystemInfo({
        editors: [
          makeEditor({ claudeAccount: { mode: "account", accountId: work.id, detail: null } }),
          makeEditor({
            id: "cursor",
            name: "Cursor",
            claudeAccount: { mode: "custom", accountId: null, detail: "/Users/me/.claude-work" },
          }),
        ],
      }),
    );
    mockCommand("set_editor_account", null);
    renderWithProviders(<EditorsSection />);

    expect(
      await screen.findByText("New Claude tabs in every VS Code window use Work."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your Cursor settings point Claude Code at /Users/me/.claude-work."),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Cursor: Claude Code account" })).toHaveTextContent(
      "Custom folder",
    );

    await userEvent.click(screen.getByRole("combobox", { name: "VS Code: Claude Code account" }));
    await userEvent.click(await screen.findByRole("option", { name: "Per window" }));
    await waitFor(() => {
      expect(callsTo("set_editor_account")[0]?.args).toEqual({ input: { editorId: "vscode" } });
    });
  });

  it("explains a setting left behind by a removed account", async () => {
    mockCommand("list_accounts", [work]);
    mockCommand(
      "get_system_info",
      makeSystemInfo({
        editors: [
          makeEditor({
            claudeAccount: {
              mode: "custom",
              accountId: null,
              detail: "/Users/me/.claude-switch/profiles/0b7d4c1e-9a55-4f0e-8a51-2d3c4b5a6f70",
            },
          }),
        ],
      }),
    );
    renderWithProviders(<EditorsSection />);

    expect(
      await screen.findByText(
        "VS Code still starts Claude Code with the profile of an account that was removed from Claude Switch. Choose an account, or Per window.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "VS Code: Claude Code account" }),
    ).toHaveTextContent("Removed account");
  });

  it("installs or updates the Claude Switch extension", async () => {
    mockCommand("list_accounts", [work]);
    mockCommand(
      "get_system_info",
      makeSystemInfo({
        appVersion: "0.2.0",
        editors: [
          makeEditor(),
          makeEditor({ id: "cursor", name: "Cursor", extensionVersion: "0.1.0" }),
        ],
      }),
    );
    mockCommand("install_editor_extension", makeEditor({ extensionVersion: "0.2.0" }));
    renderWithProviders(<EditorsSection />);

    expect(
      await screen.findByText(/Adds an account switcher to VS Code's title bar and status bar/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Version 0.1.0 is installed; Claude Switch includes 0.2.0."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(callsTo("install_editor_extension")[0]?.args).toEqual({ editorId: "vscode" });
    });
  });

  it("cannot install from a build without the extension", async () => {
    mockCommand("list_accounts", [work]);
    mockCommand(
      "get_system_info",
      makeSystemInfo({ editors: [makeEditor()], extensionPackageAvailable: false }),
    );
    renderWithProviders(<EditorsSection />);
    expect(await screen.findByRole("button", { name: "Install" })).toBeDisabled();
  });
});
