import type { Account } from "@/bindings/Account";
import type { Conversation } from "@/bindings/Conversation";
import type { ContinueContext } from "@/store/ui";

export const DEFAULT_MESSAGE = "Continue where you left off.";

/** "820 B", "14 KB", "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The conversation to preselect: the newest one from the context's project
 * and account, then from its project, then the newest overall. The list is
 * already sorted newest first.
 */
export function pickConversation(
  conversations: readonly Conversation[],
  context: ContinueContext,
): Conversation | undefined {
  const inProject = conversations.filter(
    (c) => !context.projectId || c.projectId === context.projectId,
  );
  return (
    inProject.find((c) => !context.accountId || c.accountId === context.accountId) ??
    inProject[0] ??
    conversations[0]
  );
}

/** The account to continue with: the first signed-in account that is not the source. */
export function pickTarget(
  accounts: readonly Account[],
  sourceAccountId: string | null,
  chosenId: string | undefined,
): Account | undefined {
  const candidates = accounts.filter((a) => a.id !== sourceAccountId);
  return (
    candidates.find((a) => a.id === chosenId && a.authStatus === "authenticated") ??
    candidates.find((a) => a.authStatus === "authenticated")
  );
}
