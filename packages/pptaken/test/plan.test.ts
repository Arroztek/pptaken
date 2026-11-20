// SPDX-License-Identifier: AGPL-3.0-or-later
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type Flags, UsageError } from "../src/args.js";
import { planStart, publicUrlFor } from "../src/plan.js";

const none: Flags = { open: false, jsonLogs: false, clearPresenterPassword: false };
const linux = (env: Record<string, string | undefined> = {}) => ({
  platform: "linux" as const,
  env,
  homedir: "/home/ana",
});

describe("planStart", () => {
  it("uses the safe local defaults", () => {
    const plan = planStart(none, linux(), "/work");
    expect(plan).toMatchObject({
      dataDir: "/home/ana/.local/share/pptaken",
      host: "127.0.0.1",
      exposed: false,
      logLevel: "warn",
      startPort: 8080,
      explicitPort: false,
      publicUrl: undefined,
    });
    expect(plan.env).toMatchObject({
      PPTAKEN_DATA_DIR: "/home/ana/.local/share/pptaken",
      PPTAKEN_HOST: "127.0.0.1",
      PPTAKEN_LOG_LEVEL: "warn",
    });
    expect(publicUrlFor(plan, 8081)).toBe("http://localhost:8081");
  });

  it("environment variables are honoured and options win over them", () => {
    const env = {
      PPTAKEN_PORT: "9000",
      PPTAKEN_HOST: "0.0.0.0",
      PPTAKEN_LOG_LEVEL: "info",
      PPTAKEN_PUBLIC_URL: "https://env.example.com",
      PPTAKEN_DATA_DIR: "/srv/env",
    };
    const fromEnv = planStart(none, linux(env), "/work");
    expect(fromEnv).toMatchObject({
      startPort: 9000,
      explicitPort: true,
      host: "0.0.0.0",
      exposed: true,
      logLevel: "info",
      publicUrl: "https://env.example.com",
      dataDir: resolve("/srv/env"),
    });
    const fromFlags = planStart(
      {
        ...none,
        port: 9100,
        host: "127.0.0.1",
        logLevel: "error",
        publicUrl: "https://flag.example.com",
        dataDir: "/srv/flag",
      },
      linux(env),
      "/work",
    );
    expect(fromFlags).toMatchObject({
      startPort: 9100,
      explicitPort: true,
      host: "127.0.0.1",
      exposed: false,
      logLevel: "error",
      publicUrl: "https://flag.example.com",
      dataDir: resolve("/srv/flag"),
    });
  });

  it("an exposed host without a public URL lets the server derive the address per request", () => {
    const plan = planStart({ ...none, host: "0.0.0.0" }, linux(), "/work");
    expect(plan.exposed).toBe(true);
    expect(publicUrlFor(plan, 8080)).toBeUndefined();
  });

  it("--admin-password-file is resolved from the working folder and replaces an environment password", () => {
    const plan = planStart(
      { ...none, adminPasswordFile: "pw.txt", scripts: "owner" },
      linux({ PPTAKEN_ADMIN_PASSWORD: "from-env" }),
      "/work",
    );
    expect(plan.env.PPTAKEN_ADMIN_PASSWORD_FILE).toBe(resolve("/work", "pw.txt"));
    expect(plan.env.PPTAKEN_ADMIN_PASSWORD).toBeUndefined();
    expect(plan.env.PPTAKEN_SCRIPTS).toBe("owner");
  });

  it("explains invalid environment values", () => {
    expect(() => planStart(none, linux({ PPTAKEN_PORT: "eighty" }), "/w")).toThrow(UsageError);
    expect(() => planStart(none, linux({ PPTAKEN_PORT: "0" }), "/w")).toThrow(
      /between 1 and 65535/,
    );
    expect(() => planStart(none, linux({ PPTAKEN_LOG_LEVEL: "loud" }), "/w")).toThrow(
      /PPTAKEN_LOG_LEVEL must be/,
    );
    // An option replaces a bad variable.
    expect(
      planStart({ ...none, port: 8080 }, linux({ PPTAKEN_PORT: "eighty" }), "/w").startPort,
    ).toBe(8080);
  });
});
