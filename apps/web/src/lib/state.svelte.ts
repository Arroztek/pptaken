// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared app state (Svelte 5 runes). Lives at module level so it survives the remount
// that happens when the language changes (see App.svelte).
import { type Locale, readTheme, type ThemeChoice } from "@pptaken/ui";
import { api, type CreatedToken, type SetupStatus } from "./api";
import { isAppPath, normalizePath } from "./router";
import { initialLocale, LANG_KEY, readStored, writeStored } from "./storage";
import { createWebTranslator, type Key, type Vars } from "./translate";

// ------------------------------------------------------------ preferences

export const prefs = $state<{ locale: Locale; theme: ThemeChoice; refocusLang: boolean }>({
  locale: initialLocale(
    readStored(LANG_KEY),
    typeof navigator === "undefined" ? [] : navigator.languages,
  ),
  theme: readTheme("system"),
  refocusLang: false,
});

let translator = createWebTranslator(prefs.locale);

/** Translate with the current locale. Reactive inside templates (reads prefs.locale). */
export function t(key: Key, vars?: Vars): string {
  void prefs.locale;
  return translator(key, vars);
}

export function setLocale(locale: Locale): void {
  if (locale === prefs.locale) return;
  translator = createWebTranslator(locale);
  prefs.locale = locale;
  prefs.refocusLang = true;
  writeStored(LANG_KEY, locale);
  document.documentElement.lang = locale;
}

// ---------------------------------------------------------------- session

export type Boot = "loading" | "ready" | "error";

export const session = $state<{
  boot: Boot;
  status: SetupStatus | null;
  installed: boolean;
  signedIn: boolean;
  /** True right after the setup form succeeds: the connect step shows "Step 2 of 2". */
  justInstalled: boolean;
  notice: "sessionEnded" | null;
}>({
  boot: "loading",
  status: null,
  installed: false,
  signedIn: false,
  justInstalled: false,
  notice: null,
});

/** First call boots the app; later calls (after setup, sign-in) refresh quietly in place. */
export async function loadSession(): Promise<void> {
  if (session.boot !== "ready") session.boot = "loading";
  try {
    const status = await api.setupStatus();
    session.status = status;
    session.installed = status.installed;
    session.signedIn = false;
    if (status.installed) {
      const s = await api.session();
      session.installed = s !== "setup-required";
      session.signedIn = s === "signed-in";
    }
    session.boot = "ready";
  } catch {
    session.boot = "error";
  }
}

/** Call with any API error from a signed-in page: a 401 means the session ended. */
export function handleAuthError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "UNAUTHENTICATED") {
    session.signedIn = false;
    session.notice = "sessionEnded";
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ route

export const route = $state<{ path: string; search: string }>({
  path: typeof location === "undefined" ? "/" : normalizePath(location.pathname),
  search: typeof location === "undefined" ? "" : location.search,
});

function leaving(from: string, to: string) {
  // Token secrets live only while the page that created them is open.
  if (from !== to) clearSecrets();
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const path = normalizePath(url.pathname);
  leaving(route.path, path);
  if (options.replace) history.replaceState(null, "", url.pathname + url.search);
  else history.pushState(null, "", url.pathname + url.search);
  route.path = path;
  route.search = url.search;
  if (!options.replace) window.scrollTo(0, 0);
}

export function startRouter(): void {
  window.addEventListener("popstate", () => {
    const path = normalizePath(location.pathname);
    leaving(route.path, path);
    route.path = path;
    route.search = location.search;
  });
  // Client-side navigation for in-app links; everything else (/p/…, external) is a normal page load.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !isAppPath(url.pathname)) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });
  window.addEventListener("pagehide", clearSecrets);
}

// -------------------------------------------------------------- secrets

/**
 * One-time token secrets: Claude Code and other-client tokens on /welcome, a new token on /tokens.
 * Memory only (never storage, never the URL); cleared when the path changes or the page is left.
 * Kept here rather than in components so a language switch (which re-creates the tree) keeps them.
 */
export const secrets = $state<{
  code: CreatedToken | null;
  other: CreatedToken | null;
  created: CreatedToken | null;
}>({ code: null, other: null, created: null });

export function clearSecrets(): void {
  secrets.code = null;
  secrets.other = null;
  secrets.created = null;
}

// ----------------------------------------------------------------- network

export const network = $state({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
});

export function watchNetwork(): void {
  window.addEventListener("online", () => {
    network.online = true;
  });
  window.addEventListener("offline", () => {
    network.online = false;
  });
}
