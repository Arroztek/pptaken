# Content sanitizer (barrier 1)

Slide HTML, inline SVG, slide CSS and theme CSS are untrusted. Before they are stored or served, the server runs
them through [`@pptaken/sanitizer`](../../packages/sanitizer/README.md), which keeps only allowlisted elements,
attributes, CSS properties and values, and reports what it removed as warnings with stable codes
(`REMOVED_ELEMENT`, `REMOVED_ATTRIBUTE`, `REMOVED_CSS_RULE`, `REMOVED_CSS_PROPERTY`, `REMOVED_URL`,
`INVALID_ASSET_REF`, ...) and a `path` such as `slides[3].html`.

It is the first of the three independent barriers of [ADR-001](../adr/0001-content-format.md); the sandboxed
iframe (opaque origin) and the no-network CSP remain mandatory.

What agents need to know:

- Use HTML structure and text elements, tables, inline `<svg>` (shapes, text, gradients, clip paths, masks,
  patterns, markers, a few filter primitives) and `<img src="asset:<hex>">`. No links, forms, media, scripts,
  `<style>` elements or MathML.
- Put CSS in the slide's `css` field (scoped automatically to the slide: `:root`, `html` and `body` mean the slide)
  or in `theme.css`. `@media`, `@supports` and `@keyframes` are allowed; `@import`, `@font-face` and other
  at-rules are removed.
- The only URLs are `asset:<hex>` references (`<img src>`, SVG `<image href>`, `url()` in backgrounds and masks)
  and `#id` references inside SVG.
- Fonts come from the bundled catalog (or generic families) by name.
- Only `data-step` is allowed among `data-*` attributes.

The exact allowlists, limits, warning codes and the decisions behind them are in the package README.

## Profiles: `safe` and `interactive` (ADR-020)

`sanitizeSlideHtml(html, { profile })` and `sanitizeDeck(deck, { profile })` take a profile; `safe` is the default
and is unchanged. `interactive` is a strict superset for decks that declare author scripts or libraries:

- extra elements, with only these attributes (plus the global ones): `canvas` (width, height), `button` (type
  `button` only, disabled, value), `input` (type `range`, `number` or `checkbox` only: an input without one of them
  is removed; min, max, step, value, checked, disabled), `select` (disabled, multiple, size), `option` (value,
  selected, disabled, label), `label` (for), `output` (for), `progress` (value, max), `meter` (value, min, max, low,
  high, optimum);
- `data-*` attributes (lowercase, at most 32 characters after `data-`), except the reserved `data-slide`,
  `data-section`, `data-width`, `data-height`, `data-scripts` and `data-pptaken*`;
- still removed in both profiles: `<script>` (the warning points to the slide's `script` field), every `on*`
  attribute (the scripted document's CSP also has `script-src-attr 'none'`), links (`<a href>`), forms, frames,
  media, `<textarea>`, other input types.

The lists are policy constants (`INTERACTIVE_ELEMENT_ATTRIBUTES`, `INTERACTIVE_INPUT_TYPES`,
`INTERACTIVE_REMOVED_EXAMPLES`); the MCP authoring guide prints them, and a contract test sanitizes every listed
item (allowed: no warning; removed: a warning).

**One stored rendering, re-sanitized at serve time.** The core sanitizes a deck with scripts or libraries with
the `interactive` profile on ingest, and every other deck with `safe`. Whenever the scripts must not run (every
path except the owner's approved session), the server serves `staticDeck(deck)`: scripts and libraries removed and
the HTML re-sanitized with the `safe` profile, so canvas, controls and `data-*` disappear. Storing two renderings
was rejected (double storage, drift); re-sanitizing is deterministic and only costs time for scripted decks.
