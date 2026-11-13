import type { en } from "./en";

/** Same shape as the English dictionary, with any string values. */
type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dictionary = Widen<typeof en>;

export type Locale = "en" | "es";

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;
type Paths<T> = { [K in keyof T]: T[K] extends string ? K : Join<K, Paths<T[K]>> }[keyof T];
/** Every dotted key, e.g. "welcome.title". */
export type MessageKey = Paths<Dictionary>;
