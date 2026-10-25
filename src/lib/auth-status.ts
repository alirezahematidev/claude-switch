import type { Account } from "@/bindings/Account";
import type { AuthStatus } from "@/bindings/AuthStatus";
import type { Tone } from "@/components/ui/misc";

export interface AuthStatusMeta {
  label: string;
  tone: Tone;
  description: string;
}

export const AUTH_STATUS_META: Record<AuthStatus, AuthStatusMeta> = {
  not_configured: {
    label: "Not signed in",
    tone: "neutral",
    description: "This profile has not been signed in yet.",
  },
  auth_required: {
    label: "Sign-in required",
    tone: "warning",
    description:
      "Claude Code no longer has a valid login for this profile. Sessions can expire or be revoked; sign in again to continue.",
  },
  authenticated: {
    label: "Signed in",
    tone: "success",
    description: "Claude Code reported a login stored in this profile, as of the last check.",
  },
  unknown: {
    label: "Status unknown",
    tone: "neutral",
    description: "Claude Switch could not check this account's status.",
  },
  failed: {
    label: "Sign-in failed",
    tone: "danger",
    description: "The last sign-in attempt did not complete. The profile was kept; you can retry.",
  },
  unsupported_isolation: {
    label: "Limited isolation",
    tone: "warning",
    description:
      "Claude Code is signed in with a credential that may be shared by every profile, so this account is not isolated from the others.",
  },
};

/** Human-readable name for `authMethod` values from `claude auth status`. */
export function authMethodLabel(method: string | null): string {
  switch (method) {
    case "claude.ai":
      return "Claude subscription";
    case "api_key":
      return "Anthropic Console API key";
    case "oauth_token":
      return "OAuth token (environment, settings, or Anthropic profile)";
    case "api_key_helper":
      return "apiKeyHelper script";
    case "third_party":
      return "Cloud provider (Bedrock, Vertex AI, or Foundry)";
    case "none":
    case null:
      return "None";
    default:
      return method;
  }
}

export function needsSignIn(account: Account): boolean {
  return (
    account.authStatus === "not_configured" ||
    account.authStatus === "auth_required" ||
    account.authStatus === "failed"
  );
}

/** The identity line shown under an account name. */
export function accountSubtitle(account: Account): string | null {
  return account.verifiedEmail ?? account.label ?? null;
}
