import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeftIcon,
  GaugeIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareTerminalIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { AppSettings } from "@/bindings/AppSettings";
import type { SessionInfo } from "@/bindings/SessionInfo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot } from "@/features/accounts/AccountBits";
import { useCloseTab } from "@/hooks/useCloseTab";
import { useLaunch } from "@/hooks/useLaunch";
import { api, errorMessage, subscribe } from "@/lib/ipc";
import { forgetSession, rememberSession, useAccounts, useOpenSessions } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { exitSummary, isActive, isTabSession } from "./session-utils";
import { TerminalPane } from "./TerminalPane";

export function TerminalWorkspace({
  settings,
  theme,
  visible,
}: {
  settings: AppSettings;
  theme: "light" | "dark";
  visible: boolean;
}) {
  const { data: openSessions = [] } = useOpenSessions();
  const { data: accounts = [] } = useAccounts();
  const tabs = useUi((s) => s.tabs);
  const activeTabId = useUi((s) => s.activeTabId);
  const activateTab = useUi((s) => s.activateTab);
  const setTabs = useUi((s) => s.setTabs);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const closeTab = useCloseTab();
  const { launch } = useLaunch();
  const [confirmClose, setConfirmClose] = useState<SessionInfo | null>(null);
  const [dismissedLimits, setDismissedLimits] = useState<ReadonlySet<string>>(new Set());
  const notifiedLimits = useRef(new Set<string>());
  const stripRef = useRef<HTMLDivElement>(null);

  // Sign-in sessions have their own screen and never become tabs.
  const tabSessions = useMemo(() => openSessions.filter(isTabSession), [openSessions]);
  const sessionsById = useMemo(() => new Map(tabSessions.map((s) => [s.id, s])), [tabSessions]);
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Adopt sessions the backend holds but the UI does not (after a reload, or
  // sessions started from the menu bar), and drop tabs that no longer exist.
  useEffect(() => {
    const known = new Set(tabs);
    const missing = tabSessions.filter((s) => !known.has(s.id)).map((s) => s.id);
    const stale = tabs.filter((id) => !sessionsById.has(id));
    if (missing.length > 0 || stale.length > 0) {
      setTabs([...tabs.filter((id) => sessionsById.has(id)), ...missing]);
    }
  }, [tabSessions, sessionsById, tabs, setTabs]);

  // Keep the active tab scrolled into view.
  useEffect(() => {
    if (!activeTabId) return;
    stripRef.current
      ?.querySelector(`[data-tab-id="${activeTabId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  useEffect(
    () =>
      subscribe("focus-session", (id) => {
        useUi.getState().openTab(id);
      }),
    [],
  );

  // A usage limit in a tab the user is not looking at gets a toast too.
  const notifyLimit = useEffectEvent((session: SessionInfo) => {
    const ui = useUi.getState();
    if (visible && ui.activeTabId === session.id) return;
    const account = accountsById.get(session.accountId);
    toast.warning(`${account?.name ?? "An account"} reached a usage limit`, {
      description: session.title,
      action: {
        label: "Continue…",
        onClick: () => {
          ui.openDialog("continueConversation", continueContext(session));
        },
      },
    });
  });
  useEffect(() => {
    for (const s of tabSessions) {
      if (s.usageLimitReached && s.projectId && !notifiedLimits.current.has(s.id)) {
        notifiedLimits.current.add(s.id);
        notifyLimit(s);
      }
    }
  }, [tabSessions]);

  const requestClose = (session: SessionInfo | undefined, id: string) => {
    if (session && isActive(session)) {
      setConfirmClose(session);
    } else {
      void closeTab(id);
    }
  };

  // Menu: Close Tab (⌘W)
  const onMenuAction = useEffectEvent((action: string) => {
    if (action !== "close-tab") return;
    const { activeTabId: id, view } = useUi.getState();
    if (view.kind !== "terminal" || !id) return;
    requestClose(sessionsById.get(id), id);
  });
  useEffect(
    () =>
      subscribe("menu-action", (action) => {
        onMenuAction(action);
      }),
    [],
  );

  const active = activeTabId ? sessionsById.get(activeTabId) : undefined;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", !visible && "hidden")}>
      <div
        data-tauri-drag-region
        className={cn(
          "flex h-11 shrink-0 items-end gap-1 border-b bg-sidebar pr-2 pl-2",
          // Leave room for the traffic lights when the sidebar is hidden.
          sidebarHidden && "pl-20",
        )}
      >
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Terminal sessions"
          data-tauri-drag-region
          className="no-scrollbar flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
        >
          {tabs.map((id) => {
            const session = sessionsById.get(id);
            if (!session) return null;
            return (
              <TerminalTab
                key={id}
                session={session}
                account={accountsById.get(session.accountId)}
                selected={id === activeTabId}
                onSelect={() => {
                  activateTab(id);
                }}
                onClose={() => {
                  requestClose(session, id);
                }}
              />
            );
          })}
        </div>
        {active && (
          <Tooltip content="New session with this account and project">
            <Button
              variant="ghost"
              size="icon-sm"
              className="mb-1.5 shrink-0"
              aria-label="New session"
              onClick={() => {
                void launch(active.accountId, active.kind === "shell" ? "shell" : "claude", {
                  projectId: active.projectId,
                });
              }}
            >
              <PlusIcon />
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="relative min-h-0 flex-1 bg-terminal">
        {tabs.map((id) => {
          const session = sessionsById.get(id);
          if (!session) return null;
          const selected = id === activeTabId;
          return (
            <div
              key={id}
              role="tabpanel"
              aria-label={session.title}
              className={cn("absolute inset-0 flex flex-col", !selected && "hidden")}
            >
              {session.usageLimitReached && session.projectId && !dismissedLimits.has(id) && (
                <LimitBar
                  accountName={accountsById.get(session.accountId)?.name}
                  onContinue={() => {
                    useUi.getState().openDialog("continueConversation", continueContext(session));
                  }}
                  onDismiss={() => {
                    setDismissedLimits((prev) => new Set(prev).add(id));
                  }}
                />
              )}
              <div className="min-h-0 flex-1">
                <TerminalPane
                  sessionId={id}
                  active={selected && visible}
                  settings={settings}
                  theme={theme}
                />
              </div>
              {!isActive(session) && (
                <ExitBar
                  session={session}
                  onClose={() => {
                    void closeTab(id);
                  }}
                />
              )}
            </div>
          );
        })}
        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <SquareTerminalIcon className="size-6" />
            <p className="text-[13px]">No open sessions</p>
          </div>
        )}
      </div>

      <Dialog
        open={confirmClose !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmClose(null);
        }}
      >
        <DialogContent>
          <Form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmClose) void closeTab(confirmClose.id);
              setConfirmClose(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>Stop this session?</DialogTitle>
              <DialogDescription>
                {confirmClose?.kind === "shell" ? "The shell" : "Claude Code"} is still running in “
                {confirmClose?.title}”. Closing the tab stops the process and everything it started.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirmClose(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive">
                Stop and Close
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TerminalTab({
  session,
  account,
  selected,
  onSelect,
  onClose,
}: {
  session: SessionInfo;
  account: Account | undefined;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const running = isActive(session);
  const busy = session.status === "starting" || session.status === "stopping";
  return (
    <Tooltip content={account ? `${session.title} · ${account.name}` : session.title} side="bottom">
      <div
        role="tab"
        data-tab-id={session.id}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose();
        }}
        className={cn(
          "group relative flex h-8 w-44 min-w-24 shrink items-center gap-1.5 rounded-t-md border border-b-0 pr-1 pl-2.5 text-xs transition-colors",
          selected
            ? "border-border bg-terminal text-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        {account && <AccountDot color={account.color} />}
        {session.kind === "shell" && <TerminalIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {busy ? (
          <Spinner className="size-3" />
        ) : (
          !running && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {session.exitCode !== null ? `exit ${session.exitCode}` : "ended"}
            </span>
          )
        )}
        <button
          type="button"
          aria-label={`Close ${session.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100",
            selected && "opacity-60",
          )}
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </Tooltip>
  );
}

function continueContext(session: SessionInfo) {
  return {
    accountId: session.accountId,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    destination: "terminal" as const,
  };
}

/** Offered when Claude Code reports a usage limit in this session. */
function LimitBar({
  accountName,
  onContinue,
  onDismiss,
}: {
  accountName: string | undefined;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/30 bg-warning/10 py-1.5 pr-1.5 pl-3 text-xs"
    >
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
        <GaugeIcon className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 wrap-break-word">
          Claude Code reported a usage limit{accountName ? ` for ${accountName}` : ""}.
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={onContinue}>
          <ArrowRightLeftIcon />
          Continue in Another Account
        </Button>
        <Tooltip content="Dismiss">
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <XIcon />
          </Button>
        </Tooltip>
      </span>
    </div>
  );
}

function ExitBar({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const replaceTab = useUi((s) => s.replaceTab);
  const client = useQueryClient();
  const { size } = useLaunch();
  const [busy, setBusy] = useState(false);
  const failed = session.status === "failed" || (session.exitCode ?? 0) !== 0;
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2 text-xs",
        failed ? "bg-destructive/5" : "bg-muted/60",
      )}
    >
      <span className={cn("min-w-0 flex-1", failed ? "text-destructive" : "text-muted-foreground")}>
        {exitSummary(session)}
      </span>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          loading={busy}
          onClick={() => {
            setBusy(true);
            const { cols, rows } = size();
            api
              .restartSession(session.id, cols, rows)
              .then((next) => {
                forgetSession(client, session.id);
                rememberSession(client, next);
                replaceTab(session.id, next.id);
              })
              .catch((err: unknown) => {
                toast.error("Could not restart", { description: errorMessage(err) });
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {!busy && <RotateCcwIcon />}
          Restart
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
