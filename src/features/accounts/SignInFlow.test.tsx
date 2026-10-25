import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoginProgress } from "@/bindings/LoginProgress";
import { renderWithProviders } from "@/test/render";
import {
  callsTo,
  emitEvent,
  makeAccount,
  makeSettings,
  mockCommand,
  resetTauriMocks,
} from "@/test/tauri";

import { SignInProgress } from "./SignInFlow";

vi.mock("@/features/terminal/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="terminal" />,
}));

afterEach(resetTauriMocks);

const SESSION = "55555555-5555-4555-8555-555555555555";
const URL = "https://claude.com/cai/oauth/authorize?code=true&state=abc";

function progress(overrides: Partial<LoginProgress> = {}): LoginProgress {
  return {
    sessionId: SESSION,
    accountId: "11111111-1111-4111-8111-111111111111",
    phase: "waiting",
    url: URL,
    urlHost: "claude.com",
    awaitingCode: true,
    message: null,
    ...overrides,
  };
}

function setup(initial: LoginProgress = progress()) {
  mockCommand("get_login_progress", initial);
  mockCommand("get_settings", makeSettings());
  mockCommand("list_accounts", [makeAccount()]);
  const handlers = {
    onRetry: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    onSuccess: vi.fn<() => void>(),
  };
  renderWithProviders(<SignInProgress sessionId={SESSION} account={makeAccount()} {...handlers} />);
  return handlers;
}

describe("SignInProgress", () => {
  it("offers the sign-in page instead of a raw URL", async () => {
    mockCommand("open_external_url", null);
    setup();
    expect(await screen.findByText("Waiting for you to sign in")).toBeInTheDocument();
    expect(screen.getByText("claude.com")).toBeInTheDocument();
    expect(screen.queryByText(URL)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open sign-in page/i }));
    expect(callsTo("open_external_url")[0]?.args).toEqual({ url: URL });
  });

  it("submits the pasted code with Enter", async () => {
    mockCommand("submit_login_code", progress({ phase: "verifying" }));
    setup();
    const field = await screen.findByLabelText("Authorization code");
    await userEvent.type(field, "  code-123#state{Enter}");
    expect(callsTo("submit_login_code")[0]?.args).toEqual({
      sessionId: SESSION,
      code: "code-123#state",
    });
  });

  it("disables the code field until Claude Code asks for it", async () => {
    setup(progress({ phase: "starting", url: null, urlHost: null, awaitingCode: false }));
    expect(await screen.findByLabelText("Authorization code")).toBeDisabled();
    expect(screen.getByRole("button", { name: /open sign-in page/i })).toBeDisabled();
  });

  it("follows progress events to success", async () => {
    const { onSuccess } = setup();
    await screen.findByText("Waiting for you to sign in");
    act(() => {
      emitEvent("login-progress", progress({ phase: "succeeded", awaitingCode: false }));
    });
    expect(await screen.findByText("Work is signed in")).toBeInTheDocument();
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it("explains a failure and offers a retry", async () => {
    const { onRetry } = setup(
      progress({ phase: "failed", message: "Claude Code didn't accept that code." }),
    );
    expect(await screen.findByText("Claude Code didn't accept that code.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("ignores progress for other sign-ins", async () => {
    setup();
    await screen.findByText("Waiting for you to sign in");
    act(() => {
      emitEvent("login-progress", progress({ sessionId: "other", phase: "succeeded" }));
    });
    expect(screen.getByText("Waiting for you to sign in")).toBeInTheDocument();
  });
});
