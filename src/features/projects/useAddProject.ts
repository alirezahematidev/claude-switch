import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import type { Project } from "@/bindings/Project";
import { api, errorMessage } from "@/lib/ipc";
import { queryKeys } from "@/lib/queries";
import { useUi } from "@/store/ui";

/** Opens the native folder picker and registers the chosen project. */
export function useAddProject() {
  const client = useQueryClient();
  const navigate = useUi((s) => s.navigate);
  return useCallback(
    async (opts: { navigate?: boolean } = {}): Promise<Project | null> => {
      try {
        const project = await api.addProjectViaPicker();
        if (!project) return null;
        await client.invalidateQueries({ queryKey: queryKeys.projects });
        if (opts.navigate !== false) navigate({ kind: "project", projectId: project.id });
        return project;
      } catch (err) {
        toast.error("Could not add the project", { description: errorMessage(err) });
        return null;
      }
    },
    [client, navigate],
  );
}
