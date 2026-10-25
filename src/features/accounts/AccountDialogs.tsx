import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { AccountColor } from "@/bindings/AccountColor";
import type { LoginMethod } from "@/bindings/LoginMethod";
import { Button } from "@/components/ui/button";
import { Checkbox, OptionCards } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Field, Input, Label, Textarea } from "@/components/ui/input";
import { Alert } from "@/components/ui/misc";
import {
  ACCOUNT_COLOR_HEX,
  ACCOUNT_COLOR_LABEL,
  ACCOUNT_COLORS,
  nextAccountColor,
} from "@/lib/account-colors";
import { api, errorMessage } from "@/lib/ipc";
import { queryKeys, useAccounts } from "@/lib/queries";
import { useUi } from "@/store/ui";

import { cancelSignIn, looksLikeEmail, startSignIn } from "./sign-in";
import { SignInProgress, SignInSetup } from "./SignInFlow";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export function ColorPicker({
  value,
  onChange,
}: {
  value: AccountColor;
  onChange: (c: AccountColor) => void;
}) {
  return (
    <RadioGroup.Root
      aria-label="Account color"
      orientation="horizontal"
      value={value}
      onValueChange={(v) => {
        const color = ACCOUNT_COLORS.find((c) => c === v);
        if (color) onChange(color);
      }}
      className="flex flex-wrap gap-2"
    >
      {ACCOUNT_COLORS.map((color) => (
        <RadioGroup.Item
          key={color}
          value={color}
          aria-label={ACCOUNT_COLOR_LABEL[color]}
          className="flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-popover outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:ring-2 data-[state=checked]:ring-foreground/60"
          style={{ backgroundColor: ACCOUNT_COLOR_HEX[color] }}
        >
          <RadioGroup.Indicator>
            <CheckIcon className="size-3.5 text-white" strokeWidth={3} />
          </RadioGroup.Indicator>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

/**
 * Account type selection, then the sign-in screen, for one account. Shared
 * by "Add account" (after the details step) and "Sign in".
 */
function SignInSteps({
  account,
  intro,
  onClose,
  onRunningChange,
}: {
  account: Account;
  intro: React.ReactNode;
  onClose: () => void;
  onRunningChange: (sessionId: string | null) => void;
}) {
  const known = account.verifiedEmail ?? account.label;
  const [method, setMethod] = useState<LoginMethod>(
    account.authMethod === "api_key" ? "console" : "claudeai",
  );
  const [email, setEmail] = useState(looksLikeEmail(known) ? (known ?? "") : "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const begin = async () => {
    setStarting(true);
    const session = await startSignIn(account.id, method, email);
    setStarting(false);
    if (session) {
      setSessionId(session.id);
      onRunningChange(session.id);
    }
  };

  if (sessionId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Sign in to “{account.name}”</DialogTitle>
        </DialogHeader>
        <SignInProgress
          key={sessionId}
          sessionId={sessionId}
          account={account}
          onSuccess={() => {
            onRunningChange(null);
          }}
          onRetry={() => {
            cancelSignIn(sessionId);
            onRunningChange(null);
            setSessionId(null);
          }}
          onClose={() => {
            onRunningChange(null);
            onClose();
          }}
        />
      </>
    );
  }

  return (
    <Form
      autoFocus
      className="grid gap-4"
      onSubmit={() => {
        void begin();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {account.authVerifiedAt ? "Re-authenticate" : "Sign in"} “{account.name}”
        </DialogTitle>
        <DialogDescription>{intro}</DialogDescription>
      </DialogHeader>
      <SignInSetup method={method} onMethod={setMethod} email={email} onEmail={setEmail} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {account.authVerifiedAt ? "Cancel" : "Sign In Later"}
        </Button>
        <Button type="submit" loading={starting}>
          Start Sign-In
        </Button>
      </DialogFooter>
    </Form>
  );
}

/** Closes the dialog, stopping a sign-in that is still running. */
function useSignInDialogClose(close: () => void) {
  const [running, setRunning] = useState<string | null>(null);
  return {
    setRunning,
    requestClose: () => {
      if (running) cancelSignIn(running);
      setRunning(null);
      close();
    },
  };
}

// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------

export function AddAccountDialog() {
  const open = useUi((s) => s.dialogs.addAccount);
  const closeDialog = useUi((s) => s.closeDialog);
  const { setRunning, requestClose } = useSignInDialogClose(() => {
    closeDialog("addAccount");
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) requestClose();
      }}
    >
      <DialogContent className="max-w-lg">
        {open && <AddAccountFlow onClose={requestClose} onRunningChange={setRunning} />}
      </DialogContent>
    </Dialog>
  );
}

function AddAccountFlow({
  onClose,
  onRunningChange,
}: {
  onClose: () => void;
  onRunningChange: (sessionId: string | null) => void;
}) {
  const navigate = useUi((s) => s.navigate);
  const { data: accounts = [] } = useAccounts();
  const client = useQueryClient();

  const [created, setCreated] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<AccountColor>(() =>
    nextAccountColor(accounts.map((a) => a.color)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const labelId = useId();

  const submitDetails = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the account a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const account = await api.createAccount({
        name,
        color,
        ...(label.trim() ? { label } : {}),
      });
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
      setCreated(account);
      navigate({ kind: "account", accountId: account.id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <SignInSteps
        account={created}
        intro="Claude Switch runs Claude Code’s own sign-in and shows you each step."
        onClose={onClose}
        onRunningChange={onRunningChange}
      />
    );
  }

  return (
    <Form onSubmit={(e) => void submitDetails(e)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Add account</DialogTitle>
        <DialogDescription>
          Each account gets its own Claude Code profile, so it stays signed in alongside the others.
        </DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor={nameId} error={error}>
        <Input
          id={nameId}
          placeholder="Work, Personal, Client…"
          value={name}
          maxLength={64}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </Field>
      <Field
        label="Email or label (optional)"
        htmlFor={labelId}
        hint="A reminder of which Claude account this is. The verified email appears after sign-in."
      >
        <Input
          id={labelId}
          placeholder="you@example.com"
          value={label}
          maxLength={254}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </Field>
      <div className="grid gap-2">
        <Label>Color</Label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Create Account
        </Button>
      </DialogFooter>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Sign in / re-authenticate
// ---------------------------------------------------------------------------

export function SignInDialog() {
  const accountId = useUi((s) => s.dialogs.signInAccountId);
  const closeDialog = useUi((s) => s.closeDialog);
  const { data: accounts = [] } = useAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const { setRunning, requestClose } = useSignInDialogClose(() => {
    closeDialog("signInAccountId");
  });
  return (
    <Dialog
      open={Boolean(account)}
      onOpenChange={(o) => {
        if (!o) requestClose();
      }}
    >
      <DialogContent className="max-w-lg">
        {account && (
          <SignInSteps
            key={account.id}
            account={account}
            intro={
              <>
                Runs <code className="font-mono text-xs">claude auth login</code> with this
                account’s profile. Other accounts stay signed in.
              </>
            }
            onClose={requestClose}
            onRunningChange={setRunning}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export function EditAccountDialog() {
  const accountId = useUi((s) => s.dialogs.editAccountId);
  const closeDialog = useUi((s) => s.closeDialog);
  const { data: accounts = [] } = useAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const close = () => {
    closeDialog("editAccountId");
  };
  return (
    <Dialog
      open={Boolean(account)}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-lg">
        {account && <EditAccountForm key={account.id} account={account} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

function EditAccountForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(account.name);
  const [label, setLabel] = useState(account.label ?? "");
  const [notes, setNotes] = useState(account.notes ?? "");
  const [color, setColor] = useState<AccountColor>(account.color);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), label: useId(), notes: useId() };

  const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateAccount({ id: account.id, name, color, label, notes });
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => void save(e)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit account</DialogTitle>
        <DialogDescription>
          Renaming never moves the profile, so the account stays signed in.
        </DialogDescription>
      </DialogHeader>
      <Field label="Name" htmlFor={ids.name} error={error}>
        <Input
          id={ids.name}
          value={name}
          maxLength={64}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </Field>
      <Field label="Email or label" htmlFor={ids.label}>
        <Input
          id={ids.label}
          value={label}
          maxLength={254}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </Field>
      <div className="grid gap-2">
        <Label>Color</Label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <Field label="Notes" htmlFor={ids.notes} hint="⌘↩ saves.">
        <Textarea
          id={ids.notes}
          rows={4}
          value={notes}
          maxLength={2000}
          onChange={(e) => {
            setNotes(e.target.value);
          }}
        />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </DialogFooter>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export function DeleteAccountDialog() {
  const accountId = useUi((s) => s.dialogs.deleteAccountId);
  const closeDialog = useUi((s) => s.closeDialog);
  const { data: accounts = [] } = useAccounts();
  const account = accounts.find((a) => a.id === accountId);
  const close = () => {
    closeDialog("deleteAccountId");
  };
  return (
    <Dialog
      open={Boolean(account)}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-lg">
        {account && <DeleteAccountForm key={account.id} account={account} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

const REMOVE_OPTIONS = [
  {
    value: "keep",
    title: "Remove from Claude Switch",
    description: "Keeps the profile folder (settings, history, login) on disk.",
  },
  {
    value: "delete",
    title: "Remove and delete profile data",
    description:
      "Permanently deletes this account’s Claude Code settings, history, and stored login.",
    danger: true,
  },
] as const;

export function DeleteAccountForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const navigate = useUi((s) => s.navigate);
  const client = useQueryClient();
  const [mode, setMode] = useState<"keep" | "delete">("keep");
  const [confirmation, setConfirmation] = useState("");
  const [signOut, setSignOut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmId = useId();

  const running = account.runningSessions;
  const confirmed = mode === "keep" || confirmation.trim() === account.name;
  const canSubmit = !busy && running === 0 && confirmed;

  const remove = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount({
        id: account.id,
        deleteProfileData: mode === "delete",
        signOutFirst: mode === "delete" && signOut,
        confirmation,
      });
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
      navigate({ kind: "home" });
      toast.success(`Removed ${account.name}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => void remove(e)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Remove “{account.name}”?</DialogTitle>
        <DialogDescription>Project folders are never touched.</DialogDescription>
      </DialogHeader>
      {running > 0 && (
        <Alert tone="warning" title="Sessions are running">
          Stop this account’s {running === 1 ? "session" : `${running} sessions`} before removing
          it.
        </Alert>
      )}
      <OptionCards
        label="What to remove"
        value={mode}
        onChange={setMode}
        options={REMOVE_OPTIONS}
      />
      {mode === "delete" && (
        <div className="grid gap-4">
          <Checkbox
            checked={signOut}
            onCheckedChange={setSignOut}
            label="Sign out with Claude Code first (recommended)"
            description={
              <>
                Runs <code className="font-mono">claude auth logout</code> so the stored login is
                removed from the Keychain and revoked.
              </>
            }
          />
          <Field label={`Type “${account.name}” to confirm`} htmlFor={confirmId}>
            <Input
              id={confirmId}
              value={confirmation}
              onChange={(e) => {
                setConfirmation(e.target.value);
              }}
            />
          </Field>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" loading={busy} disabled={!canSubmit}>
          {mode === "delete" ? "Delete Account and Data" : "Remove Account"}
        </Button>
      </DialogFooter>
    </Form>
  );
}
