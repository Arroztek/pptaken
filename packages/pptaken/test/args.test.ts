// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseArgs, USAGE, UsageError } from "../src/args.js";

const fails = (argv: string[], message: RegExp) => {
  expect(() => parseArgs(argv)).toThrow(UsageError);
  expect(() => parseArgs(argv)).toThrow(message);
};

describe("parseArgs", () => {
  it("starts by default with safe empty flags", () => {
    expect(parseArgs([])).toEqual({
      command: "start",
      flags: { open: false, jsonLogs: false, clearPresenterPassword: false },
      positionals: [],
    });
  });

  it("accepts start and its alias serve", () => {
    expect(parseArgs(["start"]).command).toBe("start");
    expect(parseArgs(["serve"]).command).toBe("start");
  });

  it("reads every start option in both spellings", () => {
    const { flags } = parseArgs([
      "start",
      "--port",
      "9000",
      "--host=0.0.0.0",
      "--data-dir",
      "./d",
      "--public-url",
      "https://slides.example.com",
      "--scripts=OWNER",
      "--admin-password-file",
      "pw.txt",
      "--open",
      "--json-logs",
      "--log-level",
      "debug",
    ]);
    expect(flags).toEqual({
      port: 9000,
      host: "0.0.0.0",
      dataDir: "./d",
      publicUrl: "https://slides.example.com",
      scripts: "owner",
      adminPasswordFile: "pw.txt",
      open: true,
      jsonLogs: true,
      logLevel: "debug",
      clearPresenterPassword: false,
    });
  });

  it("strips brackets from an IPv6 host", () => {
    expect(parseArgs(["--host", "[::1]"]).flags.host).toBe("::1");
  });

  it("help and version win over everything else", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["backup", "--help"]).command).toBe("help");
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-v"]).command).toBe("version");
    expect(parseArgs(["version"]).command).toBe("version");
    expect(parseArgs(["help"]).command).toBe("help");
  });

  it("backup needs exactly one folder and accepts --data-dir", () => {
    expect(parseArgs(["backup", "./b", "--data-dir", "./d"])).toMatchObject({
      command: "backup",
      positionals: ["./b"],
      flags: { dataDir: "./d" },
    });
    fails(["backup"], /exactly one new folder/);
    fails(["backup", "a", "b"], /exactly one new folder/);
  });

  it("reset-password takes --clear-presenter-password", () => {
    expect(
      parseArgs(["reset-password", "--clear-presenter-password"]).flags.clearPresenterPassword,
    ).toBe(true);
    fails(["start", "--clear-presenter-password"], /cannot be used with "start"/);
  });

  it("refuses start-only options on maintenance commands", () => {
    fails(["backup", "./b", "--port", "8080"], /--port cannot be used with "backup"/);
    fails(["reset-password", "--open"], /--open cannot be used/);
  });

  it("explains invalid values in plain words", () => {
    fails(["--port", "0"], /--port must be a number between 1 and 65535/);
    fails(["--port", "70000"], /between 1 and 65535/);
    fails(["--port", "80a"], /between 1 and 65535/);
    fails(["--port"], /--port needs a value, for example --port 8080/);
    fails(["--port", "--open"], /--port needs a value/);
    fails(["--port="], /--port needs a value/);
    fails(["--host", "bad host!"], /--host must be an IP address/);
    fails(["--public-url", "slides.example.com"], /--public-url must be a full address/);
    fails(["--public-url", "ftp://x.example"], /must start with https:\/\//);
    fails(["--scripts", "on"], /--scripts must be owner or off/);
    fails(["--log-level", "loud"], /--log-level must be debug or info or warn or error/);
    fails(["--data-dir", " "], /--data-dir needs a folder path/);
    fails(["--open=yes"], /--open does not take a value/);
  });

  it("refuses unknown options, commands and arguments", () => {
    fails(["--bogus"], /Unknown option "--bogus"/);
    fails(["-x"], /Unknown option "-x"/);
    fails(["launch"], /Unknown command "launch"/);
    fails(["start", "extra"], /Unexpected argument "extra"/);
  });

  it("the usage text documents every option and the exit codes", () => {
    for (const option of [
      "--port",
      "--host",
      "--data-dir",
      "--public-url",
      "--scripts",
      "--admin-password-file",
      "--open",
      "--log-level",
      "--json-logs",
      "--clear-presenter-password",
    ]) {
      expect(USAGE).toContain(option);
    }
    expect(USAGE).toMatch(/Exit codes: 0 .* 5 Node\.js too old/s);
  });
});
