const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

type KeyLike = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/**
 * Converts a keydown into a Tauri accelerator such as
 * `CommandOrControl+Shift+K`. Returns null without a modifier or for keys
 * that cannot be bound.
 */
export function acceleratorFromEvent(e: KeyLike): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_TO_KEY[e.code];
  if (!key) return null;
  const mods = [
    e.metaKey && "CommandOrControl",
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
  ].filter((m): m is string => Boolean(m));
  if (mods.length === 0) return null;
  return [...mods, key].join("+");
}

const SYMBOLS: Record<string, string> = {
  CommandOrControl: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};

/** `CommandOrControl+Shift+K` → `⌘⇧K`. */
export function formatAccelerator(accel: string): string {
  return accel
    .split("+")
    .map((p) => SYMBOLS[p] ?? p)
    .join("");
}
