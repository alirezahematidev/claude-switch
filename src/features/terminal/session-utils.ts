import type { SessionInfo } from "@/bindings/SessionInfo";

export function isActive(session: SessionInfo): boolean {
  return (
    session.status === "running" || session.status === "starting" || session.status === "stopping"
  );
}

export function exitSummary(session: SessionInfo): string {
  if (session.status === "failed") return session.error ?? "The session failed to start.";
  if (session.exitSignal) return `Ended by signal (${session.exitSignal}).`;
  if (session.exitCode === 0) return "Exited normally.";
  if (session.exitCode !== null) return `Exited with code ${session.exitCode}.`;
  return "The session ended.";
}

/** Sessions shown as terminal tabs. Sign-ins have their own screen. */
export function isTabSession(session: SessionInfo): boolean {
  return session.attached && session.kind !== "login";
}
