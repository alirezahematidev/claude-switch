import { useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";

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
import { AppShell } from "@/features/layout/AppShell";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { ThemeContext, useResolvedTheme } from "@/hooks/useTheme";
import { api, subscribe, toIpcError } from "@/lib/ipc";
import { queryKeys, useAccounts, useBackendSync, useSettings } from "@/lib/queries";

function FatalError({ error }: { error: unknown }) {
  const err = toIpcError(error);
  const corruption = err.kind === "dataCorruption";
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div data-tauri-drag-region className="fixed inset-x-0 top-0 h-11" />
      <div className="max-w-lg space-y-3">
        <div className="flex items-center gap-2 text-destructive">
          <CircleAlertIcon className="size-5 shrink-0" />
          <h1 className="text-base font-semibold">Claude Switch could not start</h1>
        </div>
        <p className="selectable text-[13px] wrap-break-word">{err.message}</p>
        <p className="text-[13px] text-muted-foreground">
          {corruption
            ? "The app database could not be read. Your Claude Code profiles and logins are stored separately and were not changed. Quit Claude Switch, move claude-switch.sqlite out of ~/Library/Application Support/ClaudeSwitch, and reopen the app to start with a fresh database."
            : "Check that your home folder is accessible and that ~/.claude-switch and ~/Library/Application Support/ClaudeSwitch are regular folders you own, then reopen the app."}
        </p>
      </div>
    </div>
  );
}

/** Confirmation shown when quitting with running sessions. */
function QuitDialog() {
  const [running, setRunning] = useState<number | null>(null);
  const [quitting, setQuitting] = useState(false);
  useEffect(
    () =>
      subscribe("confirm-quit", (count) => {
        setRunning(count);
      }),
    [],
  );
  const noun = running === 1 ? "session is" : "sessions are";
  return (
    <Dialog
      open={running !== null}
      onOpenChange={(open) => {
        if (!open) setRunning(null);
      }}
    >
      <DialogContent>
        <Form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setQuitting(true);
            void api.quitApp(true).catch(() => {
              setQuitting(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Quit Claude Switch?</DialogTitle>
            <DialogDescription>
              {running} Claude Code {noun} still running. Quitting stops them and everything they
              started.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRunning(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={quitting}>
              Quit and Stop Sessions
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function App() {
  useBackendSync();
  const client = useQueryClient();
  const settings = useSettings();
  const accounts = useAccounts();
  const theme = useResolvedTheme(settings.data?.theme);
  // Decided once, when data first loads, so creating the first account
  // does not end onboarding midway.
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  if (onboarding === null && settings.data && accounts.data) {
    setOnboarding(!settings.data.onboardingCompleted && accounts.data.length === 0);
  }

  // The window starts hidden to avoid a blank flash. Rust shows it once the
  // UI has rendered, unless the app was launched in the background at login.
  useEffect(() => {
    void api.frontendReady().catch(() => undefined);
  }, []);

  // Errors from menu-bar actions, which have no UI of their own.
  useEffect(
    () =>
      subscribe("notice", (notice) => {
        toast.error(notice.title, { description: notice.message });
      }),
    [],
  );

  const error = settings.error ?? accounts.error;
  if (error) {
    return <FatalError error={error} />;
  }
  if (!settings.data || !accounts.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const finishOnboarding = () => {
    setOnboarding(false);
    api
      .updateSettings({ onboardingCompleted: true })
      .then((next) => {
        client.setQueryData(queryKeys.settings, next);
      })
      .catch(() => undefined);
  };

  return (
    <ThemeContext value={theme}>
      {onboarding ? (
        <Onboarding onDone={finishOnboarding} />
      ) : (
        <AppShell settings={settings.data} theme={theme} />
      )}
      <QuitDialog />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </ThemeContext>
  );
}
