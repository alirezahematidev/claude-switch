import { CheckCircle2Icon, ClipboardIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { toast } from "sonner";

import type { Account } from "@/bindings/Account";
import type { LoginMethod } from "@/bindings/LoginMethod";
import type { LoginProgress } from "@/bindings/LoginProgress";
import { Button } from "@/components/ui/button";
import { Disclosure, OptionCards } from "@/components/ui/controls";
import { Form } from "@/components/ui/form";
import { Field, Input } from "@/components/ui/input";
import { Alert, Spinner } from "@/components/ui/misc";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { useResolvedThemeValue } from "@/hooks/useTheme";
import { api, errorMessage, subscribe } from "@/lib/ipc";
import { useAccounts, useSettings } from "@/lib/queries";
import { cn } from "@/lib/utils";

import { cancelSignIn } from "./sign-in";

const METHODS = [
  {
    value: "claudeai",
    title: "Claude subscription",
    description:
      "Pro, Max, Team, or Enterprise. Recommended: the login is stored separately for each account.",
  },
  {
    value: "console",
    title: "Anthropic Console",
    description:
      "API usage billing. If Claude Code asks, choose “Create an API key”; a Console sign-in without an API key is shared by all accounts.",
  },
] as const satisfies readonly { value: LoginMethod; title: string; description: string }[];

/** Account type and optional email. Rendered inside the caller's form. */
export function SignInSetup({
  method,
  onMethod,
  email,
  onEmail,
}: {
  method: LoginMethod;
  onMethod: (m: LoginMethod) => void;
  email: string;
  onEmail: (e: string) => void;
}) {
  const emailId = useId();
  return (
    <div className="grid gap-4">
      <OptionCards label="Account type" value={method} onChange={onMethod} options={METHODS} />
      <Field
        label="Email (optional)"
        htmlFor={emailId}
        hint="Pre-fills the sign-in page. It is passed to Claude Code and not saved."
      >
        <Input
          id={emailId}
          data-autofocus
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            onEmail(e.target.value);
          }}
        />
      </Field>
    </div>
  );
}

function useLoginProgress(sessionId: string): LoginProgress | null | "gone" {
  const [progress, setProgress] = useState<LoginProgress | null | "gone">(null);
  const onProgress = useEffectEvent((p: LoginProgress) => {
    if (p.sessionId === sessionId) setProgress(p);
  });
  useEffect(() => {
    let cancelled = false;
    api
      .getLoginProgress(sessionId)
      .then((p) => {
        if (!cancelled) setProgress((current) => (current === null ? p : current));
      })
      .catch(() => {
        if (!cancelled) setProgress("gone");
      });
    const unsubscribe = subscribe("login-progress", (p) => {
      onProgress(p);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);
  return progress;
}

function Step({
  n,
  title,
  description,
  children,
  done = false,
}: {
  n: number;
  title: React.ReactNode;
  description: React.ReactNode;
  children?: React.ReactNode;
  done?: boolean;
}) {
  return (
    <div className="flex gap-3 p-3.5">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
          done ? "bg-success text-white" : "bg-primary/10 text-primary",
        )}
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="space-y-0.5">
          <div className="text-[13px] leading-5 font-medium">{title}</div>
          <p className="text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The waiting screen while Claude Code signs an account in: a button for
 * the sign-in page, a field for the authorization code, and the raw output
 * behind a disclosure.
 */
export function SignInProgress({
  sessionId,
  account,
  onRetry,
  onClose,
  onSuccess,
}: {
  sessionId: string;
  account: Account;
  onRetry: () => void;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const raw = useLoginProgress(sessionId);
  const { data: accounts = [] } = useAccounts();
  const { data: settings } = useSettings();
  const theme = useResolvedThemeValue();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const codeId = useId();

  const progress = raw === "gone" ? null : raw;
  const phase = raw === "gone" ? "failed" : (progress?.phase ?? "starting");
  const finished = phase === "succeeded" || phase === "failed";
  const fresh = accounts.find((a) => a.id === account.id) ?? account;

  // If Claude Code prints something we don't recognize, show its output.
  useEffect(() => {
    if (finished || progress?.url) return;
    const timer = window.setTimeout(() => {
      setShowOutput(true);
    }, 6000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [finished, progress?.url]);

  const succeeded = phase === "succeeded";
  const notifySuccess = useEffectEvent(onSuccess);
  useEffect(() => {
    if (succeeded) notifySuccess();
  }, [succeeded]);

  const submitCode = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = code.trim();
    if (!value) {
      setCodeError("Paste the code from the browser page.");
      return;
    }
    setSubmitting(true);
    setCodeError(null);
    try {
      await api.submitLoginCode(sessionId, value);
      setCode("");
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openPage = () => {
    if (!progress?.url) return;
    api.openExternalUrl(progress.url).catch((err: unknown) => {
      toast.error("Could not open the browser", { description: errorMessage(err) });
    });
  };

  const copyLink = () => {
    if (!progress?.url) return;
    navigator.clipboard
      .writeText(progress.url)
      .then(() => toast.success("Sign-in link copied"))
      .catch(() => toast.error("Could not copy the link"));
  };

  return (
    <div className="grid min-w-0 gap-4">
      {phase === "succeeded" ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <CheckCircle2Icon className="size-9 text-success" />
          <div className="text-[15px] font-semibold">{account.name} is signed in</div>
          <p className="text-[13px] text-muted-foreground">
            {fresh.verifiedEmail ?? "Claude Code stored the login in this account’s profile."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {finished ? (
                <KeyRoundIcon className="size-4.5" />
              ) : (
                <Spinner className="size-4.5 text-primary" />
              )}
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                {phase === "failed"
                  ? "Sign-in didn’t complete"
                  : phase === "verifying"
                    ? "Checking the code…"
                    : phase === "starting"
                      ? "Starting Claude Code…"
                      : "Waiting for you to sign in"}
              </div>
              <p className="text-xs text-muted-foreground">
                Claude Switch never sees your password or tokens.
              </p>
            </div>
          </div>

          {phase === "failed" ? (
            <Alert tone="danger">
              {progress?.message ??
                fresh.authDetail ??
                "Claude Code stopped before the sign-in finished. Try again."}
            </Alert>
          ) : (
            <div className="divide-y rounded-lg border">
              <Step
                n={1}
                title="Sign in with your browser"
                description={
                  progress?.urlHost ? (
                    <>
                      Claude Code opened{" "}
                      <span className="font-medium text-foreground">{progress.urlHost}</span> in
                      your browser. Finish there, including any email link or verification code.
                    </>
                  ) : (
                    "Claude Code is opening the sign-in page in your browser."
                  )
                }
              >
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!progress?.url} onClick={openPage}>
                    <ExternalLinkIcon />
                    Open Sign-In Page
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!progress?.url} onClick={copyLink}>
                    <ClipboardIcon />
                    Copy Link
                  </Button>
                </div>
              </Step>
              <Step
                n={2}
                title="Paste the code, if the page shows one"
                description="Usually you don’t need this: the browser returns to Claude Code by itself."
              >
                <Form onSubmit={(e) => void submitCode(e)} className="grid gap-1.5">
                  <label htmlFor={codeId} className="sr-only">
                    Authorization code
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id={codeId}
                      autoComplete="one-time-code"
                      placeholder="Paste authorization code"
                      aria-invalid={Boolean(codeError)}
                      disabled={phase === "verifying" || !progress?.awaitingCode}
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setCodeError(null);
                      }}
                      className="h-8 flex-1 font-mono text-xs tracking-wide"
                    />
                    <Button
                      type="submit"
                      size="default"
                      loading={submitting || phase === "verifying"}
                      disabled={!progress?.awaitingCode || code.trim() === ""}
                    >
                      Continue
                    </Button>
                  </div>
                  {codeError && (
                    <p role="alert" className="text-xs text-destructive">
                      {codeError}
                    </p>
                  )}
                </Form>
              </Step>
            </div>
          )}
        </>
      )}

      {phase !== "succeeded" && (
        <Disclosure title="Claude Code output" open={showOutput} onOpenChange={setShowOutput}>
          <div className="h-[min(13rem,28vh)] min-h-28 overflow-hidden rounded-md border">
            {settings && (
              <TerminalPane
                sessionId={sessionId}
                active={showOutput}
                settings={settings}
                theme={theme}
              />
            )}
          </div>
        </Disclosure>
      )}

      <div className="flex justify-end gap-2">
        {phase === "failed" ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={onRetry}>Try Again</Button>
          </>
        ) : phase === "succeeded" ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              cancelSignIn(sessionId);
              onClose();
            }}
          >
            Cancel Sign-In
          </Button>
        )}
      </div>
    </div>
  );
}
