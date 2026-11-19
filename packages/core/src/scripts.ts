// SPDX-License-Identifier: AGPL-3.0-or-later
// Interactive mode (ADR-020), pure part: the digest that the owner's consent binds to, and the derived state.
import type { Deck, VendoredScript } from "@pptaken/schema";
import { sha256Hex, utf8Encode } from "./sha256.js";

/** Trust state of a deck's author scripts: none, waiting for the owner, or approved for this exact code. */
export type ScriptsState = "none" | "pending" | "approved";

/** Version of the digest's canonical form. Bumping it sends every scripted deck back to `pending`. */
export const SCRIPTS_DIGEST_VERSION = 1;

/** A digest: 64 lowercase hex characters. */
export const SCRIPTS_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The digest of a deck's executable parts: SHA-256 (hex) over the canonical JSON
 * `{"v":1,"libs":[[sha256 of the vendored script, source URL]...],"slides":[[slide id, sha256 of the script]...]}`, slides in
 * deck order and only those with a script. `null` when the deck has neither scripts nor vendored scripts. Any change
 * to a script, to the vendored scripts (their bytes, order or source), or to which slide holds a script changes it.
 * Labels (name, version) are not part of it: the hash is what runs. Slide
 * HTML and CSS are not part of it (ADR-020, residual risks).
 */
export function scriptsDigest(deck: DigestInput): string | null {
  const libs = (deck.libs ?? []).map((lib) => [lib.sha256, lib.source ?? ""]);
  const slides = deck.slides.flatMap((slide) =>
    slide.script === undefined ? [] : [[slide.id, sha256Hex(utf8Encode(slide.script))]],
  );
  if (libs.length === 0 && slides.length === 0 && deck.script === undefined) return null;
  // The deck-level script (ADR-022) adds a `deck` member only when present, so the digests of decks without one
  // are unchanged (their approvals stay valid).
  const canonical =
    deck.script === undefined
      ? JSON.stringify({ v: SCRIPTS_DIGEST_VERSION, libs, slides })
      : JSON.stringify({
          v: SCRIPTS_DIGEST_VERSION,
          libs,
          deck: sha256Hex(utf8Encode(deck.script)),
          slides,
        });
  return sha256Hex(utf8Encode(canonical));
}

/** What the digest reads from a deck. */
export type DigestInput = Pick<Deck, "slides" | "libs"> & { script?: string | undefined };

/** The state of a deck whose current digest is `digest`, given the digest the owner approved (if any). */
export function scriptsStateOf(digest: string | null, approvedDigest: string | null): ScriptsState {
  if (digest === null) return "none";
  return approvedDigest !== null && approvedDigest === digest ? "approved" : "pending";
}

/**
 * Trust lineage key of a vendored library (ADR-024): its content hash and the address it came from. A library is
 * "new" for a lineage when this exact pair was never part of an approved version of the deck, so a new origin OR new
 * bytes (even under a known name or URL) both count as new third-party code.
 */
export function libKey(lib: { sha256: string; source?: string | null | undefined }): string {
  return `${lib.sha256} ${lib.source ?? ""}`;
}

/** The libraries of `deck` that are not in `trusted` (keys from `libKey`), in load order. */
export function untrustedLibs(
  deck: Pick<DigestInput, "libs">,
  trusted: readonly string[],
): VendoredScript[] {
  const known = new Set(trusted);
  return (deck.libs ?? []).filter((lib) => !known.has(libKey(lib))).map((lib) => ({ ...lib }));
}

/** Why an edit did or did not continue a trust lineage (ADR-024), for the audit log and tests. */
export type LineageDecision =
  | { continue: true }
  | {
      continue: false;
      reason:
        | "no_lineage"
        | "setting_off"
        | "scripts_off"
        | "no_scripts"
        | "unchanged"
        | "new_library";
      newLibs?: VendoredScript[];
    };

/**
 * The trust-lineage rule (ADR-024), pure. An edit continues the owner's approval without a click only when ALL hold:
 * the instance runs scripts; automatic updates are on; the code being replaced was approved (`approvedDigest` equals
 * `previousDigest`, so a lineage is alive: the owner approved it, or it continued one the owner approved); the new
 * code differs and is not empty; and every library of the new code was part of an approved version of this deck
 * (same hash AND same source). Anything else breaks the lineage: the deck waits for the owner's click.
 */
export function lineageDecision(input: {
  scriptsEnabled: boolean;
  autoApprove: boolean;
  approvedDigest: string | null;
  previousDigest: string | null;
  nextDigest: string | null;
  next: Pick<DigestInput, "libs">;
  trustedLibs: readonly string[];
}): LineageDecision {
  if (input.approvedDigest === null || input.previousDigest === null)
    return { continue: false, reason: "no_lineage" };
  if (input.approvedDigest !== input.previousDigest)
    return { continue: false, reason: "no_lineage" };
  if (input.nextDigest === null) return { continue: false, reason: "no_scripts" };
  if (input.nextDigest === input.previousDigest) return { continue: false, reason: "unchanged" };
  if (!input.scriptsEnabled) return { continue: false, reason: "scripts_off" };
  if (!input.autoApprove) return { continue: false, reason: "setting_off" };
  const newLibs = untrustedLibs(input.next, input.trustedLibs);
  if (newLibs.length > 0) return { continue: false, reason: "new_library", newLibs };
  return { continue: true };
}

/** Short facts about a deck's scripts, for tool results and the panel. */
export interface ScriptsSummary {
  digest: string | null;
  state: ScriptsState;
  /** Ids of the slides that carry a script, in deck order. */
  slides: string[];
  /** The vendored scripts, in load order (label, hash and provenance, for the approval screen). */
  libs: VendoredScript[];
  /** True when the deck has a deck-level script (ADR-022). */
  deckScript: boolean;
  /** Total script characters (UTF-16 code units), the deck script included. */
  chars: number;
}

export function scriptsSummary(deck: DigestInput, approvedDigest: string | null): ScriptsSummary {
  const digest = scriptsDigest(deck);
  return {
    digest,
    state: scriptsStateOf(digest, approvedDigest),
    slides: deck.slides.filter((s) => s.script !== undefined).map((s) => s.id),
    libs: (deck.libs ?? []).map((lib) => ({ ...lib })),
    deckScript: deck.script !== undefined,
    chars:
      (deck.script?.length ?? 0) + deck.slides.reduce((n, s) => n + (s.script?.length ?? 0), 0),
  };
}
