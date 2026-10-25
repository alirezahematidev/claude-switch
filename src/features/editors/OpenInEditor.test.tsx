import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";
import {
  callsTo,
  makeAccount,
  makeEditor,
  makeProject,
  makeSettings,
  makeSystemInfo,
  mockCommand,
  resetTauriMocks,
} from "@/test/tauri";

import { OpenInEditorButton } from "./OpenInEditor";

afterEach(resetTauriMocks);

function mockBackend(editors = [makeEditor()]) {
  mockCommand("get_system_info", makeSystemInfo({ editors }));
  mockCommand("get_settings", makeSettings());
  mockCommand("list_accounts", [makeAccount()]);
  mockCommand("list_projects", [makeProject()]);
  mockCommand("open_in_editor", { editorAccountChanged: false });
}

describe("OpenInEditorButton", () => {
  it("opens the project in VS Code with the selected account", async () => {
    mockBackend();
    renderWithProviders(
      <OpenInEditorButton projectId={makeProject().id} accountId={makeAccount().id} />,
    );
    const button = await screen.findByRole("button", { name: "Open in VS Code" });
    await waitFor(() => {
      expect(button).toBeEnabled();
    });
    await userEvent.click(button);
    expect(callsTo("open_in_editor")[0]?.args).toEqual({
      input: { projectId: makeProject().id, accountId: makeAccount().id, editorId: "vscode" },
    });
  });

  it("offers other detected editors in a menu", async () => {
    mockBackend([makeEditor(), makeEditor({ id: "cursor", name: "Cursor" })]);
    renderWithProviders(
      <OpenInEditorButton projectId={makeProject().id} accountId={makeAccount().id} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Choose editor" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Cursor" }));
    expect(callsTo("open_in_editor")[0]?.args).toMatchObject({ input: { editorId: "cursor" } });
  });

  it("is disabled when no editor is installed", async () => {
    mockBackend([]);
    renderWithProviders(
      <OpenInEditorButton projectId={makeProject().id} accountId={makeAccount().id} />,
    );
    expect(await screen.findByRole("button", { name: "Open in VS Code" })).toBeDisabled();
  });
});
