import { useState } from "react";
import { toast } from "sonner";

import type { EditorInfo } from "@/bindings/EditorInfo";
import { api, errorMessage } from "@/lib/ipc";
import { useAccounts, useProjects, useSettings, useSystemInfo } from "@/lib/queries";

/** Installed editors, with the last-used one first. */
export function useEditors(): { editors: EditorInfo[]; preferred: EditorInfo | undefined } {
  const { data: system } = useSystemInfo();
  const { data: settings } = useSettings();
  const editors = system?.editors ?? [];
  const preferred = editors.find((e) => e.id === settings?.preferredEditor) ?? editors[0];
  return { editors, preferred };
}

export function useOpenInEditor() {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const [busy, setBusy] = useState(false);
  const open = async (projectId: string, accountId: string, editor: EditorInfo) => {
    setBusy(true);
    try {
      const result = await api.openInEditor({ projectId, accountId, editorId: editor.id });
      const account = accounts.find((a) => a.id === accountId);
      const project = projects.find((p) => p.id === projectId);
      const windows = result.editorAccountChanged
        ? `every ${editor.name} window`
        : `new ${editor.name} windows`;
      toast.success(`Opening ${project?.name ?? "the project"} in ${editor.name}`, {
        description: account ? `Claude Code in ${windows} uses ${account.name}.` : undefined,
      });
    } catch (err) {
      toast.error(`Could not open ${editor.name}`, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return { open, busy };
}
