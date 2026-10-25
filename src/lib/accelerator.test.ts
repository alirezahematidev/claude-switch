import { describe, expect, it } from "vitest";

import { acceleratorFromEvent, formatAccelerator } from "./accelerator";

const key = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) => ({
  code,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift),
});

describe("acceleratorFromEvent", () => {
  it("builds Tauri accelerators", () => {
    expect(acceleratorFromEvent(key("KeyK", { meta: true, shift: true }))).toBe(
      "CommandOrControl+Shift+K",
    );
    expect(acceleratorFromEvent(key("Digit1", { alt: true }))).toBe("Alt+1");
    expect(acceleratorFromEvent(key("Space", { ctrl: true, alt: true }))).toBe("Control+Alt+Space");
    expect(acceleratorFromEvent(key("F5", { meta: true }))).toBe("CommandOrControl+F5");
  });

  it("requires a modifier and a bindable key", () => {
    expect(acceleratorFromEvent(key("KeyK"))).toBeNull();
    expect(acceleratorFromEvent(key("ShiftLeft", { shift: true }))).toBeNull();
    expect(acceleratorFromEvent(key("MetaLeft", { meta: true }))).toBeNull();
  });
});

it("formats accelerators with macOS symbols", () => {
  expect(formatAccelerator("CommandOrControl+Shift+K")).toBe("⌘⇧K");
  expect(formatAccelerator("Control+Alt+Space")).toBe("⌃⌥Space");
});
