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
