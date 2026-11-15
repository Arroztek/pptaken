// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MessageKey } from "@pptaken/ui";
import type { webEn } from "./en";

type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
/** Same shape as the English panel dictionary, with any string values. */
export type WebDictionary = Widen<typeof webEn>;

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;
type Paths<T> = { [K in keyof T]: T[K] extends string ? K : Join<K, Paths<T[K]>> }[keyof T];

export type WebKey = Paths<WebDictionary>;
/** Any key the panel can translate: its own, or one from @pptaken/ui's copy bank. */
export type Key = WebKey | MessageKey;
