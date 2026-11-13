// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`PPTaken listening on http://localhost:${info.port}`);
});
