import { KeyRoundIcon, RotateCcwIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type { SessionInfo } from "@/bindings/SessionInfo";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot } from "@/features/accounts/AccountBits";
import { isActive } from "@/features/terminal/session-utils";
import { useLaunch } from "@/hooks/useLaunch";
import { api, errorMessage } from "@/lib/ipc";
import { useAccounts, useProjects } from "@/lib/queries";
import { formatDuration, formatRelative } from "@/lib/utils";
import { useUi } from "@/store/ui";

const KIND_ICON = {
  claude: SquareTerminalIcon,
  shell: TerminalIcon,
  login: KeyRoundIcon,
} as const;

function StatusBadge({ session }: { session: SessionInfo }) {
  switch (session.status) {
    case "running":
      return <Badge tone="success">Running</Badge>;
    case "starting":
      return <Badge tone="info">Starting</Badge>;
    case "stopping":
      return <Badge tone="warning">Stopping</Badge>;
    case "failed":
      return <Badge tone="danger">Failed</Badge>;
    case "interrupted":
      return <Badge tone="warning">Interrupted</Badge>;
    case "exited":
      return session.exitCode === 0 || session.exitCode === null ? (
        <Badge>Ended</Badge>
      ) : (
        <Badge tone="danger">Exit {session.exitCode}</Badge>
      );
  }
}

export function SessionList({
  sessions,
  showAccount = true,
  showProject = true,
  emptyTitle,
  emptyBody,
}: {
  sessions: SessionInfo[];
  showAccount?: boolean;
  showProject?: boolean;
  emptyTitle: string;
  emptyBody?: string;
}) {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const activateTab = useUi((s) => s.activateTab);
  const openTab = useUi((s) => s.openTab);
  const { launch } = useLaunch();
  const [busyId, setBusyId] = useState<string | null>(null);
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  if (sessions.length === 0) {
    return (
      <EmptyState icon={<SquareTerminalIcon />} title={emptyTitle}>
        {emptyBody}
      </EmptyState>
    );
  }

  return (
    <Card className="divide-y overflow-hidden">
      {sessions.map((s) => {
        const account = accountsById.get(s.accountId);
        const project = s.projectId ? projectsById.get(s.projectId) : undefined;
        const Icon = KIND_ICON[s.kind];
        const active = isActive(s);
        return (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{s.title}</span>
                <StatusBadge session={s} />
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                {showAccount && account && (
                  <>
                    <AccountDot color={account.color} />
                    <span className="min-w-0 shrink truncate">{account.name}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                {showProject && (
                  <>
                    <span className="min-w-0 shrink-[2] truncate">
                      {project?.name ?? (s.projectId ? "Removed project" : "Home folder")}
                    </span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span className="shrink-0">{formatRelative(s.startedAt)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatDuration(s.startedAt, s.endedAt)}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {s.attached && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    openTab(s.id);
                    activateTab(s.id);
                  }}
                >
                  Show
                </Button>
              )}
              {active && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Stop ${s.title}`}
                  loading={busyId === s.id}
                  onClick={() => {
                    setBusyId(s.id);
                    api
                      .stopSession(s.id)
                      .catch((err: unknown) => {
                        toast.error("Could not stop the session", {
                          description: errorMessage(err),
                        });
                      })
                      .finally(() => {
                        setBusyId(null);
                      });
                  }}
                >
                  Stop
                </Button>
              )}
              {!active && !s.attached && s.kind !== "login" && account && (
                <Tooltip content="Start a new session like this one">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Start again: ${s.title}`}
                    onClick={() => {
                      void launch(s.accountId, s.kind === "shell" ? "shell" : "claude", {
                        projectId: project ? s.projectId : null,
                      });
                    }}
                  >
                    <RotateCcwIcon />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
