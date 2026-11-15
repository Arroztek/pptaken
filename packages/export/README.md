# @pptaken/export

Portability of presentations (phase F3): the **single-file HTML export** and the **`.pptaken` archive** (export and
import), on top of a minimal ZIP writer and a hardened ZIP reader. Node only (uses `node:zlib` and `node:crypto`);
no runtime dependency outside the workspace. License: AGPL-3.0-or-later.

This package does no storage I/O and does not import `@pptaken/core`: `apps/server` composes it with the core's
`exportPresentation` / `importPresentation` use cases. HTTP contract: [`docs/spec/http-api.md`](../../docs/spec/http-api.md)
("Export and import").

```sh
pnpm --filter @pptaken/export build
pnpm --filter @pptaken/export test           # Vitest: ZIP reader/writer (hostile archives, fuzz), archive, HTML
pnpm --filter @pptaken/export test:browser   # builds, then opens exported files from file:// in Chromium, Firefox, WebKit
```

## API

| Function | |
|---|---|
| `exportHtml({ deck, assets?, includeNotes?, fonts?, counter?, generator? })` | `{ html, filename, bytes, includesNotes, embeddedFonts, warnings }`. `deck` must be the stored (sanitized) deck; `assets` is a `Map<sha256, { mediaType, bytes }>`; `fonts` are bundled WOFF2 faces (only the families the deck uses are embedded). Warnings: `MISSING_ASSET`, `UNSUPPORTED_ASSET`, `FONT_SKIPPED`, `LARGE_FILE` (above 25 MB). |
| `writeArchive({ deck, assets, includeNotes = true, generator, exportedAt? })` | `{ bytes, filename, manifest }`. Verifies every asset's SHA-256. |
| `readArchive(bytes, limits?)` | `{ manifest, deck: unknown, assets }` or `ArchiveError` (`code` + safe English message). The deck and the assets are still untrusted: pass them to the core's `importPresentation`. |
| `writeZip(entries)` / `readZip(bytes, limits)` | The ZIP layer (`ZipError`). |
| `exportFilenames(title, ext)`, `slugify`, `unicodeStem` | Safe file names (ASCII slug and a Unicode name for RFC 6266 `filename*`). |

## The HTML file

- An outer trusted page (black, no chrome) with an **inline classic shell** and the deck in
  `<iframe sandbox="allow-scripts" srcdoc="…">` built by `@pptaken/player`'s `buildDeckDocument` (public API only).
- `asset:<hex>` references are rewritten to `data:` URIs with the player's **exact-token** rules (a whole
  `src`/`href` value or a whole `url()` argument; unique hash prefixes resolve like in the core); text that merely
  contains `asset:` is untouched. Fonts are `@font-face` rules with `data:font/woff2` sources.
- Security parity with the content route: a CSP `<meta>` in the deck document (`default-src 'none'; script-src
  'nonce-…'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none';
  base-uri 'none'; frame-src 'none'`) with a fresh nonce per export. The outer page carries the same policy (a
  srcdoc frame inherits it, so both apply; the outer one allows `frame-src 'self'` for the frame). `sandbox` cannot
  be set by `<meta>`: the iframe attribute gives the opaque origin. The shell validates every message
  (`event.source` is the frame, `event.origin === "null"`, exact shapes) and treats a second frame load as a fault.
- Speaker notes are **left out by default** (T7). With `includeNotes`, they are stored in the outer page only and
  shown with `n`.
- Keys: arrows, Space/Shift+Space, PageUp/PageDown, Enter/Backspace, Home/End, `b`/`.` black screen, `f` full
  screen, `n` notes (when included). URL hash `#/<slide>/<step>` (read on load, written 400 ms after moving).
  Counter `n / N` for 2 s after each move.
- Escaping: the srcdoc value escapes `&` and `"`; the shell configuration is JSON with `<`, `>`, `&`, U+2028 and
  U+2029 escaped; titles go through `escapeHtml`. Tested with hostile titles and content.

## The `.pptaken` archive (format version 1)

`manifest.json` (`format`, `formatVersion`, `exportedAt`, `generator`, `deck {title, lang}`, `notes`, `assets[]`),
`deck.json` (the stored envelope) and `assets/<sha256>`. The reader refuses: not-a-ZIP, ZIP64, spanned or encrypted
archives, unknown compression methods, unsafe names (absolute, drive letters, backslashes, `..`, empty segments,
control/bidi characters, non-UTF-8), duplicates (also case-insensitive), symbolic links and other non-regular files,
any entry outside the layout (checked before inflating), more than `maxAssets + 3` entries, entries or totals above
the limits (declared sizes, before inflating; inflation is capped at the declared size), deflate ratios above
200:1 for entries over 64 KiB, overlapping entries, local headers that disagree with the central directory, data
between the entries and the central directory, CRC-32 mismatches, a missing or malformed manifest, an unsupported
`formatVersion`, listed assets that are missing or unlisted ones that are present, and assets whose SHA-256 does not
match their name.

## Decisions and open questions

| Topic | Decision |
|---|---|
| Inline shell | A compact dedicated shell (`src/shell.ts`, one self-contained function embedded with `toString()`), not a bundle of `@pptaken/player/shell`: `file://` pages cannot import ES modules, the player shell is being extended concurrently (presenter, overview, print), and the exported file only needs presenting. Same keys, navigation semantics and message validation; the browser test compares its traversal with `@pptaken/player/navigation`. It accepts `ready` with or without `width`/`height` (the protocol grew those fields in F3). |
| Focus | A transparent layer over the frame keeps keyboard focus on the outer page (so `n` and `f` work directly, with user activation); keys forwarded by the runtime are still accepted. |
| Fonts | `font-display: block` (the fonts are local). Only families of the catalog that the deck names (theme fonts or CSS/HTML text) are embedded; a WOFF2 magic check guards the input. |
| No dependencies | ZIP is ~300 lines on `node:zlib` instead of a library: the reader's hostile-input rules are the point, and they are easier to audit than a general-purpose library's options. |
| Archive notes | Included by default (the owner's backup or transfer); `includeNotes: false` strips them. |
| Unknown manifest keys | Ignored (forward compatible within version 1); known keys are strictly typed. |
| Open | Video/audio assets, ZIP64 for archives above 4 GB (limits are far below), and streaming import (the archive is read in memory, at most `PPTAKEN_MAX_IMPORT_MB`). |
| Open | A future presenter-view export (notes + clock) in the HTML file; today notes are a simple panel. |
