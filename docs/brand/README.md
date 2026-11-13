# PPTaken · Brand book

> The final design system, built on the direction in [`../foundation/05-visual-identity.md`](../foundation/05-visual-identity.md).
> Code and tokens: [`packages/ui`](../../packages/ui/README.md). Reference screens: [`preview/index.html`](preview/index.html) (it must be served over HTTP for the fonts to load; see §14).

---

## 1. Concept: the stagehand crew

Before the curtain rises there is a minute of silence that nobody in the audience sees. One hand coils a cable, another checks that the microphone breathes, someone on the catwalk aims the follow-spot at the exact spot where the speaker will stand. Then darkness; then a single cue. And the light falls, amber, on one place only.

That is PPTaken. It does not paint the set: your agent paints the set. PPTaken is the people in black, the craft nobody applauds because when it works you do not notice it. Its aesthetic is that of the wings: **dark matte wood, script paper with pencil notes, spike tape on the floor, a single beam of light**. Nothing shines for the sake of shining. Everything that is lit is lit because it matters.

Three gestures come from it and repeat across the whole system:

- **A single Spotlight.** The amber `#FFB224` is the follow-spot. It marks *the* action or *the* element on stage. If there are two, one is too many. On the remote it is the Next button; on the podium, first place; in the list, the presentation that is live.
- **The 16:9 rectangle.** The screen is our unit of measure: the eye of the P, the thumbnails, the illustrations.
- **The curtain fade.** Appearing is rising 8 px while opacity reaches one, in 200 ms and without bounce. Disappearing is even faster.

One sentence for every doubtful decision: **backstage calm, spotlight precision.**

## 2. Personality and voice (summary)

Archetype: the stage manager. Speaks little, in the second person, verbs first and no exclamation marks. Explains what is happening and what to do, without blame. Dry, scarce humor, never in an error. AI is called "your agent" or "Claude", never "magic". No emojis in the interface. Full detail is in 05 §2–§3; the bilingual copy bank is in §10 of this document.

## 3. Final palette

The values from 05 are kept except **light Warning** (see §12). Ratios recalculated with `node packages/ui/scripts/check-contrast.mjs` (WCAG 2.x formula): **83 pairs checked, 83 pass, 0 fail.**

### 3.1 Roles

| Token (`--ppt-…`) | Role | Light | Dark |
|---|---|---|---|
| `bg` | Paper / Backstage | `#FAF7F2` | `#0F1115` |
| `surface` | Cards, panels | `#FFFFFF` | `#181B22` |
| `surface-2` | Sunken areas, hover | `#F3EEE6` | `#20242D` |
| `border` | Decorative separators | `#E4DED3` | `#2A2F3A` |
| `border-strong` | Control outline | `#767C8C` | `#8B8FA0` |
| `text` | Ink / Chalk | `#16181D` | `#F2EFE9` |
| `text-muted` | Secondary | `#565C6B` | `#A3A9B8` |
| `accent` | **Spotlight** (fill) | `#FFB224` | `#FFB224` |
| `accent-hover` | Spotlight on hover *(new)* | `#F2A30C` | `#F2A30C` |
| `on-accent` | Text on Spotlight | `#16181D` | `#16181D` |
| `accent-text` | Spotlight as text ("Draft") | `#8A5A00` | `#FFB224` |
| `accent-halo` | Spotlight halo ≤ 8 % *(new)* | `rgba(255,178,36,.08)` | `rgba(255,178,36,.07)` |
| `interactive` | **Curtain**: links, tabs, selection | `#5746AF` | `#A99BFF` |
| `on-interactive` | Text on Curtain | `#FFFFFF` | `#16181D` |
| `interactive-subtle` | Selection background *(new)* | `rgba(87,70,175,.10)` | `rgba(169,155,255,.14)` |
| `success` | Connected, saved | `#1E7A52` | `#3DD68C` |
| `danger` / `on-danger` | Delete, revoke | `#C4343A` / `#FFFFFF` | `#FF6B70` / `#16181D` |
| `warning` | Offline | **`#AA500A`** | `#FF9F43` |
| `focus-ring` | 2 px keyboard ring | `#5746AF` | `#A99BFF` |
| `scrim` | Dialog backdrop *(new)* | `rgba(22,24,29,.40)` | `rgba(0,0,0,.60)` |
| `inverse-bg` / `inverse-text` | Toasts *(new)* | `#16181D` / `#F2EFE9` | `#F2EFE9` / `#16181D` |
| `stage-letterbox` | Player background | `#000000` | `#000000` |
| `stage-chrome` | On-demand player interface | `#8B8FA0` | `#8B8FA0` |
| `stage-chrome-bg` | Chrome plate *(new)* | `rgba(0,0,0,.86)` | same |
| `stage-laser` | Laser pointer, and only that | `#FF2D55` | `#FF2D55` |
| `quiz-a…d` | Quiz options (component) | `#B8325F` `#0B6F78` `#5746AF` `#2B5CC0` | `#FF85A8` `#45C8D2` `#A99BFF` `#7EA6FF` |

### 3.2 Contrast (script result)

| Pair | Ratio | Level |
|---|---|---|
| Ink on Paper | 16.62:1 | AAA |
| Secondary on Paper | 6.26:1 | AA |
| Chalk on Backstage | 16.47:1 | AAA |
| Secondary on Backstage / dark Surface | 8.03 / 7.32:1 | AAA |
| Ink on Spotlight / on Spotlight hover | 9.85 / 8.47:1 | AAA |
| Spotlight on Backstage | 10.48:1 | AAA |
| Spotlight on Paper | 1.69:1 | **No** (documented: fill only) |
| Spotlight-text on Paper / Surface 2 | 5.55 / 5.13:1 | AA |
| Curtain on Paper / white on Curtain | 6.78 / 7.24:1 | AA / AAA |
| Light Curtain on Backstage | 7.94:1 | AAA |
| Success / Danger / Warning on Paper | 4.96 / 5.04 / 5.09:1 | AA |
| Success / Danger / Warning on Surface 2 (light) | 4.59 / 4.66 / 4.71:1 | AA |
| Success / Danger / Warning on Backstage | 10.07 / 6.83 / 9.26:1 | AA+ |
| Strong border on background (light / dark) | 3.91 / 5.88:1 | ≥ 3:1 components |
| Strong border on Surface 2 (light) | 3.61:1 | ≥ 3:1 components |
| Letter on quiz shape (light, worst case) | 5.74:1 | AA |
| Quiz shape on Surface (light, worst case) | 5.74:1 | ≥ 3:1 graphics |
| Player chrome on letterbox | 6.53:1 | AA |
| Player chrome on its plate, over a white slide | 4.85:1 | AA |

The full table (83 rows, light and dark) is printed by the script. The script exits with code 1 if any pair drops below its minimum: use it in CI.

### 3.3 Rules (those of 05, plus two)

1. One Spotlight per screen.
2. Curtain for secondary interactive things and the focus ring. **There is no filled Curtain button**: it would compete with Spotlight. Secondary buttons are outlined.
3. Amber is not a warning. Warning always carries an icon and text.
4. Laser only on the pointer.
5. Dark by default in the player and remote; light (or system) in the panel.
6. Flat backgrounds; the only gradient is the spotlight halo.
7. *(new)* Semantic colors may be used as text on `bg`, `surface` and `surface-2`; the script guarantees it.
8. *(new)* The QR always sits on a white plate, in dark mode too: readers need dark modules on light.

## 4. Typography

| Role | Family | Use | Detail |
|---|---|---|---|
| Voice | **Bricolage Grotesque** (opsz 12–96, wght 200–800) | Headlines, logotype, podium numbers, the remote's Next button | Automatic `font-optical-sizing`: at 64 px the opsz axis tightens the drawing like a poster; at 20 px it opens up. Headlines `-0.02em`, line height 1.1 |
| Text | **Inter** (wght 100–900) | Everything else | Buttons 14 px semibold; body 16 px; tabular figures in counters and tables |
| Signals | **JetBrains Mono** (wght 100–800) | Audience code, clock, tokens, shortcuts, "eyebrow" labels | **Ligatures disabled** on everything that gets copied (`--` does not become an em dash) |

Scale (rem): `0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 · 3 · 4`. Line heights: 1.1 / 1.3 / 1.5. Live specimens: [`preview/components.html`](preview/components.html), *Type* section.

Audience pages: only Latin Inter (48 KB) and `data-surface="audience"`, which turns the voice into Inter 800.

### Files and licenses (verified)

Source: Fontsource v5.3.0 variable packages (jsDelivr), which already come split into Latin and Latin Extended. Each license was compared with the `OFL.txt` of the `google/fonts` repository: identical body (only a trailing space at line end differs). All three are **SIL Open Font License 1.1**; the file sits next to each family.

| File | Bytes |
|---|---|
| `inter-latin-wght.woff2` | 48,256 |
| `inter-latin-ext-wght.woff2` | 85,068 |
| `bricolage-grotesque-latin-opsz-wght.woff2` | 76,888 |
| `bricolage-grotesque-latin-ext-opsz-wght.woff2` | 30,736 |
| `jetbrains-mono-latin-wght.woff2` | 40,404 |
| `jetbrains-mono-latin-ext-wght.woff2` | 15,196 |

Panel in Spanish or English: 165,548 bytes of fonts. Audience: 48,256. Latin Extended is only downloaded if the page uses one of its characters (checked in the browser with "Łódź").

## 5. Logo

Files in [`logo/`](logo/). Legibility sheet: [`preview/logo.html`](preview/logo.html).

### 5.1 Construction

A 64 grid. **The stem** is 12 wide: it is both the P's vertical stroke and the screen's stand. **The bowl** is an ink frame with its two right corners rounded (radius 12), which is what makes it read as a P and not as a flag. **The eye** is a 32 × 18 slide, exactly 16:9, lit in Spotlight, with a 2.5 screen radius. Inside, **the "next" arrow**: a chevron with a 3.75 stroke and round caps, always in Ink, in dark mode too (it sits on amber). Weights: stem 12, frame 7 at top and bottom, 6 on the right. The contrast between a thick stem and a finer bowl is that of a poster grotesque.

In dark mode the frame turns Chalk and the eye stays in Spotlight: the screen looks lit in a darkened room.

### 5.2 Logotype and horizontal lockup

`PPTaken` in Bricolage Grotesque, optical axis 48, "PP" at 800 and "Taken" at 500, tracking −0.02 em, converted to paths (no font dependency). In the horizontal lockup the **text baseline rests on the bottom edge of the bowl** and the cap height almost matches the bowl's: the stem drops like a descender. Spacing between isotype and text: 14 units.

### 5.3 Versions

| File | Use |
|---|---|
| `pptaken-isotype.svg` / `-on-dark.svg` | Color isotype, on light / dark |
| `pptaken-lockup.svg` / `-on-dark.svg` | Horizontal lockup |
| `pptaken-wordmark.svg` / `-on-dark.svg` | The name only |
| `pptaken-isotype-mono-ink.svg`, `pptaken-lockup-mono-ink.svg` | One ink, Ink. The eye is a solid separated from the frame by a 2 hairline |
| `pptaken-isotype-mono-chalk.svg`, `pptaken-lockup-mono-chalk.svg` | One ink, Chalk, on dark backgrounds |
| `pptaken-isotype-stamp.svg`, `pptaken-lockup-stamp.svg` | Stamping (stamp, screen print, laser, embroidery): **a single compound path**, black, 2.5 hairline and a cut-out arrow |
| `favicon.svg` | Adaptive favicon: Ink on light, Chalk on dark (`prefers-color-scheme` inside the SVG). 16 drawing without the arrow |
| `favicon-16.svg`, `favicon-32.svg` (+ `-on-dark`) | Drawn to the pixel grid, without the arrow |
| `pptaken-app-icon.svg` | 512 app icon: Chalk isotype on Backstage, 112 corners. Never on an orange square |
| `source/` | `logo.py` and `wordmark.py` regenerate everything (fontTools + uharfbuzz) |

### 5.4 Minimum sizes and clear space

- Isotype with arrow: **24 px**. Between 16 and 23 px the favicon drawing is used (no arrow, pixel-fitted). Checked by rasterizing at 16, 24, 32 and 64 px on light and dark: at 16 the arrow turns to noise; at 24 it reads.
- Horizontal lockup: **24 px tall**.
- Clear space: **one stem width (x)** free on each side. At 64 px tall, x = 12 px.

### 5.5 Don't

Rotate it. Change the amber. Add a shadow. Enclose it in an orange square (it evokes Microsoft's product). Put it inside the player. Recolor the arrow.

## 6. Iconography

Phosphor Icons, *regular* weight (MIT), bundled locally in `packages/ui/icons/`. Only the 29 that are used: `arrow-left`, `arrow-right`, `check`, `check-circle`, `circle-fill`, `circle-notch`, `copy`, `cursor-click`, `desktop`, `diamond-fill`, `dots-three`, `globe`, `info`, `magnifying-glass`, `moon`, `pencil-simple`, `play`, `sign-out`, `square-fill`, `squares-four`, `sun`, `terminal-window`, `timer`, `trash`, `triangle-fill`, `warning`, `warning-circle`, `wifi-slash`, `x`. To add one: copy its SVG into `icons/` and run `build-icons.mjs`.

Sizes: 20 px by default, 18 in buttons, 16 in small buttons, 14 in labels. Always `currentColor`. An icon never stands alone if it communicates state: it carries text or `aria-label`.

## 7. Illustration

Sparse, geometric, **two inks**: Ink (`currentColor`, which turns Chalk in dark mode) and Spotlight. Spotlight is allowed as flat ink or hatched (16–22 % opacity) for light beams. Motifs: beams as wedges, the 16:9 rectangle, floor-tape crosses, the curtain arc. No characters, no "AI" gradients, no mascot in v1.

| File | Where |
|---|---|
| [`illustrations/empty-stage.svg`](illustrations/empty-stage.svg) | The list's empty state: a screen on its stand (the P again) in a pool of light, with two tape crosses |
| [`illustrations/cue-light.svg`](illustrations/cue-light.svg) | Waiting states: the stage manager's cue light joined by a dotted line to a slide with the arrow |
| [`illustrations/curtain-call.svg`](illustrations/curtain-call.svg) | "Ask for your first presentation": the proscenium arch, the gathered curtain and the lit slide |

## 8. Shape, space and components

- Radii: 6 (fields), 14 (cards, dialogs), pill (buttons). Thumbnails inside a card: 8.
- 4 px grid; spacing `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`.
- A single elevation (`--ppt-shadow-overlay`) for dialogs and toasts.
- **Tactile pill buttons**: 44 px tall, Spotlight with a 2 px inner shadow on the bottom edge, like a key. On press it drops 1 px.
- Remote: Next takes all the available height (min. 220 px), Previous ≥ 96 px. Buttons with a 28 px radius.
- Quiz: options ≥ 64 px. **The shape is the badge** (triangle, diamond, circle, 48 px square) with the letter inside; color is the third cue.
- Full catalog in [`preview/components.html`](preview/components.html) and in `packages/ui`.

## 9. Motion

- Durations: 120 ms (fast), 200 ms (base), 480 ms (podium only). Curve `cubic-bezier(.2, 0, 0, 1)`. No bounce.
- Appearing = curtain fade (opacity + 8 px). Disappearing: opacity only.
- The player animates nothing of its own; the chrome appears and fades after 2 s.
- **The only celebration**: the podium. The blocks rise in the order 3rd → 2nd → 1st and then the beam lights the winner.
- `prefers-reduced-motion: reduce`: the motion tokens drop to 1 ms / 100 ms, the shift to 0, the "live" dot stops breathing, and the podium appears with a 100 ms fade with no delays.

## 10. Copy bank (en / es)

The interface ships bilingual: English is the primary language and Spanish is a first-class translation. Both columns are product content.

| Screen | English | Español |
|---|---|---|
| Welcome | Connect your agent. | Conecta tu agente. |
| | Your agent designs. You present. | Tu agente diseña. Tú presentas. |
| | Copy the setup prompt. | Copia el prompt de configuración. |
| | It includes a new token with minimal permissions. It is shown only once. | Incluye un token nuevo con permisos mínimos. Se muestra una sola vez. |
| | Paste it into Claude Code. | Pégalo en Claude Code. |
| | Wait for the cue. | Espera la señal. |
| | Waiting for your agent's first call… | Esperando la primera llamada de tu agente… |
| | Claude connected. | Claude se conectó. |
| | Copy the connector URL. | Copia la URL del conector. |
| | Your server is public and uses HTTPS. Good. | Tu servidor es público y usa HTTPS. Bien. |
| | claude.ai cannot reach this server. | claude.ai no puede llegar a este servidor. |
| | Ask for your first deck. | Pide tu primera presentación. |
| List | Presentations | Presentaciones |
| | Your agent makes them. You present them. | Las hace tu agente. Tú las presentas. |
| | No presentations yet. | Aún no hay presentaciones. |
| | Ask your agent for one. It shows up here the moment it is created; the stage is already set. | Pídele una a tu agente. Aparece aquí en cuanto la crea; el escenario ya está listo. |
| | Copy example prompt | Copiar prompt de ejemplo |
| | Back on stage / Present | Volver a escena / Presentar |
| | Live / Draft / Quiz draft | En escena / Borrador / Quiz en borrador |
| Remote | Next / Previous | Siguiente / Anterior |
| | Connected / Reconnecting… | Conectado / Reconectando… |
| | Connection lost. You are still presenting. Your phone will reconnect on its own. | Se perdió la conexión. Sigues presentando; el celular volverá solo. |
| | Laser / Drag to point on the screen | Láser / Arrastra para señalar en la pantalla |
| Quiz | Question 3 of 8 | Pregunta 3 de 8 |
| | Answer sent. Watch the screen. | Respuesta enviada. Mira la pantalla. |
| | Correct / Your answer | Correcta / Tu respuesta |
| | You got it. Fast, too. | Acertaste. Rápido, además. |
| | Draft. Review it before your audience sees it. | Borrador. Revísalo antes de que lo vea tu público. |
| Podium | Final ranking | Ranking final |
| | Thanks for playing. | Gracias por jugar. |
| Player | Ready to present offline. | Lista para presentar sin conexión. |
| | Presented with PPTaken | Presentado con PPTaken |
| Errors | Your agent sent a slide that is too large. We already told it. | Tu agente envió un slide demasiado grande. Ya se lo dijimos. |

Full dictionaries: `packages/ui/src/i18n/en.ts` and `es.ts` (same keys, enforced by the type system).

## 11. Accessibility checklist

- [x] All text pairs ≥ 4.5:1 and component pairs ≥ 3:1, in light and dark (script, 83/83).
- [x] Nothing is communicated by color alone: badges with a dot or icon + text, notices with icon + title, quiz with shape + color + letter.
- [x] A 2 px focus ring in Curtain, with a 2 px gap, on all controls (`:focus-visible`).
- [x] Touch targets ≥ 44 px (small desktop buttons: 36 px, above WCAG 2.2's 24 px minimum).
- [x] WAI-ARIA tabs with arrows, Home and End; theme selector as a `radiogroup` with arrows.
- [x] Native dialog (`<dialog>`): traps focus, Escape closes, returns focus.
- [x] Dangerous notices with `role="alert"`; the rest `role="status"`; copying announces "Copied" through an `aria-live` region.
- [x] Audience code spelled out for screen readers ("K 7 M, 2 Q X"); the separator is not copied.
- [x] `prefers-reduced-motion` respected (tokens + per-component rules).
- [x] Mono without ligatures on everything that gets copied.
- [x] No horizontal scroll at 360 px on any screen (checked).
- [ ] Test with real NVDA / VoiceOver (pending).
- [ ] Test `forced-colors` (Windows high-contrast mode) (pending).

## 12. Deviations from 05 and why

1. **Light Warning `#B4540A` → `#AA500A`.** On Surface 2 (`#F3EEE6`, the hover and sunken-area background) it gave 4.32:1 and failed AA. The new value is the same hue, 4 % darker: 4.71:1 on Surface 2 and 5.09:1 on Paper.
2. **Player chrome plate: `rgba(0,0,0,.86)`.** 05 says "translucent black" without a value. At 62 % (the natural choice) the gray `#8B8FA0` over a white slide falls to 1.93:1; the script caught it. At 86 % it gives 4.85:1 in the worst case and still lets the slide show through.
3. **Isotype: the eye is the slide, not the whole bowl.** The sketch painted the whole bowl amber on a stem; rendered, it read as a flag on a pole, not as a P. The final one draws an ink P whose **eye** is the lit slide, which is literally what §10 asks for. Also, the sketch's slide measured 42 × 26 (1.62); it is now 32 × 18, exactly 16:9.
4. **Minimum isotype size with arrow: 24 px**, not 16. At 16 px the arrow is noise; it is solved with the favicon drawing (16 and 32 px, no arrow, pixel-fitted), as §10 already anticipated.
5. **Alternative "the second P is the first one's shadow": not adopted.** With an isotype that is already a P, another shadowed P in the name produces "P PP" and dilutes the reading. It remains documented as future exploration.
6. **Tokens added** (they change nothing existing): `accent-hover`, `accent-halo`, `interactive-subtle`, `on-danger`, `scrim`, `inverse-bg/text`, `stage-chrome-bg`, shadows, `motion-slow` (480 ms, podium only), `motion-rise`, `leading-snug`, `tracking-*`, control sizes and `z`. New primitives only for the quiz (rose, teal, blue) plus `spotlight.600`.
7. **Quiz colors** (component level): rose, teal, Curtain and blue. Amber (it is the Spotlight), Success green and red (Danger and Laser) are deliberately avoided, because in the reveal those colors already mean "correct" or "incorrect".
8. **Quiz clock in Inter**, not in JetBrains Mono: the audience page only loads Inter (§6).
9. **No filled Curtain button** (the `palette-preview.html` sketch had one): it competed visually with Spotlight.
10. **Player status dot in the Warning color.** §11 asks for an 8 px dot and forbids *brand* colors on the canvas; Warning is semantic, sits in the corner of the letterbox (outside the canvas when there are bars) and has an `aria-label`.
11. **QR always on white**, in dark mode too, for reader legibility.

## 13. What I could not verify

- **`prefers-reduced-motion`**: the browser tools do not allow emulating it. I simulated it by rewriting the media queries on the podium page: all animations become 100 ms fades with no delay and `--ppt-motion-base` is 100 ms. The other screens were reviewed in the code.
- **Svelte components at runtime**: there is no build step in this phase. They pass `svelte-check` (Svelte 5.57.3, TypeScript 5) with 0 errors and 0 warnings, run in a temporary directory, but they were not mounted in a real app. The previews use the same `components.css`, not the same generated markup.
- **Real screen readers, `forced-colors`, physical devices** (real phone, projector) and printing.
- **Adaptive favicon** in each browser's real tab bar.
- **claude.ai menu path** ("Customize → Connectors → Add custom connector"): taken from 01 §7, not checked against claude.ai's current interface.
- **Color blindness**: I did not simulate deuteranopia on the quiz colors; shape and letter cover the case by design.
- The first capture of the podium animations sometimes came out empty because the browser pane freezes the timeline until it paints; a second capture shows the final state. It is not a page fault.

## 14. How to view and regenerate

```sh
# Preview (fonts need HTTP; file:// blocks them in some browsers)
python -m http.server 8000      # from the repo root
# open http://localhost:8000/docs/brand/preview/  ·  ?theme=dark  ?lang=es  ?state=empty

node packages/ui/scripts/build-tokens.mjs     # tokens.json -> dist/tokens.css, src/tokens.ts
node packages/ui/scripts/build-icons.mjs      # icons/*.svg -> src/icons.ts, dist/icons.css
node packages/ui/scripts/check-contrast.mjs   # 83 pairs; exit code 1 if any fails
python docs/brand/logo/source/logo.py docs/brand/logo/source/wordmark-opsz48.json docs/brand/logo packages/ui/src/logo.ts docs/brand/preview/logo-data.js
```
