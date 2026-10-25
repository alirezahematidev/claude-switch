import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { api, errorMessage, IpcError } from "@/lib/ipc";
import { forgetSession, queryKeys } from "@/lib/queries";
import { useUi } from "@/store/ui";

/** Closes a tab, stopping its process first if it is still running. */
export function useCloseTab() {
  const removeTab = useUi((s) => s.removeTab);
  const client = useQueryClient();
  return useCallback(
    async (sessionId: string) => {
      try {
        await api.closeSession(sessionId);
      } catch (err) {
        // A session the backend no longer tracks can still leave the UI.
        if (!(err instanceof IpcError && err.kind === "notFound")) {
          toast.error("Could not stop the session", { description: errorMessage(err) });
          return;
        }
      }
      forgetSession(client, sessionId);
      removeTab(sessionId);
      void client.invalidateQueries({ queryKey: queryKeys.openSessions });
    },
    [client, removeTab],
  );
}
