/**
 * The parts of the `vscode` module the tested code uses. Tests load it with
 * `vi.mock("vscode", () => import("./vscode-stub.js"))` and read `ui`.
 */
import type * as vscode from "vscode";

interface TerminalOptions {
  name: string;
  pty: vscode.Pseudoterminal;
}

/** What was shown, and the controls a test can use. */
export const ui = {
  infos: [] as string[],
  errors: [] as string[],
  status: [] as string[],
  /** The Cancel button of the last `withProgress`. */
  cancel: undefined as (() => void) | undefined,
  /** Options of the terminals created, newest last. */
  terminals: [] as TerminalOptions[],
};

export function resetUi(): void {
  ui.infos.length = 0;
  ui.errors.length = 0;
  ui.status.length = 0;
  ui.cancel = undefined;
  ui.terminals.length = 0;
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export const ProgressLocation = { Window: 10, Notification: 15 };

export const Uri = { parse: (url: string) => url };

export const env = {
  openExternal: () => Promise.resolve(true),
  clipboard: { writeText: () => Promise.resolve() },
};

// Notifications stay open until the code that showed them is done.
const open = () => new Promise<undefined>(() => undefined);

export const window = {
  showQuickPick: (items: unknown[]) => Promise.resolve(items[0]),
  showInformationMessage: (text: string) => {
    ui.infos.push(text);
    return open();
  },
  showWarningMessage: (text: string) => {
    ui.infos.push(text);
    return open();
  },
  showErrorMessage: (text: string) => {
    ui.errors.push(text);
    return Promise.resolve(undefined);
  },
  showInputBox: () => Promise.resolve(undefined),
  setStatusBarMessage: (text: string) => {
    ui.status.push(text);
  },
  withProgress: (
    _options: unknown,
    task: (
      report: unknown,
      token: { onCancellationRequested(listener: () => void): { dispose(): void } },
    ) => Promise<void>,
  ) =>
    task(
      {},
      {
        onCancellationRequested: (listener) => {
          ui.cancel = listener;
          return { dispose: () => undefined };
        },
      },
    ),
  createTerminal: (options: TerminalOptions) => {
    ui.terminals.push(options);
    return { show: () => undefined };
  },
};
