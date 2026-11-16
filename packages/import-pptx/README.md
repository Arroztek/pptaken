# @pptaken/import-pptx

Converts a PowerPoint `.pptx` (also `.pptm`, `.potx`, `.ppsx`) into a `pptaken.deck` envelope, its images and a
list of warnings. Phase 1 of the PowerPoint import: [docs/spec/pptx-import.md](../../docs/spec/pptx-import.md),
[ADR-0019](../../docs/adr/0019-powerpoint-import.md). License: AGPL-3.0-or-later (open core).

```sh
pnpm --filter @pptaken/import-pptx build
pnpm --filter @pptaken/import-pptx test   # converter features + hostile corpus (generated fixtures)
```

## API

| Export | |
|---|---|
| `convertPptx(bytes, { limits? })` | Pure and synchronous: `{ deck, assets, warnings }` or a `PptxError` (`NOT_PPTX`, `LEGACY_PPT`, `ENCRYPTED`, `INVALID_FILE`, `TOO_LARGE`). No file system, no network. |
| `@pptaken/import-pptx/isolated` → `convertPptxIsolated(bytes, { limits?, timeoutMs?, maxMemoryMb? })` | The same in a worker thread with a heap limit and a hard timeout (`TIMEOUT`). Servers use this one. |
| `DEFAULT_PPTX_LIMITS`, `PptxWarning`, `PptxAsset`, `mapFont`, `autoNumber` | Limits, types and helpers. |

The output is untrusted: `apps/server` passes it to the core's `importPptx`, which validates, sanitizes and checks
every image like any agent write.

## Layout

| File | |
|---|---|
| `src/package.ts` | OPC layer: allow-listed parts, relationships confined to the package, lazy reads over `@pptaken/zip`. |
| `src/xml.ts` | `saxes`-based parser: refuses DTDs, checks UTF-8, caps depth/elements/text, canonical namespace prefixes. |
| `src/convert.ts` | Slides, placeholders and inheritance, shapes, pictures, groups, tables, backgrounds, notes, steps, warnings. |
| `src/text.ts` | Paragraphs, runs, bullets and numbering with the style chain. |
| `src/color.ts`, `src/fonts.ts`, `src/geometry.ts` | Theme colours and fills, font mapping, preset and custom shapes. |
| `src/isolated.ts`, `src/worker.ts` | The worker-thread runner. |

## Dependencies

| Package | Version (pinned) | License | Why |
|---|---|---|---|
| `saxes` | 6.0.0 | ISC | Non-validating, streaming XML parser; no DTD processing, no network; one dependency (`xmlchars` 2.2.0, MIT). Neither has install scripts. |

Workspace: `@pptaken/zip` (ZIP reader), `@pptaken/core` (`sniffImage`, `sha256Hex`), `@pptaken/schema`.

Test fixtures are built in memory by `@pptaken/testing/pptx` (`buildPptx`): no binary files in the repository.
