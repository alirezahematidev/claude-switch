/** A helper process that answers requests by itself, for flow tests. */
import { EventEmitter } from "node:events";

import { isRecord } from "../src/accounts";
import type { Account } from "../src/bindings/Account";
import type { HelperProcess } from "../src/helper";

/** The result of each method; `null` for the others. */
export type Answers = Record<string, unknown>;

export class FakeHelperProcess extends EventEmitter implements HelperProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Requests received, in order. */
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const request: unknown = JSON.parse(line);
        if (!isRecord(request) || typeof request.method !== "string") continue;
        const { id, method } = request;
        this.calls.push({ method, params: isRecord(request.params) ? request.params : {} });
        setImmediate(() => {
          this.send({ id, result: this.answers[method] ?? null });
        });
      }
      return true;
    },
    end: () => undefined,
  };

  constructor(private readonly answers: Answers = {}) {
    super();
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  send(message: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
  }

  event(event: string, data: unknown): void {
    this.send({ event, data });
  }

  kill(): void {
    this.emit("exit", null);
  }
}

/** Lets pending replies and the code awaiting them run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

export const account = (extra: Partial<Account> = {}): Account => ({
  id: "a",
  name: "Work",
  label: null,
  verifiedEmail: null,
  orgName: null,
  configDir: "/Users/me/.claude-switch/profiles/a",
  color: "blue",
  notes: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
  authStatus: "not_configured",
  authMethod: null,
  authStatusCheckedAt: null,
  authVerifiedAt: null,
  authDetail: null,
  runningSessions: 0,
  ...extra,
});
