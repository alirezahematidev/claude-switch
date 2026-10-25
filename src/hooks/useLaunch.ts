import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import type { SessionInfo } from "@/bindings/SessionInfo";
import { api, errorMessage } from "@/lib/ipc";
import { rememberSession, useSettings } from "@/lib/queries";
import { estimateTerminalSize } from "@/lib/terminal";
import { useUi } from "@/store/ui";

export interface LaunchOptions {
  projectId?: string | null;
  continueLast?: boolean;
  /** Open the tab in the background instead of switching to it. */
  background?: boolean;
}

/** Starts sessions and opens them as terminal tabs. */
export function useLaunch() {
  const { data: settings } = useSettings();
  const openTab = useUi((s) => s.openTab);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const client = useQueryClient();

  const size = useCallback(
    () => estimateTerminalSize(settings?.terminalFontSize ?? 13, sidebarHidden),
    [settings?.terminalFontSize, sidebarHidden],
  );

  const finish = useCallback(
    (session: SessionInfo, background?: boolean) => {
      rememberSession(client, session);
      openTab(session.id, !background);
      return session;
    },
    [client, openTab],
  );

  const launch = useCallback(
    async (
      accountId: string,
      kind: "claude" | "shell",
      opts: LaunchOptions = {},
    ): Promise<SessionInfo | null> => {
      try {
        const session = await api.startSession({
          accountId,
          kind,
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          ...(opts.continueLast ? { continueLast: true } : {}),
          ...size(),
        });
        return finish(session, opts.background);
      } catch (err) {
        toast.error("Could not start the session", { description: errorMessage(err) });
        return null;
      }
    },
    [finish, size],
  );

  return { launch, size };
}
