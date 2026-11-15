# @pptaken/realtime

The PPTaken remote control (phase F4): the versioned WebSocket protocol with hand-written validators (no zod: these
modules also ship to the phone and the player page), the pure live-session reducer
`(state, event) -> { state, effects }`, the in-memory `RealtimeHub` that runs it, and the framework-free browser
modules served by the server under `/_rt/`: a reconnecting socket client, the screen side of the player page, the
pairing panel (QR, approvals, kick) and the phone page. No runtime dependencies. License: Apache-2.0.

The sockets themselves (the `ws` package, upgrade checks, authentication) live in `apps/server/src/realtime.ts`.

Specification: [`docs/spec/realtime.md`](../../docs/spec/realtime.md). Decisions:
[ADR-017](../../docs/adr/0017-remote-control.md).

```sh
pnpm --filter @pptaken/realtime build   # tsc
pnpm --filter @pptaken/realtime test    # Vitest against dist (build first)
pnpm --filter @pptaken/server test:remote   # Playwright, laptop + phone contexts, Chromium, Firefox, WebKit
```
