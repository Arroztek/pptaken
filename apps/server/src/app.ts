// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  return app;
}
