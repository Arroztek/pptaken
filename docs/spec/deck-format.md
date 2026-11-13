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
    "fonts": ["Inter", "JetBrains Mono"]      // from the bundled catalog, ≤ 4, unique
  },
  "slides": [                         // required, 1..200
    {
      "id": "intro",                  // required, [a-z0-9-]{1,40}, unique, stable across edits
      "title": "Welcome",             // optional, ≤ 200 chars (overview and speaker view)
      "html": "<h1>Welcome</h1>",     // required, ≤ 256 KB
      "css": "h1 { color: #5746AF }", // optional, ≤ 64 KB, scoped to this slide
      "notes": "Say hello. **Smile.**",   // optional Markdown, ≤ 16 KB, never shown to the audience
      "section": "Opening",           // optional, ≤ 100 chars
      "durationHintSec": 60           // optional, 1..3600
    }
  ]
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

Fonts are used by name from a closed catalog bundled with the player: Inter, IBM Plex Sans,
Bricolage Grotesque, Space Grotesk, Source Serif 4, Fraunces, JetBrains Mono, IBM Plex Mono,
Atkinson Hyperlegible. External fonts are not allowed.

## Assets

Images are uploaded separately and referenced as `asset:<hex id>` (16 to 64 lowercase hex characters, the
content hash) in slide HTML and CSS. External URLs are not allowed, so decks work offline and do not leak the
audience's IP address.

## Content rules (enforced by the sanitizer and the sandbox, not by the schema)

Slide content is untrusted. The server removes scripts, event-handler attributes, frames, forms, `@import` and
external `url()`, and reports what it removed as warnings. The player also runs the content in a sandboxed
iframe with a network-free CSP. See [`docs/spikes/S1-isolation.md`](../spikes/S1-isolation.md).

## Limits

| Item | Limit |
|---|---|
| Slides per deck | 200 |
| Slide HTML / slide CSS / theme CSS | 256 KB / 64 KB / 64 KB (counted in UTF-16 code units) |
| Notes per slide | 16 KB |
| Fonts per theme | 4 |

## Versioning

`schemaVersion` is an integer. Compatible additions (new optional fields) do not change it; incompatible changes
bump it and ship a migrator. The JSON Schema is published with each release. Uniqueness of slide ids cannot be
expressed in JSON Schema and is enforced by `parseDeck`.

## Examples

See [`packages/schema/examples/`](../../packages/schema/examples/).
