import { describe, expect, it } from "vitest";

import { formatDuration, formatRelative, matchesQuery, pluralize, tildify } from "./utils";

describe("formatRelative", () => {
  const now = new Date("2026-10-24T12:00:00Z");

  it("handles missing and invalid values", () => {
    expect(formatRelative(null, now)).toBe("Never");
    expect(formatRelative("not a date", now)).toBe("Unknown");
  });

  it("formats recent and older times", () => {
    expect(formatRelative("2026-10-24T11:59:50Z", now)).toBe("just now");
    expect(formatRelative("2026-10-24T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelative("2026-10-24T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-10-23T12:00:00Z", now)).toBe("yesterday");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration("2026-10-24T12:00:00Z", "2026-10-24T12:00:42Z")).toBe("42s");
    expect(formatDuration("2026-10-24T12:00:00Z", "2026-10-24T12:03:05Z")).toBe("3m 5s");
    expect(formatDuration("2026-10-24T10:00:00Z", "2026-10-24T12:05:00Z")).toBe("2h 5m");
  });

  it("uses now for running sessions", () => {
    const now = new Date("2026-10-24T12:01:00Z");
    expect(formatDuration("2026-10-24T12:00:00Z", null, now)).toBe("1m 0s");
  });
});

describe("tildify", () => {
  it("abbreviates only the home directory", () => {
    expect(tildify("/Users/me/code/x", "/Users/me")).toBe("~/code/x");
    expect(tildify("/Users/me", "/Users/me")).toBe("~");
    expect(tildify("/Users/meow/code", "/Users/me")).toBe("/Users/meow/code");
    expect(tildify("/tmp/x", undefined)).toBe("/tmp/x");
  });
});

describe("matchesQuery", () => {
  it("matches case-insensitively across fields", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("WORK", "Day work", null)).toBe(true);
    expect(matchesQuery("gmail", null, "me@gmail.com")).toBe(true);
    expect(matchesQuery("zzz", "Work", "me@work.example")).toBe(false);
  });
});

it("pluralizes", () => {
  expect(pluralize(1, "session")).toBe("1 session");
  expect(pluralize(3, "session")).toBe("3 sessions");
});
