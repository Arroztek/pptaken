# @pptaken/zip

The minimal ZIP writer and the hardened ZIP reader shared by the `.pkn` archive ([`@pptaken/export`](../export))
and the PowerPoint importer ([`@pptaken/import-pptx`](../import-pptx)). Node's `zlib` only. License:
AGPL-3.0-or-later.

| Function | |
|---|---|
| `writeZip(entries, { date? })` | Stored or deflated entries, UTF-8 names, regular-file permissions. |
| `openZip(bytes, limits)` | Validates the whole archive without inflating anything and returns an index; included entries are inflated (bounded by their declared size) and CRC-checked when `read(name)` is called. Entries outside `limits.include` are validated structurally but never inflated nor counted in the size limits. |
| `readZip(bytes, limits)` | `openZip` + read every entry. |
| `unsafeNameReason`, `printable`, `crc32` | Helpers. |

Refused (`ZipError` with a stable `code`): not a ZIP, ZIP64, spanned archives, encryption, unknown compression
methods, unsafe names (traversal, absolute, drive letters, backslashes, control/zero-width/bidi characters),
duplicates (also after Unicode and case folding), symbolic links and special files, central directory entries
that do not match their local headers, overlapping entries, too many entries, oversized entries or totals, and
compression ratios above the limit (checked on declared sizes before inflating). Hostile-archive tests live in
`@pptaken/export` (`test/zip.test.ts`, which exercises this package through its re-export) and here
(`test/open.test.ts`).
