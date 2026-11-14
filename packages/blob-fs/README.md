# @pptaken/blob-fs

The core's `BlobStore` port on the local file system. License: AGPL-3.0-or-later.

```ts
import { openFsBlobStore } from "@pptaken/blob-fs";
const blobs = await openFsBlobStore({ root: "/data/blobs", maxBlobBytes: 10 * 1024 * 1024 });
```

- **Content-addressed:** `sha256/<first two hex>/<64 hex>`. `put` of existing content writes nothing and
  refreshes the file's modification time (the orphan collector's grace period uses it as `createdAt`).
- **Safe keys:** every key is checked against `/^[0-9a-f]{64}$/` before a path is built; anything else is
  reported as absent (`get` → `null`, `has`/`delete` → `false`). No key can address a file outside the store.
- **Atomic writes:** data goes to `tmp/<random>.part` (opened with `wx`, mode `0600`), is `fsync`ed and renamed
  into place, so readers never see a partial blob. Temporary files older than `staleTempMs` (1 h) are removed at
  open. Directories are created with mode `0700` (POSIX; Windows ignores modes).
- **Streaming:** `putStream(asyncIterable, { maxBytes })` hashes while writing and aborts (deleting the temporary
  file) with a `LIMIT_EXCEEDED` `DomainError` as soon as the limit is passed; `getStream` reads in 64 KB chunks.
- **Limits:** the per-call `maxBytes` and the store-wide `maxBlobBytes` both apply (the smaller wins).

Tested with `runBlobStoreContract` from `@pptaken/testing` plus layout, permission, limit, sweep and core
integration tests.
