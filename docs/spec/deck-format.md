# `pptaken.deck` format, version 1

The deck format is the contract between an agent that writes presentations and the player that shows them.
The machine-readable definition is `@pptaken/schema` (Zod, with a generated JSON Schema at
`@pptaken/schema/deck.schema.json`); this page explains it. License: Apache-2.0.

Design background: [ADR-001](../adr/0001-content-format.md).

## Shape

```jsonc
{
  "schemaVersion": 1,                 // required, must be 1
  "title": "How a talk gets taken care of",   // required, 1..200 chars
  "lang": "en",                       // optional BCP-47 tag
  "aspectRatio": "16:9",              // optional, "16:9" (default) or "4:3"
  "targetMinutes": 20,                // optional, 1..600
  "theme": {                          // optional
    "css": ":root { --accent: #FFB224 }",     // shared CSS, ≤ 64 KB
    "fonts": ["Inter", "JetBrains Mono"],     // bundled fonts used, ≤ 4, unique
    "fontFaces": [ … ]                        // vendored fonts (see Fonts)
  },
  "slides": [                         // required, 1..200
    {
      "id": "intro",                  // required, [a-z0-9-]{1,40}, unique, stable across edits
      "title": "Welcome",             // optional, ≤ 200 chars (overview and speaker view)
      "html": "<h1>Welcome</h1>",     // required, ≤ 256 KB
      "css": "h1 { color: #5746AF }", // optional, ≤ 64 KB, scoped to this slide
      "notes": "Say hello. **Smile.**",   // optional Markdown, ≤ 16 KB, never shown to the audience
      "section": "Opening",           // optional, ≤ 100 chars
      "durationHintSec": 60,          // optional, 1..3600
      "script": "slide.onEnter(…)"    // optional, interactive mode only (see below)
    }
  ],
  "libs": ["uplot@1"]                 // optional, interactive mode only: vendored scripts (id or reference)
}
```

Objects are **strict**: unknown fields are rejected, so a typo such as `note` instead of `notes` is reported
instead of silently dropped.

## Canvas

Every slide is drawn on a fixed logical canvas and scaled by the player with letterboxing:

| `aspectRatio` | Canvas (CSS px) |
|---|---|
| `16:9` | 1920 × 1080 |
| `4:3` | 1440 × 1080 |

Write with absolute pixel sizes for that canvas (body text around 40 px, titles around 96 px).

## Steps

Add `data-step="n"` to any element to reveal it on the n-th advance. Elements without a number are revealed in
document order. The player counts the steps; nothing else needs to be declared.

## Fonts

Bundled fonts are used by name: Inter, IBM Plex Sans, Bricolage Grotesque, Space Grotesk, Source Serif 4, Fraunces,
JetBrains Mono, IBM Plex Mono, Atkinson Hyperlegible (`theme.fonts` lists the ones a deck uses). Since ADR-022 any
other family works once it is **vendored** into `theme.fontFaces`:

```jsonc
"theme": {
  "fontFaces": [                         // ≤ 96; filled by the server when it vendors fonts
    { "family": "Lora", "src": "asset:<sha256>", "format": "woff2",
      "weight": "400 700", "style": "normal", "unicodeRange": "U+0000-00FF, U+0131",
      "source": "https://fonts.gstatic.com/…" }   // provenance only
  ],
  "googleFonts": [{ "family": "Lora", "weights": [400, 700], "italic": false }]   // input only, ≤ 8, not stored
}
```

The server fills `fontFaces` from a stylesheet URL (`@import url(https://fonts.googleapis.com/css2?…)`,
`<link rel=stylesheet>`), an `@font-face` with an https `src`, or `theme.googleFonts` (it builds the css2 URL).
Families declared in `fontFaces` are accepted by the sanitizer like the bundled ones; any other family name is
removed with a warning (a bare family name is never resolved to a download on its own).

## Assets and external resources

Images, fonts and scripts are stored on the instance and referenced as `asset:<hex id>` (16 to 64 lowercase hex
characters, the content hash; `fontFaces[].src` uses the full 64). They are added by `add_asset` (base64 or an https
URL) or **vendored at write time** (ADR-022): https URLs in slide HTML (`<img src/srcset>`, `<picture>`, SVG
`<image href>`, `<link rel=stylesheet>`, `<script src>`), in CSS (`url()`, `@import`, `@font-face`) and in `libs`
are fetched once by the server, checked by content, stored, and the deck is rewritten to the stored copies. The
stored deck never references a third party at view time, so decks work offline and do not leak the audience's IP
address. Video, audio, iframes and embeds are removed with a warning.

`vendored` (optional, written by the server, ≤ 300 entries) is the provenance of those resources:
`[{ kind: "script" | "stylesheet" | "font" | "image", url, status: "vendored" | "failed", finalUrl?, redirects?,
sha256?, bytes?, mediaType?, fetchedAt, error?, via? }]`. It is never used at view time; a value sent by a client is
ignored and recomputed.
## Content rules (enforced by the sanitizer and the sandbox, not by the schema)

Slide content is untrusted. The server removes scripts, event-handler attributes, frames, forms, `@import` and
external `url()` that were not vendored, and reports what it removed as warnings. The player also runs the content in a sandboxed
iframe with a network-free CSP. See [`docs/spikes/S1-isolation.md`](../spikes/S1-isolation.md).

## Interactive mode: `script` and `libs` (ADR-020)

Two optional fields, a compatible addition to version 1 (no `schemaVersion` bump). Objects are strict, so an
older server **rejects** a deck that uses them instead of dropping the code silently (fail closed).

- `slides[].script`: the slide's JavaScript, an inline classic script. At most 128 KB per slide and 1 MB per deck
  (UTF-16 code units). It must not contain `<script`, `</script` or `<!--` (inside a string write
  `"</script>"`), NUL or lone surrogates. Libraries come through `libs`; nothing is fetched at view time.
- `libs`: an ordered list (at most 16) of **vendored script assets** `{ "name", "version"?, "sha256", "source"? }`:
  scripts stored on the instance, referenced by the SHA-256 of the file, with the https URL they were vendored from
  (provenance; viewers never contact it). A bundled id is accepted as shorthand and stored expanded; this version
  bundles `uplot@1` (uPlot 1.6.32, MIT, global `uPlot`). A reference to a script the instance does not store is
  refused. As input, an entry may also be an https URL of a classic (UMD/IIFE) build: the server vendors it on write
  (ADR-022) and stores `{ name, version?, sha256, source, finalUrl, bytes }` in its place.
- `script` (deck level, ADR-022): one classic script run once in the global scope, after `libs` and before the
  slide scripts; at most 512 KB, counted in the 1 MB total; same rules as `slides[].script`.

The code runs **only** in the owner's own session, after the owner approved the deck's scripts digest, on an
instance where the operator enabled it (`PPTAKEN_SCRIPTS=owner`). Everywhere else (presenter previews, phones,
exports, offline copies, future public links) the slide is shown without it: its `html`/`css` are the
**mandatory static fallback**. Any change to a script or to `libs` returns the deck to "pending approval".

Each script runs once, at load, as `function (slide) { … }` with:

| Member | Meaning |
|---|---|
| `root` | the slide's `<section>` element |
| `onEnter(fn(step))` | the slide became the current one (present mode) |
| `onStep(fn(step))` | the revealed step count changed while the slide is current |
| `onLeave(fn())` | the slide stopped being the current one (or the mode left present) |
| `setSteps(n)` | the slide has `n` steps (at least its `data-step` groups); call it during setup only |

Exceptions are caught per slide and reported to the presenter view (no details). Keys typed in a form control stay
there (except `Escape`, `b`, `f`); other keys go to the player. Decks with scripts or libraries are sanitized
with the `interactive` profile (canvas, a few controls, `data-*`; see the [sanitizer](sanitizer.md)).

## Limits

| Item | Limit |
|---|---|
| Slides per deck | 200 |
| Slide HTML / slide CSS / theme CSS | 256 KB / 64 KB / 64 KB (counted in UTF-16 code units) |
| Notes per slide | 16 KB |
| Fonts per theme | 4 |
| Script per slide / all scripts | 128 KB / 1 MB (UTF-16 code units) |
| Vendored scripts per deck | 16 (stored on the instance) |

## Versioning

`schemaVersion` is an integer. Compatible additions (new optional fields) do not change it; incompatible changes
bump it and ship a migrator. The JSON Schema is published with each release. Uniqueness of slide ids cannot be
expressed in JSON Schema and is enforced by `parseDeck`.

## Examples

See [`packages/schema/examples/`](../../packages/schema/examples/).
