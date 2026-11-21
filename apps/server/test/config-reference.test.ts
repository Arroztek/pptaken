// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the documented variable table (src/config-vars.ts) in step with what loadConfig() really does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { CONFIG_VARS } from "../src/config-vars.js";

const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");

describe("configuration reference", () => {
  it("lists exactly the PPTAKEN_* variables that config.ts reads", () => {
    const read = new Set(source.match(/PPTAKEN_[A-Z0-9_]+/g));
    const listed = new Set(CONFIG_VARS.map((v) => v.name));
    expect([...read].sort()).toEqual([...listed].sort());
    expect(listed.size).toBe(CONFIG_VARS.length);
  });

  it("describes every variable", () => {
    for (const v of CONFIG_VARS) {
      expect(v.description.length, v.name).toBeGreaterThan(20);
      expect(v.example, v.name).not.toBe("");
      expect(v.since, v.name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("starts with the defaults it documents", () => {
    const config = loadConfig({});
    expect(String(config.port)).toBe(CONFIG_VARS.find((v) => v.name === "PPTAKEN_PORT")?.default);
    expect(config.host).toBe(CONFIG_VARS.find((v) => v.name === "PPTAKEN_HOST")?.default);
    expect(config.scripts).toBe(CONFIG_VARS.find((v) => v.name === "PPTAKEN_SCRIPTS")?.default);
    expect(config.logLevel).toBe(CONFIG_VARS.find((v) => v.name === "PPTAKEN_LOG_LEVEL")?.default);
    expect(config.vendorFetch).toBe(true);
    expect(config.publicLinks).toBe(
      CONFIG_VARS.find((v) => v.name === "PPTAKEN_PUBLIC_LINKS")?.default === "on",
    );
    expect(config.trustProxy).toBe(false);
    expect(config.maxApiBodyBytes).toBe(64 * 1024);
    expect(config.maxMcpBodyBytes).toBe(4 * 1024 * 1024);
    expect(config.maxImportBytes).toBe(100 * 1024 * 1024);
  });

  it("enforces the documented bounds of integer variables", () => {
    for (const v of CONFIG_VARS.filter((x) => x.type === "integer")) {
      expect(() => loadConfig({ [v.name]: String(v.min) }), v.name).not.toThrow();
      expect(() => loadConfig({ [v.name]: String(v.max) }), v.name).not.toThrow();
      expect(() => loadConfig({ [v.name]: String((v.max ?? 0) + 1) }), v.name).toThrow(ConfigError);
      if ((v.min ?? 0) > 0) {
        expect(() => loadConfig({ [v.name]: String((v.min ?? 0) - 1) }), v.name).toThrow(
          ConfigError,
        );
      }
    }
  });

  it("accepts the documented values of enum variables and rejects others", () => {
    for (const v of CONFIG_VARS.filter((x) => x.type === "enum")) {
      for (const value of v.allowed ?? []) {
        expect(() => loadConfig({ [v.name]: value }), `${v.name}=${value}`).not.toThrow();
      }
      expect(() => loadConfig({ [v.name]: "nonsense" }), v.name).toThrow(ConfigError);
    }
  });
});
