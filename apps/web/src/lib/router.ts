// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure routing decisions: given the path and what we know about the instance, render a page or redirect.

export type Page =
  | "setup"
  | "connect"
  | "login"
  | "decks"
  | "deck"
  | "approve"
  | "trash"
  | "apps"
  | "security"
  | "settings"
  | "oauthConsent"
  | "notFound";

/**
 * How a page is framed. "shell": the signed-in dashboard with the sidebar. "focused": a single centered column
 * under a slim bar (setup, sign-in, OAuth consent, the one-click approval screen, and anything shown while signed
 * out). The player, presenter view and phone remote are server pages and never pass through here.
 */
export type Layout = "shell" | "focused";

const SHELL_PAGES: readonly Page[] = [
  "decks",
  "deck",
  "trash",
  "connect",
  "apps",
  "security",
  "settings",
  "notFound",
];

export function layoutFor(page: Page, signedIn: boolean): Layout {
  return signedIn && SHELL_PAGES.includes(page) ? "shell" : "focused";
}

export interface RouteContext {
  installed: boolean;
  signedIn: boolean;
}

export type Decision = { kind: "render"; page: Page } | { kind: "redirect"; to: string };

/** Client-side routes. Everything else (/p/…, /c/…, /api/…) is a real server request. */
export const APP_PATHS = [
  "/",
  "/welcome",
  "/login",
  "/decks",
  "/trash",
  "/apps",
  "/tokens",
  "/security",
  "/settings",
] as const;

/** Pages that need a session; `next` may only point at one of these (no open redirects). */
const PROTECTED: readonly string[] = [
  "/decks",
  "/trash",
  "/apps",
  "/tokens",
  "/security",
  "/settings",
  "/welcome",
];

/** Signed-in pages that render directly (no extra state): path -> page. `/tokens` is the old "Access" address. */
const SIGNED_IN_PAGES: Readonly<Record<string, Page>> = {
  "/decks": "decks",
  "/trash": "trash",
  "/apps": "apps",
  "/tokens": "apps",
  "/security": "security",
  "/settings": "settings",
};

/**
 * The OAuth consent page of a pending connection request (ADR-0018): `/connect/<32 base64url characters>`. It is
 * a protected page too, so signing in can return to it (internal path only).
 */
export const CONSENT_PATH = /^\/connect\/[A-Za-z0-9_-]{32}$/;

/**
 * A presentation's page (`urls.manage`): `/decks/<id>`. A protected page, so signing in returns to it (internal
 * path only). Ids are ULIDs on the server; the pattern stays loose and safe.
 */
export const DECK_PATH = /^\/decks\/[A-Za-z0-9_-]{1,64}$/;

/** The one-click approval screen (the agents' `approve_url`, ADR-024): `/decks/<id>/approve`. */
export const APPROVE_PATH = /^\/decks\/[A-Za-z0-9_-]{1,64}\/approve$/;

/** The deck id of a deck page or approval path, or null. */
export function deckIdOf(path: string): string | null {
  const clean = normalizePath(path);
  return DECK_PATH.test(clean) || APPROVE_PATH.test(clean) ? (clean.split("/")[2] ?? null) : null;
}

/** The request id of a consent path, or null. */
export function consentRequestId(path: string): string | null {
  const clean = normalizePath(path);
  return CONSENT_PATH.test(clean) ? (clean.split("/")[2] ?? null) : null;
}

export function normalizePath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? "/";
  if (clean.length > 1 && clean.endsWith("/")) return clean.replace(/\/+$/, "") || "/";
  return clean || "/";
}

export function isAppPath(path: string): boolean {
  const clean = normalizePath(path);
  return (
    (APP_PATHS as readonly string[]).includes(clean) ||
    CONSENT_PATH.test(clean) ||
    DECK_PATH.test(clean) ||
    APPROVE_PATH.test(clean)
  );
}

/** Only same-app protected paths are valid `next` targets. Anything else goes to the list. */
export function safeNext(next: string | null | undefined): string {
  if (!next) return "/decks";
  return PROTECTED.includes(next) ||
    CONSENT_PATH.test(next) ||
    DECK_PATH.test(next) ||
    APPROVE_PATH.test(next)
    ? next
    : "/decks";
}

export function loginUrl(next: string): string {
  const target = safeNext(next);
  return target === "/decks" ? "/login" : `/login?next=${encodeURIComponent(target)}`;
}

export function decide(rawPath: string, search: string, ctx: RouteContext): Decision {
  const path = normalizePath(rawPath);
  const redirect = (to: string): Decision => ({ kind: "redirect", to });
  const render = (page: Page): Decision => ({ kind: "render", page });
  const guarded = (page: Page): Decision => {
    if (!ctx.installed) return redirect("/welcome");
    if (!ctx.signedIn) return redirect(loginUrl(path));
    return render(page);
  };

  switch (path) {
    case "/":
      if (!ctx.installed) return redirect("/welcome");
      return redirect(ctx.signedIn ? "/decks" : "/login");
    case "/welcome":
      if (!ctx.installed) return render("setup");
      return ctx.signedIn ? render("connect") : redirect(loginUrl("/welcome"));
    case "/login": {
      if (!ctx.installed) return redirect("/welcome");
      if (ctx.signedIn) return redirect(safeNext(new URLSearchParams(search).get("next")));
      return render("login");
    }
    default: {
      const page = SIGNED_IN_PAGES[path];
      if (page !== undefined) return guarded(page);
      if (APPROVE_PATH.test(path)) return guarded("approve");
      if (DECK_PATH.test(path)) return guarded("deck");
      if (CONSENT_PATH.test(path)) return guarded("oauthConsent");
      return render("notFound");
    }
  }
}
