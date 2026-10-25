/**
 * Which account the Claude Code extension uses, and how to change it.
 *
 * The Claude Code extension starts Claude Code with the editor window's
 * environment plus its `claudeCode.environmentVariables` setting; an entry
 * named `CLAUDE_CONFIG_DIR` with an absolute path there wins (documented). The
 * setting is machine-scoped, so VS Code keeps it in user settings and it
 * applies to new Claude tabs in every window. Without it, a window uses the
 * `CLAUDE_CONFIG_DIR` it was opened with (Claude Switch's "Open in VS Code"),
 * or Claude Code's default `~/.claude`.
 */
import * as path from "node:path";

import type { BridgeAccount } from "./bindings/BridgeAccount";
import type { BridgeConversation } from "./bindings/BridgeConversation";

export const CONFIG_DIR = "CLAUDE_CONFIG_DIR";

export interface EnvEntry {
  name: string;
  value: string;
}

/** Where the account in use comes from. */
export type AccountSource = "settings" | "window" | "default";

export interface InUse {
  /** The profile folder, or `undefined` for Claude Code's default. */
  dir: string | undefined;
  source: AccountSource;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

/** The setting as name/value pairs (it may be a list or an object). */
function entries(value: unknown): EnvEntry[] {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.flatMap((item) =>
      isRecord(item) && typeof item.name === "string"
        ? [{ name: item.name, value: asText(item.value) }]
        : [],
    );
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([name, v]) => ({ name, value: asText(v) }));
  }
  return [];
}

/** `CLAUDE_CONFIG_DIR` from the setting, read the way the extension reads it. */
export function configDirFromSetting(value: unknown): string | undefined {
  return entries(value)
    .filter((e) => e.name === CONFIG_DIR && path.isAbsolute(e.value))
    .map((e) => e.value)
    .at(-1);
}

/**
 * The setting with its `CLAUDE_CONFIG_DIR` entry set to `dir`, or removed.
 * Other variables are kept. `undefined` means "remove the setting".
 */
export function withConfigDir(value: unknown, dir: string | undefined): unknown {
  if (isRecord(value)) {
    const next = { ...value };
    delete next[CONFIG_DIR];
    if (dir !== undefined) next[CONFIG_DIR] = dir;
    return Object.keys(next).length > 0 ? next : undefined;
  }
  const items: unknown[] = Array.isArray(value) ? value : [];
  const kept = items.filter((item) => !(isRecord(item) && item.name === CONFIG_DIR));
  const next = dir === undefined ? kept : [...kept, { name: CONFIG_DIR, value: dir }];
  return next.length > 0 ? next : undefined;
}

export function configDirInUse(
  setting: unknown,
  windowEnv: Record<string, string | undefined>,
): InUse {
  const fromSetting = configDirFromSetting(setting);
  if (fromSetting) return { dir: fromSetting, source: "settings" };
  const fromWindow = windowEnv[CONFIG_DIR];
  if (fromWindow && path.isAbsolute(fromWindow)) return { dir: fromWindow, source: "window" };
  return { dir: undefined, source: "default" };
}

export function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function accountFor(
  accounts: readonly BridgeAccount[],
  dir: string | undefined,
): BridgeAccount | undefined {
  return dir === undefined ? undefined : accounts.find((a) => sameDir(a.configDir, dir));
}

/** Theme colors closest to Claude Switch's account colors. */
export const ACCOUNT_THEME_COLORS: Record<string, string> = {
  blue: "charts.blue",
  violet: "charts.purple",
  green: "charts.green",
  orange: "charts.orange",
  pink: "terminal.ansiMagenta",
  teal: "terminal.ansiCyan",
  amber: "charts.yellow",
  red: "charts.red",
  sky: "terminal.ansiBrightBlue",
  slate: "descriptionForeground",
};

/** Conversations from several folders, newest first, each session once. */
export function mergeConversations(
  lists: readonly { directory: string; conversations: readonly BridgeConversation[] }[],
): (BridgeConversation & { directory: string })[] {
  const seen = new Map<string, BridgeConversation & { directory: string }>();
  for (const { directory, conversations } of lists) {
    for (const c of conversations) {
      const prev = seen.get(c.sessionId);
      if (!prev || prev.modifiedAt < c.modifiedAt) seen.set(c.sessionId, { ...c, directory });
    }
  }
  return [...seen.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "yesterday". */
export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds) || Math.abs(seconds) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds / 60), "minute");
}

/**
 * The Claude Code extension's documented link for opening a conversation of
 * the focused window's workspace in a tab, with a message placed (not sent)
 * in its message box. Characters that change the meaning of a link query are
 * dropped from the message, which is only a nudge.
 */
export function claudeLink(scheme: string, sessionId?: string, message?: string): string {
  const query: string[] = [];
  if (sessionId) query.push(`session=${encodeURIComponent(sessionId)}`);
  const text = message
    ?.replace(/[&=#+%?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text) query.push(`prompt=${encodeURIComponent(text)}`);
  return `${scheme}://anthropic.claude-code/open${query.length > 0 ? `?${query.join("&")}` : ""}`;
}
