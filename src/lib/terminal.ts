import type { ITheme } from "@xterm/xterm";

export const DEFAULT_TERMINAL_FONT =
  '"SF Mono", Menlo, Monaco, "Cascadia Mono", "Vazirmatn", "Geeza Pro", "Noto Sans Arabic", monospace';

export const darkTerminalTheme: ITheme = {
  background: "#17171c",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#17171c",
  selectionBackground: "#3b82f655",
  black: "#27272a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

export const lightTerminalTheme: ITheme = {
  background: "#fcfcfd",
  foreground: "#27272a",
  cursor: "#27272a",
  cursorAccent: "#fcfcfd",
  selectionBackground: "#3b82f640",
  black: "#27272a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#a16207",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#ca8a04",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#18181b",
};

/**
 * Initial PTY size estimate so the process starts close to its final size;
 * the terminal view refits precisely once mounted.
 */
export function estimateTerminalSize(fontSize: number, sidebarHidden: boolean) {
  const cellWidth = fontSize * 0.6;
  const cellHeight = Math.ceil(fontSize * 1.15);
  const width = window.innerWidth - (sidebarHidden ? 0 : 248) - 24;
  const height = window.innerHeight - 44 - 16;
  return {
    cols: Math.min(400, Math.max(20, Math.floor(width / cellWidth))),
    rows: Math.min(200, Math.max(5, Math.floor(height / cellHeight))),
  };
}
