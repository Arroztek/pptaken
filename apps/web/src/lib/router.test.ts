// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { decide, isAppPath, loginUrl, normalizePath, safeNext } from "./router";

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
    expect(decide("/tokens", "", inn)).toEqual({ kind: "render", page: "tokens" });
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
    expect(isAppPath("/p/abc")).toBe(false);
    expect(isAppPath("/api/v1/decks")).toBe(false);
  });

  it("only allows internal protected next targets", () => {
    expect(safeNext("/tokens")).toBe("/tokens");
    expect(safeNext("/login")).toBe("/decks");
    expect(safeNext(null)).toBe("/decks");
    expect(loginUrl("/decks")).toBe("/login");
  });
});
