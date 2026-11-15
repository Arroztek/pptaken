// SPDX-License-Identifier: AGPL-3.0-or-later
import { en as uiEn, es as uiEs } from "@pptaken/ui";
import { describe, expect, it } from "vitest";
import { ApiError, type ErrorCode } from "./api";
import { errorMessage } from "./errors";
import { initialLocale } from "./storage";
import { createWebTranslator, keysOf, placeholders, readKey, webDictionaries } from "./translate";

const { en, es } = webDictionaries;

describe("panel dictionaries", () => {
  it("have the same keys in English and Spanish", () => {
    expect(keysOf(es).sort()).toEqual(keysOf(en).sort());
  });

  it("have no empty strings and matching placeholders", () => {
    for (const key of keysOf(en)) {
      const a = readKey(en, key) ?? "";
      const b = readKey(es, key) ?? "";
      expect(a.trim(), key).not.toBe("");
      expect(b.trim(), key).not.toBe("");
      expect(placeholders(b), key).toEqual(placeholders(a));
    }
  });

  it("do not shadow keys of the ui copy bank", () => {
    const ui = new Set(keysOf(uiEn));
    expect(keysOf(en).filter((k) => ui.has(k))).toEqual([]);
  });

  it("follow the voice rules: no exclamation marks, no emoji", () => {
    for (const dict of [en, es]) {
      for (const key of keysOf(dict)) {
        const text = readKey(dict, key) ?? "";
        expect(text, key).not.toMatch(/!/);
        expect(text, key).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("ui dictionaries stay in sync too", () => {
    expect(keysOf(uiEs).sort()).toEqual(keysOf(uiEn).sort());
  });
});

describe("translator", () => {
  it("reads panel keys first, then ui keys, with placeholders", () => {
    const tEs = createWebTranslator("es");
    expect(tEs("nav.decks")).toBe("Presentaciones");
    expect(tEs("welcome.title")).toBe("Conecta tu agente.");
    expect(tEs("errors.rateLimited", { n: 30 })).toBe(
      "Demasiados intentos. Vuelve a intentarlo en 30 segundos.",
    );
    expect(createWebTranslator("en")("welcome.step", { current: 1, total: 2 })).toBe("Step 1 of 2");
  });

  it("translates every API error code in both languages", () => {
    const codes: ErrorCode[] = [
      "VALIDATION_ERROR",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "SETUP_REQUIRED",
      "ALREADY_SETUP",
      "RATE_LIMITED",
      "INTERNAL",
      "NETWORK",
      "BAD_RESPONSE",
      "UNKNOWN",
    ];
    for (const locale of ["en", "es"] as const) {
      const t = createWebTranslator(locale);
      for (const code of codes) {
        const message = errorMessage(new ApiError(code, 0, "server text"), t);
        expect(message).not.toMatch(/^errors\./);
        expect(message).not.toBe("server text");
      }
    }
    const t = createWebTranslator("en");
    expect(errorMessage(new ApiError("UNAUTHENTICATED", 401, ""), t, "login")).toBe(
      "That password is not right. Try again.",
    );
    expect(errorMessage(new ApiError("FORBIDDEN", 403, ""), t, "setup")).toMatch(/install code/);
    expect(errorMessage(new ApiError("RATE_LIMITED", 429, "", null, 12), t)).toMatch(/12 seconds/);
    expect(errorMessage(new Error("boom"), t)).toMatch(/unexpected/);
  });
});

describe("initialLocale", () => {
  it("prefers a valid stored choice, then the browser languages", () => {
    expect(initialLocale("es", ["en-US"])).toBe("es");
    expect(initialLocale("fr", ["es-MX", "en"])).toBe("es");
    expect(initialLocale(null, ["de-DE"])).toBe("en");
  });
});
