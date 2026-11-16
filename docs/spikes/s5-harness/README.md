# Spike S5 harness: hostile author script in the content frame

Throwaway code for [`../S5-script-mode.md`](../S5-script-mode.md). Not product code: it imports the built
`@pptaken/player` (`packages/player/dist`) only to use the real content headers (`contentHeaders`), the real runtime
(`RUNTIME_SOURCE`), the offline `<meta>` CSP and the real shell (`createPlayer`).

```
pnpm --filter @pptaken/player build        # if packages/player/dist is missing or stale
node docs/spikes/s5-harness/run.mjs        # all sections, Chromium + Firefox + WebKit, about 20 minutes
node docs/spikes/s5-harness/run.mjs --only=net,proto --engines=chromium
node docs/spikes/s5-harness/run.mjs --only=abuse,watchdog --engines=chromium-full,firefox-fission --out=./x.json
```

Engines: `chromium` (Playwright's default headless shell: **no site isolation**, one renderer for every frame),
`chromium-full` (full Chromium build in new headless mode, `channel: "chromium"`: isolates like desktop Chrome),
`firefox` (Playwright's Firefox: Fission off), `firefox-fission` (`fission.autostart` on), `webkit`. The committed
`last-run.json` merges three runs (listed in its `runs` field): the full run on the three default engines, a rerun of
`watchdog` after a fix to its gap window, and `abuse,watchdog` on the two isolated variants.

Sections: `nav` (self-navigation), `net` (network side channels, fresh realms), `abuse` (busy loop, allocation,
rAF storm, 10^6 nodes, big canvas), `watchdog` (heartbeat + frame replacement), `proto` (forged protocol messages
against the real shell), `srcdoc` (offline path with author script). Output: `last-run.json` (rewritten after each
engine).

## Servers (all random ports, loopback only)

| Name | Origin | Role |
|---|---|---|
| app | `http://localhost:A` | harness shell (`/shell`, CSP like `playerCsp`), real player page (`/proto`), `/_player/` (dist), same-origin content |
| site2 | `http://localhost:B` | content, same-site cross-origin |
| xsite | `http://127.0.0.1:C` | content, cross-site |
| listener | `http://[::1]:L` | attacker server: logs every request and WebSocket upgrade (a different site from all of the above) |
| stun, stun2 | `udp 127.0.0.1` | count STUN packets (stun2 only for the fresh-realm probes) |
| turn, preconnect | `tcp 127.0.0.1` | count raw TCP connections |

The content document is runtime + four slides + one author script (`PROBE` in `server.mjs`). Its text is constant
(configuration comes from `<body data-cfg>`) so one `sha256` covers it in the hash-only variant and in the page CSP
for `srcdoc`. Variants: `prod` (production headers; runtime and author script share the nonce, the obvious way to
enable author scripts), `prod+webrtc 'block'`, `hash-only script-src` (no nonce in the document at all).

Shell CSP `strict` = `playerCsp` shape (`frame-src 'self' <site2> <xsite>`); `loose` = `frame-src *` (control).

## Measurement notes

- Requests are attributed by a token in the URL path; UDP/TCP by the current test label (tests run sequentially).
- Playwright's `page.evaluate` grants transient user activation to the page (Chromium reports `isActive` true
  inside any evaluate). The `proto` section therefore does no evaluate and no input for 10 s, then one real click,
  and the page records `navigator.userActivation.isActive` when each message arrives.
- Abuse: the parent runs a 20 ms `setInterval` heartbeat; "gap" is the largest interval between ticks.
  Key latency = time from Playwright sending a key to the parent's `keydown` (focus on a parent button).
- Chromium only: out-of-process iframes and renderer count through CDP (`Target.getTargets`,
  `SystemInfo.getProcessInfo`).
- `dns-prefetch` cannot be observed with loopback servers (no resolver in the loop); it is reported as unmeasured.
- The allocation probe stops at 1.5 GB (64 MB chunks) to keep the machine usable: it is a bounded bomb.
