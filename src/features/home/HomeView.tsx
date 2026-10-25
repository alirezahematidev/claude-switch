import {
  FolderOpenIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";

import type { Account } from "@/bindings/Account";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, EmptyState, Section } from "@/components/ui/misc";
import { AccountAvatar, AuthStatusBadge } from "@/features/accounts/AccountBits";
import { useAddProject } from "@/features/projects/useAddProject";
import { SystemWarnings } from "@/features/settings/SystemWarnings";
import { useLaunch } from "@/hooks/useLaunch";
import { accountSubtitle, needsSignIn } from "@/lib/auth-status";
import { useAccounts, useProjects, useSystemInfo } from "@/lib/queries";
import { formatRelative, pluralize, tildify } from "@/lib/utils";
import { useUi } from "@/store/ui";

export function HomeView() {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const { data: system } = useSystemInfo();
  const openDialog = useUi((s) => s.openDialog);
  const navigate = useUi((s) => s.navigate);
  const addProject = useAddProject();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-7 px-8 py-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Accounts</h1>
          <p className="text-[13px] text-muted-foreground">
            Every account keeps its own Claude Code login, settings, and history. Switching never
            signs another account out.
          </p>
        </div>
        <Button
          onClick={() => {
            openDialog("addAccount", true);
          }}
        >
          <PlusIcon />
          Add Account
        </Button>
      </header>

      <SystemWarnings compact />

      {accounts.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title="No accounts yet"
          action={
            <Button
              onClick={() => {
                openDialog("addAccount", true);
              }}
            >
              Add Your First Account
            </Button>
          }
        >
          Add an account and sign in once with Claude Code. After that, open it with one click.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      )}

      <Section
        title="Projects"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void addProject()}>
            <FolderPlusIcon />
            Add Project
          </Button>
        }
      >
        {projects.length === 0 ? (
          <EmptyState icon={<FolderPlusIcon />} title="No projects yet">
            Add a folder to open Claude Code there with any account.
          </EmptyState>
        ) : (
          <Card className="divide-y overflow-hidden">
            {projects.slice(0, 6).map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => {
                  navigate({ kind: "project", projectId: p.id });
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/50"
              >
                {p.favorite ? (
                  <StarIcon className="size-4 shrink-0 fill-warning text-warning" />
                ) : (
                  <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {tildify(p.directory, system?.homeDir)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {p.runningSessions > 0
                    ? `${pluralize(p.runningSessions, "session")} running`
                    : formatRelative(p.lastUsedAt)}
                </span>
              </button>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}

export function AccountCard({ account }: { account: Account }) {
  const navigate = useUi((s) => s.navigate);
  const openDialog = useUi((s) => s.openDialog);
  const { launch } = useLaunch();
  const subtitle = accountSubtitle(account);
  const signIn = needsSignIn(account);

  return (
    <Card className="flex flex-col gap-3 p-3.5 transition-colors hover:border-foreground/15">
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          onClick={() => {
            navigate({ kind: "account", accountId: account.id });
          }}
        >
          <AccountAvatar account={account} className="size-9 text-sm" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold">{account.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {subtitle ?? "No email or label"}
            </span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${account.name}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void launch(account.id, "shell")}>
              New Shell
            </DropdownMenuItem>
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
      <div className="flex flex-wrap items-center gap-2">
        <AuthStatusBadge account={account} />
        {account.runningSessions > 0 && (
          <span className="text-xs text-success">
            {pluralize(account.runningSessions, "session")} running
          </span>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Used {formatRelative(account.lastUsedAt).toLowerCase()}
        </span>
        {signIn ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openDialog("signInAccountId", account.id);
            }}
          >
            <KeyRoundIcon />
            Sign In
          </Button>
        ) : (
          <Button size="sm" onClick={() => void launch(account.id, "claude")}>
            <PlayIcon />
            Open
          </Button>
        )}
      </div>
    </Card>
  );
}
