// SPDX-License-Identifier: AGPL-3.0-or-later
// Public links (ADR-026), the credentials a guest page carries after `/s/<secret>` resolved:
//
// - the LINK GRANT (`X-PPTaken-View`, purpose `link`, subject `<deck>:<link id>:<kind>`, 8 h, content subkey): what a
//   guest page sends to content-url, to the guest presenter-data and opened endpoints, and to the unlock. It is
//   verified AND the link is looked up again on every use, so turning a link off (or the trash, an expiry, the
//   instance switch, the owner's setting) stops it at once; the 8 h only bounds a grant whose link stays alive.
// - link-bound content tokens minted from it: `ldoc` (static document, `<deck>:<rev>:<link>`), `lsdoc` (scripted
//   document of a presenter link after the unlock, `<deck>:<rev>:<digest>:<link>`) and `lasset` (`<deck>:<link>`);
//   the content routes re-check the link on every request, so even an already loaded page stops getting images.
//
// The test-only guest route (ADR-021) keeps minting the old deck-only `view` grant; it is honoured only when the
// server was created with `testRoutes` (never in production) and behaves like a presenter link with no link id.
import { signToken, verifyToken } from "@pptaken/auth-local";
import { DEFAULT_WORKSPACE_ID, type ResolvedShareLink, type ShareLinkKind } from "@pptaken/core";
import type { Services } from "./context.js";

/** Lifetime of a link grant (one working day); every use re-checks the link itself. */
export const LINK_GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Whether public links work now: the operator's PPTAKEN_PUBLIC_LINKS and the owner's Settings switch. */
export async function publicLinksOn(s: Services): Promise<boolean> {
  return s.config.publicLinks && (await s.auth.publicLinksAllowed());
}

/** Purpose and subject of a signed token, UNVERIFIED (only to choose what to verify it against). */
export function claimsOf(token: string): { purpose: string; subject: string } | null {
  const payload = token.split(".")[0];
  if (payload === undefined || !/^[A-Za-z0-9_-]{1,400}$/.test(payload)) return null;
  const parts = Buffer.from(payload, "base64url").toString("utf8").split("|");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  return { purpose: parts[1] ?? "", subject: parts[2] ?? "" };
}

export function signLinkGrant(
  s: Services,
  claims: { deckId: string; linkId: string; kind: ShareLinkKind },
): string {
  return signToken(s.contentKey, {
    purpose: "link",
    subject: `${claims.deckId}:${claims.linkId}:${claims.kind}`,
    exp: s.clock.now() + LINK_GRANT_TTL_MS,
  });
}

/** The link `linkId` of `deckId` when it works right now (switches on, live, deck live, revision present). */
export async function liveLink(
  s: Services,
  linkId: string,
  deckId: string,
): Promise<ResolvedShareLink | null> {
  if (!ULID.test(linkId) || !ULID.test(deckId)) return null;
  if (!(await publicLinksOn(s))) return null;
  return s.core.checkShareLink(DEFAULT_WORKSPACE_ID, linkId, deckId);
}

/** What a verified guest grant allows. `linkId` is null only for the test route's grant. */
export interface GuestGrant {
  linkId: string | null;
  kind: ShareLinkKind;
  /** The revision this guest sees (a pinned link's revision, else the current one); null: the current one. */
  revision: number | null;
}

/**
 * Verifies a guest page's grant for `deckId`: signature, expiry, deck binding, and the link still working now.
 * `null` for anything else.
 */
export async function verifyGuestGrant(
  s: Services,
  token: string | undefined,
  deckId: string,
): Promise<GuestGrant | null> {
  if (token === undefined || token === "" || token.length > 600 || !ULID.test(deckId)) return null;
  const claims = claimsOf(token);
  if (claims === null) return null;
  const now = s.clock.now();
  if (claims.purpose === "view") {
    if (s.testRoutes !== true) return null;
    return verifyToken(s.contentKey, token, { purpose: "view", subject: deckId, now })
      ? { linkId: null, kind: "presenter", revision: null }
      : null;
  }
  if (claims.purpose !== "link") return null;
  const [subjectDeck, linkId, kind] = claims.subject.split(":");
  if (subjectDeck !== deckId || linkId === undefined || (kind !== "view" && kind !== "presenter")) {
    return null;
  }
  if (!verifyToken(s.contentKey, token, { purpose: "link", subject: claims.subject, now })) {
    return null;
  }
  const live = await liveLink(s, linkId, deckId);
  if (live === null || live.link.kind !== kind) return null;
  return { linkId, kind, revision: live.revision };
}

/** The link id bound to a link-bound content token (`ldoc`, `lsdoc`, `lasset`), parsed from its subject. */
export function contentTokenLink(
  purpose: string,
  subject: string,
  deckId: string,
  revisionText: string | null,
): { linkId: string; digest: string | null } | null {
  const parts = subject.split(":");
  if (parts[0] !== deckId) return null;
  if (purpose === "lasset" && parts.length === 2)
    return { linkId: parts[1] as string, digest: null };
  if (revisionText === null || parts[1] !== revisionText) return null;
  if (purpose === "ldoc" && parts.length === 3) return { linkId: parts[2] as string, digest: null };
  if (purpose === "lsdoc" && parts.length === 4 && SHA256.test(parts[2] as string)) {
    return { linkId: parts[3] as string, digest: parts[2] as string };
  }
  return null;
}
