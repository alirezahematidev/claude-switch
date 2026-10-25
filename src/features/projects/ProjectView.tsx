import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeftIcon,
  FolderOpenIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  StarIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { Project } from "@/bindings/Project";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form } from "@/components/ui/form";
import { Field, Input, Label } from "@/components/ui/input";
import { Alert, Card, Section } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot, AuthStatusIcon } from "@/features/accounts/AccountBits";
import { OpenInEditorButton } from "@/features/editors/OpenInEditor";
import { SessionList } from "@/features/sessions/SessionList";
import { isActive } from "@/features/terminal/session-utils";
import { useLaunch } from "@/hooks/useLaunch";
import { AUTH_STATUS_META } from "@/lib/auth-status";
import { api, errorMessage } from "@/lib/ipc";
import {
  queryKeys,
  useAccounts,
  useOpenSessions,
  useSessionHistory,
  useSystemInfo,
} from "@/lib/queries";
import { tildify } from "@/lib/utils";
import { useUi } from "@/store/ui";

export function ProjectView({ project }: { project: Project }) {
  const client = useQueryClient();
  const navigate = useUi((s) => s.navigate);
  const { data: system } = useSystemInfo();
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingBusy, setRemovingBusy] = useState(false);

  const update = async (patch: {
    name?: string;
    favorite?: boolean;
    defaultAccountId?: string;
  }) => {
    try {
      await api.updateProject({ id: project.id, ...patch });
      await client.invalidateQueries({ queryKey: queryKeys.projects });
      return true;
    } catch (err) {
      toast.error("Could not update the project", { description: errorMessage(err) });
      return false;
    }
  };

  const remove = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRemovingBusy(true);
    try {
      await api.removeProject(project.id);
      await client.invalidateQueries({ queryKey: queryKeys.projects });
      navigate({ kind: "home" });
    } catch (err) {
      toast.error("Could not remove the project", { description: errorMessage(err) });
    } finally {
      setRemovingBusy(false);
      setRemoving(false);
    }
  };

  const shortPath = tildify(project.directory, system?.homeDir);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <header className="flex items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <FolderOpenIcon className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <h1 className="truncate text-lg leading-6 font-semibold">{project.name}</h1>
          <Tooltip content={project.directory} side="bottom">
            <p className="selectable truncate font-mono text-xs text-muted-foreground">
              {shortPath}
            </p>
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip content={project.favorite ? "Remove from favorites" : "Add to favorites"}>
            <Button
              variant="outline"
              size="icon"
              aria-pressed={project.favorite}
              aria-label="Favorite"
              onClick={() => void update({ favorite: !project.favorite })}
            >
              <StarIcon className={project.favorite ? "fill-warning text-warning" : ""} />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setRenaming(true);
                }}
              >
                <PencilIcon />
                Rename…
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!project.exists}
                onSelect={() => {
                  api
                    .revealPath({ kind: "project", projectId: project.id })
                    .catch((err: unknown) => {
                      toast.error("Could not show the folder", { description: errorMessage(err) });
                    });
                }}
              >
                <FolderOpenIcon />
                Show in Finder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  setRemoving(true);
                }}
              >
                <Trash2Icon />
                Remove from Claude Switch…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {!project.exists && (
        <Alert tone="danger" title="Folder not found">
          <span className="font-mono text-xs break-all">{project.directory}</span> no longer exists.
          Sessions can’t start here until it’s restored.
        </Alert>
      )}

      <LaunchCard
        project={project}
        onDefaultAccount={(id) => void update({ defaultAccountId: id })}
      />
      <ProjectSessions project={project} />

      <Alert tone="info" title="Project settings still apply">
        Claude Code also reads this folder’s own <code className="font-mono">CLAUDE.md</code> and{" "}
        <code className="font-mono">.claude/</code> settings, whichever account you use. Claude
        Switch never creates or edits them.
      </Alert>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          {renaming && (
            <RenameProjectForm
              project={project}
              onClose={() => {
                setRenaming(false);
              }}
              onSave={(name) => update({ name })}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <Form className="grid gap-4" onSubmit={(e) => void remove(e)}>
            <DialogHeader>
              <DialogTitle>Remove “{project.name}”?</DialogTitle>
              <DialogDescription>
                It disappears from Claude Switch. The folder and its files are not changed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setRemoving(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" loading={removingBusy}>
                Remove
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LaunchCard({
  project,
  onDefaultAccount,
}: {
  project: Project;
  onDefaultAccount: (accountId: string) => void;
}) {
  const { data: accounts = [] } = useAccounts();
  const { launch } = useLaunch();
  const openDialog = useUi((s) => s.openDialog);
  const fallback =
    accounts.find((a) => a.id === project.defaultAccountId) ??
    accounts.find((a) => a.authStatus === "authenticated") ??
    accounts[0];
  const [chosenId, setChosenId] = useState<string | undefined>(fallback?.id);
  const selectId = useId();
  // Fall back if the chosen account was removed.
  const accountId = accounts.some((a) => a.id === chosenId) ? chosenId : fallback?.id;
  const account = accounts.find((a) => a.id === accountId);
  const disabled = !account || !project.exists;

  const go = (kind: "claude" | "shell", continueLast = false) => {
    if (!account) return;
    void launch(account.id, kind, { projectId: project.id, continueLast });
  };

  return (
    <Section
      title="Launch"
      description="Each session and editor window stays bound to the account it was opened with."
    >
      <Card className="space-y-3 p-3.5">
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor={selectId}>Account</Label>
          <Select
            id={selectId}
            value={accountId}
            placeholder="No accounts yet"
            disabled={accounts.length === 0}
            onValueChange={(v) => {
              setChosenId(v);
              onDefaultAccount(v);
            }}
            options={accounts.map((a) => ({
              value: a.id,
              label: (
                <span className="flex min-w-0 items-center gap-2">
                  <AccountDot color={a.color} />
                  <span className="truncate">{a.name}</span>
                  <AuthStatusIcon status={a.authStatus} />
                </span>
              ),
            }))}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled}
            onClick={() => {
              go("claude");
            }}
          >
            <PlayIcon />
            Open Claude Code
          </Button>
          <Tooltip content="Continue the most recent conversation in this folder">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                go("claude", true);
              }}
            >
              <HistoryIcon />
              Continue
            </Button>
          </Tooltip>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              go("shell");
            }}
          >
            <TerminalIcon />
            Shell
          </Button>
          <OpenInEditorButton
            projectId={project.id}
            accountId={account?.id}
            disabled={!project.exists}
          />
          <Tooltip content="Continue a conversation from this project with a different account, for example after a usage limit">
            <Button
              variant="ghost"
              disabled={!project.exists || accounts.length < 2}
              onClick={() => {
                openDialog("continueConversation", { projectId: project.id });
              }}
            >
              <ArrowRightLeftIcon />
              Continue in Another Account…
            </Button>
          </Tooltip>
        </div>
        {account && account.authStatus !== "authenticated" && (
          <p className="text-xs text-warning">
            {AUTH_STATUS_META[account.authStatus].label}: Claude Code may ask {account.name} to sign
            in first.
          </p>
        )}
      </Card>
    </Section>
  );
}

function ProjectSessions({ project }: { project: Project }) {
  const { data: open = [] } = useOpenSessions();
  const { data: history = [] } = useSessionHistory({ projectId: project.id, limit: 15 });
  const running = open.filter((s) => s.projectId === project.id && isActive(s));
  const past = history.filter((s) => !isActive(s));
  return (
    <>
      {running.length > 0 && (
        <Section title="Running sessions">
          <SessionList sessions={running} showProject={false} emptyTitle="" />
        </Section>
      )}
      <Section title="Recent sessions">
        <SessionList
          sessions={past}
          showProject={false}
          emptyTitle="No sessions in this project yet"
        />
      </Section>
    </>
  );
}

function RenameProjectForm({
  project,
  onClose,
  onSave,
}: {
  project: Project;
  onClose: () => void;
  onSave: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <Form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        void onSave(name).then((ok) => {
          setBusy(false);
          if (ok) onClose();
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>Only the label changes; the folder is not renamed.</DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor={id}>
        <Input
          id={id}
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!name.trim()}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}
