import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
