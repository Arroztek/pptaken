// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure routing decisions: given the path and what we know about the instance, render a page or redirect.

export type Page = "setup" | "connect" | "login" | "decks" | "tokens" | "notFound";

export interface RouteContext {
  installed: boolean;
  signedIn: boolean;
}

export type Decision = { kind: "render"; page: Page } | { kind: "redirect"; to: string };

/** Client-side routes. Everything else (/p/…, /c/…, /api/…) is a real server request. */
export const APP_PATHS = ["/", "/welcome", "/login", "/decks", "/tokens"] as const;

/** Pages that need a session; `next` may only point at one of these (no open redirects). */
const PROTECTED: readonly string[] = ["/decks", "/tokens", "/welcome"];

export function normalizePath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? "/";
  if (clean.length > 1 && clean.endsWith("/")) return clean.replace(/\/+$/, "") || "/";
  return clean || "/";
}

export function isAppPath(path: string): boolean {
  return (APP_PATHS as readonly string[]).includes(normalizePath(path));
}

/** Only same-app protected paths are valid `next` targets. Anything else goes to the list. */
export function safeNext(next: string | null | undefined): string {
  if (!next) return "/decks";
  return PROTECTED.includes(next) ? next : "/decks";
}

export function loginUrl(next: string): string {
  const target = safeNext(next);
  return target === "/decks" ? "/login" : `/login?next=${encodeURIComponent(target)}`;
}

export function decide(rawPath: string, search: string, ctx: RouteContext): Decision {
  const path = normalizePath(rawPath);
  const redirect = (to: string): Decision => ({ kind: "redirect", to });
  const render = (page: Page): Decision => ({ kind: "render", page });

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
    case "/decks":
    case "/tokens":
      if (!ctx.installed) return redirect("/welcome");
      if (!ctx.signedIn) return redirect(loginUrl(path));
      return render(path === "/decks" ? "decks" : "tokens");
    default:
      return render("notFound");
  }
}
