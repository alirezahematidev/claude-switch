/**
 * Signing an account in, the way the desktop app does: `claude auth login`
 * runs in the helper with the account's profile, and its output is followed
 * for the sign-in link, the code prompt and the result. Claude Code opens
 * the browser itself; Claude Switch never sees passwords or tokens.
 */
import * as vscode from "vscode";

import type { Account } from "./bindings/Account";
import type { LoginMethod } from "./bindings/LoginMethod";
import type { LoginProgress } from "./bindings/LoginProgress";
import type { SessionInfo } from "./bindings/SessionInfo";
import type { Helper } from "./helper";
import { validateLoginCode } from "./model";

const OPEN_PAGE = "Open Page";
const ENTER_CODE = "Enter Code";
const COPY_LINK = "Copy Link";
const TRY_AGAIN = "Try Again";

async function chooseMethod(account: Account): Promise<LoginMethod | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Claude subscription",
        description: "Pro, Max, Team, Enterprise",
        method: "claudeai" as const,
      },
      { label: "Anthropic Console", description: "API billing", method: "console" as const },
    ],
    { title: `Sign in ${account.name}` },
  );
  return picked?.method;
}

/** What signing in needs from the helper. */
export type SignInHelper = Pick<
  Helper,
  "on" | "startLogin" | "loginProgress" | "submitLoginCode" | "closeSession"
>;

/**
 * Signs `account` in. Resolves with the account once signed in, or
 * `undefined` when the sign-in failed or was cancelled.
 */
export async function signIn(helper: SignInHelper, account: Account): Promise<Account | undefined> {
  const method = await chooseMethod(account);
  if (!method) return undefined;
  let session: SessionInfo;
  try {
    session = await helper.startLogin({ accountId: account.id, method, cols: 120, rows: 30 });
  } catch (err) {
    await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return undefined;
  }

  let progress: LoginProgress | undefined;
  let signedIn: Account | undefined;
  let cancelled = false;
  // Assigned by the executor of `done` below, which runs at once.
  let finish!: () => void;
  const changed = new vscode.EventEmitter<void>();
  const update = (p: LoginProgress) => {
    progress = p;
    changed.fire();
    // "succeeded" comes as soon as Claude Code prints it; the sign-in is
    // over with `loginCompleted`, once the stored login has been checked.
    if (p.phase === "failed") finish();
  };
  const subscriptions = [
    helper.on("loginProgress", (p) => {
      if (p.sessionId === session.id) update(p);
    }),
    helper.on("loginCompleted", (a) => {
      if (a.id !== account.id) return;
      signedIn = a;
      finish();
    }),
    helper.on("exited", () => {
      finish();
    }),
  ];
  const done = new Promise<void>((resolve) => {
    finish = () => {
      for (const s of subscriptions) s.dispose();
      resolve();
    };
  });
  // Progress sent before the subscriptions existed.
  helper
    .loginProgress(session.id)
    .then((p) => {
      if (!progress) update(p);
    })
    .catch(() => undefined);
  const nextChange = () =>
    new Promise<"changed">((resolve) => {
      const s = changed.event(() => {
        s.dispose();
        resolve("changed");
      });
    });

  // One message with the link and the code field; shown again only when its
  // choices change, or after one was taken.
  const offer = async () => {
    let shown: Thenable<string | undefined> | undefined;
    let shownFor = "";
    for (;;) {
      const url = progress?.url ?? undefined;
      const actions = [
        ...(url ? [OPEN_PAGE] : []),
        ...(progress?.awaitingCode ? [ENTER_CODE] : []),
        ...(url ? [COPY_LINK] : []),
      ];
      // Set when Claude Code refused a code and is waiting for another.
      const problem = progress?.phase === "waiting" ? progress.message : null;
      const key = [...actions, problem].join("|");
      // Nothing to offer while a code is checked or once it is over.
      if (url && progress?.phase === "waiting" && (!shown || key !== shownFor)) {
        shown = problem
          ? vscode.window.showWarningMessage(problem, ...actions)
          : vscode.window.showInformationMessage(
              `Finish signing in to ${account.name} in your browser.`,
              ...actions,
            );
        shownFor = key;
      }
      const action = await Promise.race([
        ...(shown ? [shown] : []),
        nextChange(),
        done.then(() => "done" as const),
      ]);
      if (action === "done") return;
      if (action === "changed") continue;
      shown = undefined;
      if (action === undefined) {
        await Promise.race([nextChange(), done]);
        continue;
      }
      if (action === OPEN_PAGE && url) await vscode.env.openExternal(vscode.Uri.parse(url));
      if (action === COPY_LINK && url) await vscode.env.clipboard.writeText(url);
      if (action === ENTER_CODE) {
        const code = await vscode.window.showInputBox({
          title: `Sign in ${account.name}`,
          prompt: "The code shown on the sign-in page",
          ignoreFocusOut: true,
          validateInput: validateLoginCode,
        });
        if (code) {
          try {
            // The result follows as progress events; the reply can be older
            // than one that already arrived.
            await helper.submitLoginCode(session.id, code.trim());
          } catch (err) {
            await vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Signing in ${account.name}…`,
      cancellable: true,
    },
    async (_report, token) => {
      const cancel = token.onCancellationRequested(() => {
        cancelled = true;
        finish();
      });
      void offer();
      await done;
      cancel.dispose();
    },
  );
  changed.dispose();
  // Also stops a sign-in that is still running.
  helper.closeSession(session.id).catch(() => undefined);

  if (signedIn) {
    vscode.window.setStatusBarMessage(`$(check) ${signedIn.name} signed in`, 4000);
    return signedIn;
  }
  if (cancelled) return undefined;
  const reason = progress?.phase === "failed" && progress.message ? `: ${progress.message}` : ".";
  const action = await vscode.window.showErrorMessage(
    `${account.name} was not signed in${reason}`,
    TRY_AGAIN,
  );
  if (action === TRY_AGAIN) return signIn(helper, account);
  return undefined;
}
