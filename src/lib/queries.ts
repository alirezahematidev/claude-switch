import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { ChangeScope } from "@/bindings/ChangeScope";
import type { ListSessionsInput } from "@/bindings/ListSessionsInput";
import type { SessionInfo } from "@/bindings/SessionInfo";
import { api, subscribe } from "@/lib/ipc";

export const queryKeys = {
  accounts: ["accounts"] as const,
  projects: ["projects"] as const,
  sessions: ["sessions"] as const,
  openSessions: ["sessions", "open"] as const,
  sessionHistory: (filter: ListSessionsInput) => ["sessions", "history", filter] as const,
  system: ["system"] as const,
  settings: ["settings"] as const,
  conversations: ["conversations"] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data changes are pushed by backend events; no polling or refetch on
        // focus is needed.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}

export function useAccounts() {
  return useQuery({ queryKey: queryKeys.accounts, queryFn: api.listAccounts });
}

export function useProjects() {
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });
}

export function useOpenSessions() {
  return useQuery({ queryKey: queryKeys.openSessions, queryFn: api.listOpenSessions });
}

export function useSessionHistory(filter: ListSessionsInput) {
  return useQuery({
    queryKey: queryKeys.sessionHistory(filter),
    queryFn: () => api.listSessions(filter),
  });
}

export function useSystemInfo() {
  return useQuery({ queryKey: queryKeys.system, queryFn: api.getSystemInfo });
}

/**
 * Conversations are written by Claude Code outside the app (for example in
 * VS Code), so they are re-read whenever a view needing them mounts.
 */
export function useConversations() {
  return useQuery({
    queryKey: queryKeys.conversations,
    queryFn: api.listConversations,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: api.getSettings });
}

/**
 * Records a session the UI just started, before opening its tab. The
 * backend's `session-updated` event can arrive after the command response.
 */
export function rememberSession(client: QueryClient, session: SessionInfo): void {
  client.setQueryData<SessionInfo[]>(queryKeys.openSessions, (current = []) =>
    current.some((s) => s.id === session.id) ? current : [...current, session],
  );
}

/**
 * Drops a session the UI just closed or replaced, so the tab-adoption logic
 * does not resurrect its tab before the backend's list is refetched.
 */
export function forgetSession(client: QueryClient, sessionId: string): void {
  client.setQueryData<SessionInfo[]>(queryKeys.openSessions, (current) =>
    current?.filter((s) => s.id !== sessionId),
  );
}

const scopeKeys: Record<ChangeScope, readonly string[]> = {
  accounts: queryKeys.accounts,
  projects: queryKeys.projects,
  sessions: queryKeys.sessions,
  settings: queryKeys.settings,
  system: queryKeys.system,
};

/** Keeps the query cache in sync with backend change events. */
export function useBackendSync(): void {
  const client = useQueryClient();
  useEffect(() => {
    const cleanups = [
      subscribe("state-changed", (scope) => {
        void client.invalidateQueries({ queryKey: scopeKeys[scope] });
      }),
      subscribe("session-updated", (session) => {
        client.setQueryData<SessionInfo[]>(queryKeys.openSessions, (current) => {
          if (!current) return current;
          const exists = current.some((s) => s.id === session.id);
          if (exists) return current.map((s) => (s.id === session.id ? session : s));
          return session.attached ? [...current, session] : current;
        });
      }),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [client]);
}
