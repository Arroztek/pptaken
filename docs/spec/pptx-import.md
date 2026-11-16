# PowerPoint import (`.pptx`), phase 1

The owner uploads a PowerPoint file from the panel and gets a normal presentation (revision 1, its own link). The
promise is **recognizable and editable, not pixel-faithful**: what PowerPoint calls a title, a bullet list, a picture
or a table arrives as such, at the same place, ready to be edited by hand or by an agent. Everything that is lost or
approximated is reported as a warning naming the slide and the feature; nothing lossy fails the import.

Decision record: [ADR-0019](../adr/0019-powerpoint-import.md). HTTP contract:
[http-api.md](http-api.md#post-apiv1decksimport-pptx). Code: [`@pptaken/import-pptx`](../../packages/import-pptx)
(AGPL-3.0-or-later, open core).

## Pipeline

1. `POST /api/v1/decks/import-pptx` (owner session, CSRF, size limit, rate limit) receives the raw file.
2. The core's `importPptx` use case (owner only) calls the configured converter port. The server's implementation
   runs `convertPptx` from `@pptaken/import-pptx` in a **worker thread** with a V8 heap limit (768 MB) and a hard
   timeout (60 s); the worker gets an empty environment and only the file's bytes.
3. The converter is a pure function: bytes in, `{ deck, assets, warnings }` out. No file system, no network.
4. Its output is **untrusted**, exactly like an agent's: the core validates the deck with `parseDeck`, sanitizes it,
   validates it again, checks every image like `add_asset` (type by content signature, SHA-256, size and pixel
   limits, per-deck quotas) and writes everything in one transaction (`storeImported`, shared with `.pkn` imports).
5. The response lists the converter's warnings first, then the core's (sanitizer, unused assets).

## Supported input

| Input | Result |
|---|---|
| `.pptx`, `.potx`, `.ppsx` (Office Open XML, transitional or strict namespaces) | Imported |
| `.pptm` | Imported; the macro part is never read (warning "Macros were removed") |
| `.ppt` (PowerPoint 97-2003 binary) | Refused: "save it as .pptx" |
| Password-protected presentation (CFB container with `EncryptedPackage`) | Refused: "remove the password" |
| Other Office documents (`.docx`, `.xlsx`…), anything else | Refused: "not a .pptx presentation" |

## Fidelity

| PowerPoint | In PPTaken | Notes |
|---|---|---|
| Slide size | `16:9` (1920×1080) or `4:3` (1440×1080), the nearest | Other ratios are fitted with margins (`PPTX_CANVAS_ADJUSTED`). 1 pt = 2 px on both canvases |
| Placeholders (title, body, subtitle, footer…) | Absolutely positioned text boxes | Position, size and text styles inherited slide → layout → master → master text styles → presentation defaults |
| Text runs | `<span>` with size, colour, bold, italic, underline, strike, caps, letter spacing, super/subscript | Theme colours resolved through the colour map, with `lumMod`/`lumOff`/`tint`/`shade`/`alpha` |
| Paragraphs | `<p>` with alignment, indent and hanging indent, line and paragraph spacing, line breaks, right-to-left | `normAutofit` font scale and line reduction applied |
| Bullets and numbering | A bullet or number before the text | Characters, Wingdings/Symbol look-alikes, colour, size; numbering schemes (1. a) I. …) with levels and `startAt` |
| Fonts | The bundled catalog (`PPTX_FONT_REPLACED` per font) | Calibri, Arial, Segoe, Aptos… → Inter; Times, Georgia, Cambria… → Source Serif 4; Consolas, Courier… → JetBrains Mono; Century Gothic, Futura… → Space Grotesk; Trebuchet, Gill Sans… → IBM Plex Sans; unknown → Inter. Narrow sources (Calibri 0.88, Arial 0.95…) are set slightly smaller to keep line breaks close. At most 4 fonts per deck: rarer ones fold into the most used |
| Text that no longer fits | Kept in place, clipped at the box | Boxes keep their source position with `overflow: hidden`; bottom/center anchoring uses `safe` alignment so the first lines stay visible. A replaced font can still change line breaks |
| Vertical anchoring and insets | Flex column with the same padding | |
| Vertical text | `writing-mode: vertical-rl` | `vert270` and the like are approximated |
| Pictures | `<img src="asset:…">` with alt text (`descr`) | Crop (`srcRect`) kept; rotation and flips kept; PNG, JPEG, GIF, WebP, AVIF |
| Unsupported image formats (EMF, WMF, TIFF, SVG without a PNG fallback), oversize or broken images, linked images | A hatched placeholder box with the alt text as its label | `PPTX_IMAGE_DROPPED`; linked (external) images are never downloaded |
| Rectangles, rounded rectangles, ellipses | `<div>` with background, border, radius, shadow | Fill and line from the shape or its theme style reference (`p:style`) |
| Lines and connectors | Inline `<svg>` line with dashes and arrowheads | Bent and curved connectors become straight (`PPTX_FEATURE_SIMPLIFIED`) |
| Triangles, diamonds, arrows, chevrons, stars and other common presets; custom geometry | Inline `<svg>` path | Other presets become rectangles (`shape:<name>`) |
| Fills | Solid, linear and radial gradients, picture fills | Pattern fills become solid; gradients on SVG shapes become solid |
| Groups | Flattened; child coordinates transformed | Group rotation is ignored (warning); nesting followed to 16 levels |
| Tables | `<table>` with column widths, row heights, merged cells, cell fills, borders, padding | Table styles approximated (header in accent 1, banded rows) |
| Slide background | Slide CSS `:root { background: … }` | Solid, gradient, picture; from slide, layout or master |
| Master and layout decorations | Drawn under the slide's own shapes | Honour "hide background graphics" (`showMasterSp`) |
| Speaker notes | `notes` (Markdown-escaped plain text) | Cut at 16 KB (`PPTX_CONTENT_TRUNCATED`) |
| Sections | `section` per slide | |
| Slide titles | `title` (overview, speaker view) | From the title placeholder |
| Entrance animations on click | `data-step` on the shape or on the animated paragraphs | `PPTX_FEATURE_SIMPLIFIED` (effects and timing are lost) |
| Hidden slides | Imported and shown | Warning |
| Deck title and language | `docProps/core.xml` title (else the first slide title); the most used run language | |

Not carried over (each one a per-slide `PPTX_FEATURE_DROPPED` or a deck-level warning, never a failure):
transitions, exit/emphasis/motion paths and timed or triggered animations, charts and SmartArt (a placeholder box
marks them), embedded OLE objects (shown as their picture when there is one), video and audio (the poster frame is
kept), ink, 3D, glow/reflection/soft edges, WordArt warps (text kept as plain coloured text), hyperlinks (text kept),
comments, embedded fonts, ActiveX and macros.

## Limits

| Limit | Value | When exceeded |
|---|---|---|
| File size | `PPTAKEN_MAX_IMPORT_MB` (default 100 MB) | `413` before reading |
| ZIP entries | 5 000 | Refused |
| Uncompressed size of the parts that are read | 400 MB in total, 16 MB per XML part | Refused |
| Compression ratio of a part | 500:1 (for parts over 64 KB) | Refused (ZIP bomb) |
| XML per part | depth 256, 400 000 elements, 8 M characters of text | Refused |
| Slides | 200 (the format's limit) | Refused, with a hint to split the file |
| Images | 10 MB and 64 megapixels each (20 000 px per side), 200 and 100 MB per deck | Placeholder + warning |
| Shapes per slide | 1 000 after flattening | The rest left out + warning |
| Slide HTML | 200 KB (format limit 256 KB) | The rest left out + warning |
| Conversion | 60 s, 768 MB heap, 2 at once per server | Refused (`LIMIT_EXCEEDED`) / `429` |

## Security

The file is hostile input (threat model T1, T12; [security](../foundation/04-security-and-auth.md)):

- **ZIP**: the hardened reader of `@pptaken/zip` (shared with `.pkn` imports): central directory checked against
  local headers, unsafe names (traversal, absolute, drive letters, control and bidi characters), duplicates
  (also case-folded), symbolic links, overlapping entries, encryption, ZIP64 and spanning refused; sizes and ratios
  checked from the declared values before inflating; inflation bounded by the declared size; CRC-32 verified.
- **Allow-listed parts**: only `[Content_Types].xml`, `_rels/.rels`, `docProps/core.xml`, `ppt/presentation.xml`
  and its relationships, `ppt/slides/`, `ppt/slideLayouts/`, `ppt/slideMasters/`, `ppt/theme/`, `ppt/notesSlides/`
  (with their `_rels/`) and `ppt/media/` are ever inflated. Everything else (`vbaProject.bin`, `embeddings/`,
  `activeX/`, OLE, charts, diagrams, fonts, comments, custom XML) is validated structurally and never decompressed.
- **XML**: a part containing `<!DOCTYPE` or `<!ENTITY` is refused before parsing (no DTD, no entity expansion, no
  external entities); parsing uses `saxes` (non-validating, no network); the bytes must be valid UTF-8 (or UTF-16
  with a BOM); depth, element and text caps.
- **Relationships** resolve only inside the package (`..` cannot escape the root, URLs and absolute paths are
  refused). External targets (`TargetMode="External"`: linked images, videos, hyperlinks) are **never fetched**.
- **Images**: type by content signature (the core's `sniffImage`, polyglot checks included), dimensions read from
  the header without decoding, size and pixel caps; no image library, no native code, no LibreOffice.
- **Output**: every text, alt text and attribute is escaped by the converter; styles are built from numbers and fixed
  keywords; font names map to the catalog (source names never reach CSS). The sanitizer and the sandboxed content
  frame stay in force regardless.

Tests: `packages/import-pptx/test/hostile.test.ts` (ZIP bomb, overlapping entries, billion laughs, XXE, path
traversal, encrypted and legacy CFB files, `.pptm` with a 40 MB `vbaProject.bin`, giant image dimensions, 10 000
slides, deeply nested groups, truncated XML, external relationships, malformed UTF-8, hostile text, size caps,
random corruption, worker timeout).

## Phase 2 (not built)

An MCP upload-ticket tool so an agent can import a `.pptx` the owner hands it and then restyle the converted deck
(hybrid: deterministic backbone, agent polish). See ADR-0019.
