import type { EnvConflictKind } from "@/bindings/EnvConflictKind";
import { Alert } from "@/components/ui/misc";
import { useSystemInfo } from "@/lib/queries";
import { useUi } from "@/store/ui";

const CONFLICT_REASON: Record<EnvConflictKind, string> = {
  credential: "supplies a credential that would override the account's login",
  provider: "switches the API provider or endpoint",
  config_dir: "points Claude Code at a different configuration folder",
  nested_session: "marks the process as running inside another Claude Code session",
  claude_setting: "changes Claude Code behavior",
};

/**
 * Environment and system conditions that affect isolation. Variable names
 * are shown; values never are.
 */
export function SystemWarnings({ compact = false }: { compact?: boolean }) {
  const { data: system } = useSystemInfo();
  const navigate = useUi((s) => s.navigate);
  if (!system) return null;

  const important = system.envConflicts.filter((c) => c.kind !== "claude_setting");
  const items: React.ReactNode[] = [];

  if (important.length > 0) {
    items.push(
      <Alert
        key="env"
        tone="warning"
        title="Some environment variables are not passed to Claude Code"
      >
        {compact ? (
          <>
            {important.map((c) => c.name).join(", ")} {important.length === 1 ? "is" : "are"} set
            for Claude Switch but deliberately left out of sessions so each account uses its own
            login.{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                navigate({ kind: "settings" });
              }}
            >
              Details
            </button>
          </>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {system.envConflicts.map((c) => (
              <li key={c.name}>
                <code className="font-mono text-xs text-foreground">{c.name}</code>{" "}
                {CONFLICT_REASON[c.kind]}.
              </li>
            ))}
            <li className="pt-1">
              They are removed from every session. Variables set in your shell profile still apply
              inside shells and to commands Claude Code runs.
            </li>
          </ul>
        )}
      </Alert>,
    );
  }
  for (const w of system.warnings) {
    items.push(
      <Alert key={w.code} tone="warning">
        {w.message}
      </Alert>,
    );
  }
  if (items.length === 0) return null;
  return <div className="space-y-2">{items}</div>;
}
