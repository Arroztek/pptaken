// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCsrf,
  checkPasswordPolicy,
  constantTimeEqual,
  deriveKey,
  generateApiToken,
  generateInstallCode,
  hashPassword,
  isCommonPassword,
  loadOrCreateSecretKey,
  needsRehash,
  normalizeInstallCode,
  parseSecretKey,
  REDACTED,
  redact,
  redactString,
  SignInThrottle,
  signToken,
  TokenBucketLimiter,
  verifyPassword,
  verifyToken,
} from "../src/index.js";

const FAST = { ln: 10, r: 8, p: 1 };

class FakeClock {
  t = 0;
  now() {
    return this.t;
  }
}

describe("password hashing (scrypt)", () => {
  it("hashes with a per-user salt and verifies", async () => {
    const a = await hashPassword("correct horse battery", FAST);
    const b = await hashPassword("correct horse battery", FAST);
    expect(a).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("never verifies against malformed or out-of-range hashes", async () => {
    const good = await hashPassword("pw pw pw pw pw", FAST);
    for (const stored of [
      "",
      "plain",
      good.replace("ln=10", "ln=40"),
      good.replace("ln=10", "ln=5"),
      good.replace(/\$[^$]+$/, "$AAAA"),
    ]) {
      expect(await verifyPassword("pw pw pw pw pw", stored)).toBe(false);
    }
  });

  it("uses OWASP parameters by default and flags weaker hashes for rehash", async () => {
    const weak = await hashPassword("x".repeat(12), FAST);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
  }, 20_000);
});

describe("password policy", () => {
  it("requires 12 characters, rejects common and repetitive passwords", () => {
    expect(checkPasswordPolicy("short").problem).toBe("too_short");
    expect(checkPasswordPolicy(undefined).ok).toBe(false);
    expect(checkPasswordPolicy("x".repeat(2000)).problem).toBe("too_long");
    expect(checkPasswordPolicy("zzzzzzzzzzzzzz").problem).toBe("repetitive");
    for (const p of [
      "password1234",
      "Password123!",
      "qwertyuiop123",
      "iloveyou2024",
      "football12345",
      "passwordpassword",
      "123456789012",
      "1q2w3e4r5t6y",
      "Contrasena123",
    ]) {
      expect(isCommonPassword(p), p).toBe(true);
      expect(checkPasswordPolicy(p).problem, p).toBe("common");
    }
    expect(checkPasswordPolicy("violet otter climbs 7 dunes").ok).toBe(true);
    // Counted in characters, not UTF-16 units.
    expect(checkPasswordPolicy("ñandú🙂ñandú🙂ab").ok).toBe(true);
  });
});

describe("token formats", () => {
  it("API tokens are ppt_ + 43 base64url characters (256 bits)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateApiToken();
      expect(t).toMatch(/^ppt_[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("install codes use an unambiguous alphabet and normalize", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInstallCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(code).not.toMatch(/[01ILOU]/);
    }
    expect(normalizeInstallCode(" 7k2m-9qxd ")).toBe("7K2M9QXD");
    expect(normalizeInstallCode("7K2M9QX")).toBeNull();
    expect(normalizeInstallCode("7K2M-9QX0")).toBeNull();
    expect(normalizeInstallCode(null)).toBeNull();
  });

  it("signed tokens bind purpose, subject and expiry", () => {
    const key = deriveKey(Buffer.alloc(32, 7), "content-token");
    const other = deriveKey(Buffer.alloc(32, 7), "install-code");
    expect(key.equals(other)).toBe(false);
    const t = signToken(key, { purpose: "doc", subject: "01ABC:3", exp: 1000 });
    expect(verifyToken(key, t, { purpose: "doc", subject: "01ABC:3", now: 999 })).toBe(true);
    expect(verifyToken(key, t, { purpose: "doc", subject: "01ABC:3", now: 1000 })).toBe(false);
    expect(verifyToken(key, t, { purpose: "doc", subject: "01ABC:4", now: 0 })).toBe(false);
    expect(verifyToken(key, t, { purpose: "asset", subject: "01ABC:3", now: 0 })).toBe(false);
    expect(verifyToken(other, t, { purpose: "doc", subject: "01ABC:3", now: 0 })).toBe(false);
    const [payload, sig] = t.split(".") as [string, string];
    const forged = Buffer.from("v1|doc|01ABC:3|99999999", "utf8").toString("base64url");
    expect(
      verifyToken(key, `${forged}.${sig}`, { purpose: "doc", subject: "01ABC:3", now: 0 }),
    ).toBe(false);
    for (const bad of [undefined, "", "a.b.c", `${payload}.`, `.${sig}`, `${payload}.${sig}x`]) {
      expect(verifyToken(key, bad, { purpose: "doc", subject: "01ABC:3", now: 0 })).toBe(false);
    }
    expect(() => signToken(key, { purpose: "a|b", subject: "x", exp: 1 })).toThrow();
  });

  it("constant-time equality", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("rate limiting (fake clock)", () => {
  it("token bucket allows a burst then refills continuously", () => {
    const clock = new FakeClock();
    const rl = new TokenBucketLimiter({ capacity: 3, refill: 3, intervalMs: 60_000, clock });
    expect([1, 2, 3].map(() => rl.take("a").ok)).toEqual([true, true, true]);
    const denied = rl.take("a");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBe(20_000);
    expect(rl.take("b").ok).toBe(true); // keys are independent
    clock.t += 20_000;
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
  });

  it("bounds memory", () => {
    const clock = new FakeClock();
    const rl = new TokenBucketLimiter({
      capacity: 1,
      refill: 1,
      intervalMs: 1000,
      clock,
      maxKeys: 100,
    });
    for (let i = 0; i < 1000; i++) rl.take(`ip${i}`);
    expect(rl.size).toBeLessThanOrEqual(100);
  });

  it("sign-in: 5 per minute per IP with an increasing delay after failures", () => {
    const clock = new FakeClock();
    const t = new SignInThrottle({ clock });
    // Successes do not trigger the delay, the bucket still caps attempts.
    for (let i = 0; i < 5; i++) expect(t.check("1.1.1.1").ok).toBe(true);
    expect(t.check("1.1.1.1").ok).toBe(false);
    expect(t.check("2.2.2.2").ok).toBe(true);

    clock.t += 60_000;
    const ip = "3.3.3.3";
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock.t += 20 * 60_000; // enough to refill the bucket and pass any delay
      expect(t.check(ip).ok).toBe(true);
      t.fail(ip);
      const next = t.check(ip);
      delays.push(next.ok ? 0 : next.retryAfterMs);
    }
    // forgetAfter is one hour; 20 minutes between failures keeps counting.
    expect(delays).toEqual([0, 0, 1000, 2000, 4000, 8000]);
    t.succeed(ip);
    expect(t.check(ip).ok).toBe(true);
    expect(t.delayFor(100)).toBe(15 * 60_000);
  });

  it("sign-in: a global failure budget pauses every IP", () => {
    const clock = new FakeClock();
    const t = new SignInThrottle({ clock, globalFailuresPer10Min: 3, delayAfterFailures: 100 });
    for (let i = 0; i < 3; i++) {
      expect(t.check(`10.0.0.${i}`).ok).toBe(true);
      t.fail(`10.0.0.${i}`);
    }
    const blocked = t.check("192.168.1.1");
    expect(blocked.ok).toBe(false);
    clock.t += 200_000;
    expect(t.check("192.168.1.1").ok).toBe(true);
  });
});

describe("CSRF", () => {
  const allowed = ["https://slides.example.com"];
  const check = (method: string, headers: Record<string, string>) =>
    checkCsrf({ method, header: (n) => headers[n.toLowerCase()] ?? null, allowedOrigins: allowed });

  it("passes safe methods and same-origin requests with the header", () => {
    expect(check("GET", {}).ok).toBe(true);
    expect(check("POST", { "x-pptaken-csrf": "1", origin: "https://slides.example.com" }).ok).toBe(
      true,
    );
    expect(
      check("DELETE", { "x-pptaken-csrf": "1", referer: "https://slides.example.com/decks?x=1" })
        .ok,
    ).toBe(true);
  });

  it("fails without the header, with another or opaque origin, or with no origin at all", () => {
    expect(check("POST", { origin: "https://slides.example.com" })).toEqual({
      ok: false,
      reason: "missing_header",
    });
    expect(check("POST", { "x-pptaken-csrf": "0", origin: "https://slides.example.com" }).ok).toBe(
      false,
    );
    for (const origin of [
      "https://evil.example",
      "http://slides.example.com",
      "https://slides.example.com:8443",
      "null",
      "https://slides.example.com.evil.example",
    ]) {
      expect(check("POST", { "x-pptaken-csrf": "1", origin }).ok, origin).toBe(false);
    }
    expect(check("PUT", { "x-pptaken-csrf": "1" }).ok).toBe(false);
    // Origin wins over Referer.
    expect(
      check("POST", {
        "x-pptaken-csrf": "1",
        origin: "https://evil.example",
        referer: "https://slides.example.com/",
      }).ok,
    ).toBe(false);
  });
});

describe("secrets", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("generates secret.key once with 0600 and reloads it", () => {
    dir = mkdtempSync(join(tmpdir(), "pptaken-auth-"));
    const a = loadOrCreateSecretKey({ dataDir: dir });
    expect(a.source).toBe("generated");
    expect(a.key.length).toBe(32);
    const b = loadOrCreateSecretKey({ dataDir: dir });
    expect(b.source).toBe("data-dir");
    expect(b.key.equals(a.key)).toBe(true);
    expect(readFileSync(join(dir, "secret.key"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("accepts an injected key and rejects weak ones", () => {
    const hex = "ab".repeat(32);
    expect(loadOrCreateSecretKey({ dataDir: "/nonexistent", value: hex }).source).toBe("env");
    expect(parseSecretKey(Buffer.alloc(32, 1).toString("base64")).length).toBe(32);
    expect(() => parseSecretKey("too-short")).toThrow();
    expect(() => parseSecretKey("ab".repeat(16))).toThrow();
  });
});

describe("log redaction", () => {
  it("removes secrets by key and by value", () => {
    const token = generateApiToken();
    const out = redact({
      headers: {
        authorization: `Bearer ${token}`,
        cookie: "pptaken_session=abc",
        "user-agent": "x",
      },
      body: { password: "hunter2hunter2", installCode: "7K2M-9QXD", name: "ok" },
      message: `failed with ${token} at /c/x?ct=SECRETVALUE&y=1`,
      nested: [{ secret: "s" }],
      code: "VALIDATION_ERROR",
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(token.slice(4));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("7K2M");
    expect(text).not.toContain("SECRETVALUE");
    expect(text).not.toContain("abc");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain(REDACTED);
    expect(redactString("Cookie: __Host-pptaken_session=zzz; other=1")).not.toContain("zzz");
  });

  it("survives cycles and errors", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
    expect(redact(new Error(`bad ${generateApiToken()}`))).toMatchObject({ name: "Error" });
  });
});
