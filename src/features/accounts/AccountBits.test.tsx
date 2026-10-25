import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AuthStatus } from "@/bindings/AuthStatus";
import { renderWithProviders } from "@/test/render";
import { makeAccount } from "@/test/tauri";

import { AuthStatusBadge, AuthStatusIcon } from "./AccountBits";

const cases: [AuthStatus, string][] = [
  ["not_configured", "Not signed in"],
  ["auth_required", "Sign-in required"],
  ["authenticated", "Signed in"],
  ["unknown", "Status unknown"],
  ["failed", "Sign-in failed"],
  ["unsupported_isolation", "Limited isolation"],
];

describe("auth status presentation", () => {
  it.each(cases)("labels %s as %s", (status, label) => {
    renderWithProviders(<AuthStatusBadge account={makeAccount({ authStatus: status })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("gives the compact icon an accessible name", () => {
    renderWithProviders(<AuthStatusIcon status="unsupported_isolation" />);
    expect(screen.getByRole("img", { name: "Limited isolation" })).toBeInTheDocument();
  });
});
