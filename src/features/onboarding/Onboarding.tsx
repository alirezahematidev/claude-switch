import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CircleIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { AccountColor } from "@/bindings/AccountColor";
import type { LoginMethod } from "@/bindings/LoginMethod";
import type { Project } from "@/bindings/Project";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Field, Input, Label } from "@/components/ui/input";
import { Alert, Card, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AccountDot, AuthStatusBadge } from "@/features/accounts/AccountBits";
import { ColorPicker } from "@/features/accounts/AccountDialogs";
import { cancelSignIn, looksLikeEmail, startSignIn } from "@/features/accounts/sign-in";
import { SignInProgress, SignInSetup } from "@/features/accounts/SignInFlow";
import { SystemWarnings } from "@/features/settings/SystemWarnings";
import { nextAccountColor } from "@/lib/account-colors";
import { api, errorMessage } from "@/lib/ipc";
import { queryKeys, rememberSession, useAccounts, useSystemInfo } from "@/lib/queries";
import { estimateTerminalSize } from "@/lib/terminal";
import { cn, tildify } from "@/lib/utils";
import { useUi } from "@/store/ui";

const STEPS = [
  "Welcome",
  "System check",
  "How it works",
  "Add account",
  "Sign in",
  "Accounts",
  "Project",
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [account, setAccount] = useState<Account | null>(null);
  const { data: accounts = [] } = useAccounts();
  const current = account ? (accounts.find((a) => a.id === account.id) ?? account) : null;

  const next = () => {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <div className="flex min-h-0 flex-1">
        <aside className="w-52 shrink-0 px-6 pt-4">
          <ol className="space-y-3" aria-label="Setup steps">
            {STEPS.map((label, i) => (
              <li
                key={label}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 text-[13px] leading-5",
                  i === step ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {i < step ? (
                  <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                ) : (
                  <CircleIcon className={cn("size-4 shrink-0", i === step && "text-primary")} />
                )}
                {label}
              </li>
            ))}
          </ol>
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 pt-1 pb-10">
            {step === 0 && <Welcome onNext={next} onSkip={onDone} />}
            {step === 1 && <SystemCheck onNext={next} />}
            {step === 2 && <HowItWorks onNext={next} />}
            {step === 3 && (
              <CreateAccount
                existing={accounts}
                onCreated={(a) => {
                  setAccount(a);
                  next();
                }}
              />
            )}
            {step === 4 && current && <SignIn account={current} onNext={next} />}
            {step === 5 && (
              <AccountsSummary
                accounts={accounts}
                onAddAnother={() => {
                  setAccount(null);
                  setStep(3);
                }}
                onNext={next}
              />
            )}
            {step === 6 && <ChooseProject accounts={accounts} onDone={onDone} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="mb-5 space-y-1.5">
      <h1 className="text-xl leading-7 font-semibold">{title}</h1>
      {children && <p className="text-[13px] text-muted-foreground">{children}</p>}
    </header>
  );
}

function StepFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex items-center justify-between gap-3">{children}</div>;
}

function Welcome({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <>
      <StepHeader title="Welcome to Claude Switch">
        Keep several Claude Code accounts signed in at once and open any of them with one click. No
        more logging out and waiting for a sign-in email every time you switch.
      </StepHeader>
      <div className="grid gap-3">
        {[
          {
            icon: <UsersIcon />,
            title: "One profile per account",
            body: "Each account has its own Claude Code configuration, history, and login.",
          },
          {
            icon: <KeyRoundIcon />,
            title: "Claude Code’s own sign-in",
            body: "You sign in through the official CLI and your browser. Claude Switch never sees passwords or tokens.",
          },
          {
            icon: <LockKeyholeIcon />,
            title: "Local only",
            body: "No servers, accounts, or analytics. Everything stays on this Mac.",
          },
        ].map((f) => (
          <Card key={f.title} className="flex gap-3 p-3.5">
            <span className="flex h-5 items-center text-primary [&_svg]:size-4.5">{f.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13px] leading-5 font-medium">{f.title}</span>
              <span className="block text-xs text-muted-foreground">{f.body}</span>
            </span>
          </Card>
        ))}
      </div>
      <StepFooter>
        <Button variant="ghost" onClick={onSkip}>
          Skip Setup
        </Button>
        <Button onClick={onNext}>Get Started</Button>
      </StepFooter>
    </>
  );
}

function SystemCheck({ onNext }: { onNext: () => void }) {
  const { data: system, isLoading } = useSystemInfo();
  const client = useQueryClient();
  const [checking, setChecking] = useState(false);
  const cli = system?.cli;
  const found = cli?.state === "found";

  const recheck = async () => {
    setChecking(true);
    try {
      await api.refreshCliDetection();
      await client.invalidateQueries({ queryKey: queryKeys.system });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <StepHeader title="System check">
        Claude Switch runs the Claude Code CLI you already have installed.
      </StepHeader>
      {isLoading || !system ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          <Card className="divide-y">
            <div className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
              <CheckCircle2Icon className="size-4 shrink-0 text-success" />
              <span className="flex-1">macOS {system.osVersion}</span>
              <span className="text-xs text-muted-foreground">{system.arch}</span>
            </div>
            <div className="flex items-start gap-3 px-3.5 py-2.5 text-[13px] leading-5">
              <span className="flex h-5 items-center">
                {found ? (
                  <CheckCircle2Icon className="size-4 text-success" />
                ) : (
                  <TriangleAlertIcon className="size-4 text-warning" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div>
                  {found ? `Claude Code ${cli.version ?? ""}` : "Claude Code was not found"}
                </div>
                {cli?.path && (
                  <div className="font-mono text-[11px] break-all text-muted-foreground">
                    {cli.path}
                  </div>
                )}
                {!found && cli?.message && (
                  <div className="text-xs text-muted-foreground">{cli.message}</div>
                )}
              </div>
            </div>
          </Card>
          {!found && (
            <Alert
              tone="warning"
              title="Install Claude Code, then check again"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    api
                      .pickClaudeExecutable()
                      .then(() => client.invalidateQueries({ queryKey: queryKeys.system }))
                      .catch((err: unknown) => {
                        toast.error("Could not use that file", { description: errorMessage(err) });
                      });
                  }}
                >
                  Choose Executable…
                </Button>
              }
            >
              <pre className="selectable mt-1 overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">
                {"curl -fsSL https://claude.ai/install.sh | bash\nbrew install --cask claude-code"}
              </pre>
            </Alert>
          )}
          <SystemWarnings />
        </div>
      )}
      <StepFooter>
        <Button variant="ghost" disabled={checking} onClick={() => void recheck()}>
          <RefreshCwIcon className={cn(checking && "animate-spin")} />
          Check Again
        </Button>
        <Button onClick={onNext} disabled={!found}>
          Continue
        </Button>
      </StepFooter>
    </>
  );
}

function HowItWorks({ onNext }: { onNext: () => void }) {
  return (
    <>
      <StepHeader title="How accounts stay separate">
        Claude Code supports a separate configuration folder per account through{" "}
        <code className="font-mono text-xs">CLAUDE_CONFIG_DIR</code>. Claude Switch creates one for
        each account and starts every session with the right one.
      </StepHeader>
      <div className="space-y-3">
        <Card className="space-y-3 p-3.5 text-[13px] leading-5">
          <div className="flex gap-2.5">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
            <span>
              <strong className="font-medium">Isolated:</strong> Claude subscription logins (Pro,
              Max, Team, Enterprise) and Console logins that create an API key. Claude Code keeps
              each one in a separate Keychain entry tied to the account’s folder.
            </span>
          </div>
          <div className="flex gap-2.5">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              <strong className="font-medium">Not isolated:</strong> Console sign-in without an API
              key, Anthropic profiles, cloud providers (Bedrock, Vertex AI, Foundry), apiKeyHelper
              scripts, and API keys set in your environment. These live outside the account folder.
              Claude Switch flags accounts using them as “Limited isolation”.
            </span>
          </div>
        </Card>
        <Alert tone="info">
          Logins can expire or be revoked. When that happens the account shows “Sign-in required”
          and you sign in again; other accounts are unaffected.
        </Alert>
      </div>
      <StepFooter>
        <span />
        <Button onClick={onNext}>Add an Account</Button>
      </StepFooter>
    </>
  );
}

function CreateAccount({
  existing,
  onCreated,
}: {
  existing: Account[];
  onCreated: (a: Account) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(existing.length === 0 ? "Personal" : "");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<AccountColor>(() =>
    nextAccountColor(existing.map((a) => a.color)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), label: useId() };

  const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the account a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const account = await api.createAccount({ name, color, ...(label.trim() ? { label } : {}) });
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
      onCreated(account);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form autoFocus onSubmit={(e) => void submit(e)}>
      <StepHeader title={existing.length === 0 ? "Add your first account" : "Add another account"}>
        Name it after how you use it. You can change the name and color later.
      </StepHeader>
      <Card className="grid gap-4 p-4">
        <Field label="Name" htmlFor={ids.name} error={error}>
          <Input
            id={ids.name}
            maxLength={64}
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field
          label="Email or label (optional)"
          htmlFor={ids.label}
          hint="Only a reminder for you; the verified email appears after sign-in."
        >
          <Input
            id={ids.label}
            maxLength={254}
            placeholder="you@example.com"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </Field>
        <div className="grid gap-2">
          <Label>Color</Label>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      </Card>
      <StepFooter>
        <span />
        <Button type="submit" loading={busy}>
          Create Account
        </Button>
      </StepFooter>
    </Form>
  );
}

function SignIn({ account, onNext }: { account: Account; onNext: () => void }) {
  const known = account.verifiedEmail ?? account.label;
  const [method, setMethod] = useState<LoginMethod>("claudeai");
  const [email, setEmail] = useState(looksLikeEmail(known) ? (known ?? "") : "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const begin = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStarting(true);
    const session = await startSignIn(account.id, method, email);
    setStarting(false);
    if (session) setSessionId(session.id);
  };

  if (sessionId) {
    return (
      <>
        <StepHeader title={`Sign in to “${account.name}”`} />
        <SignInProgress
          key={sessionId}
          sessionId={sessionId}
          account={account}
          onSuccess={() => undefined}
          onRetry={() => {
            cancelSignIn(sessionId);
            setSessionId(null);
          }}
          onClose={() => {
            cancelSignIn(sessionId);
            onNext();
          }}
        />
      </>
    );
  }

  return (
    <Form autoFocus onSubmit={(e) => void begin(e)}>
      <StepHeader title={`Sign in to “${account.name}”`}>
        This runs <code className="font-mono text-xs">claude auth login</code> for this account.
        Claude Code opens your browser; you finish there and come back.
      </StepHeader>
      <Card className="p-4">
        <SignInSetup method={method} onMethod={setMethod} email={email} onEmail={setEmail} />
      </Card>
      <StepFooter>
        <Button variant="ghost" onClick={onNext}>
          Skip for Now
        </Button>
        <Button type="submit" loading={starting}>
          Start Sign-In
        </Button>
      </StepFooter>
    </Form>
  );
}

function AccountsSummary({
  accounts,
  onAddAnother,
  onNext,
}: {
  accounts: Account[];
  onAddAnother: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <StepHeader title="Your accounts">
        Add every Claude account you switch between. Each signs in once.
      </StepHeader>
      <Card className="divide-y">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <AccountDot color={a.color} size="md" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.name}</span>
            <AuthStatusBadge account={a} />
          </div>
        ))}
      </Card>
      <StepFooter>
        <Button variant="outline" onClick={onAddAnother}>
          Add Another Account
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </StepFooter>
    </>
  );
}

function ChooseProject({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const client = useQueryClient();
  const openTab = useUi((s) => s.openTab);
  const { data: system } = useSystemInfo();
  const [project, setProject] = useState<Project | null>(null);
  const [accountId, setAccountId] = useState<string | undefined>(
    () => accounts.find((a) => a.authStatus === "authenticated")?.id ?? accounts[0]?.id,
  );
  const [busy, setBusy] = useState(false);
  const selectId = useId();

  const pick = async () => {
    try {
      const p = await api.addProjectViaPicker();
      if (p) {
        setProject(p);
        await client.invalidateQueries({ queryKey: queryKeys.projects });
      }
    } catch (err) {
      toast.error("Could not add the project", { description: errorMessage(err) });
    }
  };

  const launch = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!accountId || !project) return;
    setBusy(true);
    try {
      const s = await api.startSession({
        accountId,
        projectId: project.id,
        kind: "claude",
        ...estimateTerminalSize(13, false),
      });
      rememberSession(client, s);
      onDone();
      openTab(s.id);
    } catch (err) {
      toast.error("Could not start Claude Code", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={(e) => void launch(e)}>
      <StepHeader title="Open a project">
        Choose a folder to start Claude Code in. The folder is never modified by Claude Switch.
      </StepHeader>
      <Card className="grid gap-4 p-4">
        <div className="grid gap-1.5">
          <Label>Folder</Label>
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="outline" onClick={() => void pick()}>
              <FolderPlusIcon />
              {project ? "Choose Another…" : "Choose Folder…"}
            </Button>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {project ? tildify(project.directory, system?.homeDir) : "No folder chosen"}
            </span>
          </div>
        </div>
        {accounts.length > 0 && (
          <div className="grid max-w-sm gap-1.5">
            <Label htmlFor={selectId}>Account</Label>
            <Select
              id={selectId}
              value={accountId}
              onValueChange={setAccountId}
              options={accounts.map((a) => ({
                value: a.id,
                label: (
                  <span className="flex min-w-0 items-center gap-2">
                    <AccountDot color={a.color} />
                    <span className="truncate">{a.name}</span>
                  </span>
                ),
              }))}
            />
          </div>
        )}
      </Card>
      <StepFooter>
        <Button variant="ghost" onClick={onDone}>
          Finish Without Launching
        </Button>
        <Button type="submit" loading={busy} disabled={!project || !accountId}>
          Launch Claude Code
        </Button>
      </StepFooter>
    </Form>
  );
}
