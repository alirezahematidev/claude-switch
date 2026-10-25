import { Section } from "@/components/ui/misc";
import { isActive } from "@/features/terminal/session-utils";
import { useOpenSessions, useSessionHistory } from "@/lib/queries";

import { SessionList } from "./SessionList";

export function SessionsView() {
  const { data: open = [] } = useOpenSessions();
  const { data: history = [] } = useSessionHistory({ limit: 100 });
  const running = open.filter(isActive);
  const past = history.filter((s) => !isActive(s));
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Sessions</h1>
        <p className="text-[13px] text-muted-foreground">
          Each session runs one process bound to one account. Only session metadata is kept;
          terminal output and conversations are never saved by Claude Switch.
        </p>
      </header>
      <Section title="Running">
        <SessionList
          sessions={running}
          emptyTitle="Nothing is running"
          emptyBody="Start a session from an account or project."
        />
      </Section>
      <Section title="History">
        <SessionList sessions={past} emptyTitle="No past sessions" />
      </Section>
    </div>
  );
}
