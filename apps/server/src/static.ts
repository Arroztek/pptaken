// SPDX-License-Identifier: AGPL-3.0-or-later
// The built web app (apps/web/dist), served only if the directory exists, with SPA fallback to index.html for
// non-API paths. Paths are resolved inside the root; anything that escapes it is a 404.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface StaticFile {
  body: Uint8Array;
  type: string;
  /** Hashed build assets can be cached forever; HTML must be revalidated. */
  immutable: boolean;
}

export class WebApp {
  readonly available: boolean;
  constructor(private readonly root: string) {
    this.available = existsSync(join(root, "index.html"));
  }

  private read(relative: string): StaticFile | null {
    const target = normalize(join(this.root, relative));
    if (
      target !== this.root &&
      !target.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep)
    ) {
      return null;
    }
    try {
      if (!statSync(target).isFile()) return null;
    } catch {
      return null;
    }
    const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    return { body: readFileSync(target), type, immutable: relative.startsWith("/assets/") };
  }

  /** The file for a URL path, or `index.html` (SPA fallback) for paths without a file extension. */
  resolve(pathname: string): StaticFile | null {
    if (!this.available) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    if (decoded !== "/" && !decoded.endsWith("/")) {
      const file = this.read(decoded);
      if (file !== null) return file;
      if (extname(decoded) !== "") return null;
    }
    return this.read("/index.html");
  }
}
