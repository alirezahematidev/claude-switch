import { toast } from "sonner";

import type { LoginMethod } from "@/bindings/LoginMethod";
import type { SessionInfo } from "@/bindings/SessionInfo";
import { api, errorMessage } from "@/lib/ipc";

export const looksLikeEmail = (s: string | null | undefined): boolean =>
  Boolean(s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()));

/** Starts `claude auth login` for an account. */
export async function startSignIn(
  accountId: string,
  method: LoginMethod,
  email: string,
): Promise<SessionInfo | null> {
  try {
    return await api.startLogin({
      accountId,
      method,
      ...(email.trim() ? { email: email.trim() } : {}),
      cols: 120,
      rows: 30,
    });
  } catch (err) {
    toast.error("Could not start sign-in", { description: errorMessage(err) });
    return null;
  }
}

/** Stops a sign-in that is still running. */
export function cancelSignIn(sessionId: string): void {
  void api.closeSession(sessionId).catch(() => undefined);
}
