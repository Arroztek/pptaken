// SPDX-License-Identifier: AGPL-3.0-or-later
// The vendoring fetcher (ADR-022) over a fake network: SSRF checks on every hop, DNS rebinding, caps, timeouts,
// concurrency, caching, host lists and the operator switch. No real network.
import { TokenBucketLimiter } from "@pptaken/auth-local";
import type { VendorFetchRequest, VendorKind } from "@pptaken/core";
import { pngBytes } from "@pptaken/testing";
import { describe, expect, it } from "vitest";
import type { ResolvedAddress } from "../src/safe-fetch.js";
import { createVendorFetcher, hostMatches, type VendorTransport } from "../src/vendor-fetch.js";

const enc = (t: string) => new TextEncoder().encode(t);
const PUBLIC = "93.184.216.34";

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | (() => AsyncIterable<Uint8Array>);
  /** Never answer (slow server). */
  hang?: boolean;
}

function network(routes: Record<string, FakeResponse>, dns: Record<string, string[]> = {}) {
  const seen: { url: string; address: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const resolve = async (host: string): Promise<ResolvedAddress[]> => {
    const list = dns[host] ?? [PUBLIC];
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const transport: VendorTransport = async ({ url, address, signal }) => {
    seen.push({ url: url.href, address: address.address });
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const r = routes[url.href];
      if (r === undefined)
        return { status: 404, headers: {}, body: (async function* () {})(), abort() {} };
      if (r.hang === true) {
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      await new Promise((ok) => setTimeout(ok, 5));
      const fixed = r.body;
      const body: AsyncIterable<Uint8Array> =
        typeof fixed === "function"
          ? fixed()
          : (async function* () {
              if (fixed !== undefined) yield fixed;
            })();
      return { status: r.status ?? 200, headers: r.headers ?? {}, body, abort() {} };
    } finally {
      active--;
    }
  };
  return { resolve, transport, seen, max: () => maxActive };
}

const req = (
  url: string,
  kind: VendorKind = "image",
  deadline = Date.now() + 30_000,
): VendorFetchRequest => ({
  url,
  kind,
  deckId: "01J00000000000000000000000",
  actor: { actor: "agent", tokenId: "tok" },
  deadline,
});

describe("vendor fetcher: SSRF on every hop", () => {
  it("follows up to 3 redirects and reports the chain", async () => {
    const net = network({
      "https://cdn.example/a@1/x.png": { status: 302, headers: { location: "/a@1.2/x.png" } },
      "https://cdn.example/a@1.2/x.png": {
        status: 301,
        headers: { location: "https://mirror.example/x.png" },
      },
      "https://mirror.example/x.png": { body: pngBytes() },
    });
    const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0 });
    const r = await f.fetch(req("https://cdn.example/a@1/x.png"));
    expect(r.finalUrl).toBe("https://mirror.example/x.png");
    expect(r.redirects).toEqual([
      "https://cdn.example/a@1.2/x.png",
      "https://mirror.example/x.png",
    ]);
  });

  it("refuses more than 3 redirects", async () => {
    const routes: Record<string, FakeResponse> = {};
    for (let i = 0; i < 5; i++)
      routes[`https://r.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const f = createVendorFetcher({ enabled: true, ...network(routes), cacheBytes: 0 });
    await expect(f.fetch(req("https://r.example/0"))).rejects.toMatchObject({ code: "http-error" });
  });

  for (const target of [
    "https://127.0.0.1/x",
    "https://10.0.0.7/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://[64:ff9b::a00:1]/x",
    "https://[2002:a00:1::]/x",
    "https://[fe80::1]/x",
    "https://100.64.0.1/x",
    "https://2130706433/x",
    "https://0x7f.1/x",
    "https://localhost/x",
    "http://cdn.example/x",
    "https://cdn.example:8443/x",
    "https://user:pw@cdn.example/x",
  ]) {
    it(`blocks ${target}, directly and as a redirect target`, async () => {
      const net = network({
        "https://ok.example/r": { status: 302, headers: { location: target } },
      });
      const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0 });
      await expect(f.fetch(req(target))).rejects.toMatchObject({ code: "blocked-address" });
      await expect(f.fetch(req("https://ok.example/r"))).rejects.toMatchObject({
        code: "blocked-address",
      });
      expect(net.seen.map((s) => s.url)).toEqual(["https://ok.example/r"]);
    });
  }

  it("blocks host names that resolve to private addresses (metadata alias, mixed answers)", async () => {
    const net = network(
      {},
      {
        "metadata.example": ["169.254.169.254"],
        "mixed.example": [PUBLIC, "10.1.2.3"],
        "v6.example": ["::1"],
      },
    );
    const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0 });
    for (const host of ["metadata.example", "mixed.example", "v6.example"]) {
      await expect(f.fetch(req(`https://${host}/x.png`))).rejects.toMatchObject({
        code: "blocked-address",
      });
    }
    expect(net.seen).toEqual([]);
  });

  it("pins the connection to the checked address (DNS rebinding cannot swap it)", async () => {
    let calls = 0;
    const base = network({ "https://rebind.example/x.png": { body: pngBytes() } });
    const resolve = async (): Promise<ResolvedAddress[]> =>
      // First answer public, any later answer private: a second lookup would be the rebinding.
      calls++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    const f = createVendorFetcher({
      enabled: true,
      resolve,
      transport: base.transport,
      cacheBytes: 0,
    });
    await f.fetch(req("https://rebind.example/x.png"));
    expect(calls).toBe(1);
    expect(base.seen).toEqual([{ url: "https://rebind.example/x.png", address: PUBLIC }]);
  });
});

describe("vendor fetcher: content and size", () => {
  it("refuses by declared length and while streaming", async () => {
    const big = new Uint8Array(4096);
    const net = network({
      "https://s.example/declared.png": {
        headers: { "content-length": "999999999" },
        body: pngBytes(),
      },
      "https://s.example/stream.js": {
        body: async function* () {
          for (let i = 0; i < 10; i++) yield big;
        },
      },
    });
    const f = createVendorFetcher({
      enabled: true,
      ...net,
      cacheBytes: 0,
      maxBytes: { script: 10_000 },
    });
    await expect(f.fetch(req("https://s.example/declared.png"))).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(f.fetch(req("https://s.example/stream.js", "script"))).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("checks magic bytes, not the declared type, and refuses compressed bodies", async () => {
    const net = network({
      "https://s.example/a.png": {
        headers: { "content-type": "image/png" },
        body: enc("<html>login</html>"),
      },
      "https://s.example/a.svg": {
        body: enc('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      },
      "https://s.example/gz.js": {
        headers: { "content-encoding": "gzip" },
        body: new Uint8Array([31, 139, 8]),
      },
      "https://s.example/font.woff2": { body: pngBytes() },
    });
    const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0 });
    for (const [url, kind] of [
      ["https://s.example/a.png", "image"],
      ["https://s.example/a.svg", "image"],
      ["https://s.example/gz.js", "script"],
      ["https://s.example/font.woff2", "font"],
    ] as const) {
      await expect(f.fetch(req(url, kind))).rejects.toMatchObject({ code: "bad-type" });
    }
  });

  it("HTTP errors are reported as http-error", async () => {
    const f = createVendorFetcher({
      enabled: true,
      ...network({ "https://s.example/500": { status: 500 } }),
      cacheBytes: 0,
    });
    await expect(f.fetch(req("https://s.example/500"))).rejects.toMatchObject({
      code: "http-error",
    });
    await expect(f.fetch(req("https://s.example/missing"))).rejects.toMatchObject({
      code: "http-error",
    });
  });
});

describe("vendor fetcher: time, concurrency, cache, policy", () => {
  it("times out a server that never answers and a slow-loris body", async () => {
    const net = network({
      "https://slow.example/hang.png": { hang: true },
      "https://slow.example/loris.js": {
        body: async function* () {
          for (;;) {
            await new Promise((ok) => setTimeout(ok, 30));
            yield enc("/");
          }
        },
      },
    });
    const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0, requestTimeoutMs: 120 });
    const started = Date.now();
    await expect(f.fetch(req("https://slow.example/hang.png"))).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(f.fetch(req("https://slow.example/loris.js", "script"))).rejects.toMatchObject({
      code: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("respects the write's deadline", async () => {
    const f = createVendorFetcher({
      enabled: true,
      ...network({ "https://a.example/x.png": { body: pngBytes() } }),
      cacheBytes: 0,
    });
    await expect(
      f.fetch(req("https://a.example/x.png", "image", Date.now() - 1)),
    ).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("limits fetches in flight", async () => {
    const routes: Record<string, FakeResponse> = {};
    for (let i = 0; i < 6; i++) routes[`https://c.example/${i}.png`] = { body: pngBytes() };
    const net = network(routes);
    const f = createVendorFetcher({ enabled: true, ...net, cacheBytes: 0, maxConcurrent: 2 });
    await Promise.all(Object.keys(routes).map((u) => f.fetch(req(u))));
    expect(net.max()).toBeLessThanOrEqual(2);
    expect(f.inFlight).toBe(0);
  });

  it("caches by kind and URL", async () => {
    const net = network({ "https://c.example/a.png": { body: pngBytes() } });
    const f = createVendorFetcher({ enabled: true, ...net });
    const a = await f.fetch(req("https://c.example/a.png"));
    const b = await f.fetch(req("https://c.example/a.png"));
    expect(net.seen).toHaveLength(1);
    expect(b.bytes).toEqual(a.bytes);
  });

  it("applies the allow and deny lists to every hop", async () => {
    const net = network({
      "https://cdn.jsdelivr.net/x.png": {
        status: 302,
        headers: { location: "https://evil.example/x.png" },
      },
      "https://fonts.gstatic.com/x.png": { body: pngBytes() },
    });
    const allow = createVendorFetcher({
      enabled: true,
      ...net,
      cacheBytes: 0,
      allowHosts: ["jsdelivr.net", "gstatic.com"],
    });
    await expect(allow.fetch(req("https://fonts.gstatic.com/x.png"))).resolves.toBeTruthy();
    await expect(allow.fetch(req("https://cdn.jsdelivr.net/x.png"))).rejects.toMatchObject({
      code: "not-allowed-host",
    });
    const deny = createVendorFetcher({
      enabled: true,
      ...net,
      cacheBytes: 0,
      denyHosts: ["gstatic.com"],
    });
    await expect(deny.fetch(req("https://fonts.gstatic.com/x.png"))).rejects.toMatchObject({
      code: "not-allowed-host",
    });
    expect(hostMatches("a.b.example.com", "example.com")).toBe(true);
    expect(hostMatches("badexample.com", "example.com")).toBe(false);
  });

  it("is off with the operator switch and rate-limited per actor", async () => {
    const net = network({ "https://c.example/a.png": { body: pngBytes() } });
    const off = createVendorFetcher({ enabled: false, ...net });
    await expect(off.fetch(req("https://c.example/a.png"))).rejects.toMatchObject({
      code: "disabled",
    });
    const limited = createVendorFetcher({
      enabled: true,
      ...net,
      cacheBytes: 0,
      limiter: new TokenBucketLimiter({
        capacity: 2,
        refill: 2,
        intervalMs: 60_000,
        clock: { now: Date.now },
      }),
    });
    await limited.fetch(req("https://c.example/a.png"));
    await limited.fetch(req("https://c.example/a.png"));
    await expect(limited.fetch(req("https://c.example/a.png"))).rejects.toMatchObject({
      code: "rate-limited",
    });
  });
});
