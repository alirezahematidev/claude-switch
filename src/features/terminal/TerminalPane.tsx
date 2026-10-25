import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { AppSettings } from "@/bindings/AppSettings";
import { api, Channel, errorMessage, subscribe } from "@/lib/ipc";
import { darkTerminalTheme, DEFAULT_TERMINAL_FONT, lightTerminalTheme } from "@/lib/terminal";
import { cn } from "@/lib/utils";

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
  settings: AppSettings;
  theme: "light" | "dark";
  className?: string;
}

/**
 * A real terminal bound to one backend PTY session. Output arrives as raw
 * bytes over a Tauri channel; keystrokes go back through `write_session`.
 * Nothing is rendered as HTML and nothing is persisted.
 */
export function TerminalPane({ sessionId, active, settings, theme, className }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Options at mount time; later changes are applied by the effects below.
  const initial = useRef({ settings, theme });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { settings: s, theme: t } = initial.current;

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: s.terminalFontFamily || DEFAULT_TERMINAL_FONT,
      fontSize: s.terminalFontSize,
      lineHeight: 1.15,
      scrollback: s.terminalScrollback,
      macOptionIsMeta: s.terminalOptionAsMeta,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      cursorBlink: true,
      drawBoldTextInBrightColors: false,
      theme: t === "dark" ? darkTerminalTheme : lightTerminalTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        api.openExternalUrl(uri).catch((err: unknown) => {
          toast.error("Could not open link", { description: errorMessage(err) });
        });
      }),
    );
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // xterm's DOM renderer is the fallback.
    }

    term.attachCustomKeyEventHandler((event) => {
      // Shift+Enter inserts a newline in Claude Code (sent as Meta+Enter).
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        void api.writeSession(sessionId, "\x1b\r").catch(() => undefined);
        return false;
      }
      return true;
    });

    const ignore = () => undefined;
    const subs = [
      term.onData((data) => {
        void api.writeSession(sessionId, data).catch(ignore);
      }),
      term.onBinary((data) => {
        void api.writeSession(sessionId, data, true).catch(ignore);
      }),
      term.onResize(({ cols, rows }) => {
        void api.resizeSession(sessionId, cols, rows).catch(ignore);
      }),
    ];

    const channel = new Channel<ArrayBuffer>((chunk) => {
      term.write(new Uint8Array(chunk));
    });
    api.attachSession(sessionId, channel).catch((err: unknown) => {
      term.write(`\r\n\x1b[31m[Claude Switch] ${errorMessage(err)}\x1b[0m\r\n`);
    });

    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          try {
            fit.fit();
          } catch {
            // Fitting can fail while the element is detached.
          }
        }
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    refit();

    // "Clear Terminal" from the menu targets the focused pane.
    const unsubscribe = subscribe("menu-action", (action) => {
      if (action === "clear-terminal" && host.contains(document.activeElement)) {
        term.clear();
      }
    });

    termRef.current = term;
    fitRef.current = fit;
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      for (const sub of subs) sub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Apply setting changes to the live terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.terminalFontFamily || DEFAULT_TERMINAL_FONT;
    term.options.fontSize = settings.terminalFontSize;
    term.options.scrollback = settings.terminalScrollback;
    term.options.macOptionIsMeta = settings.terminalOptionAsMeta;
    try {
      fitRef.current?.fit();
    } catch {
      // Ignore while hidden.
    }
  }, [
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalScrollback,
    settings.terminalOptionAsMeta,
  ]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = theme === "dark" ? darkTerminalTheme : lightTerminalTheme;
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Ignore while hidden.
      }
      termRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [active]);

  return (
    <div
      className={cn("terminal-host h-full w-full bg-terminal px-3 pt-2 pb-1", className)}
      data-session-id={sessionId}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
