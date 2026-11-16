// SPDX-License-Identifier: AGPL-3.0-or-later
// The SSRF-safe fetcher (threat T8): address classification and target validation with an injected resolver, so
// nothing here touches the network.
import { describe, expect, it } from "vitest";
import {
  FetchBlockedError,
  fetchClientMetadataDocument,
  isBlockedAddress,
  maxAgeOf,
  type ResolvedAddress,
  resolveSafeTarget,
} from "../src/safe-fetch.js";

const resolver =
  (map: Record<string, string[]>) =>
  async (host: string): Promise<ResolvedAddress[]> => {
    const list = map[host];
    if (list === undefined) throw new Error("NXDOMAIN");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.1.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2001::1",
    "not an ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "160.79.104.10",
    "2606:4700::6810:84e5",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("resolveSafeTarget", () => {
  const dns = resolver({
    "public.example": ["93.184.216.34"],
    "internal.example": ["10.0.0.5"],
    "metadata.example": ["169.254.169.254"],
    "mixed.example": ["93.184.216.34", "127.0.0.1"],
    "v6.example": ["2606:4700::6810:84e5"],
    "v6loop.example": ["::1"],
    "empty.example": [],
  });

  it("accepts https on 443 to a public address", async () => {
    const t = await resolveSafeTarget("https://public.example/oauth/client.json", dns);
    expect(t.address.address).toBe("93.184.216.34");
    expect((await resolveSafeTarget("https://v6.example:443/c.json", dns)).address.family).toBe(6);
  });

  it.each([
    ["http://public.example/c.json", /https/],
    ["ftp://public.example/c.json", /https/],
    ["https://user:pw@public.example/c.json", /credentials/],
    ["https://public.example:8443/c.json", /443/],
    ["https://internal.example/c.json", /private/],
    ["https://metadata.example/latest", /private/],
    ["https://mixed.example/c.json", /private/],
    ["https://v6loop.example/c.json", /private/],
    ["https://empty.example/c.json", /resolve/],
    ["https://nxdomain.example/c.json", /resolve/],
    ["https://localhost/c.json", /not reachable/],
    ["https://app.localhost/c.json", /not reachable/],
    ["https://127.0.0.1/c.json", /private/],
    ["https://[::1]/c.json", /private/],
    ["https://[::ffff:a00:1]/c.json", /private/],
    ["https://169.254.169.254/latest/meta-data/", /private/],
    ["https://2130706433/c.json", /private/], // decimal 127.0.0.1, normalized by the URL parser
    ["not a url", /valid URL/],
  ])("refuses %s", async (url, reason) => {
    const p = resolveSafeTarget(url, dns);
    await expect(p).rejects.toBeInstanceOf(FetchBlockedError);
    await expect(p).rejects.toThrow(reason);
  });

  it("CIMD fetches go through the same checks", async () => {
    await expect(
      fetchClientMetadataDocument("https://internal.example/c.json", dns),
    ).rejects.toBeInstanceOf(FetchBlockedError);
  });
});

describe("maxAgeOf", () => {
  it("reads Cache-Control", () => {
    expect(maxAgeOf(undefined)).toBeNull();
    expect(maxAgeOf("public, max-age=600")).toBe(600);
    expect(maxAgeOf("no-store")).toBe(0);
    expect(maxAgeOf("private")).toBeNull();
  });
});
