import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { renderWithProviders } from "@/test/render";
import { backendError, callsTo, makeAccount, mockCommand, resetTauriMocks } from "@/test/tauri";

import { DeleteAccountForm } from "./AccountDialogs";

afterEach(resetTauriMocks);

function renderDelete(account = makeAccount({ name: "Work" })) {
  const onClose = vi.fn();
  renderWithProviders(
    <Dialog open>
      <DialogContent>
        <DeleteAccountForm account={account} onClose={onClose} />
      </DialogContent>
    </Dialog>,
  );
  return { onClose };
}

describe("DeleteAccountForm", () => {
  it("removes the account but keeps profile data by default", async () => {
    mockCommand("delete_account", null);
    mockCommand("list_accounts", []);
    const { onClose } = renderDelete();
    await userEvent.click(screen.getByRole("button", { name: "Remove Account" }));
    expect(callsTo("delete_account")[0]?.args).toEqual({
      input: {
        id: "11111111-1111-4111-8111-111111111111",
        deleteProfileData: false,
        signOutFirst: false,
        confirmation: "",
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("requires typing the exact name before deleting profile data", async () => {
    mockCommand("delete_account", null);
    mockCommand("list_accounts", []);
    renderDelete();
    await userEvent.click(screen.getByRole("radio", { name: /delete profile data/i }));
    const button = screen.getByRole("button", { name: "Delete Account and Data" });
    expect(button).toBeDisabled();

    const input = screen.getByLabelText(/to confirm/i);
    await userEvent.type(input, "work");
    expect(button).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "Work");
    expect(button).toBeEnabled();

    await userEvent.click(button);
    expect(callsTo("delete_account")[0]?.args).toEqual({
      input: {
        id: "11111111-1111-4111-8111-111111111111",
        deleteProfileData: true,
        signOutFirst: true,
        confirmation: "Work",
      },
    });
  });

  it("submits with Enter once the name is confirmed", async () => {
    mockCommand("delete_account", null);
    mockCommand("list_accounts", []);
    renderDelete();
    await userEvent.click(screen.getByRole("radio", { name: /delete profile data/i }));
    await userEvent.type(screen.getByLabelText(/to confirm/i), "Wrong{Enter}");
    expect(callsTo("delete_account")).toHaveLength(0);
    await userEvent.clear(screen.getByLabelText(/to confirm/i));
    await userEvent.type(screen.getByLabelText(/to confirm/i), "Work{Enter}");
    expect(callsTo("delete_account")).toHaveLength(1);
  });

  it("uses a custom checkbox for signing out", async () => {
    renderDelete();
    await userEvent.click(screen.getByRole("radio", { name: /delete profile data/i }));
    const box = screen.getByRole("checkbox", { name: /sign out with claude code first/i });
    expect(box.tagName).toBe("BUTTON");
    expect(box).toHaveAttribute("aria-checked", "true");
  });

  it("blocks removal while sessions run", () => {
    renderDelete(makeAccount({ name: "Busy", runningSessions: 2 }));
    expect(screen.getByText(/sessions are running/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Account" })).toBeDisabled();
  });

  it("shows backend errors without closing", async () => {
    mockCommand(
      "delete_account",
      backendError("authFailed", "Authentication failed: logout did not succeed"),
    );
    const { onClose } = renderDelete();
    await userEvent.click(screen.getByRole("button", { name: "Remove Account" }));
    expect(await screen.findByText(/logout did not succeed/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
