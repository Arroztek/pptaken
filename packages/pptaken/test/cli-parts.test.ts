// SPDX-License-Identifier: AGPL-3.0-or-later
// The small pieces of the CLI that need no server: output style, banner, browser opening, ports and the lock.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectStyle, formatBanner, isLoopbackHost } from "../src/banner.js";
import { LOCK_FILE, readLiveLock, writeLock } from "../src/lock.js";
import { humanLine } from "../src/logging.js";
import { openCommand } from "../src/open.js";
import { candidatePorts, isAnswering, isFree, PORT_ATTEMPTS } from "../src/ports.js";

const plain = { color: false, unicode: false };
const tty = { isTTY: true };

describe("output style", () => {
  it("respects NO_COLOR, non-terminals and TERM=dumb", () => {
    expect(detectStyle(tty, {}, "linux")).toEqual({ color: true, unicode: true });
    expect(detectStyle(tty, { NO_COLOR: "1" }, "linux").color).toBe(false);
    expect(detectStyle(tty, { NO_COLOR: "" }, "linux").color).toBe(true);
    expect(detectStyle({ isTTY: false }, {}, "linux")).toEqual({ color: false, unicode: false });
    expect(detectStyle(tty, { TERM: "dumb" }, "linux").color).toBe(false);
  });

  it("falls back to ASCII on the legacy Windows console only", () => {
    expect(detectStyle(tty, {}, "win32").unicode).toBe(false);
    expect(detectStyle(tty, { WT_SESSION: "x" }, "win32").unicode).toBe(true);
    expect(detectStyle(tty, { TERM_PROGRAM: "vscode" }, "win32").unicode).toBe(true);
  });
});

describe("banner", () => {
  const input = {
    version: "1.2.3",
    url: "http://localhost:8080",
    installCode: "ABCD-EFGH",
    dataDir: "/home/ana/.local/share/pptaken",
    host: "127.0.0.1",
    exposed: false,
    scripts: "off" as const,
  };

  it("says where to open it, the install code, the data folder, how to stop and how to connect Claude", () => {
    const text = formatBanner(input, plain);
    expect(text).toContain("PPTaken 1.2.3 is running.");
    expect(text).toContain("Open          http://localhost:8080");
    expect(text).toContain("Install code  ABCD-EFGH");
    expect(text).toContain("Data          /home/ana/.local/share/pptaken");
    expect(text).toContain("press Ctrl+C");
    expect(text).toContain("https://docs-pkn.arroz.dev/connect/overview/");
    expect(text).toContain("http://localhost:8080/mcp");
    expect(text).toMatch(/Claude Desktop and claude\.ai .* cannot reach/s);
    expect(text).not.toContain("WARNING");
    expect(text).toMatch(/^[\x20-\x7E\n]*$/);
  });

  it("shows no install code once installed, and warns when exposed", () => {
    const text = formatBanner(
      {
        ...input,
        installCode: null,
        exposed: true,
        host: "0.0.0.0",
        scripts: "owner",
        portNote: "Port 8080 was busy, so PPTaken uses 8081.",
      },
      plain,
    );
    expect(text).not.toContain("Install code");
    expect(text).toContain("Sign in");
    expect(text).toContain("WARNING  PPTaken listens on 0.0.0.0");
    expect(text).toContain("without encryption");
    expect(text).toContain("Interactive");
    expect(text).toContain("Port 8080 was busy");
  });

  it("uses colours and box drawing only when allowed", () => {
    expect(formatBanner(input, { color: true, unicode: true })).toMatch(/\u001b\[1m/);
    expect(formatBanner(input, { color: true, unicode: true })).toContain("─");
  });

  it("knows loopback hosts", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "app.localhost"]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe("logs", () => {
  it("formats a JSON record as one short human line", () => {
    const line = humanLine(
      JSON.stringify({
        time: "2026-11-19T10:11:12.000Z",
        level: "warn",
        msg: "sign-in failed",
        ip: "::1",
      }),
      plain,
    );
    expect(line).toBe("10:11:12 WARN  sign-in failed ip=::1");
  });
});

describe("--open", () => {
  it("never involves a shell and uses fixed programs", () => {
    expect(openCommand("http://localhost:8080", "win32", { SystemRoot: "C:\\Windows" })).toEqual({
      command: "C:\\Windows\\explorer.exe",
      args: ["http://localhost:8080"],
    });
    expect(openCommand("http://localhost:8080", "win32", { SystemRoot: "relative" })?.command).toBe(
      "C:\\Windows\\explorer.exe",
    );
    expect(openCommand("https://slides.example.com", "darwin", {})).toEqual({
      command: "/usr/bin/open",
      args: ["https://slides.example.com"],
    });
    expect(openCommand("http://127.0.0.1:9000/", "linux", {})?.command).toBe("xdg-open");
  });

  it("refuses anything that is not a plain http(s) origin", () => {
    for (const url of [
      'http://localhost:8080" & calc',
      "http://localhost:8080/?a=b",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://localhost:8080 --flag",
    ]) {
      expect(openCommand(url, "win32", {}), url).toBeNull();
    }
  });
});

describe("ports", () => {
  it("tries the next ports only when the port was not chosen", () => {
    expect(candidatePorts(8080, true)).toEqual([8080]);
    expect(candidatePorts(8080, false)).toHaveLength(PORT_ATTEMPTS);
    expect(candidatePorts(8080, false)[1]).toBe(8081);
    expect(candidatePorts(65535, false)).toEqual([65535]);
  });

  it("detects a port that is in use", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await isAnswering(port)).toBe(true);
      expect(await isFree("127.0.0.1", port)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(await isFree("127.0.0.1", port)).toBe(true);
  });
});

describe("lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pptaken-lock-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a live process, ignores a dead one and its own", () => {
    writeFileSync(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4242, url: "http://localhost:1", startedAt: "" }),
    );
    expect(readLiveLock(dir, () => true)?.url).toBe("http://localhost:1");
    expect(readLiveLock(dir, () => false)).toBeNull();
    const release = writeLock(dir, "http://localhost:2");
    expect(readLiveLock(dir, () => true)).toBeNull();
    release();
    expect(readLiveLock(dir, () => true)).toBeNull();
  });
});
