import {
  FolderOpenIcon,
  FolderPlusIcon,
  LayoutGridIcon,
  SettingsIcon,
  SquareTerminalIcon,
  UserPlusIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { Kbd } from "@/components/ui/misc";
import { AccountDot, AuthStatusIcon } from "@/features/accounts/AccountBits";
import { useAddProject } from "@/features/projects/useAddProject";
import { useLaunch } from "@/hooks/useLaunch";
import { accountSubtitle } from "@/lib/auth-status";
import { useAccounts, useOpenSessions, useProjects } from "@/lib/queries";
import { cn, matchesQuery as matches } from "@/lib/utils";
import { useUi } from "@/store/ui";

interface PaletteItem {
  id: string;
  group: "Accounts" | "Sessions" | "Projects" | "Actions";
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  /** ⌘↩ alternative action. */
  alt?: () => void;
  altHint?: string;
}

export function QuickSwitcher() {
  const open = useUi((s) => s.quickSwitchOpen);
  const setOpen = useUi((s) => s.setQuickSwitchOpen);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30" />
        {open && <Palette />}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Palette() {
  const setOpen = useUi((s) => s.setQuickSwitchOpen);
  const navigate = useUi((s) => s.navigate);
  const activateTab = useUi((s) => s.activateTab);
  const openDialog = useUi((s) => s.openDialog);
  const tabs = useUi((s) => s.tabs);
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const { data: sessions = [] } = useOpenSessions();
  const { launch } = useLaunch();
  const addProject = useAddProject();
  const [query, setQuery] = useState("");
  const [rawIndex, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const close = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const accountItems: PaletteItem[] = accounts
      .filter((a) => matches(query, a.name, a.label, a.verifiedEmail))
      .map((a) => ({
        id: `account:${a.id}`,
        group: "Accounts",
        label: a.name,
        hint: accountSubtitle(a) ?? undefined,
        icon: (
          <span className="flex items-center gap-1.5">
            <AccountDot color={a.color} size="md" />
            <AuthStatusIcon status={a.authStatus} />
          </span>
        ),
        run: close(() => {
          navigate({ kind: "account", accountId: a.id });
        }),
        alt: close(() => void launch(a.id, "claude")),
        altHint: "New session",
      }));
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const sessionItems: PaletteItem[] = sessions
      .filter((s) => s.kind !== "login" && tabs.includes(s.id))
      .filter((s) => matches(query, s.title, accountsById.get(s.accountId)?.name))
      .map((s) => ({
        id: `session:${s.id}`,
        group: "Sessions",
        label: s.title,
        hint: accountsById.get(s.accountId)?.name,
        icon: <SquareTerminalIcon className="size-4 text-muted-foreground" />,
        run: close(() => {
          activateTab(s.id);
        }),
      }));
    const projectItems: PaletteItem[] = projects
      .filter((p) => matches(query, p.name, p.directory))
      .map((p) => ({
        id: `project:${p.id}`,
        group: "Projects",
        label: p.name,
        hint: p.directory,
        icon: <FolderOpenIcon className="size-4 text-muted-foreground" />,
        run: close(() => {
          navigate({ kind: "project", projectId: p.id });
        }),
      }));
    const actionItems: PaletteItem[] = [
      {
        id: "action:overview",
        group: "Actions" as const,
        label: "Overview",
        icon: <LayoutGridIcon className="size-4 text-muted-foreground" />,
        run: close(() => {
          navigate({ kind: "home" });
        }),
      },
      {
        id: "action:add-account",
        group: "Actions" as const,
        label: "Add Account…",
        icon: <UserPlusIcon className="size-4 text-muted-foreground" />,
        run: close(() => {
          openDialog("addAccount", true);
        }),
      },
      {
        id: "action:add-project",
        group: "Actions" as const,
        label: "Add Project…",
        icon: <FolderPlusIcon className="size-4 text-muted-foreground" />,
        run: close(() => void addProject()),
      },
      {
        id: "action:settings",
        group: "Actions" as const,
        label: "Settings",
        icon: <SettingsIcon className="size-4 text-muted-foreground" />,
        run: close(() => {
          navigate({ kind: "settings" });
        }),
      },
    ].filter((i) => matches(query, i.label));
    return [...accountItems, ...sessionItems, ...projectItems, ...actionItems];
  }, [
    accounts,
    sessions,
    projects,
    tabs,
    query,
    navigate,
    activateTab,
    openDialog,
    launch,
    addProject,
    setOpen,
  ]);

  const index = Math.min(rawIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex(items.length ? (index + 1) % items.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(items.length ? (index - 1 + items.length) % items.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[index];
      if (!item) return;
      if (e.metaKey && item.alt) item.alt();
      else item.run();
    }
  };

  let lastGroup: string | null = null;
  return (
    <DialogPrimitive.Content
      aria-describedby={undefined}
      className="fixed top-[14vh] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
      onKeyDown={onKeyDown}
    >
      <DialogPrimitive.Title className="sr-only">Switch account</DialogPrimitive.Title>
      <input
        role="combobox"
        aria-expanded="true"
        aria-controls="quick-switch-list"
        aria-activedescendant={items[index] ? `qs-${index}` : undefined}
        placeholder="Switch account, open a project or session…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        className="h-11 w-full border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div
        id="quick-switch-list"
        role="listbox"
        ref={listRef}
        className="max-h-80 overflow-y-auto p-1.5"
      >
        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No matches</p>
        )}
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id}>
              {header && (
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                  {header}
                </div>
              )}
              <div
                id={`qs-${i}`}
                role="option"
                aria-selected={i === index}
                data-index={i}
                tabIndex={-1}
                onMouseMove={() => {
                  setIndex(i);
                }}
                onClick={item.run}
                onKeyDown={(e) => {
                  if (e.key === "Enter") item.run();
                }}
                className={cn(
                  "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]",
                  i === index && "bg-accent",
                )}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
                {item.hint && (
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {item.hint}
                  </span>
                )}
                {i === index && item.altHint && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <Kbd>⌘↩</Kbd> {item.altHint}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </DialogPrimitive.Content>
  );
}
