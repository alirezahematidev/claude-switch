import { useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeftIcon, MessagesSquareIcon, UserPlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { Conversation } from "@/bindings/Conversation";
import type { EditorInfo } from "@/bindings/EditorInfo";
import { Button } from "@/components/ui/button";
import { OptionCards, Segmented } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Field, Input, Label } from "@/components/ui/input";
import { Alert, EmptyState, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AccountDot } from "@/features/accounts/AccountBits";
import { useEditors } from "@/features/editors/useEditors";
import { useLaunch } from "@/hooks/useLaunch";
import { AUTH_STATUS_META } from "@/lib/auth-status";
import { api, toIpcError, type IpcError } from "@/lib/ipc";
import {
  queryKeys,
  rememberSession,
  useAccounts,
  useConversations,
  useProjects,
  useSettings,
  useSystemInfo,
} from "@/lib/queries";
import { formatRelative } from "@/lib/utils";
import { useUi, type ContinueContext } from "@/store/ui";

import { DEFAULT_MESSAGE, formatBytes, pickConversation, pickTarget } from "./handoff";

const TERMINAL = "terminal";

/** "Continue in Another Account": hands a conversation to another account. */
export function ContinueConversationDialog() {
  const context = useUi((s) => s.dialogs.continueConversation);
  const closeDialog = useUi((s) => s.closeDialog);
  const close = () => {
    closeDialog("continueConversation");
  };
  return (
    <Dialog
      open={context !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue in Another Account</DialogTitle>
          <DialogDescription>
            Pick up where a conversation stopped, for example after a usage limit.
          </DialogDescription>
        </DialogHeader>
        {context && <ContinueBody context={context} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function ContinueBody({ context, onDone }: { context: ContinueContext; onDone: () => void }) {
  const { data: conversations, isPending, error } = useConversations();
  const { data: accounts = [], isPending: accountsPending } = useAccounts();
  const { isPending: projectsPending } = useProjects();
  const { isPending: systemPending } = useSystemInfo();
  const { isPending: settingsPending } = useSettings();
  const openDialog = useUi((s) => s.openDialog);

  // Everything the form shows, so it does not change under the pointer.
  if (isPending || accountsPending || projectsPending || systemPending || settingsPending) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <Alert tone="danger" title="Could not look for conversations">
        {toIpcError(error).message}
      </Alert>
    );
  }
  if (accounts.length < 2) {
    return (
      <EmptyState
        icon={<UserPlusIcon className="size-5 text-muted-foreground" />}
        title="Add another account first"
        action={
          <Button
            size="sm"
            onClick={() => {
              onDone();
              openDialog("addAccount", true);
            }}
          >
            Add Account
          </Button>
        }
      >
        A conversation can continue with any other signed-in account.
      </EmptyState>
    );
  }
  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={<MessagesSquareIcon className="size-5 text-muted-foreground" />}
        title="No conversations yet"
      >
        Conversations appear here after you use Claude Code in a project you added to Claude Switch,
        in VS Code, a terminal, or here.
      </EmptyState>
    );
  }
  return <ContinueForm context={context} conversations={conversations} onDone={onDone} />;
}

function ContinueForm({
  context,
  conversations,
  onDone,
}: {
  context: ContinueContext;
  conversations: Conversation[];
  onDone: () => void;
}) {
  const { data: accounts = [] } = useAccounts();
  const { data: projects = [] } = useProjects();
  const { data: settings } = useSettings();
  const { editors } = useEditors();
  const { size } = useLaunch();
  const client = useQueryClient();
  const openTab = useUi((s) => s.openTab);
  const openDialog = useUi((s) => s.openDialog);
  const targetId = useId();
  const destinationId = useId();
  const messageId = useId();

  const [chosenConversation, setChosenConversation] = useState<string | null>(null);
  const [chosenTarget, setChosenTarget] = useState<string | undefined>();
  const [chosenDestination, setChosenDestination] = useState<string | null>(null);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<IpcError | null>(null);

  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const selected =
    conversations.find((c) => c.sessionId === chosenConversation) ??
    pickConversation(conversations, context);
  const target = pickTarget(accounts, selected?.accountId ?? null, chosenTarget);
  const candidates = accounts.filter((a) => a.id !== selected?.accountId);

  // An editor by default only for people who already open projects in one.
  const defaultDestination =
    context.destination === TERMINAL
      ? TERMINAL
      : (editors.find((e) => e.id === settings?.preferredEditor)?.id ?? TERMINAL);
  const destination =
    chosenDestination === TERMINAL || editors.some((e) => e.id === chosenDestination)
      ? (chosenDestination ?? TERMINAL)
      : defaultDestination;
  const editor = editors.find((e) => e.id === destination);
  const editorBlocked = editor?.claudeAccount.mode === "unreadable";

  const submit = async () => {
    if (!selected || !target || editorBlocked) return;
    setBusy(true);
    setFailure(null);
    try {
      const trimmed = message.trim();
      const result = await api.continueConversation({
        projectId: selected.projectId,
        sessionId: selected.sessionId,
        ...(selected.accountId ? { fromAccountId: selected.accountId } : {}),
        toAccountId: target.id,
        ...(editor ? { editorId: editor.id } : {}),
        ...(trimmed ? { message: trimmed } : {}),
        ...size(),
      });
      void client.invalidateQueries({ queryKey: queryKeys.conversations });
      setBusy(false);
      onDone();
      if (result.session) {
        rememberSession(client, result.session);
        openTab(result.session.id);
        toast.success(`Continuing with ${target.name}`);
      } else if (editor) {
        toast.success(`Opened in ${editor.name} with ${target.name}`, {
          description:
            "If a new conversation opens instead, pick this one from Session history in the Claude panel.",
        });
      }
    } catch (err) {
      setFailure(toIpcError(err));
      setBusy(false);
    }
  };

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Project";
  const destinations = [
    { value: TERMINAL, label: "Claude Switch" },
    ...editors.map((e) => ({ value: e.id, label: e.name })),
  ];

  return (
    <Form
      autoFocus
      className="grid min-w-0 gap-4"
      onSubmit={() => {
        void submit();
      }}
    >
      <div className="grid min-w-0 gap-1.5">
        <Label>Conversation</Label>
        {/* Two cards at the smallest window size, up to four when there is room. */}
        <div className="max-h-[clamp(8rem,calc(100vh-27rem),15rem)] overflow-y-auto">
          <OptionCards
            label="Conversation"
            value={selected?.sessionId ?? ""}
            onChange={(id) => {
              setChosenConversation(id);
              setFailure(null);
            }}
            options={conversations.map((c) => ({
              value: c.sessionId,
              title: <span className="block truncate">{projectName(c.projectId)}</span>,
              description: (
                <ConversationMeta
                  conversation={c}
                  account={c.accountId ? accountsById.get(c.accountId) : undefined}
                />
              ),
            }))}
          />
        </div>
      </div>

      <Field label="Continue with" htmlFor={targetId}>
        <Select
          id={targetId}
          value={target?.id}
          placeholder="No other account is signed in"
          disabled={candidates.length === 0}
          onValueChange={(id) => {
            setChosenTarget(id);
            setFailure(null);
          }}
          options={candidates.map((a) => ({
            value: a.id,
            disabled: a.authStatus !== "authenticated",
            label: <AccountOption account={a} />,
          }))}
        />
      </Field>

      {editors.length > 0 && (
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={destinations.length > 3 ? destinationId : undefined}>Open in</Label>
          {destinations.length > 3 ? (
            <Select
              id={destinationId}
              value={destination}
              onValueChange={setChosenDestination}
              options={destinations}
            />
          ) : (
            <div>
              <Segmented
                label="Open in"
                value={destination}
                onChange={setChosenDestination}
                options={destinations}
              />
            </div>
          )}
        </div>
      )}

      <Field
        label="Message"
        htmlFor={messageId}
        hint={
          editor
            ? `Placed in ${editor.name}'s message box; press Return there to send it.`
            : "Sent as soon as the conversation opens. Leave empty to only open it."
        }
      >
        <Input
          id={messageId}
          value={message}
          maxLength={2000}
          onChange={(e) => {
            setMessage(e.target.value);
          }}
        />
      </Field>

      {editor && target && <EditorNote editor={editor} account={target} />}
      {!target && (
        <Alert tone="warning" title="No other account is signed in">
          Sign in to another account to continue this conversation with it.
        </Alert>
      )}
      {failure && (
        <Alert
          tone="danger"
          title="Could not continue the conversation"
          action={
            failure.kind === "authRequired" && target ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onDone();
                  openDialog("signInAccountId", target.id);
                }}
              >
                Sign In
              </Button>
            ) : undefined
          }
        >
          {failure.kind === "authRequired" && target
            ? `${target.name} needs to sign in again.`
            : failure.message}
        </Alert>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!selected || !target || editorBlocked}>
          {!busy && <ArrowRightLeftIcon />}
          Continue
        </Button>
      </DialogFooter>
    </Form>
  );
}

function ConversationMeta({
  conversation,
  account,
}: {
  conversation: Conversation;
  account: Account | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {account && <AccountDot color={account.color} />}
      <span className="min-w-0 truncate">{account?.name ?? "Default folder (~/.claude)"}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{formatRelative(conversation.modifiedAt)}</span>
      <span aria-hidden>·</span>
      <span className="shrink-0">{formatBytes(conversation.sizeBytes)}</span>
    </span>
  );
}

function AccountOption({ account }: { account: Account }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AccountDot color={account.color} />
      <span className="truncate">{account.name}</span>
      {account.authStatus !== "authenticated" && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {AUTH_STATUS_META[account.authStatus].label}
        </span>
      )}
    </span>
  );
}

/** What changes in the editor, said before it happens. */
function EditorNote({ editor, account }: { editor: EditorInfo; account: Account }) {
  const { mode, detail } = editor.claudeAccount;
  if (mode === "unreadable") {
    return (
      <Alert tone="danger" title={`${editor.name}'s settings could not be read`}>
        Fix settings.json in {editor.name} first, or continue in Claude Switch. {detail}
      </Alert>
    );
  }
  return (
    <Alert
      tone={mode === "custom" ? "warning" : "info"}
      title={`${editor.name} will use ${account.name}`}
    >
      Set in your {editor.name} user settings, for new Claude tabs in every window. Tabs already
      open keep their account.
      {mode === "custom" &&
        ` It replaces the folder set there now (${detail ?? "unknown"}); a backup is kept.`}
    </Alert>
  );
}
