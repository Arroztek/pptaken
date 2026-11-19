// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isActive, NAV_GROUPS } from "./nav";
import { decide, isAppPath, layoutFor, loginUrl, normalizePath, safeNext } from "./router";

const fresh = { installed: false, signedIn: false };
const out = { installed: true, signedIn: false };
const inn = { installed: true, signedIn: true };

describe("decide", () => {
  it("routes / by instance state", () => {
    expect(decide("/", "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(decide("/", "", out)).toEqual({ kind: "redirect", to: "/login" });
    expect(decide("/", "", inn)).toEqual({ kind: "redirect", to: "/decks" });
  });

  it("shows setup, then connect, on /welcome", () => {
    expect(decide("/welcome", "", fresh)).toEqual({ kind: "render", page: "setup" });
    expect(decide("/welcome", "", inn)).toEqual({ kind: "render", page: "connect" });
    expect(decide("/welcome", "", out)).toEqual({ kind: "redirect", to: "/login?next=%2Fwelcome" });
  });

  it("guards the signed-in pages", () => {
    expect(decide("/decks", "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(decide("/decks", "", out)).toEqual({ kind: "redirect", to: "/login" });
    expect(decide("/tokens", "", out)).toEqual({ kind: "redirect", to: "/login?next=%2Ftokens" });
    expect(decide("/tokens", "", inn)).toEqual({ kind: "render", page: "apps" });
    expect(decide("/apps", "", inn)).toEqual({ kind: "render", page: "apps" });
    expect(decide("/trash", "", inn)).toEqual({ kind: "render", page: "trash" });
    expect(decide("/settings", "", inn)).toEqual({ kind: "render", page: "settings" });
    expect(decide("/settings", "", out)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fsettings",
    });
    expect(decide("/trash", "", out)).toEqual({ kind: "redirect", to: "/login?next=%2Ftrash" });
    expect(decide("/security", "", out)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fsecurity",
    });
    expect(decide("/security", "", inn)).toEqual({ kind: "render", page: "security" });
    expect(decide("/security", "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(decide("/decks/", "", inn)).toEqual({ kind: "render", page: "decks" });
  });

  it("sends signed-in owners away from /login, honouring a safe next", () => {
    expect(decide("/login", "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(decide("/login", "", out)).toEqual({ kind: "render", page: "login" });
    expect(decide("/login", "?next=%2Ftokens", inn)).toEqual({ kind: "redirect", to: "/tokens" });
    expect(decide("/login", "?next=https%3A%2F%2Fevil.test", inn)).toEqual({
      kind: "redirect",
      to: "/decks",
    });
    expect(decide("/login", "?next=%2F%2Fevil.test", inn)).toEqual({
      kind: "redirect",
      to: "/decks",
    });
  });

  it("guards the OAuth consent page and returns to it after sign-in", () => {
    const path = "/connect/abcdefghijklmnopqrstuvwxyzABCDEF";
    expect(decide(path, "", inn)).toEqual({ kind: "render", page: "oauthConsent" });
    expect(decide(path, "", out)).toEqual({
      kind: "redirect",
      to: `/login?next=${encodeURIComponent(path)}`,
    });
    expect(decide(path, "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(decide("/login", `?next=${encodeURIComponent(path)}`, inn)).toEqual({
      kind: "redirect",
      to: path,
    });
    expect(decide("/connect/short", "", inn)).toEqual({ kind: "render", page: "notFound" });
    expect(safeNext("/connect/abcdefghijklmnopqrstuvwxyzABCDEF/x")).toBe("/decks");
    expect(safeNext("//evil.test/connect/abcdefghijklmnopqrstuvwxyzABCDEF")).toBe("/decks");
    expect(isAppPath(path)).toBe(true);
  });

  it("renders not found for unknown paths", () => {
    expect(decide("/nope", "", inn)).toEqual({ kind: "render", page: "notFound" });
  });
});

describe("helpers", () => {
  it("normalizes paths", () => {
    expect(normalizePath("/decks/")).toBe("/decks");
    expect(normalizePath("/decks?q=1#x")).toBe("/decks");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
  });

  it("knows which paths are client-side", () => {
    expect(isAppPath("/tokens")).toBe(true);
    expect(isAppPath("/security")).toBe(true);
    expect(isAppPath("/p/abc")).toBe(false);
    expect(isAppPath("/api/v1/decks")).toBe(false);
  });

  it("only allows internal protected next targets", () => {
    expect(safeNext("/tokens")).toBe("/tokens");
    expect(safeNext("/security")).toBe("/security");
    expect(safeNext("/login")).toBe("/decks");
    expect(safeNext(null)).toBe("/decks");
    expect(loginUrl("/decks")).toBe("/login");
  });
});

describe("layoutFor", () => {
  it("frames signed-in dashboard pages with the sidebar", () => {
    for (const page of [
      "decks",
      "connect",
      "apps",
      "trash",
      "settings",
      "security",
      "notFound",
    ] as const) {
      expect(layoutFor(page, true)).toBe("shell");
    }
  });

  it("keeps setup, sign-in, consent and signed-out pages focused", () => {
    expect(layoutFor("setup", false)).toBe("focused");
    expect(layoutFor("login", false)).toBe("focused");
    expect(layoutFor("oauthConsent", true)).toBe("focused");
    expect(layoutFor("notFound", false)).toBe("focused");
  });
});

describe("navigation", () => {
  it("links only to app paths, each once", () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(isAppPath(href)).toBe(true);
  });

  it("marks the current page, ignoring a trailing slash", () => {
    const decks = { href: "/decks", label: "nav.decks", icon: "presentation" } as const;
    expect(isActive(decks, "/decks/")).toBe(true);
    expect(isActive(decks, "/tokens")).toBe(false);
  });
});

describe("presentation page (/decks/:id)", () => {
  it("renders for the owner, sends others to sign in and back, and is an app path", () => {
    expect(decide("/decks/01JD0000000000000000000000", "", inn)).toEqual({
      kind: "render",
      page: "deck",
    });
    expect(decide("/decks/01JD0000000000000000000000", "", out)).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fdecks%2F01JD0000000000000000000000",
    });
    expect(decide("/decks/01JD0000000000000000000000", "", fresh)).toEqual({
      kind: "redirect",
      to: "/welcome",
    });
    expect(isAppPath("/decks/deck_001")).toBe(true);
    expect(isAppPath("/decks/a/b")).toBe(false);
    expect(safeNext("/decks/deck_001")).toBe("/decks/deck_001");
    expect(safeNext("/decks/../tokens")).toBe("/decks");
    expect(safeNext("//evil.example/decks/x")).toBe("/decks");
    expect(layoutFor("deck", true)).toBe("shell");
  });

  it("keeps Presentations highlighted in the sidebar", () => {
    const decks = NAV_GROUPS[0]?.items[0];
    if (!decks) throw new Error("no decks item");
    expect(isActive(decks, "/decks/deck_001")).toBe(true);
    expect(isActive(decks, "/decksx")).toBe(false);
    expect(isActive(decks, "/trash")).toBe(true);
  });
});

describe("one-click approval screen (/decks/:id/approve)", () => {
  const path = "/decks/01JD0000000000000000000000/approve";
  it("renders focused for the owner and returns to it after sign-in", () => {
    expect(decide(path, "", inn)).toEqual({ kind: "render", page: "approve" });
    expect(layoutFor("approve", true)).toBe("focused");
    expect(decide(path, "", out)).toEqual({
      kind: "redirect",
      to: `/login?next=${encodeURIComponent(path)}`,
    });
    expect(decide("/login", `?next=${encodeURIComponent(path)}`, inn)).toEqual({
      kind: "redirect",
      to: path,
    });
    expect(decide(path, "", fresh)).toEqual({ kind: "redirect", to: "/welcome" });
    expect(isAppPath(path)).toBe(true);
  });

  it("refuses anything that is not exactly an approval path as next", () => {
    expect(safeNext("/decks/x/approve/more")).toBe("/decks");
    expect(safeNext("//evil.test/decks/x/approve")).toBe("/decks");
    expect(safeNext("/decks/x/approve?next=https://evil.test")).toBe("/decks");
  });

  it("puts Connected apps and Settings in the sidebar, under plain labels", () => {
    const labels = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual([
      "nav.decks",
      "nav.connect",
      "nav.apps",
      "nav.security",
      "nav.settings",
    ]);
    const apps = NAV_GROUPS[1]?.items[0];
    if (!apps) throw new Error("no apps item");
    expect(isActive(apps, "/tokens")).toBe(true);
  });
});
