# @pptaken/sanitizer

Allowlist-based sanitizer for untrusted slide content (HTML, inline SVG and CSS). It is **barrier 1** of the
PPTaken content trust model ([ADR-001](../../docs/adr/0001-content-format.md),
[security §4](../../docs/foundation/04-security-and-auth.md)). Barriers 2 and 3 (the sandboxed iframe with an
opaque origin and the no-network CSP) must stay in place: a sanitizer is a single barrier and sanitizers fail.

License: AGPL-3.0-or-later.

## Threat model

Slide HTML/CSS is written by an AI agent that may have been manipulated by prompt injection, and in the future
cloud by arbitrary third parties. We treat every byte as hostile. The sanitizer must:

- remove everything that can execute code (scripts, event handlers, `javascript:` URLs, SMIL, plugins, frames);
- remove everything that can load something from outside the deck (any URL other than an `asset:<hex>`
  reference, `@import`, `@font-face`, external `url()`, `<link>`, `<meta>` refresh, `<base>`);
- keep slide CSS inside its slide (selector scoping), so one slide cannot restyle another slide;
- resist parser differentials and mutation XSS (mXSS);
- never throw, never hang, and fail closed (empty field plus a warning) on pathological input;
- tell the agent what it removed (warnings with stable codes) without echoing the payload.

Out of scope (handled elsewhere or accepted): visual deception inside the canvas (a slide that imitates a
dialog), CPU-heavy but harmless rendering (huge blur filters, long animations), and speaker notes (Markdown,
rendered by the trusted UI with its own stricter rules).

## How it works

- **HTML** is parsed with [`parse5`](https://github.com/inikulin/parse5), a WHATWG-compliant parser that builds
  the same tree a browser builds (including foreign content, foster parenting, raw-text elements and the
  scripting flag). The input is parsed as the children of a `<section>` (the element the player puts it in),
  a **new** tree is built from allowlisted nodes only, and it is serialized with parse5.
- **mXSS defense**: the serialized output is parsed and sanitized again until it is a fixed point (at most two
  extra passes). If it does not converge the field fails closed with `UNSTABLE_OUTPUT`. This also makes the API
  idempotent: `sanitize(sanitize(x)) === sanitize(x)`.
- **CSS** (slide `css`, theme `css` and `style` attributes) is parsed with
  [`css-tree`](https://github.com/csstree/csstree), a spec-based CSS parser; the output is rebuilt from
  validated nodes only (any node type we do not know, including unparsed `Raw` nodes, removes the declaration
  or rule). The same fixed-point check is applied.
- **No regular expressions parse HTML or CSS.** Regular expressions only validate single, already tokenized
  values (an id, a number, a hex color, an asset reference).

### Why these parsers

| Need | Choice | Why |
|---|---|---|
| HTML | `parse5` **8.0.1** (pinned) | Implements the WHATWG parsing algorithm (the one browsers use), including SVG/MathML namespaces and integration points, which is what mXSS exploits. Widely used (jsdom, Angular, cheerio), maintained, one dependency (`entities`). 8.0.1 rather than the newest 8.1.1 because the newest release was only days old when this package was created. |
| CSS | `css-tree` **3.2.1** (pinned) | Spec-based tokenizer and parser with a typed AST for selectors, at-rule preludes and values (we need `Url`, `Function`, `String` nodes with decoded values). Used by csso and stylelint tooling. It keeps escapes in identifiers raw, which lets us refuse them; it decodes strings and URLs, which lets us validate what the browser will see. |

`postcss` was considered for CSS; its values are plain strings, so we would have needed a second value parser
and a hand-written tokenizer for escapes, which is exactly what we want to avoid.

## API

```ts
import { sanitizeCss, sanitizeDeck, sanitizeSlideHtml } from "@pptaken/sanitizer";

sanitizeSlideHtml(html, { path?: string, maxLength?: number }): { html: string; warnings: Warning[] }
sanitizeCss(css, { scope?: string, path?: string, maxLength?: number }): { css: string; warnings: Warning[] }
sanitizeDeck(deck, { slideScope?: (slideId) => string }): { deck: Deck; warnings: Warning[] }
```

- `sanitizeSlideHtml` returns HTML that is safe to put **inside** the `<section>` of a document served with the
  no-network CSP (either as `innerHTML` of that section or by string concatenation between `<section ...>` and
  `</section>`; the output is always a balanced serialization of a tree).
- `sanitizeCss` returns CSS that is safe to put inside a `<style>` element (it never contains `</` or `<!`).
  With `scope` (for example `[data-slide="intro"]`), every selector is rewritten to match only inside the scope;
  a leading `:root`, `html` or `body` (and runs such as `html body`) maps to the scope element itself. The scope
  must be a single compound selector made of attribute, class or id selectors.
- `sanitizeDeck` sanitizes every slide's `html` and `css` (scoped with `[data-slide="<id>"]` by default, so the
  player must put `data-slide="<id>"` on the element that contains each slide) and the theme CSS (not scoped).
  It returns a new deck; the input is not modified. Notes, titles and other fields are not touched.
- All functions are deterministic and never throw on hostile content.

### Warnings

```ts
interface Warning { code: WarningCode; message: string; path?: string; name?: string }
```

`path` uses the MCP error style (`slides[3].html`, `slides[3].css`, `theme.css`). `name` is the removed element,
attribute, property or at-rule, truncated to 40 characters with control and bidi characters replaced: warnings
never carry the hostile payload. Warnings are deduplicated and capped at 100 per field (plus one
`TOO_MANY_WARNINGS`). Comments, doctypes and SVG namespace declarations (`xmlns`, `xmlns:xlink`) are removed
silently because they are expected noise.

| Code | Meaning |
|---|---|
| `REMOVED_ELEMENT` | Element removed together with its content |
| `UNWRAPPED_ELEMENT` | Harmless but unknown element removed, children kept (`<a>`, `<font>`, custom elements) |
| `REMOVED_ATTRIBUTE` | Attribute removed (event handler, unknown attribute or invalid value) |
| `REMOVED_CSS_RULE` | Rule or at-rule removed (`@import`, `@font-face`, selector escaping the slide...) |
| `REMOVED_CSS_PROPERTY` | Declaration removed (unknown property or unsafe value) |
| `REMOVED_FONT_FAMILY` | Font family not in the bundled catalog removed from a `font`/`font-family` list |
| `REMOVED_URL` | URL removed (only `asset:<hex>`, and `#id` fragments for SVG paint, are allowed) |
| `INVALID_ASSET_REF` | Image whose source is not a valid `asset:<hex>` reference; the image was removed |
| `INPUT_TOO_LARGE` | Field above its size limit; emptied |
| `LIMIT_EXCEEDED` | Depth/node/rule/nesting limit exceeded; emptied |
| `UNSTABLE_OUTPUT` | Output did not reach a fixed point on re-parse (mXSS defense); emptied |
| `INTERNAL_ERROR` | Unexpected error or invalid input type; emptied |
| `TOO_MANY_WARNINGS` | Summary of warnings beyond the cap |

## Policy (deny by default)

The machine-readable policy is [`src/policy.ts`](src/policy.ts) (also exported as `policy`). Tables here mirror it.

### HTML elements

| Allowed | |
|---|---|
| Structure and text | `div span p br hr h1-h6 ul ol li dl dt dd blockquote pre code kbd samp var mark small strong em b i u s sub sup abbr cite q time figure figcaption section article aside header footer main nav address del ins wbr bdi bdo ruby rt rp` |
| Tables | `table thead tbody tfoot tr th td caption colgroup col` |
| Media | `img` (only with `src="asset:<hex>"`), `svg` (see below) |

Additions to the brief: `del ins wbr bdi bdo ruby rt rp` (inline text semantics, no attributes beyond the global
ones). **Removed with their content**: `script style iframe frame frameset object embed applet param noscript
noembed noframes template xmp plaintext listing textarea title head base basefont link meta form input button
select option optgroup datalist output keygen audio video source track picture canvas dialog details summary slot
portal fencedframe marquee blink menu menuitem image isindex map area html body search selectedcontent`, all of
MathML, and SVG elements outside the SVG allowlist. **Unwrapped** (children kept): every other HTML element,
including `a` (no links in v1) and custom elements. Comments, CDATA sections and processing instructions are
removed.

### HTML attributes

| Attribute | Where | Rule |
|---|---|---|
| `class` | all | tokens `[A-Za-z_-][A-Za-z0-9_-]{0,63}`, at most 32; tokens starting with `pptaken` are dropped (reserved for the runtime) |
| `id` | all | `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, not in the DOM-clobbering denylist (case-insensitive), not starting with `pptaken` |
| `style` | all | parsed as a declaration list and filtered with the CSS rules; at most 8 KB |
| `lang` | all | BCP-47 shape |
| `dir` | all | `ltr`, `rtl`, `auto` |
| `title` | all | text (control characters removed), at most 2 KB |
| `role` | all | one static role from the allowlist (`img`, `list`, `figure`, `heading`, `table`...); interactive and live-region roles (`button`, `link`, `dialog`, `alert`...) are refused so content cannot pose as controls |
| `aria-*` | all | name `aria-[a-z]{3,24}`, value text up to 512 characters |
| `data-step` | all | empty or an integer 1..99; no other `data-*` (they could fake the player's own `data-slide` hooks) |
| `hidden` | all | `""`, `hidden` or `until-found` (hiding is harmless; useful for speaker-only drafts) |
| `translate` | all | `yes`/`no` |
| `src` `alt` `width` `height` | `img` | `src` must match `ASSET_REF_PATTERN` exactly (after entity decoding, no trimming); sizes are integers |
| `colspan` `rowspan` | `td` `th` | integers up to 65534; `th` also `scope` (`row col rowgroup colgroup`) |
| `start` `type` `reversed` | `ol` | integer; `1 a A i I`; boolean |
| `value` | `li` | integer |
| `span` | `col` `colgroup` | integer |
| `datetime` | `time` | `[0-9A-Za-z:+\-. ]{1,64}` |

Never allowed: `on*`, `href` (HTML), `src` except on `img`, `srcset`, `srcdoc`, `formaction`, `action`, `name`,
`is`, `ping`, `target`, `rel`, `download`, `autofocus`, `accesskey`, `tabindex`, `contenteditable`,
`draggable`, `inert`, `popover`, `cite`, `background`, `xlink:*` on HTML elements, and anything else not listed.
`tabindex`, `contenteditable` and `draggable` are refused because the content must not take keyboard focus or
capture input meant for the clicker (keys are forwarded to the shell).

**DOM clobbering rule.** Elements with an `id` become named properties of `window` (and, for some elements, of
`document`). The only script inside the content iframe is the PPTaken runtime; an `id` such as `location`,
`parent`, `top`, `document`, `name`, `__proto__` or `constructor` could shadow something it reads. The
denylist (`CLOBBER_DENYLIST`) holds the `window`/`document`/`Object.prototype` names a runtime is likely to use,
compared case-insensitively. `name` is never allowed. The runtime should still not read globals that content
can define (use module-scoped references).

### SVG

Elements: `svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath
linearGradient radialGradient stop clipPath mask pattern marker title desc image filter feGaussianBlur feOffset
feBlend feColorMatrix feComposite feFlood feMerge feMergeNode`. `a` is unwrapped. Everything else in the SVG
namespace (`script style foreignObject animate animateMotion animateTransform set mpath switch feImage feTile
iframe handler`...) is removed with its content.

- `title` and `desc` may only contain text: they are HTML integration points, where the parser builds HTML
  elements inside SVG.
- An HTML element can only appear inside SVG through an integration point, so any HTML element found under an
  SVG element is removed with its content; the only SVG element allowed directly in HTML is `svg`.
- `href` (and `xlink:href`, normalized to `href`) is allowed on `use textPath linearGradient radialGradient
  pattern filter` as a same-document fragment `#id` (safe id pattern), and on `image` only as `asset:<hex>`.
- `<use>` must reference an element **of the same slide** that is not its ancestor and contains no `<use>`
  itself. This blocks exponential expansion (the SVG "billion laughs") and cycles. At most 500 `use` per slide.
- Presentation attributes (`fill stroke stroke-* opacity fill-opacity stop-color font-* text-anchor
  dominant-baseline clip-path mask filter marker-*` and more, see `SVG_ATTRIBUTES`) are validated as CSS values
  of the property with the same name, so `fill="url(#g)"` passes and `fill="url(http://x)"` does not.
- Geometry: `d` (path data alphabet only), `points` (numbers), `transform`/`gradientTransform`/`patternTransform`
  (numbers plus `matrix translate scale rotate skewX skewY`), coordinates and sizes (`[0-9A-Za-z.,%+\- ]`, no
  parentheses), enumerations (`gradientUnits`, `preserveAspectRatio`...) checked against their value lists.
- **SMIL decision: dropped entirely.** `animate`, `animateMotion`, `animateTransform`, `set` and `mpath` are
  removed. Validating `attributeName`/`values` is possible, but SMIL can retarget `href` and event attributes in
  ways that have produced real bypasses, and CSS animations cover the need.
- `feDropShadow` is not allowed: the HTML parser's SVG tag-name table does not adjust it, so in HTML it becomes
  an inert `fedropshadow` element. Use `feGaussianBlur` + `feOffset` + `feMerge`, or CSS `filter: drop-shadow()`.

### URLs

The only external-looking value allowed anywhere is the asset reference `asset:<16-64 lowercase hex>`
(`ASSET_REF_PATTERN` from `@pptaken/schema`), matched exactly against the attribute value as the browser sees
it (after entity decoding). Everything else is removed: `http:`, `https:`, `//host`, `data:`, `javascript:`,
`vbscript:`, `blob:`, `file:`, `mailto:`, relative paths, and every whitespace, entity, case, NUL or control
character variant of them, because none of them can match the strict pattern. Fragment references `#id` are
allowed only in SVG `href`s (above) and in `url(#id)` for SVG paint/clip/mask/filter/marker properties.

### CSS

| | Rule |
|---|---|
| At-rules | only `@media`, `@supports` (conditions made of known node types; `@supports` declarations validated like any declaration) and `@keyframes` (identifier name; `from`, `to` and percentages), nested at most 3 deep, contents filtered by the same rules. Removed: `@import @font-face @namespace @charset @property @container @layer @scope @page @counter-style @font-palette-values @starting-style` and any other |
| Selectors | type, class, id, attribute (`= ~= |= ^= $= *=`, flags `i`/`s`) selectors, combinators (descendant, `>`, `+`, `~`), pseudo-classes `root first-child last-child only-child nth-*() *-of-type empty not() is() where() has() hover active focus focus-within focus-visible lang() dir()`, pseudo-elements `::before ::after ::first-line ::first-letter ::marker ::selection`. No escapes, no namespaces, no nesting (`&`), no `:host`/`::slotted`/`::part`, no class or id starting with `pptaken` |
| Scoping | with `scope`, each selector becomes `scope descendant...`; a leading `:root`/`html`/`body` run becomes the scope element itself; root-like selectors anywhere else (also inside `:is()`/`:not()`...) and sibling combinators right after the scope (`body ~ x`) remove the selector |
| Properties | allowlist `CSS_PROPERTIES` (layout, box model, flex, grid, typography, colors, backgrounds, borders, shadows, transforms, transitions, animations, filters, masks, SVG presentation properties...). Custom properties `--name` are allowed and their values are filtered like any other value |
| Values | every token must be an identifier, number, dimension, percentage, hex color, string (no `<`, `\`, control characters; at most 512 characters), operator `, / + - *`, a function from `CSS_FUNCTIONS` (colors, gradients, math, `var`, transforms, easing, filter functions, `repeat minmax fit-content`, basic shapes, `counter(s)`), or a `url()`. Anything unparsed (`Raw`) removes the declaration. `!important` is kept; other `!` flags are removed |
| `url()` | `url(asset:<hex>)` only in `background(-image) border-image(-source) list-style(-image) mask(-image) -webkit-mask(-image)` and custom properties; `url(#id)` only in `fill stroke clip-path mask filter marker*` and custom properties. `content: url()` is never allowed. Removed functions: `image() image-set() -webkit-image-set() cross-fade() element() -moz-element() paint() src() attr() env() expression()` |
| Fonts | literal family names in `font-family` and `font` must be catalog fonts (`FONT_CATALOG`) or generic families; other names are dropped from the list (the declaration is removed if nothing remains). `var()` is allowed in font values |
| Escapes | backslash escapes outside strings (`\75rl(`, `c\olor`) make css-tree produce raw or escaped tokens, which never match the allowlists. Escapes inside strings are decoded by css-tree and validated on the decoded value. Comments inside tokens (`u/**/rl(`) split them into tokens that do not match |
| `z-index` | literal integers must be within ±9999 |

### Interactive profile (ADR-020)

`profile: "interactive"` (`sanitizeSlideHtml`, `sanitizeDeck`) adds, for decks with owner-approved author scripts only:
`canvas`, `button` (type `button`), `input` (type `range`, `number` or `checkbox`; any other or no type removes the
input), `select`, `option`, `label`, `output`, `progress`, `meter`, their value attributes
(`INTERACTIVE_ELEMENT_ATTRIBUTES`) and `data-*` attributes except the reserved ones. Everything else above still
applies: no `on*`, no links, forms, frames, media or scripts (`<script>` now warns that code belongs in the slide's
`script` field). `staticDeck(deck)` is the static fallback: scripts and libraries dropped, HTML re-sanitized with the
safe profile. See [docs/spec/sanitizer.md](../../docs/spec/sanitizer.md).

## Limits

Size limits are those of `@pptaken/schema` `LIMITS` (slide HTML 256 KB, slide and theme CSS 64 KB, UTF-16 code
units). Internal limits (`SANITIZER_LIMITS`), all fail closed for the whole field unless noted:

| Limit | Value |
|---|---|
| Attributes in one tag (cost guard before parsing) | 1 024 |
| Estimated unclosed elements (cost guard before parsing) | 2 048 |
| Top-level nodes of a slide (cost guard before parsing) | 2 000 |
| Element nesting depth | 64 |
| Parsed nodes per slide | 40 000 |
| Attributes kept per element | 64 (extra ones dropped) |
| Attribute value length | 2 KB (`style` 8 KB, SVG geometry 64 KB; the attribute is dropped) |
| CSS bracket nesting (checked before parsing) | 32 |
| CSS rules per stylesheet | 4 000 |
| Selectors per rule | 64 (rule dropped) |
| Conditional at-rule nesting | 3 (rule dropped) |
| `<use>` per slide | 500 (extra ones dropped) |

**Cost guards.** The HTML parsing algorithm has quadratic corners, in parse5 and in browsers alike: duplicate
attribute detection is linear per attribute (40 000 distinct attributes in one tag took 4.7 s), the adoption
agency walks the stack of open elements (deep unclosed formatting elements took 2.2 s), and parse5 moves a
fragment's top-level children with `indexOf` + `splice` (30 000 top-level `<br>` took up to 3 s). Before
parsing, a single linear scan estimates those three quantities and fails closed when they are absurd. The scan is
not a parser and makes no safety decision; it over-estimates (it does not skip comments or raw-text elements), so
it can only reject more input, never let more through. Legitimate slides are far below these numbers.

Sanitizing a realistic 256 KB slide takes about 0.2 s on a laptop (the test bound is 2 s); every pathological
input in the corpus and the unit tests fails closed in a few milliseconds.

## Decisions where the brief said "decide"

| Topic | Decision | Reason |
|---|---|---|
| `hidden` | allowed | harmless, and the step runtime may rely on it |
| `contenteditable`, `draggable`, `tabindex` | refused | content must not take focus or capture input meant for the clicker |
| SMIL | dropped entirely | `attributeName` retargeting is a proven bypass class; CSS animations suffice |
| `@property` | removed | it registers globally (not scoped to the slide) and accepts `<url>` initial values |
| `@container` | removed (v1) | not needed for fixed-size canvases; fewer prelude shapes to validate. Revisit if agents need it |
| `position: fixed` | allowed | the content lives in an iframe and cannot cover the player chrome; inside the canvas it is just layout |
| `z-index` | literal values bounded to ±9999 | lets the in-iframe runtime keep its own overlays above content without an arms race |
| Attribute selectors and exfiltration | no special rule | CSS exfiltration needs a network request (`url()`, `@import`, `@font-face`), all of which are removed, and barrier 3 blocks the network anyway |
| `data-*` other than `data-step` | refused | could fake the player's hooks (`data-slide`) and be used to style other slides' scoped CSS |
| Font names via `var()` | allowed, not checked | no `@font-face` and no network, so an unknown family can only fall back to a local font |

## Testing

```sh
pnpm --filter @pptaken/sanitizer test          # unit + corpus + legit + fuzz (Vitest, no browser)
pnpm --filter @pptaken/sanitizer test:browser  # builds, then Playwright on Chromium, Firefox and WebKit
```

- `test/corpus.test.ts`: every vector in `corpus/*.json` is sanitized; the **parsed output** is walked with
  parse5/css-tree and must contain no disallowed element, no foreign-content escape, no `on*` attribute, no
  URL-bearing attribute with a non-asset value, no forbidden at-rule/function/property/url in CSS, and scoped CSS
  must stay in its scope. Every vector must be idempotent. Every vector with a payload must produce a warning.
- `corpus/legit.json` (17 realistic slides) must sanitize with **zero warnings** and keep the listed structure.
- `test/unit.test.ts`: targeted policy tests, deck paths, warning format, limits, performance, and every deck in
  `packages/schema/examples/*.json` must sanitize with zero warnings (skipped when the folder is empty).
- `test/fuzz.test.ts`: 2 500 HTML and 1 500 CSS seeded random mutations of the corpus (deterministic), same
  invariants, idempotence, no exceptions.
- `browser/run.mjs` (adapted from the S1 spike harness): serves every vector **raw** and **sanitized** from a
  server that reproduces the production isolation (response header `Content-Security-Policy: sandbox
  allow-scripts; default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src
  'nonce-<random per response>'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'` and
  `<iframe sandbox="allow-scripts">`), with a nonce-authorized instrumentation script that turns
  `alert/confirm/prompt/print` into canaries. The parent page holds a session cookie (`HttpOnly; SameSite=Lax`,
  like production) plus an informational cookie without `SameSite`, and a fake API that records every hit and the
  cookies it received. Phases, per engine:
  1. **controls**: a nonce-authorized `alert()` and an external image in a document without CSP must both be
     detected (the harness tests itself);
  2. **sanitized** (every vector plus the legitimate slides): no canary, `window.__pwned` never set, **no request
     of any kind**, every document completes;
  3. **raw, planned CSP**: no canary; requests other than same-origin subresources of the content route only for
     vectors marked `rawNetworkLeak`; findings are recorded;
  4. **raw, hardened CSP** (`img-src`/`font-src` limited to `<origin>/c/asset/`): the same, and the session cookie
     must never be sent except through the documented navigation gap.

  Results go to `browser/last-run.json`.

### Adding a corpus vector

Add an object to the relevant `corpus/*.json` file (or a new file):

```json
{ "id": "unique-kebab-id", "category": "svg", "source": "own | OWASP ... (own variation) | ...",
  "html": "<svg onload=alert(1)>", "notes": "What it tries." }
```

Use `css` for stylesheet vectors, `htmlGenerator`/`cssGenerator` (`{ prefix, unit, times, suffix }`) for large
generated inputs, and `rawNetworkLeak` (a reason) only for vectors that the browser test shows leak a request
**when not sanitized** (a documented gap of barriers 2-3). Absolute-path or external URLs in such vectors should
carry `?v=<vector id>` so the browser test can attribute the request. Write your own variations; do not paste third-party
vector dumps. When a vector breaks the sanitizer, fix the policy and keep the vector.

## What barriers 2-3 do and do not guarantee (measured by the browser test)

Sanitized output: in Chromium, Firefox and WebKit, no canary, no request of any kind, no crash.

With **raw, unsanitized** content in the production isolation (Playwright 1.65 engines on Windows):

- **Guaranteed** in all three engines: no author script runs (inline scripts, event handlers and `javascript:`
  URLs are blocked by `script-src 'nonce-…'` without `'unsafe-inline'`, nonce guessing fails with a per-response
  nonce), nothing reaches the parent window, the content has an opaque origin, and external subresources
  (`http://evil.test/...`) are blocked by the CSP.
- **Not guaranteed, finding 1 — `img-src 'self'` is the whole origin.** For a sandboxed document `'self'` still
  means the origin of its URL, so raw `<img src="/api/anything">` sends a GET to the PPTaken API (the response
  cannot be read). Chromium sends no `SameSite=Lax` cookie with it; **WebKit sends the `SameSite=Lax` session
  cookie** (it considers the request same-site), and Firefox and WebKit send cookies without `SameSite`. Raw
  relative URLs such as `<img src=x>` likewise produce cookie-bearing GETs to `/c/...` in WebKit.
  *Recommendation:* restrict `img-src` and `font-src` to the asset path (`img-src <origin>/c/asset/`); the
  hardened phase shows this removes every such request in all engines. Keep API `GET`s free of side effects.
- **Not guaranteed, finding 2 — navigation.** A raw `<meta http-equiv="refresh">` navigates the sandboxed iframe
  itself to any URL (CSP has no navigation directive): an external GET that can leak data in its URL, or a GET to
  the PPTaken API that **carries the `SameSite=Lax` session cookie in WebKit**. No CSP variant stops it. The
  sanitizer removes `<meta>`. *Recommendations:* serve content from a separate, cookie-less origin (already
  planned for the cloud as `*.pptaken-usercontent.com`; worth doing for self-hosted instances too, for example a
  second port or host name), keep API `GET`s side-effect free, and have the player treat an unexpected `load`
  of the content iframe as a fault.
- **Not guaranteed, finding 3 — renderer DoS.** In Chromium, raw depth bombs (20 000 nested `div`s, nested
  formatting elements, nested tables) crash the renderer, and because the sandboxed iframe shares the process of
  the parent page, **the player tab crashes with it**. The sanitizer fails closed on all of them. The sandbox
  isolates privileges, not availability.

## Known residual risks and open questions

- **Parser differential with real browsers.** parse5 follows the WHATWG algorithm, but browser parsers evolve
  (for example the 2025 changes to `<select>` parsing). Mitigations: the fixed-point re-parse, the narrow
  allowlist (no `select`, `option`, `template`), and the browser test. Keep parse5 updated and re-run the
  browser test on every upgrade.
- **Document-wide names.** `@keyframes` names and SVG ids are document-global: slide B can override slide A's
  animation, and `url(#id)` may resolve to an element of another slide when ids collide. Visual only. *Open
  question:* should the server prefix ids and keyframe names with the slide id?
- **Cross-slide `<use>` chains.** `<use>` validation is per slide, but the browser resolves `#id` to the first
  element with that id in the whole document. With colliding ids across slides, a `<use>` can end up pointing
  at another slide's element that itself contains `<use>`, rebuilding a chain (a rendering DoS, not an escape).
  *Open question:* enforce deck-wide unique ids in `sanitizeDeck`, or prefix ids per slide on the server, or
  keep only the current and neighbouring slides in the DOM.
- **Theme CSS is unscoped** by design and can style the whole content document, including any runtime element
  inside the iframe. The theme comes from the same author as the slides.
- **Visual deception** (fake dialogs) inside the canvas is not addressed by the sanitizer (accepted residual risk
  in security §4).
- **Rendering cost.** Large blur filters, many gradients or long animations can make a slide slow; they cannot
  escape the iframe.
- **`asset:` references are kept as-is.** The server must rewrite them to content-route URLs on the parse tree
  (or by exact token replacement of `ASSET_REF_PATTERN` matches), never by loose string substitution.
- **Open question: links.** `<a>` is unwrapped in v1. If links are wanted later they need a navigation policy
  in the player (the sandbox already blocks top navigation and popups).
