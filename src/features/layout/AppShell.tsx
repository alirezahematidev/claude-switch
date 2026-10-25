import type { AppSettings } from "@/bindings/AppSettings";
import { Spinner } from "@/components/ui/misc";
import {
  AddAccountDialog,
  DeleteAccountDialog,
  EditAccountDialog,
  SignInDialog,
} from "@/features/accounts/AccountDialogs";
import { AccountView } from "@/features/accounts/AccountView";
import { ContinueConversationDialog } from "@/features/handoff/ContinueDialog";
import { HomeView } from "@/features/home/HomeView";
import { QuickSwitcher } from "@/features/palette/QuickSwitcher";
import { ProjectView } from "@/features/projects/ProjectView";
import { SessionsView } from "@/features/sessions/SessionsView";
import { SettingsView } from "@/features/settings/SettingsView";
import { TerminalWorkspace } from "@/features/terminal/TerminalWorkspace";
import { useMenuActions } from "@/hooks/useMenuActions";
import { useAccounts, useProjects } from "@/lib/queries";
import { useUi } from "@/store/ui";

import { Sidebar } from "./Sidebar";

function Page() {
  const view = useUi((s) => s.view);
  const { data: accounts, isLoading: accountsLoading } = useAccounts();
  const { data: projects, isLoading: projectsLoading } = useProjects();

  if (accountsLoading || projectsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  switch (view.kind) {
    case "account": {
      const account = accounts?.find((a) => a.id === view.accountId);
      return account ? <AccountView account={account} /> : <HomeView />;
    }
    case "project": {
      const project = projects?.find((p) => p.id === view.projectId);
      return project ? <ProjectView project={project} /> : <HomeView />;
    }
    case "sessions":
      return <SessionsView />;
    case "settings":
      return <SettingsView />;
    case "home":
    case "terminal":
      return <HomeView />;
  }
}

export function AppShell({ settings, theme }: { settings: AppSettings; theme: "light" | "dark" }) {
  const view = useUi((s) => s.view);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  useMenuActions();
  const terminalVisible = view.kind === "terminal";

  return (
    <div className="flex h-full">
      {!sidebarHidden && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col">
        {!terminalVisible && (
          <div
            data-tauri-drag-region
            className={sidebarHidden ? "h-11 shrink-0" : "h-2 shrink-0"}
          />
        )}
        <div className="relative min-h-0 flex-1">
          {/* Terminals stay mounted so their state survives navigation. */}
          <div className={terminalVisible ? "absolute inset-0" : "hidden"}>
            <TerminalWorkspace settings={settings} theme={theme} visible={terminalVisible} />
          </div>
          {!terminalVisible && (
            <div className="absolute inset-0 overflow-y-auto">
              <Page />
            </div>
          )}
        </div>
      </main>
      <QuickSwitcher />
      <AddAccountDialog />
      <SignInDialog />
      <EditAccountDialog />
      <DeleteAccountDialog />
      <ContinueConversationDialog />
    </div>
  );
}
