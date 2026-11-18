# Bring your Claude artifact

Claude often answers "make me a presentation" with an **HTML artifact**: one page with inline styles, Google Fonts,
a chart library from a CDN, images by URL and a few scripts. PPTaken can turn that page into a presentation on your
own instance, as it is. The decisions and limits are in [ADR-022](../adr/0022-vendoring-and-html-importer.md).

## How

Ask your agent (connected to PPTaken over MCP) to call **`import_html_deck`** with the artifact's whole HTML, for
example: *"Import this artifact into PPTaken"*. You get back the presentation's links, how it was split into slides,
which external files were copied, and warnings.

## What happens

1. **Slides.** PPTaken looks, in this order, for elements with `data-slide`, elements with the class `slide`, a group
   of sibling `<section>`s, then `<h1>`/`<h2>` headings. Otherwise the page becomes one slide. Each slide is a fixed
   1920×1080 canvas; `100vw`/`100vh` become the canvas size.
2. **Fonts, images, stylesheets, libraries.** Every https resource is downloaded **once** by your PPTaken, checked,
   stored and the slides point to the stored copy. Nobody who watches your presentation (or its offline copy)
   contacts Google Fonts, the CDN or the image host. The presentation page in the panel lists them under
   **Vendored resources**, with where each one came from.
3. **Code.** Inline scripts and `onclick=…` handlers become the presentation's script; CDN libraries become its
   libraries. **Nothing runs until you review and approve it** in the panel (see
   [Interactive presentations](interactive-decks.md)); until then, and on phones, exports and offline copies, you see
   the static version.

## What changes, honestly

- PPTaken drives navigation (arrows, space, clicker, phone remote). The artifact's own navigation code is kept but
  can no longer hide slides; its buttons and counters are hidden.
- A long scrolling page imported as one slide is cut at the bottom: mark the slides with `class="slide"` or
  `<section>`s and import again.
- Forms keep only sliders, number inputs, checkboxes, buttons and selects. Links are not clickable.
- What cannot work: live data from the network (APIs, WebSockets), embedded videos, maps or other pages (iframes),
  ES modules (ask for the library's UMD build), and React/JSX artifacts that need a transpiler in the page (ask for a
  plain HTML/JS version).
- Your PPTaken's operator can turn downloads off (`PPTAKEN_VENDOR_FETCH=off`) or limit them to some hosts
  (`PPTAKEN_VENDOR_ALLOW_HOSTS`, `PPTAKEN_VENDOR_DENY_HOSTS`). With downloads off, artifacts that use external files
  are refused with a clear message.
- Fonts and libraries keep their licences; publishing a presentation that contains them is your responsibility.
