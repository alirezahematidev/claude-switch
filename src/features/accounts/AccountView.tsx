import {
  ChevronDownIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HistoryIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  StarIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, Card, EmptyState, Section, Spinner } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { OpenInEditorButton } from "@/features/editors/OpenInEditor";
import { useAddProject } from "@/features/projects/useAddProject";
import { SessionList } from "@/features/sessions/SessionList";
import { isActive } from "@/features/terminal/session-utils";
import { useLaunch } from "@/hooks/useLaunch";
import { AUTH_STATUS_META, accountSubtitle, authMethodLabel, needsSignIn } from "@/lib/auth-status";
import { api, errorMessage } from "@/lib/ipc";
import { useOpenSessions, useProjects, useSessionHistory, useSystemInfo } from "@/lib/queries";
import { formatDateTime, formatRelative, tildify } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { AccountAvatar, AuthStatusBadge } from "./AccountBits";

export function AccountView({ account }: { account: Account }) {
  const openDialog = useUi((s) => s.openDialog);
  const { launch } = useLaunch();
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    setChecking(true);
    try {
      const updated = await api.refreshAuthStatus(account.id);
      toast(AUTH_STATUS_META[updated.authStatus].label, {
        description: updated.authDetail ?? undefined,
      });
    } catch (err) {
      toast.error("Could not check status", { description: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  };

  const subtitle = accountSubtitle(account);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <header className="flex items-start gap-4">
        <AccountAvatar account={account} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="max-w-full min-w-0 truncate text-lg leading-6 font-semibold">
              {account.name}
            </h1>
            <AuthStatusBadge account={account} />
          </div>
          <p className="selectable truncate text-[13px] text-muted-foreground">
            {subtitle ?? "No email or label"}
            {account.orgName && <span> · {account.orgName}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {needsSignIn(account) ? (
            <Button
              onClick={() => {
                openDialog("signInAccountId", account.id);
              }}
            >
              <KeyRoundIcon />
              Sign In
            </Button>
          ) : (
            <LaunchButton account={account} onLaunch={launch} />
          )}
          <Tooltip content="Check sign-in status">
            <Button
              variant="outline"
              size="icon"
              aria-label="Check sign-in status"
              disabled={checking}
              onClick={() => void refresh()}
            >
              {checking ? <Spinner /> : <RefreshCwIcon />}
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {needsSignIn(account) && (
                <DropdownMenuItem onSelect={() => void launch(account.id, "claude")}>
                  <PlayIcon />
                  Open Claude Code Anyway
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => {
                  openDialog("signInAccountId", account.id);
                }}
              >
                <KeyRoundIcon />
                {account.authVerifiedAt ? "Re-authenticate…" : "Sign In…"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  openDialog("editAccountId", account.id);
                }}
              >
                <PencilIcon />
                Edit…
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  api
                    .revealPath({ kind: "profile", accountId: account.id })
                    .catch((err: unknown) => {
                      toast.error("Could not show the profile folder", {
                        description: errorMessage(err),
                      });
                    });
                }}
              >
                <FolderOpenIcon />
                Show Profile in Finder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  openDialog("deleteAccountId", account.id);
                }}
              >
                <Trash2Icon />
                Remove…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <StatusCallout account={account} />
      <QuickLaunch account={account} />
      <AccountSessions account={account} />
      <ProfileDetails account={account} />
    </div>
  );
}

function LaunchButton({
  account,
  onLaunch,
}: {
  account: Account;
  onLaunch: ReturnType<typeof useLaunch>["launch"];
}) {
  return (
    <div className="flex">
      <Button className="rounded-r-none" onClick={() => void onLaunch(account.id, "claude")}>
        <PlayIcon />
        New Session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
            aria-label="More launch options"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void onLaunch(account.id, "claude")}>
            <PlayIcon />
            New Claude Session
            <DropdownMenuShortcut>⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void onLaunch(account.id, "claude", { continueLast: true })}
          >
            <HistoryIcon />
            Continue Last Conversation
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onLaunch(account.id, "shell")}>
            <TerminalIcon />
            New Shell
            <DropdownMenuShortcut>⇧⌘T</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function StatusCallout({ account }: { account: Account }) {
  const openDialog = useUi((s) => s.openDialog);
  const meta = AUTH_STATUS_META[account.authStatus];
  const signIn = (
    <Button
      size="sm"
      onClick={() => {
        openDialog("signInAccountId", account.id);
      }}
    >
      {account.authVerifiedAt ? "Re-authenticate" : "Sign In"}
    </Button>
  );
  switch (account.authStatus) {
    case "authenticated":
      return null;
    case "not_configured":
      return (
        <Alert tone="info" title="This account isn't signed in yet" action={signIn}>
          Sign in once with Claude Code. After that it stays signed in next to your other accounts.
        </Alert>
      );
    case "auth_required":
      return (
        <Alert tone="warning" title={meta.label} action={signIn}>
          {meta.description}
          {account.authVerifiedAt && <> Last verified {formatRelative(account.authVerifiedAt)}.</>}
        </Alert>
      );
    case "failed":
      return (
        <Alert tone="danger" title={meta.label} action={signIn}>
          {account.authDetail ?? meta.description}
        </Alert>
      );
    case "unsupported_isolation":
      return (
        <Alert tone="warning" title="This account is not isolated">
          {account.authDetail ?? meta.description}
        </Alert>
      );
    case "unknown":
      return (
        <Alert tone="info" title={meta.label}>
          {account.authDetail ?? meta.description}
        </Alert>
      );
  }
}

function QuickLaunch({ account }: { account: Account }) {
  const { data: projects = [] } = useProjects();
  const { launch } = useLaunch();
  const navigate = useUi((s) => s.navigate);
  const addProject = useAddProject();
  const { data: system } = useSystemInfo();
  const home = system?.homeDir;
  const shown = projects.slice(0, 8);

  return (
    <Section
      title="Open in a project"
      description="Starts Claude Code, or opens VS Code, in the project folder using this account."
      actions={
        <Button size="sm" variant="ghost" onClick={() => void addProject()}>
          <FolderPlusIcon />
          Add Project
        </Button>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={<FolderPlusIcon />}
          title="No projects yet"
          action={
            <Button size="sm" variant="outline" onClick={() => void addProject()}>
              Choose a Folder…
            </Button>
          }
        >
          Add a project folder to launch this account directly inside it.
        </EmptyState>
      ) : (
        <Card className="divide-y overflow-hidden">
          {shown.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2">
              {p.favorite ? (
                <StarIcon className="size-4 shrink-0 fill-warning text-warning" />
              ) : (
                <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  navigate({ kind: "project", projectId: p.id });
                }}
              >
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {tildify(p.directory, home)}
                </div>
              </button>
              {!p.exists && (
                <span className="shrink-0 text-xs text-destructive">Folder missing</span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                <OpenInEditorButton
                  iconOnly
                  projectId={p.id}
                  accountId={account.id}
                  disabled={!p.exists}
                />
                <Tooltip content="Continue the last conversation in this project">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Continue in ${p.name}`}
                    disabled={!p.exists}
                    onClick={() =>
                      void launch(account.id, "claude", { projectId: p.id, continueLast: true })
                    }
                  >
                    <HistoryIcon />
                  </Button>
                </Tooltip>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!p.exists}
                  onClick={() => void launch(account.id, "claude", { projectId: p.id })}
                >
                  Open
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </Section>
  );
}

function AccountSessions({ account }: { account: Account }) {
  const { data: open = [] } = useOpenSessions();
  const { data: history = [] } = useSessionHistory({ accountId: account.id, limit: 15 });
  const running = open.filter((s) => s.accountId === account.id && isActive(s));
  const past = history.filter((s) => !isActive(s));
  return (
    <>
      {running.length > 0 && (
        <Section title="Running sessions">
          <SessionList sessions={running} showAccount={false} emptyTitle="" />
        </Section>
      )}
      <Section title="Recent sessions">
        <SessionList
          sessions={past}
          showAccount={false}
          emptyTitle="No sessions yet"
          emptyBody="Sessions you start with this account appear here. Terminal output is never saved."
        />
      </Section>
    </>
  );
}

function ProfileDetails({ account }: { account: Account }) {
  const rows: [string, React.ReactNode][] = [
    [
      "Profile folder",
      <span key="dir" className="selectable font-mono text-xs break-all">
        {account.configDir}
      </span>,
    ],
    ["Sign-in method", authMethodLabel(account.authMethod)],
    ["Last checked", formatDateTime(account.authStatusCheckedAt)],
    ["Last verified signed in", formatDateTime(account.authVerifiedAt)],
    ["Last used", formatDateTime(account.lastUsedAt)],
    ["Created", formatDateTime(account.createdAt)],
  ];
  return (
    <Section
      title="Profile"
      description="Claude Code runs with CLAUDE_CONFIG_DIR set to this folder, so settings, history, and the login stay separate per account."
    >
      <Card className="divide-y">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[180px_1fr] gap-3 px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0">{value}</span>
          </div>
        ))}
        {account.notes && (
          <div className="grid grid-cols-[180px_1fr] gap-3 px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">Notes</span>
            <span className="selectable whitespace-pre-wrap">{account.notes}</span>
          </div>
        )}
      </Card>
    </Section>
  );
}
