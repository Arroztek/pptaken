// SPDX-License-Identifier: AGPL-3.0-or-later
// In-memory implementation of docs/spec/http-api.md for exercising the built web app without the real
// server. Serves apps/web/dist with the SPA fallback and a strict CSP, like apps/server will.
//
//   node test/mock-server.mjs            → http://127.0.0.1:4173, fresh instance (install code 7K2M-9QXD)
//   MOCK_INSTALLED=1 MOCK_DECKS=14 MOCK_CONNECT_DELAY_MS=3000 MOCK_HTTPS=1 PORT=4173 node test/mock-server.mjs
//
// Tests import startMockServer() and get an isolated server (and its mutable state) per test.
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INSTALL_CODE = "7K2M-9QXD";
export const OWNER_PASSWORD = "stagehand crew 2026";
export const STRICT_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'";
const DEFAULT_SCOPES = ["decks:read", "decks:write", "quiz:draft"];
const COMMON = new Set(["password1234", "123456789012", "qwertyuiopas", "passwordpassword"]);

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
};

const TITLES = [
  "Q3 results for the sales team",
  "Onboarding: your first week",
  "A short history of the printing press",
  "Garden club: spring plan",
  "Design review: checkout v4",
  "Workshop: prompts that work",
  "Quarterly planning, engineering",
  "Coffee origins for beginners",
  "Release notes 0.1",
  "Volunteer briefing, city marathon",
  "Board update, November",
  "Intro to tide pools",
];

/** Build `n` deck summaries, newest first. */
export function makeDecks(n, now = Date.now()) {
  return Array.from({ length: n }, (_, i) => ({
    id: `deck_${String(i + 1).padStart(3, "0")}`,
    title:
      i < TITLES.length
        ? TITLES[i]
        : `${TITLES[i % TITLES.length]} (${Math.floor(i / TITLES.length) + 1})`,
    lang: i % 5 === 3 ? "es" : "en",
    slideCount: [14, 22, 9, 11, 18, 26, 1, 7][i % 8],
    revision: (i % 6) + 1,
    updatedAt: new Date(now - (i * i * 3 + 2) * 3600 * 1000).toISOString(),
    createdBy: i % 3 === 2 ? "owner" : "agent",
  }));
}

export function createState(options = {}) {
  return {
    installed: options.installed ?? false,
    password: options.installed ? (options.password ?? OWNER_PASSWORD) : null,
    https: options.https ?? false,
    decks: Array.isArray(options.decks) ? options.decks : makeDecks(options.decks ?? 0),
    pageSize: options.pageSize ?? 6,
    connectDelayMs: options.connectDelayMs ?? 3000,
    loginLimit: options.loginLimit ?? 5,
    retryAfter: options.retryAfter ?? 30,
    sessions: new Set(),
    tokens: [],
    firstTokenAt: null,
    loginAttempts: [],
    csp: options.csp ?? STRICT_CSP,
    /** Every API request, for assertions (method, path, csrf header, origin). */
    log: [],
    /** Export downloads ({ id, format, notes }) and import body sizes. */
    exports: [],
    imports: [],
  };
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(status === 204 ? undefined : payload);
}

function fail(res, status, code, message, extra = {}, headers = {}) {
  send(res, status, { error: { code, message, ...extra } }, headers);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = v.join("=");
  }
  return out;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function newSession(state, res) {
  const id = randomBytes(24).toString("base64url");
  state.sessions.add(id);
  res.setHeader(
    "Set-Cookie",
    `pptaken_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  );
}

function publicUrl(state, req) {
  return `${state.https ? "https" : "http"}://${req.headers.host}`;
}

async function handleApi(state, req, res, url) {
  const path = url.pathname.slice("/api/v1".length);
  const method = req.method ?? "GET";
  const sid = cookies(req).pptaken_session;
  const signedIn = Boolean(sid && state.sessions.has(sid));
  state.log.push({
    method,
    path,
    csrf: req.headers["x-pptaken-csrf"] ?? null,
    origin: req.headers.origin ?? null,
  });

  if (method !== "GET") {
    const origin =
      req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : null);
    if (req.headers["x-pptaken-csrf"] !== "1" || origin !== `http://${req.headers.host}`) {
      return fail(res, 403, "FORBIDDEN", "Missing CSRF header or foreign origin.");
    }
  }

  if (method === "GET" && path === "/setup/status") {
    return send(res, 200, {
      installed: state.installed,
      publicUrl: publicUrl(state, req),
      https: state.https,
      version: "0.1.0",
    });
  }

  if (method === "POST" && path === "/setup") {
    if (state.installed) return fail(res, 409, "ALREADY_SETUP", "Already set up.");
    const body = await readJson(req);
    if (!body || typeof body.installCode !== "string" || typeof body.password !== "string") {
      return fail(res, 400, "VALIDATION_ERROR", "Invalid body.");
    }
    if (body.installCode.trim().toUpperCase() !== INSTALL_CODE) {
      return fail(res, 403, "FORBIDDEN", "Wrong install code.");
    }
    if (body.password.length < 12) {
      return fail(res, 400, "VALIDATION_ERROR", "Weak password.", {
        hint: "Use at least 12 characters.",
      });
    }
    if (COMMON.has(body.password.toLowerCase())) {
      return fail(res, 400, "VALIDATION_ERROR", "Weak password.", {
        hint: "This password is too common. Try a short phrase.",
      });
    }
    state.installed = true;
    state.password = body.password;
    newSession(state, res);
    return send(res, 201, { owner: { id: "owner_1" } });
  }

  if (method === "POST" && path === "/auth/login") {
    if (!state.installed) return fail(res, 409, "SETUP_REQUIRED", "Not set up.");
    const now = Date.now();
    state.loginAttempts = state.loginAttempts.filter((t) => now - t < 60_000);
    if (state.loginAttempts.length >= state.loginLimit) {
      return fail(
        res,
        429,
        "RATE_LIMITED",
        "Too many attempts.",
        {},
        { "Retry-After": String(state.retryAfter) },
      );
    }
    state.loginAttempts.push(now);
    const body = await readJson(req);
    if (!body || body.password !== state.password)
      return fail(res, 401, "UNAUTHENTICATED", "Wrong password.");
    state.loginAttempts = [];
    newSession(state, res);
    return send(res, 200, { owner: { id: "owner_1" } });
  }

  if (method === "POST" && path === "/auth/logout") {
    if (sid) state.sessions.delete(sid);
    res.setHeader("Set-Cookie", "pptaken_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return send(res, 204);
  }

  if (method === "GET" && path === "/auth/me") {
    if (!state.installed) return fail(res, 409, "SETUP_REQUIRED", "Not set up.");
    if (!signedIn) return fail(res, 401, "UNAUTHENTICATED", "Sign in.");
    return send(res, 200, { owner: { id: "owner_1" }, csrf: "1" });
  }

  // Everything below needs the owner session.
  if (!state.installed) return fail(res, 409, "SETUP_REQUIRED", "Not set up.");
  if (!signedIn) return fail(res, 401, "UNAUTHENTICATED", "Sign in.");

  if (method === "POST" && path === "/tokens") {
    const body = await readJson(req);
    if (!body || typeof body.name !== "string" || !body.name.trim()) {
      return fail(res, 400, "VALIDATION_ERROR", "Name required.");
    }
    const secret = `ppt_${randomBytes(32).toString("base64url")}`;
    const token = {
      id: `tok_${randomBytes(6).toString("hex")}`,
      name: body.name.trim(),
      scopes: Array.isArray(body.scopes) ? body.scopes : DEFAULT_SCOPES,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      hash: createHash("sha256").update(secret).digest("hex"),
    };
    state.tokens.push(token);
    state.firstTokenAt ??= Date.now();
    const { hash: _hash, lastUsedAt: _l, revokedAt: _r, ...publicToken } = token;
    return send(res, 201, { token: publicToken, secret });
  }

  if (method === "GET" && path === "/tokens") {
    return send(res, 200, { tokens: state.tokens.map(({ hash: _hash, ...t }) => t) });
  }

  const del = path.match(/^\/tokens\/([^/]+)$/);
  if (method === "DELETE" && del) {
    const token = state.tokens.find((t) => t.id === decodeURIComponent(del[1]));
    if (!token) return fail(res, 404, "NOT_FOUND", "No such token.");
    token.revokedAt ??= new Date().toISOString();
    return send(res, 204);
  }

  if (method === "GET" && path === "/connect/status") {
    const connected =
      state.firstTokenAt !== null && Date.now() - state.firstTokenAt >= state.connectDelayMs;
    if (connected) {
      const first = state.tokens[0];
      if (first && !first.lastUsedAt)
        first.lastUsedAt = new Date(state.firstTokenAt + state.connectDelayMs).toISOString();
    }
    return send(res, 200, {
      mcpUrl: `${publicUrl(state, req)}/mcp`,
      agentConnected: connected,
      lastCallAt: connected
        ? new Date(state.firstTokenAt + state.connectDelayMs).toISOString()
        : null,
      lastTool: connected ? "whoami" : null,
      clientName: connected ? "Claude Code" : null,
    });
  }

  if (method === "GET" && path === "/decks") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const list = q ? state.decks.filter((d) => d.title.toLowerCase().includes(q)) : state.decks;
    const start = Number.parseInt(url.searchParams.get("cursor") || "0", 10) || 0;
    const page = list.slice(start, start + state.pageSize);
    const next = start + state.pageSize < list.length ? String(start + state.pageSize) : null;
    return send(res, 200, { decks: page, nextCursor: next });
  }

  // Export: a small stand-in file per format, with the real server's download headers.
  const exp = path.match(/^\/decks\/([^/]+)\/export$/);
  if (method === "GET" && exp) {
    const deck = state.decks.find((d) => d.id === decodeURIComponent(exp[1]));
    if (!deck) return fail(res, 404, "NOT_FOUND", "Presentation not found");
    const format = url.searchParams.get("format");
    const notes = url.searchParams.get("notes");
    if (format !== "html" && format !== "pptaken") {
      return fail(res, 400, "VALIDATION_ERROR", "format must be html or pptaken");
    }
    state.exports.push({ id: deck.id, format, notes });
    const name = `${deck.id}${format === "html" ? ".html" : ".pkn"}`;
    const body =
      format === "html"
        ? `<!doctype html><title>${deck.id}</title><p>notes=${notes}</p>`
        : "PK\u0005\u0006mock";
    res.writeHead(200, {
      "Content-Type": format === "html" ? "text/html; charset=utf-8" : "application/zip",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${name}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    return res.end(body);
  }

  // Import: a body containing BROKEN is refused like a damaged archive; WARN adds a warning.
  if (method === "POST" && path === "/decks/import") {
    if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/zip") {
      return fail(res, 400, "VALIDATION_ERROR", "The request body must be a .pkn archive");
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("latin1");
    state.imports.push(text.length);
    if (text.includes("BROKEN")) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Not a valid .pkn archive: manifest.json is missing",
        {
          hint: "Export the presentation again from PPTaken and import the unmodified file.",
        },
      );
    }
    const deck = {
      id: `deck_imp_${state.imports.length}`,
      title: `Imported deck ${state.imports.length}`,
      lang: "en",
      slideCount: 3,
      revision: 1,
      updatedAt: new Date().toISOString(),
      createdBy: "owner",
    };
    state.decks.unshift(deck);
    const warnings = text.includes("WARN")
      ? [
          {
            code: "UNUSED_ASSET",
            message: "asset:0123456789abcdef… is not used by any slide; it was not imported",
          },
        ]
      : [];
    return send(res, 201, { deck, assetCount: 0, warnings });
  }

  // PowerPoint import: a body containing LEGACY is refused like a .ppt file; otherwise warnings of every group.
  if (method === "POST" && path === "/decks/import-pptx") {
    const type = (req.headers["content-type"] ?? "").split(";")[0];
    if (type !== "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      return fail(res, 400, "VALIDATION_ERROR", "The request body must be a .pptx file");
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("latin1");
    state.imports.push(text.length);
    if (text.includes("LEGACY")) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "This is a PowerPoint 97-2003 (.ppt) file, which cannot be imported",
        { hint: "Open it in PowerPoint and save it as .pptx, then import that file." },
      );
    }
    const deck = {
      id: `deck_pptx_${state.imports.length}`,
      title: "Quarterly review",
      lang: "en",
      slideCount: 12,
      revision: 1,
      updatedAt: new Date().toISOString(),
      createdBy: "owner",
    };
    state.decks.unshift(deck);
    const warnings = [
      {
        code: "PPTX_FEATURE_DROPPED",
        message: "Slide 4: charts are not imported; an empty box marks where they were",
        path: "slides[3]",
        slideId: "slide-4",
        name: "chart",
      },
      {
        code: "PPTX_FEATURE_DROPPED",
        message: "Slide 7: the slide transition is not kept",
        path: "slides[6]",
        slideId: "slide-7",
        name: "transition",
      },
      {
        code: "PPTX_FONT_REPLACED",
        message: 'The font "Calibri" was replaced by Inter; line breaks may differ',
        name: "font:Calibri",
      },
    ];
    return send(res, 201, { deck, assetCount: 4, warnings });
  }

  const one = path.match(/^\/decks\/([^/]+)$/);
  if (method === "GET" && one) {
    const deck = state.decks.find((d) => d.id === decodeURIComponent(one[1]));
    if (!deck) return fail(res, 404, "NOT_FOUND", "No such deck.");
    return send(res, 200, { ...deck, urls: { present: `/p/${deck.id}` } });
  }

  return fail(res, 404, "NOT_FOUND", "No such route.");
}

async function serveFile(res, file, csp) {
  const body = await readFile(file);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": file.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(body);
}

/**
 * Start an isolated mock server. Resolves to { url, state, close }.
 * @param {{ port?: number, dist?: string } & Parameters<typeof createState>[0]} options
 */
export async function startMockServer(options = {}) {
  const state = createState(options);
  const dist = resolve(options.dist ?? join(here, "..", "dist"));
  const index = join(dist, "index.html");
  await stat(index).catch(() => {
    throw new Error(`Build the app first: ${index} is missing (pnpm --filter @pptaken/web build).`);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/v1/")) return await handleApi(state, req, res, url);
      if (url.pathname.startsWith("/p/")) {
        // Stand-in for the player page that apps/server serves.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": state.csp,
        });
        return res.end(
          '<!doctype html><html lang="en"><title>Player</title><h1>Player placeholder</h1></html>',
        );
      }
      if (url.pathname === "/mcp")
        return fail(res, 401, "UNAUTHENTICATED", "Bearer token required.");
      const file = normalize(join(dist, decodeURIComponent(url.pathname)));
      if (file.startsWith(dist + sep) && extname(file)) {
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) return await serveFile(res, file, state.csp);
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      return await serveFile(res, index, state.csp); // SPA fallback
    } catch (error) {
      fail(res, 500, "INTERNAL", error instanceof Error ? error.message : "Internal error");
    }
  });

  await new Promise((done) => server.listen(options.port ?? 0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done(undefined));
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const mock = await startMockServer({
    port: Number(env.PORT ?? 4173),
    installed: env.MOCK_INSTALLED === "1",
    https: env.MOCK_HTTPS === "1",
    decks: Number(env.MOCK_DECKS ?? 0),
    connectDelayMs: Number(env.MOCK_CONNECT_DELAY_MS ?? 3000),
  });
  console.log(`PPTaken mock ready at ${mock.url} · Install code: ${INSTALL_CODE}`);
  if (env.MOCK_INSTALLED === "1") console.log(`Owner password: ${OWNER_PASSWORD}`);
}
