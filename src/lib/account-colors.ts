import type { AccountColor } from "@/bindings/AccountColor";

/** Display order in the color picker. Mirrors `AccountColor::ALL` in Rust. */
export const ACCOUNT_COLORS: readonly AccountColor[] = [
  "blue",
  "violet",
  "green",
  "orange",
  "pink",
  "teal",
  "amber",
  "red",
  "sky",
  "slate",
];

/** Solid swatch colors; legible on both themes. */
export const ACCOUNT_COLOR_HEX: Record<AccountColor, string> = {
  slate: "#64748b",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

export const ACCOUNT_COLOR_LABEL: Record<AccountColor, string> = {
  slate: "Slate",
  red: "Red",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  sky: "Sky",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};

/** A color not yet used by other accounts, for new-account defaults. */
export function nextAccountColor(used: readonly AccountColor[]): AccountColor {
  return ACCOUNT_COLORS.find((c) => !used.includes(c)) ?? "blue";
}
