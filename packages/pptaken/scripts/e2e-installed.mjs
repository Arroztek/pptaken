// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end test of the PUBLISHABLE package, run against an INSTALLED copy, never against the repository:
//
//   1. `npm pack` packages/pptaken (or take --tarball <file>), then, in a fresh temp folder OUTSIDE the monorepo:
//      a local project (`npm init -y` + `npm install <tarball>` + `npm exec pptaken`), a real `npx --package`, and a
//      global-style install into a temp prefix. npm uses a temp cache, so nothing outside the temp folder changes.
//   2. Starts the installed CLI with a temp data folder, a random port and --scripts owner, and checks through HTTP,
//      MCP and Chromium (Playwright): healthz, the panel, setup with the install code, an access key, MCP tools/list
//      and create_presentation, the player reaching "ready" with a bundled font loaded, /r, /_rt/qr.js, /p/sw.js, a
//      WebSocket upgrade (and a refused foreign Origin), approval of an interactive deck that then runs, backup and
//      reset-password, port-busy / already-running / data-folder / old-Node messages, the default port moving on
//      when busy, a clean stop (database closed, WAL merged), a SIGTERM stop, and a second start reusing the data.
//
// Usage:  pnpm --filter pptaken test:installed           (after `pnpm build`)
//         node scripts/e2e-installed.mjs --tarball pptaken-0.1.0.tgz [--keep]
// Needs:  network access to the npm registry (better-sqlite3 is installed from it) and Playwright's Chromium
//         (`pnpm exec playwright install chromium`). Exit code 0 when every check passed.
import { fork, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium } from "@playwright/test";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgDir, "../..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const tarballArg = args.includes("--tarball") ? args[args.indexOf("--tarball") + 1] : undefined;
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const IS_WINDOWS = process.platform === "win32";

const OWNER = "violet otter climbs 7 dunes";
const NEW_OWNER = "amber heron reads 4 maps";

// --- tiny harness --------------------------------------------------------------------------------------------------
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  -- ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pptaken-installed-")));
if (!relative(repoRoot, tmp).startsWith("..")) {
  console.error(`The temp folder ${tmp} is inside the repository; set TMPDIR/TEMP elsewhere.`);
  process.exit(2);
}
console.log(
  `== pptaken ${version}: installed-copy test in ${tmp} (${process.platform}-${process.arch}, Node ${process.versions.node})`,
);

/** Environment for every child: no PPTAKEN_* or npm_* leaking in from the caller, a private npm cache. */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(pptaken_|npm_)/i.test(k)),
);
Object.assign(baseEnv, {
  npm_config_cache: join(tmp, "npm-cache"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_loglevel: "warn",
  NO_COLOR: "1",
});

/** The npm and npx CLIs as JavaScript files run by this Node.js (no shell, no .cmd wrappers). */
function npmScript(name) {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", `${name}-cli.js`),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", `${name}-cli.js`),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`cannot find ${name}-cli.js next to ${process.execPath}`);
  return found;
}
const NPM = npmScript("npm");
const NPX = npmScript("npx");

function run(file, argv, { cwd = tmp, input, env = baseEnv, timeout = 300_000 } = {}) {
  const r = spawnSync(process.execPath, [file, ...argv], {
    cwd,
    input,
    env,
    encoding: "utf8",
    timeout,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}
const npm = (argv, opts) => run(NPM, argv, opts);

const children = new Set();
/** Starts the installed CLI with an IPC channel (graceful stop on every OS). */
function startCli(bin, argv, { env = baseEnv, cwd = tmp } = {}) {
  const child = fork(bin, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  children.add(child);
  const proc = { child, stdout: "", stderr: "", exit: null };
  child.stdout.on("data", (d) => {
    proc.stdout += d;
  });
  child.stderr.on("data", (d) => {
    proc.stderr += d;
  });
  proc.exited = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => {
      children.delete(child);
      proc.exit = { code, signal };
      resolveExit(proc.exit);
    }),
  );
  return proc;
}

async function waitFor(proc, pattern, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = pattern.exec(proc.stdout);
    if (m) return m;
    if (proc.exit !== null)
      throw new Error(`exited (${JSON.stringify(proc.exit)}): ${proc.stderr}${proc.stdout}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${pattern}: ${proc.stderr}${proc.stdout}`);
}

async function waitExit(proc, ms = 20_000) {
  return Promise.race([proc.exited, sleep(ms).then(() => null)]);
}

const freePort = () =>
  new Promise((resolvePort) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });

/** Raw WebSocket handshake: the HTTP status of the upgrade answer (101 when accepted). */
function wsStatus(base, origin) {
  return new Promise((resolveStatus) => {
    const url = new URL("/ws", base);
    const req = request({
      host: "127.0.0.1",
      port: url.port,
      path: "/ws",
      headers: {
        Host: url.host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "c21va2UtdGVzdC1rZXkxMg==",
        Origin: origin,
      },
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolveStatus(0);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolveStatus(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on("error", () => resolveStatus(0));
    req.end();
  });
}

/**
 * Opens a database with the INSTALLED better-sqlite3, in a child process (a native module loaded here would keep
 * its file locked on Windows and the temp folder could not be removed).
 */
function inspectDb(project, file) {
  const script = `
    const Database = require("better-sqlite3");
    const db = new Database(${JSON.stringify(file)}, { fileMustExist: true });
    const out = {
      integrity: db.pragma("integrity_check", { simple: true }),
      decks: db.prepare("SELECT count(*) AS n FROM deck WHERE deleted_at IS NULL").get().n,
    };
    db.close();
    process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: project,
    env: baseEnv,
    encoding: "utf8",
  });
  if (r.status !== 0) return { error: r.stderr };
  return JSON.parse(r.stdout);
}

function dirSize(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name)), 0);
}

let browser;
let exitCode = 0;
try {
  // --- 1. Pack and install -----------------------------------------------------------------------------------------
  let tarball;
  if (tarballArg) {
    tarball = resolve(tarballArg);
  } else {
    const packed = npm(["pack", "--json", "--pack-destination", tmp], { cwd: pkgDir });
    if (packed.code !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    tarball = join(tmp, JSON.parse(packed.stdout)[0].filename);
  }
  check("tarball exists", existsSync(tarball), tarball);
  console.log(`      tarball ${tarball} (${(statSync(tarball).size / 1024 / 1024).toFixed(2)} MB)`);

  const project = join(tmp, "project");
  mkdirSync(project);
  check("npm init -y in a fresh project", npm(["init", "-y"], { cwd: project }).code === 0);
  const installed = npm(["install", tarball, "--no-audit", "--no-fund"], { cwd: project });
  check(
    "npm install <tarball> (no compiler needed)",
    installed.code === 0,
    installed.stderr.slice(-800),
  );
  const installedPkg = join(project, "node_modules", "pptaken");
  const bin = join(installedPkg, "bin", "pptaken.cjs");
  check(
    "installed copy lives outside the repository",
    existsSync(bin) && relative(repoRoot, bin).startsWith(".."),
  );
  const deps = readdirSync(join(project, "node_modules")).filter((n) => !n.startsWith("."));
  check(
    "only pptaken, better-sqlite3 and node-addon-api are installed",
    deps.sort().join(",") === "better-sqlite3,node-addon-api,pptaken",
    deps,
  );
  const scripted = deps.filter((name) => {
    const p = JSON.parse(readFileSync(join(project, "node_modules", name, "package.json"), "utf8"));
    const s = p.scripts ?? {};
    const implicitGyp =
      p.gypfile !== false && existsSync(join(project, "node_modules", name, "binding.gyp"));
    return s.preinstall || s.install || s.postinstall || s.prepare || implicitGyp;
  });
  check("no package in the tree runs an install script", scripted.length === 0, scripted);
  const pinned = JSON.parse(
    readFileSync(join(installedPkg, "npm-shrinkwrap.json"), "utf8"),
  ).packages;
  const drift = deps
    .filter((name) => name !== "pptaken")
    .filter((name) => {
      const v = JSON.parse(
        readFileSync(join(project, "node_modules", name, "package.json"), "utf8"),
      ).version;
      return pinned[`node_modules/${name}`]?.version !== v;
    });
  check(
    "dependencies installed at the versions pinned by npm-shrinkwrap.json",
    drift.length === 0,
    drift,
  );
  console.log(
    `      installed size: pptaken ${(dirSize(installedPkg) / 1024 / 1024).toFixed(2)} MB, all node_modules ${(dirSize(join(project, "node_modules")) / 1024 / 1024).toFixed(2)} MB`,
  );

  const viaExec = npm(["exec", "--no", "--", "pptaken", "--version"], { cwd: project });
  check("npm exec pptaken --version (local install)", viaExec.stdout.trim() === version, viaExec);
  const empty = join(tmp, "empty");
  mkdirSync(empty);
  const viaNpx = run(NPX, ["--yes", "--package", tarball, "--", "pptaken", "--version"], {
    cwd: empty,
  });
  check("npx --package <tarball> pptaken --version", viaNpx.stdout.trim() === version, viaNpx);
  const prefix = join(tmp, "global");
  const globalInstall = npm([
    "install",
    "--global",
    "--prefix",
    prefix,
    tarball,
    "--no-audit",
    "--no-fund",
  ]);
  check(
    "global-style install into a temp prefix",
    globalInstall.code === 0,
    globalInstall.stderr.slice(-800),
  );
  const globalBin = IS_WINDOWS ? join(prefix, "pptaken.cmd") : join(prefix, "bin", "pptaken");
  check("global install created the pptaken command", existsSync(globalBin), globalBin);
  // .cmd files need a shell on Windows; the arguments are fixed literals.
  const g = spawnSync(
    IS_WINDOWS ? `"${globalBin}" --help` : globalBin,
    IS_WINDOWS ? [] : ["--help"],
    {
      env: baseEnv,
      encoding: "utf8",
      shell: IS_WINDOWS,
      timeout: 60_000,
    },
  );
  check(
    "global pptaken --help prints the usage",
    g.status === 0 && g.stdout.includes("Usage: npx pptaken"),
    g.stderr,
  );

  // --- 2. Messages that need no server -------------------------------------------------------------------------------
  const oldNode = spawnSync(
    process.execPath,
    ["-e", `process.exitCode = require(${JSON.stringify(bin)}).main({ version: "18.19.0" })`],
    { env: baseEnv, encoding: "utf8" },
  );
  check(
    "Node.js too old: readable message, exit code 5 (shim with a faked version)",
    oldNode.status === 5 &&
      oldNode.stderr.includes("PPTaken needs Node.js 22 or newer, but this is Node.js 18.19.0"),
    oldNode,
  );
  const blocker = join(tmp, "a-file");
  writeFileSync(blocker, "not a folder");
  const badDir = run(bin, [
    "--data-dir",
    join(blocker, "data"),
    "--port",
    String(await freePort()),
  ]);
  check(
    "data folder not usable: friendly message, exit code 4",
    badDir.code === 4 &&
      badDir.stderr.includes("cannot create its data folder") &&
      !badDir.stderr.includes("    at "),
    badDir,
  );
  const badOpt = run(bin, ["--scripts", "maybe"]);
  check(
    "invalid option: friendly message, exit code 2",
    badOpt.code === 2 && badOpt.stderr.includes("--scripts must be owner or off"),
    badOpt,
  );

  // --- 3. First start ------------------------------------------------------------------------------------------------
  const data = join(tmp, "data");
  const port = await freePort();
  const base = `http://localhost:${port}`;
  let server = startCli(bin, ["--data-dir", data, "--port", String(port), "--scripts", "owner"]);
  await waitFor(server, /Stop\s+press Ctrl\+C/);
  const code = /Install code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(server.stdout)?.[1];
  check(
    "banner: address, install code, data folder, Ctrl+C, Claude notes",
    [
      server.stdout.includes(`Open          ${base}`),
      code,
      server.stdout.includes(data),
      server.stdout.includes("https://docs-pkn.arroz.dev/connect/overview/"),
      server.stdout.includes("cannot reach"),
    ].every(Boolean),
    server.stdout,
  );
  check(
    "banner is plain ASCII with NO_COLOR",
    !/\u001b\[/.test(server.stdout) && /^[\x00-\x7F]*$/.test(server.stdout),
  );

  const health = await fetch(`${base}/healthz`);
  check("GET /healthz", health.status === 200 && (await health.json()).status === "ok");
  const index = await (await fetch(`${base}/`)).text();
  check(
    "the web app is served from the installed package",
    index === readFileSync(join(installedPkg, "dist", "web", "index.html"), "utf8"),
  );
  for (const [path, type] of [
    ["/r", "text/html"],
    ["/_rt/qr.js", "javascript"],
    ["/p/sw.js", "javascript"],
    ["/_rt/phone.js", "javascript"],
    ["/_player/shell.js", "javascript"],
  ]) {
    const res = await fetch(`${base}${path}`);
    check(
      `GET ${path}`,
      res.status === 200 && (res.headers.get("content-type") ?? "").includes(type),
      res.status,
    );
    await res.arrayBuffer();
  }
  check("WebSocket upgrade on /ws (101)", (await wsStatus(base, base)) === 101);
  check(
    "WebSocket upgrade refused for a foreign Origin (403)",
    (await wsStatus(base, "http://attacker.invalid")) === 403,
  );

  // Browser: setup with the install code, the panel, the player.
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e}`));
  page.on("request", (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) {
      problems.push(`external request: ${r.url()}`);
    }
  });
  await page.goto(base);
  await page.waitForURL("**/welcome", { timeout: 20_000 });
  check("the panel loads and a fresh instance opens /welcome", true);
  await page.getByLabel("Install code").fill(code ?? "");
  await page.getByLabel("Your password", { exact: true }).fill(OWNER);
  await page.getByLabel("Confirm password").fill(OWNER);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect Claude." }).waitFor({ timeout: 20_000 });
  check("setup with the install code (Chromium)", true);
  const session = (await context.cookies(base)).map((c) => `${c.name}=${c.value}`).join("; ");
  const api = (path, body, cookie = session) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Origin: base,
        "X-PPTaken-CSRF": "1",
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  const tokenRes = await api("/api/v1/tokens", { name: "installed e2e" });
  const { secret } = await tokenRes.json();
  check(
    "create an access key (API token)",
    tokenRes.ok && /^ppt_/.test(secret ?? ""),
    tokenRes.status,
  );

  const mcpClient = async () => {
    const client = new Client({ name: "pptaken-installed-e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return client;
  };
  const client = await mcpClient();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(
    "MCP tools/list over HTTP",
    tools.includes("create_presentation") && tools.includes("whoami"),
    tools,
  );
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, body: JSON.parse(r.content[0].text) };
  };
  const created = await call("create_presentation", {
    title: "Installed check",
    lang: "en",
    theme: { fonts: ["Inter"], css: "h1{font-family:'Inter',sans-serif;font-size:96px}" },
    slides: [
      { id: "one", title: "One", html: "<h1>Hello from npx</h1>" },
      { id: "two", title: "Two", html: "<h1>Second slide</h1>" },
    ],
  });
  const deckId = created.body.presentation_id;
  check("MCP create_presentation", !created.error && typeof deckId === "string", created.body);

  await page.goto(`${base}/decks`);
  await page.getByText("Installed check").first().waitFor({ timeout: 20_000 });
  check("the deck appears in the panel", true);
  await page.goto(`${base}/p/${deckId}`);
  await page.waitForSelector('body[data-state="ready"]', { timeout: 30_000 });
  check("player /p/<id> reaches the ready state", true);
  const frame = page.frames().find((f) => f.url().includes("/c/"));
  const fonts = frame
    ? await frame.evaluate(async () => {
        await document.fonts.load('96px "Inter"');
        return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
      })
    : [];
  check(
    "a bundled font (Inter) loads inside the content frame",
    fonts.some((f) => f.replace(/"/g, "") === "Inter"),
    fonts,
  );

  const interactive = await call("create_presentation", {
    title: "Interactive check",
    slides: [
      {
        id: "intro",
        html: "<h1 id='t'>Intro</h1>",
        script: "slide.root.setAttribute('data-ran', '1');",
      },
    ],
  });
  const iid = interactive.body.presentation_id;
  const digest = interactive.body.interactive?.digest;
  check(
    "interactive deck is created pending approval",
    !interactive.error && typeof digest === "string",
    interactive.body,
  );
  const approve = await api(`/api/v1/decks/${iid}/scripts/approve`, { digest });
  check(
    "the owner approves the deck's scripts (--scripts owner)",
    approve.status === 200,
    approve.status,
  );
  await page.goto(`${base}/p/${iid}`);
  await page.waitForSelector('body[data-state="ready"][data-scripts="running"]', {
    timeout: 30_000,
  });
  const ran = await page
    .frames()
    .find((f) => f.url().includes("/c/"))
    ?.evaluate(() => document.querySelector('[data-ran="1"]') !== null);
  check("the approved script runs in the player", ran === true);
  check("no page errors and no requests to other hosts", problems.length === 0, problems);
  await client.close();

  // Maintenance commands while the server runs.
  const backupDir = join(tmp, "backup-1");
  const b = run(bin, ["backup", backupDir, "--data-dir", data]);
  const backupDb = join(backupDir, "pptaken.db");
  check("pptaken backup <dir>", b.code === 0 && existsSync(backupDb), b);
  if (existsSync(backupDb)) {
    const info = inspectDb(project, backupDb);
    check(
      "the backup is a consistent database with the decks",
      info.integrity === "ok" && info.decks === 2,
      info,
    );
  }
  const reset = run(bin, ["reset-password", "--data-dir", data], { input: `${NEW_OWNER}\n` });
  check(
    "pptaken reset-password (password on stdin)",
    reset.code === 0 && reset.stderr.includes("Password changed"),
    reset,
  );
  const login = await api("/api/v1/auth/login", { password: NEW_OWNER }, "");
  check("signing in with the new password works", login.status === 200, login.status);
  const loginOld = await api("/api/v1/auth/login", { password: OWNER }, "");
  check("the old password no longer works", loginOld.status === 401, loginOld.status);

  // Port busy and already-running messages.
  const busy = run(bin, ["--data-dir", join(tmp, "other-data"), "--port", String(port)], {
    timeout: 60_000,
  });
  check(
    "explicit port in use: friendly message, exit code 3",
    busy.code === 3 &&
      busy.stderr.includes(`Port ${port} is already in use`) &&
      !busy.stderr.includes("    at "),
    busy,
  );
  const twice = run(bin, ["--data-dir", data, "--port", String(await freePort())], {
    timeout: 60_000,
  });
  check(
    "second PPTaken on the same data folder is refused, exit code 3",
    twice.code === 3 && twice.stderr.includes("already running"),
    twice,
  );

  // Graceful stop over IPC (what Ctrl+C does; on Windows a signal from another process cannot be caught).
  server.child.send("pptaken:shutdown");
  const stopped = await waitExit(server);
  check("clean stop exits with code 0", stopped?.code === 0, stopped);
  check(
    "clean stop says where the data is",
    server.stderr.includes(`Stopped. Your data is in ${data}`),
    server.stderr,
  );
  const wal = join(data, "pptaken.db-wal");
  check(
    "clean stop merged the SQLite WAL (no -wal file left)",
    !existsSync(wal) || statSync(wal).size === 0,
  );
  check("clean stop removed the lock file", !existsSync(join(data, "pptaken.lock")));

  // --- 4. Second start: data reused; SIGTERM -------------------------------------------------------------------------
  const port2 = await freePort();
  const base2 = `http://localhost:${port2}`;
  server = startCli(bin, ["--data-dir", data, "--port", String(port2)]);
  await waitFor(server, /Stop\s+press Ctrl\+C/);
  check(
    "second start: no install code, sign-in hint instead",
    !server.stdout.includes("Install code") && server.stdout.includes("Sign in"),
    server.stdout,
  );
  const client2 = new Client({ name: "pptaken-installed-e2e", version: "1" });
  await client2.connect(
    new StreamableHTTPClientTransport(new URL(`${base2}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  const listed = await client2.callTool({ name: "list_presentations", arguments: {} });
  const titles = JSON.stringify(JSON.parse(listed.content[0].text));
  check(
    "second start reuses the data (same key, same decks)",
    titles.includes("Installed check") && titles.includes("Interactive check"),
    titles,
  );
  await client2.close();
  server.child.kill("SIGTERM");
  const termed = await waitExit(server);
  // POSIX: the handler runs and the stop is clean. Windows: the process is terminated at once (no handler).
  check(
    `SIGTERM stops the server (${IS_WINDOWS ? "terminated" : "graceful, code 0"})`,
    termed !== null && (IS_WINDOWS || termed.code === 0),
    termed,
  );
  const after = inspectDb(project, join(data, "pptaken.db"));
  check(
    "after SIGTERM the database is consistent and complete",
    after.integrity === "ok" && after.decks === 2,
    after,
  );

  // --- 5. Third start: stale lock tolerated; default port moves on when busy ----------------------------------------
  const holder = createNetServer();
  const held = await new Promise((r) => {
    holder.once("error", () => r(false));
    holder.listen(8080, "127.0.0.1", () => r(true));
  });
  server = startCli(bin, ["--data-dir", data]);
  const opened = await waitFor(server, /Open\s+(http:\/\/localhost:(\d+))/);
  check(
    `default port 8080 busy${held ? " (held by this test)" : " (in use on this machine)"}: the next free port is used and said`,
    Number(opened[2]) > 8080 && server.stdout.includes("busy, so PPTaken uses"),
    server.stdout,
  );
  check("a stale lock from a terminated run does not block the start", true);
  server.child.send("pptaken:shutdown");
  check("third start stops cleanly", (await waitExit(server))?.code === 0);
  if (held) holder.close();
} catch (error) {
  check(`unexpected error: ${error?.stack ?? error}`, false);
} finally {
  await browser?.close().catch(() => {});
  for (const child of children) child.kill();
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(tmp, "results.json"),
    `${JSON.stringify({ version, platform: process.platform, arch: process.arch, node: process.versions.node, checks }, null, 2)}\n`,
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
  if (keep || failed.length > 0) console.log(`Kept ${tmp} for inspection.`);
  else {
    await sleep(500);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.log(`Could not remove ${tmp} completely.`);
    }
  }
}
process.exit(exitCode);
