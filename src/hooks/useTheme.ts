import { getCurrentWindow } from "@tauri-apps/api/window";
import { createContext, useContext, useEffect, useState } from "react";

import type { ThemePreference } from "@/bindings/ThemePreference";

export type ResolvedTheme = "light" | "dark";

/** The theme currently applied, for components that render terminals. */
export const ThemeContext = createContext<ResolvedTheme>("light");

export function useResolvedThemeValue(): ResolvedTheme {
  return useContext(ThemeContext);
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies the theme preference to the document and the native window. */
export function useResolvedTheme(preference: ThemePreference | undefined): ResolvedTheme {
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setSystemDark(media.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  const pref = preference ?? "system";
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWindow()
      .setTheme(pref === "system" ? null : pref)
      .catch(() => undefined);
  }, [pref]);

  return resolved;
}
