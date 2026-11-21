# @pptaken/ui

Design tokens, fonts, icons and Svelte 5 components for PPTaken: the stagehand behind the curtain.
Brand book (Spanish): [`docs/brand/README.md`](../../docs/brand/README.md). Static reference screens: `docs/brand/preview/index.html`.

## Use

```ts
// App root, once. Order matters: fonts, tokens, icons (static HTML only), components.
import "@pptaken/ui/fonts.css";            // audience pages: "@pptaken/ui/fonts-audience.css"
import "@pptaken/ui/tokens.css";
import "@pptaken/ui/components.css";
```

```svelte
<script lang="ts">
  import { Button, CopyField, StatusBadge, setI18n, pickLocale } from "@pptaken/ui";
  setI18n(pickLocale(navigator.languages)); // "en" (default) or "es"
</script>

<Button variant="primary" icon="copy">Copy prompt</Button>
<StatusBadge status="live" />
<CopyField label="Connector URL" value="https://slides.example.com/mcp" />
```

Audience pages (`/a/:code`) set `<html data-surface="audience">` and load `fonts-audience.css` (Inter Latin only, 48 KB). Headings then fall back from Bricolage Grotesque to Inter 800.

**Never** load any of these files inside the deck iframe. The player shell uses only `--ppt-stage-*` tokens (05 §11).

## Rules the components assume

- **One Spotlight per screen.** `variant="primary"` (amber) marks *the* main action or the live item. If two are visible, one is wrong.
- **Curtain** (violet) is for links, selected tabs, selection and the 2 px focus ring.
- **Never colour alone.** Badges carry a dot or icon plus text; notices carry an icon plus a title; quiz options carry shape + colour + letter.
- **Amber is not a warning.** Warnings use `--ppt-warning` with an icon.
- **Laser red** (`--ppt-stage-laser`) is for the pointer only.
- **No emoji** in UI strings.

## Theming

`dist/tokens.css` defines light values on `:root`, dark values under `prefers-color-scheme: dark` (guarded by `:root:not([data-theme="light"])`) and under `[data-theme="dark"]`. Any subtree can force a theme with `data-theme`. `ThemeToggle` writes `data-theme` on `<html>` and stores the choice in `localStorage` (`pptaken.theme`). Panel default: system. Player and remote default: dark.

`prefers-reduced-motion: reduce` collapses `--ppt-motion-*` to short fades and removes the 8 px rise.

## Components

| Component | Notes |
|---|---|
| `Button` | `primary` (Spotlight) / `secondary` / `ghost` / `danger`; `sm` / `md` / `lg`; `icon`, `iconEnd`, `loading` (inline `Loader`), `href`, `block`. Pill, 44 px tall by default |
| `IconButton` | `label` is required (accessible name and tooltip). `pressed` exposes `aria-pressed` |
| `TextField` | Label, hint and error wired with `aria-describedby`; error has an icon. `mono` for tokens and URLs |
| `Card` | `default` / `sunken` / `flush`; `as` picks the element |
| `DeckCard` | 16:9 thumbnail (`thumbnailSrc` or `thumbnail` snippet), status badge, Present + More |
| `Table` | `columns` + `rows`, optional `cell` snippet; `kind: "num"` uses tabular figures |
| `Dialog` | Native `<dialog>`: focus trap, Escape and focus return from the platform. `bind:open` |
| `Notice` | `info` / `success` / `warning` / `danger`, icon + title + text; `danger` is `role="alert"` |
| `Toast`, `ToastRegion`, `toast` | `toast.show("Link copied.")`; render `<ToastRegion />` once |
| `Tabs` | WAI-ARIA tabs, automatic activation, arrows / Home / End |
| `StatusBadge` | `draft` / `live` / `offline` / `connected` / `revoked`; `live` is the Spotlight |
| `BigCode` | Audience join code in JetBrains Mono, one tap selects it, screen readers hear it spelled out |
| `FramedQR` | Frame only: white plate + stage tape corners. The caller renders the QR |
| `CopyField` | Single line or `multiline` prompt block; clipboard with fallback for plain `http://` on a LAN |
| `EmptyState` | Two-ink illustration snippet, title, text, actions |
| `Loader` | "The cue": `page` / `section` / `inline`; polite live region with a hidden "Loading" (`announce={false}` when something else says it); appears after 180 ms; reduced motion holds still |
| `Kbd` | `label` gives a spoken name to symbols (`→`) |
| `ThemeToggle` | System / Light / Dark radio group. `applyTheme()` / `readTheme()` helpers |
| `Logo` | `lockup` / `isotype` / `small` (16 to 23 px). Frame follows `currentColor`, the slide is always Spotlight |
| `Icon` | Phosphor regular (MIT), only the icons in `icons/` are shipped |

Styles live in `components.css` (flat, one class per rule) and the Svelte files only apply class names. The static previews in `docs/brand/preview` link the same file, so what you see there is what the components render.

## Strings

`src/i18n/en.ts` is the source; `src/i18n/es.ts` must have the same keys (the `Dictionary` type enforces it). Components read the translator from context (`setI18n`), defaulting to English. Placeholders use `{name}`.

## Scripts

All dependency-free, run with plain Node 22:

| Command | Does |
|---|---|
| `node scripts/build-tokens.mjs` | `tokens.json` → `dist/tokens.css` + `src/tokens.ts` |
| `node scripts/build-icons.mjs` | `icons/*.svg` → `src/icons.ts` + `dist/icons.css` |
| `node scripts/check-contrast.mjs` | Recomputes every pair of the brand contrast table plus the system's own pairs (83). Exits 1 on any regression |

Generated files are committed. Edit `tokens.json` or `icons/`, never the outputs.

## Fonts

Self-hosted WOFF2 variable fonts, SIL Open Font License 1.1 (license next to each family). Source: Fontsource variable packages v5.3.0, already split by Fontsource into Latin and Latin Extended subsets; the browser downloads the Latin Extended file only when a page uses one of its characters.

| File | Axes | Bytes |
|---|---|---|
| `inter/inter-latin-wght.woff2` | wght 100–900 | 48,256 |
| `inter/inter-latin-ext-wght.woff2` | wght 100–900 | 85,068 |
| `bricolage-grotesque/bricolage-grotesque-latin-opsz-wght.woff2` | opsz 12–96, wght 200–800 | 76,888 |
| `bricolage-grotesque/bricolage-grotesque-latin-ext-opsz-wght.woff2` | opsz 12–96, wght 200–800 | 30,736 |
| `jetbrains-mono/jetbrains-mono-latin-wght.woff2` | wght 100–800 | 40,404 |
| `jetbrains-mono/jetbrains-mono-latin-ext-wght.woff2` | wght 100–800 | 15,196 |

A Latin-only panel page loads 165,548 bytes of fonts; an audience page loads 48,256.

## Licenses inside this package

- Fonts: SIL OFL 1.1 (`fonts/*/OFL.txt`).
- Icons: Phosphor Icons, MIT (`icons/LICENSE-phosphor.txt`).
