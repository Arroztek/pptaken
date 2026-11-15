# @pptaken/player

The PPTaken presentation player engine: a server-side deck document builder with the content-route headers, a
tiny in-iframe runtime (about 10.0 KB, under the 11 KB budget), a validated `postMessage` protocol, the trusted shell
(`createPlayer`), the presenter view (`createPresenter`), window sync over `BroadcastChannel`, the presenter
clock/pace logic, the speaker notes renderer, and offline presenting (in-memory preload with an indicator, an
offline deck document builder and a service worker). Framework-free TypeScript. License: Apache-2.0.

Specification, serving requirements, decisions and open questions: [`docs/spec/player.md`](../../docs/spec/player.md).

```sh
pnpm --filter @pptaken/player build          # tsc + runtime bundle (dist/runtime-source.js)
pnpm --filter @pptaken/player test           # Vitest against dist (build first)
pnpm --filter @pptaken/player test:browser   # builds, then Playwright on Chromium, Firefox and WebKit
```

The builder expects a deck already sanitized by `@pptaken/sanitizer` (a dev dependency here, used by the tests
only).

| Import | Side | What |
|---|---|---|
| `@pptaken/player` | server (and shared) | builder, headers, protocol, navigation, `renderNotes`, `parsePresenterData`, pace, sync |
| `@pptaken/player/shell` | browser | `createPlayer` (no builder, no schema) |
| `@pptaken/player/presenter` | browser | `createPresenter`, `setNotesHtml`, `PRESENTER_CSS` |
| `@pptaken/player/offline-client` | browser | `loadContent`, `keepOfflineCopy`, `offlineCopyStatus` (pages) |
| `@pptaken/player/sync`, `/pace`, `/notes`, `/protocol`, `/navigation`, `/offline`, `/offline-cache` | either | the pure pieces |
| `dist/sw.js` | browser | the service worker (served by the server at `/p/sw.js`) |

## Modes and keys

| Key | Action |
|---|---|
| → Space PgDn Enter / ← Backspace PgUp Shift+Space | next / previous |
| Home / End | first / last |
| `b` `.` / `f` | black screen / full screen |
| `o` | overview: every slide as a thumbnail (fully revealed), grouped by section; arrows, Enter, click, Escape |
| `s` | presenter window (with `presenterUrl`) |
| `p` | print / PDF: every step, one page per slide |
| `?` | key help (neutral gray, on demand) |
| `t` / `Shift+R` | presenter view: start/pause / reset the clock |

`o`, `s`, `p` and `?` forwarded from the content iframe need a real user gesture
(`navigator.userActivation.isActive`): content cannot change the mode, print or open windows by itself.

## Speaker notes: why a hand-written renderer

Notes are Markdown written by the author or their agent, shown only in the trusted presenter view. The subset is
small (paragraphs, line breaks, bold, italic, code, fenced code, lists nested one level, h3/h4, blockquote), and
links and images must **not** be rendered. A general Markdown library would bring far more syntax than needed (raw
HTML, links, autolinks, reference definitions, tables), each feature something to disable and keep disabled across
upgrades, plus a sanitizer pass after it. `renderNotes` (`src/notes.ts`, ~300 lines, no dependency) escapes every
character that is not Markdown syntax and can only emit its fixed allowlist, so there is nothing to sanitize
afterwards; it is linear time (delimiter stack, precomputed backtick pairing, no backtracking regexes) and tested
against a hostile corpus, random input and adversarial shapes (`test/notes.test.ts`, which also re-parses every
output with a strict grammar and with the sanitizer's HTML parser). The presenter view rebuilds the HTML node by
node against the same allowlist before inserting it (defense in depth).

Notes never reach the content document, the content route, the sync channel or the audience: the only way out is
`GET /api/v1/decks/:id/presenter` with the owner session.

## Verified per browser

`test:browser` runs the same checks on Chromium, Firefox and WebKit: navigation, keys, hash, black screen, full
screen, scaling, frame times, the security barrier (hostile content cannot reach the parent, cookies, the API or
the network, and cannot select, switch modes, print or open windows), overview (keys and mouse, sections, steps,
`select` validation, 200-slide performance), key help, print layout, presenter window sync both ways, notes only in
the presenter, previews, clock and pace (real time and Playwright's fake clock). The real PDF (page count = 20,
text on every page) is checked in Chromium only: Playwright exposes `page.pdf()` there only.

Offline: the runtime preloads every image and font face and reports it; the dot and its texts are checked, and every
slide and step is walked with the network cut, both on the content route and on the offline (srcdoc) delivery
path, where the hostile-content checks run again under the production page CSP. How each engine treats the
sandboxed frame and service workers: [spike S4](../../docs/spikes/S4-offline.md).
