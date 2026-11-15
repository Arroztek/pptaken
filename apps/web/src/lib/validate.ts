// SPDX-License-Identifier: AGPL-3.0-or-later
// Tiny hand-written response guards. Zod would add ~13 KB gzip to every page for a dozen shapes.
// Unknown extra fields are allowed (the server may add fields); missing or mistyped ones are not.

export class ShapeError extends Error {
  constructor(
    readonly path: string,
    expected: string,
  ) {
    super(`Unexpected response shape at ${path}: expected ${expected}`);
    this.name = "ShapeError";
  }
}

export type Guard<T> = (value: unknown, path: string) => T;
export type Infer<G> = G extends Guard<infer T> ? T : never;

export const str: Guard<string> = (v, p) => {
  if (typeof v !== "string") throw new ShapeError(p, "string");
  return v;
};

export const bool: Guard<boolean> = (v, p) => {
  if (typeof v !== "boolean") throw new ShapeError(p, "boolean");
  return v;
};

/** A non-negative integer (counts, revisions). */
export const count: Guard<number> = (v, p) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw new ShapeError(p, "integer >= 0");
  return v;
};

/** An ISO-8601 timestamp that Date can parse. */
export const isoDate: Guard<string> = (v, p) => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v)))
    throw new ShapeError(p, "ISO-8601 date");
  return v;
};

export function oneOf<const T extends readonly string[]>(values: T): Guard<T[number]> {
  return (v, p) => {
    if (typeof v !== "string" || !values.includes(v)) {
      throw new ShapeError(p, values.map((x) => JSON.stringify(x)).join(" | "));
    }
    return v as T[number];
  };
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (v, p) => (v === null ? null : guard(v, p));
}

/** Accepts a missing field as null (forward and backward compatible optional fields). */
export function optionalNull<T>(guard: Guard<T>): Guard<T | null> {
  return (v, p) => (v === null || v === undefined ? null : guard(v, p));
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) throw new ShapeError(p, "array");
    return v.map((item, i) => guard(item, `${p}[${i}]`));
  };
}

type Shape = Record<string, Guard<unknown>>;
type FromShape<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

export function object<S extends Shape>(shape: S): Guard<FromShape<S>> {
  return (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(p, "object");
    const source = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const guard = shape[key] as Guard<unknown>;
      out[key] = guard(source[key], `${p}.${key}`);
    }
    return out as FromShape<S>;
  };
}

export function parse<T>(guard: Guard<T>, value: unknown): T {
  return guard(value, "$");
}
