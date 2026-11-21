// SPDX-License-Identifier: AGPL-3.0-or-later
// Public link pages (ADR-026): `GET /s/<secret>` (the player for a view or presenter link) and
// `GET /s/<secret>/presenter` (the presenter window of a presenter link). No session, no cookie, no login prompt.
//
// - Every failure (malformed, unknown, turned off, expired, deck in the trash, switch off, a view link asking for the
//   presenter window, any other path or method under /s/) answers the SAME generic page, byte for byte for the same
//   Accept-Language, with status 404. The lookup is one keyed hash + one indexed query + a constant-time compare.
// - Rate limits: 300 pages per minute per IP (an audience behind one NAT); 20 failed lookups per 10 minutes per IP and 300 instance-wide pause
//   further lookups (429, a calm "try again later" page) without touching anything else.
// - Every response carries Referrer-Policy: no-referrer, X-Robots-Tag: noindex, nofollow, noarchive,
//   Cache-Control: private, no-store, and frame-ancestors 'none'. The secret is never logged (app.ts redacts
//   `/s/<secret>`), never audited, never in an error message.
// - The page is the trusted player page with `data-viewer="guest"` and a link grant (public-links.ts); content
//   comes through the usual content-url / sandboxed content origin, always static for view links.
import { DEFAULT_WORKSPACE_ID } from "@pptaken/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv, Services } from "./context.js";
import { publicLinksOn, signLinkGrant } from "./public-links.js";
import { escapeHtml, playerPagePolicy } from "./routes-content.js";

type Lang = "en" | "es";

const TEXT: Record<
  Lang,
  { goneTitle: string; gone: string; busyTitle: string; busy: string; loading: string }
> = {
  en: {
    goneTitle: "This link is not available",
    gone: "This link is not available anymore. Ask the person who shared it for a new one.",
    busyTitle: "Please wait a moment",
    busy: "Too many tries from this network. Wait a few minutes and try again.",
    loading: "Loading…",
  },
  es: {
    goneTitle: "Este enlace no está disponible",
    gone: "Este enlace ya no está disponible. Pide uno nuevo a quien te lo compartió.",
    busyTitle: "Espera un momento",
    busy: "Demasiados intentos desde esta red. Espera unos minutos y vuelve a intentarlo.",
    loading: "Cargando…",
  },
};

/** The first supported language of an Accept-Language header (English by default). */
export function langOf(accept: string | undefined): Lang {
  for (const part of (accept ?? "").split(",").slice(0, 20)) {
    const tag = part.split(";")[0]?.trim().toLowerCase().split("-")[0];
    if (tag === "es" || tag === "en") return tag;
  }
  return "en";
}

/** Headers of every /s/ response. */
export const LINK_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  Vary: "Accept-Language",
} as const;

/** CSP of the static notice pages: no script, inline styles only, never framed. */
const NOTICE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const NOTICE_STYLE =
  "html,body{margin:0;height:100%;background:#0F1115;color:#F2EFE9;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  "main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}" +
  "div{max-width:30rem;text-align:center}h1{font-size:1.375rem;line-height:1.3;margin:0 0 12px;font-weight:600}" +
  "p{margin:0;color:#B9BDC9}";

function noticePage(lang: Lang, title: string, text: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow, noarchive"><meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title><link rel="icon" href="data:,"><style>${NOTICE_STYLE}</style></head>
<body><main><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></div></main></body></html>`;
}

/** The one answer for every link that does not work: same status, headers and bytes whatever the reason. */
export function linkNotAvailable(c: Context): Response {
  const lang = langOf(c.req.header("accept-language"));
  const t = TEXT[lang];
  return new Response(noticePage(lang, t.goneTitle, t.gone), {
    status: 404,
    headers: {
      ...LINK_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": NOTICE_CSP,
    },
  });
}

function tooManyTries(c: Context, retryAfterMs: number): Response {
  const lang = langOf(c.req.header("accept-language"));
  const t = TEXT[lang];
  return new Response(noticePage(lang, t.busyTitle, t.busy), {
    status: 429,
    headers: {
      ...LINK_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": NOTICE_CSP,
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });
}

function guestPage(
  lang: Lang,
  page: "player" | "presenter",
  data: {
    deckId: string;
    title: string;
    kind: "view" | "presenter";
    grant: string;
    presenterPath: string | null;
  },
): string {
  const attrs = [
    `data-deck="${escapeHtml(data.deckId)}"`,
    'data-viewer="guest"',
    `data-kind="${data.kind}"`,
    `data-view="${escapeHtml(data.grant)}"`,
    'data-link="1"',
    ...(data.presenterPath === null ? [] : [`data-presenter="${escapeHtml(data.presenterPath)}"`]),
    'data-state="loading"',
  ];
  const head = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow, noarchive">`;
  if (page === "presenter") {
    return `${head}<title>${escapeHtml(data.title)}</title>
<link rel="stylesheet" href="/_player/presenter.css"></head>
<body ${attrs.join(" ")}><div id="presenter"></div><p id="status" role="status">${TEXT[lang].loading}</p>
<script type="module" src="/_player/presenter-page.js"></script></body></html>`;
  }
  return `${head}<title>${escapeHtml(data.title)}</title>
<link rel="stylesheet" href="/_player/page.css"></head>
<body ${attrs.join(" ")} data-offline="loading"><div id="stage"></div><p id="status" role="status">${TEXT[lang].loading}</p>
<script type="module" src="/_player/page.js"></script></body></html>`;
}

export function shareRoutes(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const open = async (c: Context<AppEnv>, page: "player" | "presenter"): Promise<Response> => {
    const ip = c.get("ip");
    const rl = s.limits.sharePagesPerIp.take(ip);
    if (!rl.ok) return tooManyTries(c, rl.retryAfterMs);
    // A guessing pause: per IP and instance-wide, before any lookup.
    for (const [limiter, key] of [
      [s.limits.shareFailuresPerIp, ip],
      [s.limits.shareFailures, "all"],
    ] as const) {
      const gate = limiter.peek(key);
      if (!gate.ok) return tooManyTries(c, gate.retryAfterMs);
    }
    if (!(await publicLinksOn(s))) return linkNotAvailable(c);
    const secret = c.req.param("secret") ?? "";
    const resolved = await s.core.resolveShareLink(DEFAULT_WORKSPACE_ID, secret);
    if (resolved === null) {
      s.limits.shareFailuresPerIp.take(ip);
      s.limits.shareFailures.take("all");
      return linkNotAvailable(c);
    }
    const { link, deck } = resolved;
    if (page === "presenter" && link.kind !== "presenter") return linkNotAvailable(c);
    const lang = langOf(c.req.header("accept-language"));
    const html = guestPage(lang, page, {
      deckId: deck.id,
      title: deck.title,
      kind: link.kind,
      grant: signLinkGrant(s, { deckId: deck.id, linkId: link.id, kind: link.kind }),
      presenterPath:
        page === "player" && link.kind === "presenter"
          ? `/s/${encodeURIComponent(secret)}/presenter`
          : null,
    });
    return new Response(html, {
      status: 200,
      headers: {
        ...LINK_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": playerPagePolicy(c, s),
      },
    });
  };

  app.get("/s/:secret", (c) => open(c, "player"));
  app.get("/s/:secret/presenter", (c) => open(c, "presenter"));
  app.all("/s", (c) => linkNotAvailable(c));
  app.all("/s/*", (c) => linkNotAvailable(c));
  return app;
}
