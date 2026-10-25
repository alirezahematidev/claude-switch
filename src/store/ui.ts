import { create } from "zustand";

export type View =
  | { kind: "home" }
  | { kind: "account"; accountId: string }
  | { kind: "project"; projectId: string }
  | { kind: "sessions" }
  | { kind: "settings" }
  | { kind: "terminal" };

export type PageView = Exclude<View, { kind: "terminal" }>;

/** Where "Continue in Another Account" was opened from. */
export interface ContinueContext {
  projectId?: string;
  accountId?: string;
  /** Preferred destination; the dialog picks one otherwise. */
  destination?: "terminal";
}

interface DialogState {
  addAccount: boolean;
  editAccountId: string | null;
  deleteAccountId: string | null;
  signInAccountId: string | null;
  renameProjectId: string | null;
  continueConversation: ContinueContext | null;
}

interface UiState {
  view: View;
  /** Last non-terminal page, restored when the last tab closes. */
  lastPage: PageView;
  /** Open terminal tabs (session IDs) in display order. */
  tabs: string[];
  activeTabId: string | null;
  sidebarHidden: boolean;
  quickSwitchOpen: boolean;
  dialogs: DialogState;

  navigate: (view: View) => void;
  openTab: (sessionId: string, activate?: boolean) => void;
  replaceTab: (oldId: string, newId: string) => void;
  removeTab: (sessionId: string) => void;
  activateTab: (sessionId: string) => void;
  cycleTab: (delta: 1 | -1) => void;
  setTabs: (ids: string[]) => void;
  toggleSidebar: () => void;
  setQuickSwitchOpen: (open: boolean) => void;
  openDialog: <K extends keyof DialogState>(key: K, value: DialogState[K]) => void;
  closeDialog: (key: keyof DialogState) => void;
}

const closedDialogs: DialogState = {
  addAccount: false,
  editAccountId: null,
  deleteAccountId: null,
  signInAccountId: null,
  renameProjectId: null,
  continueConversation: null,
};

export const useUi = create<UiState>((set, get) => ({
  view: { kind: "home" },
  lastPage: { kind: "home" },
  tabs: [],
  activeTabId: null,
  sidebarHidden: false,
  quickSwitchOpen: false,
  dialogs: closedDialogs,

  navigate: (view) => {
    set((s) => ({
      view,
      lastPage: view.kind === "terminal" ? s.lastPage : view,
    }));
  },

  openTab: (sessionId, activate = true) => {
    set((s) => {
      const tabs = s.tabs.includes(sessionId) ? s.tabs : [...s.tabs, sessionId];
      return activate
        ? { tabs, activeTabId: sessionId, view: { kind: "terminal" } }
        : { tabs, activeTabId: s.activeTabId ?? sessionId };
    });
  },

  replaceTab: (oldId, newId) => {
    set((s) => ({
      tabs: s.tabs.map((id) => (id === oldId ? newId : id)),
      activeTabId: s.activeTabId === oldId ? newId : s.activeTabId,
    }));
  },

  removeTab: (sessionId) => {
    set((s) => {
      const idx = s.tabs.indexOf(sessionId);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((id) => id !== sessionId);
      let activeTabId = s.activeTabId;
      if (activeTabId === sessionId) {
        activeTabId = tabs[Math.min(idx, tabs.length - 1)] ?? null;
      }
      const view: View = tabs.length === 0 && s.view.kind === "terminal" ? s.lastPage : s.view;
      return { tabs, activeTabId, view };
    });
  },

  activateTab: (sessionId) => {
    if (!get().tabs.includes(sessionId)) return;
    set({ activeTabId: sessionId, view: { kind: "terminal" } });
  },

  cycleTab: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const idx = activeTabId ? tabs.indexOf(activeTabId) : -1;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) set({ activeTabId: next, view: { kind: "terminal" } });
  },

  setTabs: (ids) => {
    set((s) => ({
      tabs: ids,
      activeTabId: s.activeTabId && ids.includes(s.activeTabId) ? s.activeTabId : (ids[0] ?? null),
    }));
  },

  toggleSidebar: () => {
    set((s) => ({ sidebarHidden: !s.sidebarHidden }));
  },
  setQuickSwitchOpen: (open) => {
    set({ quickSwitchOpen: open });
  },
  openDialog: (key, value) => {
    set((s) => ({ dialogs: { ...s.dialogs, [key]: value } }));
  },
  closeDialog: (key) => {
    set((s) => ({ dialogs: { ...s.dialogs, [key]: closedDialogs[key] } }));
  },
}));
