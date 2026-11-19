// SPDX-License-Identifier: AGPL-3.0-or-later
// Presenter password unlock (ADR-021): the short-lived token that lets a page WITHOUT an owner session run a deck's
// approved author scripts, and the "view" grant that such a page needs to see the deck at all.
//
// Two credentials, deliberately separate:
// - the view grant (`X-PPTaken-View`): what lets a page without an owner session load a deck's STATIC version. In
//   this phase only the test-only guest page mints it; phase F5's presenter/public links will mint it from the
//   link (ADR-021 §F5). It never runs scripts.
// - the unlock token (`X-PPTaken-Unlock`): minted by POST /api/v1/presenter/unlock after the presenter password,
//   bound to deck id + the approved scripts digest + the presenter password epoch, at most 8 h. It only upgrades a
//   view grant of the same deck to the scripted document; on its own it grants nothing (no API, no panel, no deck
//   content). An edited deck (new digest), a revocation, a changed or removed presenter password, or the instance
//   switch turned off all end it, because the server recomputes the subject from the current state.
import { signToken, verifyToken } from "@pptaken/auth-local";
import { DEFAULT_WORKSPACE_ID, scriptsDigest } from "@pptaken/core";
import type { Context } from "hono";
import type { AppEnv, Services } from "./context.js";
import { escapeHtml, playerPagePolicy } from "./routes-content.js";

/** Lifetime of an unlock token: one working day of talks, never longer (ADR-021). */
export const UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
/** Lifetime of a view grant minted for a guest page. */
export const VIEW_TTL_MS = 8 * 60 * 60 * 1000;
export const VIEW_HEADER = "X-PPTaken-View";
export const UNLOCK_HEADER = "X-PPTaken-Unlock";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The digest of the deck's current scripts when it can be unlocked now: live deck, instance switch on, scripts
 * present and that exact digest approved. `null` otherwise. Always reads the deck (constant work per request).
 */
export async function unlockableDigest(
  s: Services,
  deckId: string,
  options: { guest: boolean } = { guest: true },
): Promise<string | null> {
  const id = ULID.test(deckId) ? deckId : "0".repeat(26);
  const deck = await s.storage.decks.get(DEFAULT_WORKSPACE_ID, id);
  if (deck === null || deck.deletedAt !== null) return null;
  const revision = await s.storage.revisions.get(DEFAULT_WORKSPACE_ID, id, deck.currentRevision);
  if (revision === null) return null;
  const digest = scriptsDigest(revision.document);
  const approval = await s.storage.scriptApprovals.get(DEFAULT_WORKSPACE_ID, id);
  if (s.config.scripts !== "owner" || digest === null || approval?.digest !== digest) return null;
  // ADR-024: screens without an owner session only unlock code the owner approved with a click, never code that
  // was approved automatically by the trust lineage.
  if (options.guest && approval.ownerDigest !== digest) return null;
  return digest;
}

export function signUnlockToken(
  s: Services,
  claims: { deckId: string; digest: string; epoch: string },
): { token: string; exp: number } {
  const exp = s.clock.now() + UNLOCK_TTL_MS;
  const token = signToken(s.unlockKey, {
    purpose: "unlock",
    subject: `${claims.deckId}:${claims.digest}:${claims.epoch}`,
    exp,
  });
  return { token, exp };
}

/**
 * Whether `token` unlocks `deckId` whose current approved digest is `digest`, under the current presenter password.
 * The expected subject is rebuilt from the current state, so any change since the unlock makes it fail.
 */
export async function verifyUnlockToken(
  s: Services,
  token: string | undefined,
  deckId: string,
  digest: string,
): Promise<boolean> {
  if (token === undefined || token === "") return false;
  const epoch = await s.auth.presenterPasswordEpoch();
  if (epoch === null) return false;
  return verifyToken(s.unlockKey, token, {
    purpose: "unlock",
    subject: `${deckId}:${digest}:${epoch}`,
    now: s.clock.now(),
  });
}

/** A view grant for one deck (static version only). Minted by guest pages: today the test route, later F5 links. */
export function signViewGrant(s: Services, deckId: string): string {
  return signToken(s.contentKey, {
    purpose: "view",
    subject: deckId,
    exp: s.clock.now() + VIEW_TTL_MS,
  });
}

export function verifyViewGrant(s: Services, token: string | undefined, deckId: string): boolean {
  if (token === undefined || token === "") return false;
  return verifyToken(s.contentKey, token, { purpose: "view", subject: deckId, now: s.clock.now() });
}

/**
 * The player page as a viewer WITHOUT an owner session sees it (ADR-021): the static version through the view
 * grant, and the presenter-password unlock (`u`) in the trusted shell. No presenter window, no remote control, no
 * offline copy. Phase F5 serves this from presenter/public links; in this phase only the test route uses it.
 */
export async function guestPlayerPage(c: Context<AppEnv>, s: Services): Promise<Response> {
  const deckId = c.req.param("deckId") ?? "";
  const deck = ULID.test(deckId) ? await s.storage.decks.get(DEFAULT_WORKSPACE_ID, deckId) : null;
  if (deck === null || deck.deletedAt !== null) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const view = signViewGrant(s, deckId);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>${escapeHtml(deck.title)} · PPTaken</title>
<link rel="stylesheet" href="/_player/page.css"></head>
<body data-deck="${escapeHtml(deckId)}" data-viewer="guest" data-view="${escapeHtml(view)}" data-state="loading" data-offline="loading"><div id="stage"></div><p id="status" role="status">Loading…</p>
<script type="module" src="/_player/page.js"></script></body></html>`;
  return c.html(html, 200, {
    "Content-Security-Policy": playerPagePolicy(c, s),
    "Cache-Control": "no-store",
  });
}
