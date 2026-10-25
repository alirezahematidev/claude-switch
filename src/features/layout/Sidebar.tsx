import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  CodeXmlIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  ListIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { Project } from "@/bindings/Project";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot, AuthStatusIcon } from "@/features/accounts/AccountBits";
import { useEditors, useOpenInEditor } from "@/features/editors/useEditors";
import { useAddProject } from "@/features/projects/useAddProject";
import { isActive } from "@/features/terminal/session-utils";
import { useLaunch } from "@/hooks/useLaunch";
import { api, errorMessage } from "@/lib/ipc";
import { queryKeys, useAccounts, useOpenSessions, useProjects, useSystemInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

const menuContentClass =
  "z-50 min-w-48 max-w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
const menuSeparator = <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />;

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between pt-2 pr-2.5 pl-3.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      {action}
    </div>
  );
}

function HeaderButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function NavItem({
  selected,
  onClick,
  children,
  className,
  ...rest
}: {
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"button">, "onClick">) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "mx-1.5 flex h-7 w-[calc(100%-12px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-accent font-medium text-foreground"
          : "text-foreground/85 hover:bg-accent/60",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function CountPill({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-success/15 px-1 text-[10px] font-medium text-success tabular-nums"
      aria-label={label}
    >
      {count}
    </span>
  );
}

function AccountItem({
  account,
  index,
  total,
  selected,
  onMove,
  onDropAt,
}: {
  account: Account;
  index: number;
  total: number;
  selected: boolean;
  onMove: (from: number, to: number) => void;
  onDropAt: (draggedId: string, targetIndex: number) => void;
}) {
  const navigate = useUi((s) => s.navigate);
  const openDialog = useUi((s) => s.openDialog);
  const { launch } = useLaunch();
  const [dragOver, setDragOver] = useState(false);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-claude-switch-account", account.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/x-claude-switch-account")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => {
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const id = e.dataTransfer.getData("application/x-claude-switch-account");
            if (id) onDropAt(id, index);
          }}
          className={cn(
            "relative",
            dragOver &&
              "before:absolute before:inset-x-3 before:-top-px before:h-0.5 before:rounded before:bg-primary",
          )}
        >
          <NavItem
            selected={selected}
            aria-keyshortcuts={index < 9 ? `Meta+${index + 1}` : undefined}
            onClick={() => {
              navigate({ kind: "account", accountId: account.id });
            }}
          >
            <AccountDot color={account.color} size="md" />
            <span className="min-w-0 flex-1 truncate">{account.name}</span>
            <CountPill
              count={account.runningSessions}
              label={`${account.runningSessions} running`}
            />
            <AuthStatusIcon status={account.authStatus} />
          </NavItem>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => void launch(account.id, "claude")}
          >
            <PlayIcon />
            New Claude Session
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => void launch(account.id, "shell")}
          >
            <TerminalIcon />
            New Shell
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              openDialog("signInAccountId", account.id);
            }}
          >
            <KeyRoundIcon />
            {account.authVerifiedAt ? "Re-authenticate…" : "Sign In…"}
          </ContextMenu.Item>
          {menuSeparator}
          <ContextMenu.Item
            className={menuItemClass}
            disabled={index === 0}
            onSelect={() => {
              onMove(index, index - 1);
            }}
          >
            <ArrowUpIcon />
            Move Up
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={index === total - 1}
            onSelect={() => {
              onMove(index, index + 1);
            }}
          >
            <ArrowDownIcon />
            Move Down
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              openDialog("editAccountId", account.id);
            }}
          >
            <PencilIcon />
            Edit…
          </ContextMenu.Item>
          {menuSeparator}
          <ContextMenu.Item
            className={cn(menuItemClass, "text-destructive [&_svg]:text-destructive")}
            onSelect={() => {
              openDialog("deleteAccountId", account.id);
            }}
          >
            <Trash2Icon />
            Remove…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function ProjectItem({ project, selected }: { project: Project; selected: boolean }) {
  const navigate = useUi((s) => s.navigate);
  const openDialog = useUi((s) => s.openDialog);
  const { data: accounts = [] } = useAccounts();
  const { launch } = useLaunch();
  const { preferred } = useEditors();
  const { open } = useOpenInEditor();
  const account =
    accounts.find((a) => a.id === project.defaultAccountId) ??
    accounts.find((a) => a.authStatus === "authenticated") ??
    accounts[0];

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <NavItem
          selected={selected}
          onClick={() => {
            navigate({ kind: "project", projectId: project.id });
          }}
        >
          {project.favorite ? (
            <StarIcon className="size-3.5 shrink-0 fill-warning text-warning" />
          ) : (
            <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              !project.exists && "text-muted-foreground line-through",
            )}
          >
            {project.name}
          </span>
          <CountPill count={project.runningSessions} label={`${project.runningSessions} running`} />
        </NavItem>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContentClass}>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={!account || !project.exists}
            onSelect={() => {
              if (account) void launch(account.id, "claude", { projectId: project.id });
            }}
          >
            <PlayIcon />
            <span className="truncate">
              Open Claude Code{account ? ` with ${account.name}` : ""}
            </span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={!account || !preferred || !project.exists}
            onSelect={() => {
              if (account && preferred) void open(project.id, account.id, preferred);
            }}
          >
            <CodeXmlIcon />
            <span className="truncate">
              Open in {preferred?.name ?? "VS Code"}
              {account ? ` with ${account.name}` : ""}
            </span>
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            disabled={accounts.length < 2 || !project.exists}
            onSelect={() => {
              openDialog("continueConversation", { projectId: project.id });
            }}
          >
            <ArrowRightLeftIcon />
            Continue in Another Account…
          </ContextMenu.Item>
          {menuSeparator}
          <ContextMenu.Item
            className={menuItemClass}
            disabled={!project.exists}
            onSelect={() => {
              api.revealPath({ kind: "project", projectId: project.id }).catch((err: unknown) => {
                toast.error("Could not show the folder", { description: errorMessage(err) });
              });
            }}
          >
            <FolderOpenIcon />
            Show in Finder
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function Sidebar() {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const { data: openSessions = [] } = useOpenSessions();
  const { data: system } = useSystemInfo();
  const view = useUi((s) => s.view);
  const activeTabId = useUi((s) => s.activeTabId);
  const tabs = useUi((s) => s.tabs);
  const navigate = useUi((s) => s.navigate);
  const activateTab = useUi((s) => s.activateTab);
  const openDialog = useUi((s) => s.openDialog);
  const addProject = useAddProject();
  const client = useQueryClient();

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const sessionsById = useMemo(() => new Map(openSessions.map((s) => [s.id, s])), [openSessions]);
  const shownProjects = projects.slice(0, 12);

  const reorder = (ids: string[]) => {
    // Optimistic update; the backend validates the permutation.
    client.setQueryData<Account[]>(queryKeys.accounts, (current) =>
      current
        ? ids.map((id) => current.find((a) => a.id === id)).filter((a): a is Account => Boolean(a))
        : current,
    );
    api.reorderAccounts(ids).catch((err: unknown) => {
      toast.error("Could not reorder accounts", { description: errorMessage(err) });
      void client.invalidateQueries({ queryKey: queryKeys.accounts });
    });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= accounts.length) return;
    const ids = accounts.map((a) => a.id);
    const [moved] = ids.splice(from, 1);
    if (moved) ids.splice(to, 0, moved);
    reorder(ids);
  };
  const dropAt = (draggedId: string, targetIndex: number) => {
    const from = accounts.findIndex((a) => a.id === draggedId);
    if (from === -1 || from === targetIndex) return;
    move(from, targetIndex);
  };

  const cli = system?.cli;
  const cliOk = cli?.state === "found";

  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-62 shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
    >
      {/* Space for the macOS traffic lights; draggable like a title bar. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />

      <div className="min-h-0 flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto pb-3">
        <NavItem
          selected={view.kind === "home"}
          onClick={() => {
            navigate({ kind: "home" });
          }}
        >
          <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
          Overview
        </NavItem>

        <SectionHeader
          title="Accounts"
          action={
            <HeaderButton
              label="Add account"
              shortcut="⇧⌘N"
              onClick={() => {
                openDialog("addAccount", true);
              }}
            >
              <PlusIcon />
            </HeaderButton>
          }
        />
        {accounts.length === 0 && (
          <p className="px-4 py-1 text-xs text-muted-foreground">No accounts yet.</p>
        )}
        {accounts.map((a, i) => (
          <AccountItem
            key={a.id}
            account={a}
            index={i}
            total={accounts.length}
            selected={view.kind === "account" && view.accountId === a.id}
            onMove={move}
            onDropAt={dropAt}
          />
        ))}

        <SectionHeader
          title="Projects"
          action={
            <HeaderButton label="Add project" shortcut="⌘O" onClick={() => void addProject()}>
              <PlusIcon />
            </HeaderButton>
          }
        />
        {shownProjects.length === 0 && (
          <p className="px-4 py-1 text-xs text-muted-foreground">No projects yet.</p>
        )}
        {shownProjects.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            selected={view.kind === "project" && view.projectId === p.id}
          />
        ))}

        <SectionHeader
          title="Sessions"
          action={
            <HeaderButton
              label="All sessions"
              shortcut="⇧⌘S"
              onClick={() => {
                navigate({ kind: "sessions" });
              }}
            >
              <ListIcon />
            </HeaderButton>
          }
        />
        {tabs.length === 0 && (
          <p className="px-4 py-1 text-xs text-muted-foreground">No open sessions.</p>
        )}
        {tabs.map((id) => {
          const s = sessionsById.get(id);
          if (!s) return null;
          const account = accountsById.get(s.accountId);
          const running = isActive(s);
          return (
            <NavItem
              key={id}
              selected={view.kind === "terminal" && activeTabId === id}
              onClick={() => {
                activateTab(id);
              }}
            >
              {account ? (
                <AccountDot color={account.color} />
              ) : (
                <span className="size-2 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  running ? "bg-success" : "bg-muted-foreground/40",
                )}
                aria-label={running ? "Running" : "Ended"}
              />
            </NavItem>
          );
        })}
      </div>

      <div className="shrink-0 space-y-0.5 border-t border-sidebar-border py-2">
        <NavItem
          selected={view.kind === "settings"}
          onClick={() => {
            navigate({ kind: "settings" });
          }}
        >
          <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
          Settings
        </NavItem>
        <NavItem
          className="h-6 text-[11px] text-muted-foreground"
          onClick={() => {
            navigate({ kind: "settings" });
          }}
        >
          <span
            className={cn("size-1.5 shrink-0 rounded-full", cliOk ? "bg-success" : "bg-warning")}
          />
          <span className="truncate">
            {cli === undefined
              ? "Checking Claude Code…"
              : cliOk
                ? `Claude Code ${cli.version ?? ""}`
                : "Claude Code not found"}
          </span>
        </NavItem>
      </div>
    </nav>
  );
}
