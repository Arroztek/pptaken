import { getContext, setContext } from "svelte";
import { en } from "./en";
import { es } from "./es";
import type { Dictionary, Locale, MessageKey } from "./types";

export type { Dictionary, Locale, MessageKey };
export { en, es };

export const dictionaries: Record<Locale, Dictionary> = { en, es };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Pick the best supported locale from a list such as navigator.languages. English is the fallback. */
export function pickLocale(preferred: readonly string[] = []): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return "en";
}

/** Create a translate function. Placeholders use {name}. Missing keys fall back to English, then to the key. */
export function createTranslator(locale: Locale = "en"): Translate {
  const dict = dictionaries[locale];
  return (key, vars) => {
    const read = (d: Dictionary) =>
      key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], d);
    const raw = read(dict) ?? read(en);
    const text = typeof raw === "string" ? raw : key;
    return vars
      ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
      : text;
  };
}

const KEY = Symbol("pptaken.i18n");

/** Call once near the root of an app (e.g. in App.svelte) to set the language for every component. */
export function setI18n(locale: Locale): Translate {
  const t = createTranslator(locale);
  setContext(KEY, t);
  return t;
}

/** Read the translator from context. Components work without setI18n: they default to English. */
export function getI18n(): Translate {
  return getContext<Translate | undefined>(KEY) ?? createTranslator("en");
}
