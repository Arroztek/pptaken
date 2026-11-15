// SPDX-License-Identifier: AGPL-3.0-or-later
// One translate function over two dictionaries: the panel's own (src/i18n) first, then @pptaken/ui's.
import { createTranslator, type Locale, type MessageKey } from "@pptaken/ui";
import { webEn } from "../i18n/en";
import { webEs } from "../i18n/es";
import type { Key, WebDictionary } from "../i18n/types";

export type { Key, Locale };
export type Vars = Record<string, string | number>;
export type T = (key: Key, vars?: Vars) => string;

export const webDictionaries: Record<Locale, WebDictionary> = { en: webEn, es: webEs };

function lookup(dict: unknown, key: string): string | undefined {
  const value = key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);
  return typeof value === "string" ? value : undefined;
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function createWebTranslator(locale: Locale): T {
  const ui = createTranslator(locale);
  const own = webDictionaries[locale];
  return (key, vars) => {
    const text = lookup(own, key) ?? lookup(webEn, key);
    return text === undefined ? ui(key as MessageKey, vars) : interpolate(text, vars);
  };
}

/** Placeholders ({name}) used by a string, sorted: en and es must use the same ones. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
}

/** Every dotted key of a nested dictionary. */
export function keysOf(dict: unknown, prefix = ""): string[] {
  if (typeof dict !== "object" || dict === null) return [];
  return Object.entries(dict).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : keysOf(v, `${prefix}${k}.`),
  );
}

export function readKey(dict: unknown, key: string): string | undefined {
  return lookup(dict, key);
}
