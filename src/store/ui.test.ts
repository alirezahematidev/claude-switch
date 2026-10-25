import { beforeEach, describe, expect, it } from "vitest";

import { useUi } from "./ui";

const initial = useUi.getState();

beforeEach(() => {
  useUi.setState(initial, true);
});

describe("terminal tabs", () => {
  it("opening a tab activates it and shows the terminal", () => {
    useUi.getState().navigate({ kind: "account", accountId: "a" });
    useUi.getState().openTab("s1");
    const s = useUi.getState();
    expect(s.tabs).toEqual(["s1"]);
    expect(s.activeTabId).toBe("s1");
    expect(s.view).toEqual({ kind: "terminal" });
    expect(s.lastPage).toEqual({ kind: "account", accountId: "a" });
  });

  it("does not duplicate tabs", () => {
    useUi.getState().openTab("s1");
    useUi.getState().openTab("s1");
    expect(useUi.getState().tabs).toEqual(["s1"]);
  });

  it("background tabs do not steal focus", () => {
    useUi.getState().openTab("s1");
    useUi.getState().navigate({ kind: "settings" });
    useUi.getState().openTab("s2", false);
    expect(useUi.getState().activeTabId).toBe("s1");
    expect(useUi.getState().view).toEqual({ kind: "settings" });
  });

  it("closing the active tab selects a neighbour, and the last returns to the page", () => {
    useUi.getState().navigate({ kind: "project", projectId: "p" });
    useUi.getState().openTab("s1");
    useUi.getState().openTab("s2");
    useUi.getState().openTab("s3");
    useUi.getState().activateTab("s2");
    useUi.getState().removeTab("s2");
    expect(useUi.getState().activeTabId).toBe("s3");
    useUi.getState().removeTab("s3");
    useUi.getState().removeTab("s1");
    expect(useUi.getState().tabs).toEqual([]);
    expect(useUi.getState().view).toEqual({ kind: "project", projectId: "p" });
  });

  it("cycles through tabs", () => {
    for (const id of ["a", "b", "c"]) useUi.getState().openTab(id);
    useUi.getState().cycleTab(1);
    expect(useUi.getState().activeTabId).toBe("a");
    useUi.getState().cycleTab(-1);
    expect(useUi.getState().activeTabId).toBe("c");
  });

  it("restart replaces a tab in place", () => {
    for (const id of ["a", "b", "c"]) useUi.getState().openTab(id);
    useUi.getState().activateTab("b");
    useUi.getState().replaceTab("b", "b2");
    expect(useUi.getState().tabs).toEqual(["a", "b2", "c"]);
    expect(useUi.getState().activeTabId).toBe("b2");
  });
});

describe("dialogs", () => {
  it("opens and closes independently", () => {
    useUi.getState().openDialog("deleteAccountId", "acct");
    expect(useUi.getState().dialogs.deleteAccountId).toBe("acct");
    useUi.getState().closeDialog("deleteAccountId");
    expect(useUi.getState().dialogs.deleteAccountId).toBeNull();
  });
});
