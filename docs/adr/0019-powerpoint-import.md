# ADR-019 · PowerPoint import

**Status:** accepted (2026-11-16). See [pptx-import.md](../spec/pptx-import.md), [http-api.md](../spec/http-api.md),
[ADR-001](0001-content-format.md) (untrusted content), [ADR-012](0012-license.md) and
[ADR-013](0013-pptaken-and-pptaken-cloud.md) (open-core boundary).

## Context

Most people who try PPTaken already have their talks in PowerPoint. Asking an agent to re-create a deck from a
description loses the structure people spent hours on; asking them to re-type it is worse. We need a way in for
`.pptx` files that keeps text, pictures, layout, notes and sections, from the panel, without weakening the security
model (every deck is untrusted content) or the self-hosted footprint (one Node process, no native dependencies).

Options considered:

1. **LibreOffice headless** (convert to HTML/SVG/PDF): the best visual fidelity, but a ~600 MB runtime with a long
   history of parser vulnerabilities, a separate process to sandbox, and output (absolutely positioned SVG text)
   that is neither editable nor what the player expects. Ruled out of the core.
2. **An agent reads the file** (via MCP) and rebuilds the deck: flexible and good at restyling, but slow,
   non-deterministic, costly, and it needs the file in the agent's context; positions and tables drift.
3. **A deterministic converter** in TypeScript: OOXML → `pptaken.deck` HTML with absolute positions, inheritance
   resolved, images as assets. Predictable, testable, fast, no native code; fidelity limited to what we map.

## Decision

1. **Deterministic converter backbone** (option 3) in a new package, `@pptaken/import-pptx`, **AGPL-3.0-or-later,
   in the open core**: every self-hosted instance can import PowerPoint; it is not a cloud-only feature.
   `convertPptx(bytes) → { deck, assets, warnings }` is a pure function with no I/O.
2. **Hybrid later**: phase 2 adds an MCP upload-ticket tool so an agent can start from the converted deck and
   restyle it. Not built now; the converter output is already a normal deck any agent can edit.
3. **The output is untrusted.** The core's `importPptx` use case (owner only) sends the converter's deck through
   the same path as `.pkn` imports and agent writes (`parseDeck`, sanitizer, asset checks, limits, one transaction).
   The core knows nothing about OOXML: it receives a `PptxConverter` port from the composition root.
4. **Isolation**: the server runs the converter in a worker thread with a heap limit, a hard timeout, an empty
   environment and at most two conversions at once. A hostile file can fail its own import, not the server.
5. **Allow-listed parts only**, read with the hardened ZIP reader moved from `@pptaken/export` into a small shared
   package, `@pptaken/zip` (now lazy: entries are inflated on demand, non-allow-listed entries are never inflated).
   Macros, embeddings, ActiveX and OLE payloads are never read; `.pptm` is accepted with its macros dropped.
6. **XML without DTDs**: any `<!DOCTYPE`/`<!ENTITY` refuses the file; parsing uses `saxes` 6.0.0 (ISC, one
   dependency, `xmlchars` 2.2.0 MIT; no install scripts, pinned exactly). External relationships are never fetched.
7. **Fidelity contract**: "recognizable and editable". Absolute positions are kept; fonts map to the bundled catalog
   with a width compensation; everything lossy (charts, SmartArt, transitions, most animations, video, 3D…) produces
   a per-slide warning naming the feature, never a failure. Entrance animations on click become `data-step`.
8. **Out of scope**: `.ppt` (binary 97-2003): detected and refused with "save it as .pptx". Password-protected files:
   refused. No LibreOffice, no image decoding or downscaling (no `sharp`): oversized images become placeholders.

## Consequences

- People can bring existing decks in one step; the summary tells them exactly what to fix.
- Text may wrap differently with replaced fonts; boxes clip (`overflow: hidden`) rather than spill over neighbours.
  Only Inter, Bricolage Grotesque and JetBrains Mono are bundled today, so serif and other mapped families render
  with the generic fallback until the rest of the catalog ships.
- Charts and SmartArt are the most visible gaps (placeholders). Rendering SmartArt from its cached drawing part and
  charts from their cached values are candidates for a later phase.
- One more parser of hostile input in the server process's family: mitigated by isolation, allow-listing, the
  hostile corpus in the tests and the unchanged sanitizer and sandbox barriers.
- `@pptaken/export` keeps re-exporting the ZIP layer, so nothing that imported it breaks.
