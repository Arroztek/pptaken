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
export function scriptsDigest(deck: Pick<Deck, "slides" | "libs">): string | null {
  const libs = (deck.libs ?? []).map((lib) => [lib.sha256, lib.source ?? ""]);
  const slides = deck.slides.flatMap((slide) =>
    slide.script === undefined ? [] : [[slide.id, sha256Hex(utf8Encode(slide.script))]],
  );
  if (libs.length === 0 && slides.length === 0) return null;
  const canonical = JSON.stringify({ v: SCRIPTS_DIGEST_VERSION, libs, slides });
  return sha256Hex(utf8Encode(canonical));
}

/** The state of a deck whose current digest is `digest`, given the digest the owner approved (if any). */
export function scriptsStateOf(digest: string | null, approvedDigest: string | null): ScriptsState {
  if (digest === null) return "none";
  return approvedDigest !== null && approvedDigest === digest ? "approved" : "pending";
}

/** Short facts about a deck's scripts, for tool results and the panel. */
export interface ScriptsSummary {
  digest: string | null;
  state: ScriptsState;
  /** Ids of the slides that carry a script, in deck order. */
  slides: string[];
  /** The vendored scripts, in load order (label, hash and provenance, for the approval screen). */
  libs: VendoredScript[];
  /** Total script characters (UTF-16 code units). */
  chars: number;
}

export function scriptsSummary(
  deck: Pick<Deck, "slides" | "libs">,
  approvedDigest: string | null,
): ScriptsSummary {
  const digest = scriptsDigest(deck);
  return {
    digest,
    state: scriptsStateOf(digest, approvedDigest),
    slides: deck.slides.filter((s) => s.script !== undefined).map((s) => s.id),
    libs: (deck.libs ?? []).map((lib) => ({ ...lib })),
    chars: deck.slides.reduce((n, s) => n + (s.script?.length ?? 0), 0),
  };
}
