// SPDX-License-Identifier: AGPL-3.0-or-later
// The Open Packaging Conventions layer: which parts of a .pptx are ever read (an allow-list), relationship
// resolution confined to the package, and a cached part reader with size budgets.
import { type OpenedZip, openZip, ZipError } from "@pptaken/zip";
import { PptxError } from "./errors.js";
import { attr, children, parseXml, type XmlElement, XmlError } from "./xml.js";

/** Limits of the package layer. */
export interface PackageLimits {
  /** Entries in the ZIP (skipped ones included). */
  maxEntries: number;
  /** Sum of the declared uncompressed sizes of the parts that may be read. */
  maxTotalBytes: number;
  /** Largest XML part. */
  maxXmlPartBytes: number;
  /** Ratio uncompressed / compressed of a deflated part (ZIP bomb guard). */
  maxRatio: number;
}

/**
 * Parts that may ever be inflated. Everything else (macros `vbaProject.bin`, `embeddings/`, `activeX/`, OLE
 * objects, embedded fonts, charts, diagrams, comments, custom XML, thumbnails) is validated structurally by the
 * ZIP reader but never decompressed or parsed.
 */
const ALLOWED_PART =
  /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/core\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/(?:slides|slideLayouts|slideMasters|notesSlides)\/(?:_rels\/)?[A-Za-z0-9_-]{1,64}\.xml(?:\.rels)?|ppt\/theme\/(?:_rels\/)?[A-Za-z0-9_-]{1,64}\.xml(?:\.rels)?|ppt\/media\/[A-Za-z0-9_.-]{1,128})$/;

export function isAllowedPart(name: string): boolean {
  return ALLOWED_PART.test(name);
}

export interface Relationship {
  id: string;
  type: string;
  /** Resolved part name inside the package, or null for an external or unresolvable target. */
  target: string | null;
  external: boolean;
}

/** Short relationship type (the last path segment of the type URI), e.g. `slide`, `image`, `notesSlide`. */
export function relKind(type: string): string {
  const i = type.lastIndexOf("/");
  return i < 0 ? type : type.slice(i + 1);
}

/** Resolves a relative target against the source part's folder; null if it leaves the package. */
export function resolveTarget(sourcePart: string, target: string): string | null {
  if (target.length === 0 || target.length > 512) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const base = target.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  const segments = [...base];
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\\") || decoded === "..") return null;
    segments.push(decoded);
  }
  return segments.length === 0 ? null : segments.join("/");
}

function relsPartOf(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** The opened package: cached XML parts, relationships and media bytes. */
export class PptxPackage {
  private readonly zip: OpenedZip;
  private readonly xmlCache = new Map<string, XmlElement | null>();
  private readonly relsCache = new Map<string, Relationship[]>();
  private xmlBytesRead = 0;

  constructor(
    bytes: Uint8Array,
    private readonly limits: PackageLimits,
  ) {
    try {
      this.zip = openZip(bytes, {
        maxEntries: limits.maxEntries,
        maxTotalBytes: limits.maxTotalBytes,
        maxEntryBytes: (name) =>
          name.startsWith("ppt/media/") ? Number.MAX_SAFE_INTEGER : limits.maxXmlPartBytes,
        maxRatio: limits.maxRatio,
        include: isAllowedPart,
      });
    } catch (error) {
      if (error instanceof ZipError) {
        if (error.code === "TOO_MANY_ENTRIES" || error.code === "TOO_LARGE") {
          throw new PptxError("TOO_LARGE", `The file is too large to import: ${error.message}`);
        }
        throw new PptxError(
          "INVALID_FILE",
          `The file is not a valid .pptx package: ${error.message}`,
        );
      }
      throw error;
    }
  }

  /** Names of the parts that are present but never read. */
  get skippedParts(): readonly string[] {
    return this.zip.skipped;
  }

  has(part: string): boolean {
    return this.zip.has(part);
  }

  size(part: string): number | null {
    return this.zip.size(part);
  }

  /** Raw bytes of an allowed part (media are inflated only when small enough). */
  bytes(part: string): Uint8Array | null {
    try {
      return this.zip.read(part);
    } catch (error) {
      if (error instanceof ZipError) {
        throw new PptxError("INVALID_FILE", `The file is damaged: ${error.message}`);
      }
      throw error;
    }
  }

  /** Parsed XML of a part, or null when absent. A malformed part fails the whole import. */
  xml(part: string): XmlElement | null {
    const cached = this.xmlCache.get(part);
    if (cached !== undefined) return cached;
    const data = this.bytes(part);
    if (data === null) {
      this.xmlCache.set(part, null);
      return null;
    }
    this.xmlBytesRead += data.length;
    if (this.xmlBytesRead > this.limits.maxTotalBytes) {
      throw new PptxError("TOO_LARGE", "The presentation's XML is too large to import");
    }
    let root: XmlElement;
    try {
      root = parseXml(data);
    } catch (error) {
      if (error instanceof XmlError) {
        throw new PptxError("INVALID_FILE", `The part ${part.slice(0, 80)} ${error.message}`);
      }
      throw error;
    }
    this.xmlCache.set(part, root);
    return root;
  }

  /** Relationships of a part. External targets are recorded but never resolved or fetched. */
  rels(part: string): Relationship[] {
    const cached = this.relsCache.get(part);
    if (cached !== undefined) return cached;
    const root = this.xml(relsPartOf(part));
    const out: Relationship[] = [];
    for (const rel of children(root ?? undefined, "rel:Relationship")) {
      const id = attr(rel, "Id");
      const type = attr(rel, "Type") ?? "";
      const target = attr(rel, "Target") ?? "";
      if (id === undefined) continue;
      const external = (attr(rel, "TargetMode") ?? "").toLowerCase() === "external";
      out.push({
        id,
        type,
        external,
        target: external ? null : resolveTarget(part === "" ? "" : part, target),
      });
    }
    this.relsCache.set(part, out);
    return out;
  }

  rel(part: string, id: string | undefined): Relationship | undefined {
    if (id === undefined) return undefined;
    return this.rels(part).find((r) => r.id === id);
  }

  /** First relationship of a kind (`slideLayout`, `slideMaster`, `theme`, `notesSlide`...). */
  relOfKind(part: string, kind: string): Relationship | undefined {
    return this.rels(part).find((r) => relKind(r.type) === kind && !r.external);
  }
}
