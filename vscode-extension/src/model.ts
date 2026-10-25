/**
 * How accounts and sessions read in the extension. Wording follows
 * the desktop app (`src/lib/auth-status.ts`), so both say the same thing.
 * No VS Code dependency, so it is tested directly.
 */
import type { Account } from "./bindings/Account";
import type { AccountColor } from "./bindings/AccountColor";
import type { AuthStatus } from "./bindings/AuthStatus";
import type { SessionInfo } from "./bindings/SessionInfo";

export const AUTH_STATUS: Record<AuthStatus, { label: string; description: string }> = {
  not_configured: {
    label: "Not signed in",
    description: "This profile has not been signed in yet.",
  },
  auth_required: {
    label: "Sign-in required",
    description:
      "Claude Code no longer has a valid login for this profile. Sessions can expire or be revoked; sign in again to continue.",
  },
  authenticated: {
    label: "Signed in",
    description: "Claude Code reported a login stored in this profile, as of the last check.",
  },
  unknown: {
    label: "Status unknown",
    description: "Claude Switch could not check this account's status.",
  },
  failed: {
    label: "Sign-in failed",
    description: "The last sign-in attempt did not complete. The profile was kept; you can retry.",
  },
  unsupported_isolation: {
    label: "Limited isolation",
    description:
      "Claude Code is signed in with a credential that may be shared by every profile, so this account is not isolated from the others.",
  },
};

/** Display order in the color picker, as in the app. */
export const ACCOUNT_COLORS: readonly AccountColor[] = [
  "blue",
  "violet",
  "green",
  "orange",
  "pink",
  "teal",
  "amber",
  "red",
  "sky",
  "slate",
];

export function colorLabel(color: AccountColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

export function isSignedIn(account: Account): boolean {
  return account.authStatus === "authenticated";
}

/** The identity line shown under an account name. */
export function accountSubtitle(account: Account): string | null {
  return account.verifiedEmail ?? account.label ?? null;
}

/** "Claude Code ended (exit code 1)." for a finished session. */
export function sessionEnded(session: SessionInfo): string {
  const what = session.kind === "shell" ? "The shell" : "Claude Code";
  if (session.error) return `${what} could not start: ${session.error}`;
  if (session.exitCode !== null) {
    return session.exitCode === 0
      ? `${what} finished.`
      : `${what} ended (exit code ${session.exitCode}).`;
  }
  if (session.exitSignal) return `${what} ended (${session.exitSignal}).`;
  return `${what} ended.`;
}

export function isActive(session: SessionInfo): boolean {
  return (
    session.status === "starting" || session.status === "running" || session.status === "stopping"
  );
}

/**
 * Turns base64 terminal output into text. A character split between two
 * chunks is completed by the next one.
 */
export class OutputDecoder {
  private readonly decoder = new TextDecoder("utf-8");

  push(base64: string): string {
    return this.decoder.decode(Buffer.from(base64, "base64"), { stream: true });
  }
}

/** A name for a new account: trimmed, 1–256 characters. */
export function validateAccountName(value: string): string | undefined {
  const name = value.trim();
  if (name.length === 0) return "Enter a name, for example Work or Personal.";
  if (name.length > 256) return "Use at most 256 characters.";
  return undefined;
}

/** A code from the sign-in page: no spaces or control characters. */
export function validateLoginCode(value: string): string | undefined {
  const code = value.trim();
  if (code.length === 0) return "Paste the code shown on the sign-in page.";
  // Control characters and spaces are refused by Claude Switch too.
  // oxlint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(code)) return "The code has no spaces or line breaks.";
  return undefined;
}
