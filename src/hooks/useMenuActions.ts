import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { Project } from "@/bindings/Project";
import type { SessionInfo } from "@/bindings/SessionInfo";
import { useAddProject } from "@/features/projects/useAddProject";
import { subscribe } from "@/lib/ipc";
import { useAccounts, useOpenSessions, useProjects } from "@/lib/queries";
import { useUi, type View } from "@/store/ui";

import { useLaunch } from "./useLaunch";

/**
 * The account and project a "new session" command should use, derived from
 * what the user is looking at.
 */
export function launchContext(
  view: View,
  activeTab: SessionInfo | undefined,
  accounts: Account[],
  projects: Project[],
): { accountId: string; projectId: string | null } | null {
  if (view.kind === "account") return { accountId: view.accountId, projectId: null };
  if (view.kind === "project") {
    const project = projects.find((p) => p.id === view.projectId);
    const accountId = project?.defaultAccountId ?? accounts[0]?.id;
    return accountId ? { accountId, projectId: view.projectId } : null;
  }
  if (view.kind === "terminal" && activeTab) {
    return { accountId: activeTab.accountId, projectId: activeTab.projectId };
  }
  const first = accounts[0];
  return first ? { accountId: first.id, projectId: null } : null;
}

/** Handles native menu commands and keyboard accelerators. */
export function useMenuActions(): void {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useOpenSessions();
  const { launch } = useLaunch();
  const addProject = useAddProject();

  const handle = useEffectEvent((action: string) => {
    const ui = useUi.getState();
    const activeTab = sessions.find((s) => s.id === ui.activeTabId);

    if (action.startsWith("select-account:")) {
      ui.navigate({ kind: "account", accountId: action.slice("select-account:".length) });
      return;
    }
    switch (action) {
      case "new-session":
      case "new-shell": {
        const ctx = launchContext(ui.view, activeTab, accounts, projects);
        if (!ctx) {
          toast("Add an account first");
          ui.openDialog("addAccount", true);
          return;
        }
        void launch(ctx.accountId, action === "new-shell" ? "shell" : "claude", {
          projectId: ctx.projectId,
        });
        return;
      }
      case "add-account":
        ui.openDialog("addAccount", true);
        return;
      case "continue-conversation": {
        const context =
          ui.view.kind === "terminal" && activeTab
            ? {
                accountId: activeTab.accountId,
                ...(activeTab.projectId ? { projectId: activeTab.projectId } : {}),
              }
            : ui.view.kind === "project"
              ? { projectId: ui.view.projectId }
              : {};
        ui.openDialog("continueConversation", context);
        return;
      }
      case "add-project":
        void addProject();
        return;
      case "quick-switch":
        ui.setQuickSwitchOpen(true);
        return;
      case "settings":
      case "troubleshooting":
        ui.navigate({ kind: "settings" });
        return;
      case "show-sessions":
        ui.navigate({ kind: "sessions" });
        return;
      case "prev-tab":
        ui.cycleTab(-1);
        return;
      case "next-tab":
        ui.cycleTab(1);
        return;
      case "toggle-sidebar":
        ui.toggleSidebar();
        return;
      default:
        // close-tab and clear-terminal are handled by the terminal views.
        return;
    }
  });

  useEffect(() => {
    return subscribe("menu-action", (action) => {
      handle(action);
    });
  }, []);
}
