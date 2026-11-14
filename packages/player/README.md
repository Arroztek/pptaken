# @pptaken/player

The PPTaken presentation player engine (phase F1): a server-side deck document builder with the content-route
headers, a tiny in-iframe runtime, a validated `postMessage` protocol and the trusted shell (`createPlayer`).
Framework-free TypeScript. License: Apache-2.0.

Specification, serving requirements, decisions and open questions: [`docs/spec/player.md`](../../docs/spec/player.md).

```sh
pnpm --filter @pptaken/player build          # tsc + runtime bundle (dist/runtime-source.js)
pnpm --filter @pptaken/player test           # Vitest against dist (build first)
pnpm --filter @pptaken/player test:browser   # builds, then Playwright on Chromium, Firefox and WebKit
```

The builder expects a deck already sanitized by `@pptaken/sanitizer` (a dev dependency here, used by the tests
only). Browser code should import `@pptaken/player/shell`.
