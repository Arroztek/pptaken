# 05 · Visual identity and design system (direction)

> This document sets the **direction**. It is written so another designer (human or model) can develop the full system faithfully. What is firm here: the concept, the colors and their values, the typographic roles and the player rules. What stays open: the final logo, the illustration and the component details.
>
> Supporting material: `assets/logo-pptaken.svg` (isotype sketch) and `assets/palette-preview.html` (open by double click; has light and dark mode). The finished result lives in [`../brand/`](../brand/README.md) and `packages/ui`.

## 1. Concept: the theatre behind the curtain

PPTaken does not paint the set. PPTaken is **the stagehand crew**: the people in black who raise the curtain on time, switch on the exact light and make sure the microphone works. When they do their job well, nobody sees them.

Everything comes from there:

- **Backstage**: the warm matte black of the wings. It is the color of the house when presenting.
- **Spotlight**: a single amber beam, the follow-spot. It points at what matters and nothing else. If everything is lit, nothing is.
- **Curtain**: velvet violet, the color of what can be touched (links, secondary actions). A promise that something is about to open.
- **Paper**: the off-white of the printed script, with pencil notes. It is the color of the house when preparing.
- **The cue**: the smallest gesture that triggers everything. One click, and the scene changes.

One sentence to remember the direction: **backstage calm, spotlight precision.**

## 2. Personality

| It is | It is not |
|---|---|
| Serene, dependable, almost invisible | Loud, a protagonist |
| Precise: one fact, one action | Cluttered, full of options |
| Warm, craftsmanlike, with a wink | Cold corporate or childish |
| Honest about its limits | Magic AI promises |
| Artisan: every detail of the clock and the click is cared for | "Good enough" |

Archetype: **the stage manager**. Speaks little, knows exactly what comes next and tells you one second before you need it.

## 3. Tone of voice

- **Second person, short sentences, verbs first.** "Copy the prompt." "Scan to control."
- **Say what happens and what to do**, without drama or blame: "Connection lost. You keep presenting; your phone will reconnect on its own."
- **Stage vocabulary in moderation**: present, scene, curtain, show, cue. Never technical jargon in the presenter interface (no "WebSocket", no "token" except in the tokens panel).
- **No chains of exclamation marks and no emojis in the interface.** Humor is dry and scarce: one line in an empty state, never in an error.
- **AI is not named with mysticism.** It is "your agent" or "Claude". Not "magic", not "intelligence".
- **Bilingual from birth**: every text is written in English and Spanish at once; idioms that do not travel are avoided.

| Moment | Yes | No |
|---|---|---|
| Empty state | "No presentations yet. Ask your agent for one." | "Oops! Looks empty in here! 🎉" |
| Ready offline | "Ready to present offline." | "Resources cached successfully" |
| Agent error | "Your agent sent a slide that is too large. We already told it." | "Error 413: payload too large" |
| Quiz in draft | "Draft. Review it before your audience sees it." | "Pending approval by the administrator" |
| Remote connected | "Phone connected." | "Device paired successfully" |

## 4. Name and tagline

- **PPTaken**, pronounced "pepetaken". In running text always `PPTaken` (capital P, P and T). In code, packages and domains: `pptaken`.
- Reading of the name: *PPT, taken* — "the presentation is taken care of". It is not explained in the interface; it is a wink.
- Main tagline: **"Your agent designs. You present."**
- Secondary tagline (for developers): "The stage for agent-made presentations."
- Legal care: "PPT" evokes a Microsoft product. Never use "PowerPoint" or its iconography (orange with the boxed P) in the brand. See the open-source guide §10.

## 5. Color

### 5.1 Base palette

| Name | Role | Light | Dark |
|---|---|---|---|
| **Paper / Backstage** | Application background | `#FAF7F2` | `#0F1115` |
| Surface | Cards, panels | `#FFFFFF` | `#181B22` |
| Surface 2 | Sunken areas, hover | `#F3EEE6` | `#20242D` |
| Subtle border | Decorative separators | `#E4DED3` | `#2A2F3A` |
| Strong border | Control outline (≥ 3:1) | `#767C8C` | `#8B8FA0` |
| **Ink / Chalk** | Main text | `#16181D` | `#F2EFE9` |
| Secondary text | Help text, metadata | `#565C6B` | `#A3A9B8` |
| **Spotlight** | Primary action, "on stage" state | `#FFB224` (fill) | `#FFB224` |
| On Spotlight | Text on top of Spotlight | `#16181D` | `#16181D` |
| Spotlight as text | Labels, "draft" | `#8A5A00` | `#FFB224` |
| **Curtain** | Links, secondary action, selection | `#5746AF` | `#A99BFF` |
| On Curtain | Text on top of Curtain | `#FFFFFF` | `#16181D` |
| Success | Connected, saved | `#1E7A52` | `#3DD68C` |
| Danger | Delete, revoke, error | `#C4343A` | `#FF6B70` |
| Warning | Offline, expires soon | `#B4540A` | `#FF9F43` |
| **Laser** | Laser pointer (only that) | `#FF2D55` | `#FF2D55` |

### 5.2 Contrast (calculated, WCAG 2.x formula)

| Pair | Ratio | Passes |
|---|---|---|
| Ink `#16181D` on Paper `#FAF7F2` | 16.6:1 | AAA |
| Secondary `#565C6B` on Paper | 6.3:1 | AA |
| Chalk `#F2EFE9` on Backstage `#0F1115` | 16.5:1 | AAA |
| Secondary `#A3A9B8` on Backstage / dark surface | 8.0:1 / 7.3:1 | AAA |
| Ink on Spotlight `#FFB224` | 9.9:1 | AAA |
| Spotlight on Backstage | 10.5:1 | AAA |
| **Spotlight on Paper** | **1.7:1** | **No**: in light mode, Spotlight only as a fill with Ink text; never as text or a thin icon |
| Spotlight-text `#8A5A00` on Paper | 5.6:1 | AA |
| Curtain `#5746AF` on Paper / white on Curtain | 6.8:1 / 7.2:1 | AA |
| Curtain `#A99BFF` on Backstage | 7.9:1 | AAA |
| Success / Danger / Warning on Paper | 5.0 / 5.0 / 4.7:1 | AA |
| Success / Danger / Warning on Backstage | 10.1 / 6.8 / 9.3:1 | AA+ |
| Strong border on background (light / dark) | 3.9 / 5.9:1 | Meets the 3:1 component rule |

### 5.3 Usage rules

1. **One Spotlight per screen.** Amber marks *the* primary action or *the* live element. If there are two amber buttons, one is too many.
2. **Curtain is for secondary interactive things**: links, active tabs, selection, keyboard focus (2 px ring).
3. **Amber is not a warning.** Warnings use the orange "Warning" and always come with an icon and text; nothing is ever communicated by color alone.
4. **The Laser red is not used in the interface.** It belongs to the pointer.
5. Dark is the default mode for the player and the remote (dark room, phone battery); light is the default for the panel. Both respect `prefers-color-scheme` and can be forced.
6. Flat backgrounds. No decorative gradients, except one brand device: the **spotlight halo**, a very faint amber radial gradient (≤ 8 % opacity) behind a protagonist element on welcome and marketing pages.

## 6. Interface typography

All are libre (SIL OFL 1.1), **hosted in the image itself** as variable WOFF2. Never from a CDN. **Verify each family's license file when adding it to the repo** and ship it next to the fonts.

| Role | Family | Use | Why |
|---|---|---|---|
| **Voice** (titles, brand) | **Bricolage Grotesque** | Headlines, logotype, big podium numbers | Grotesque with theatre-poster character: optical contrast, some human imperfection |
| **Text and interface** | **Inter** | Everything else | Legible at small sizes, tabular figures for the clock, wide language coverage |
| **Signals** (mono) | **JetBrains Mono** | Audience codes, clock, tokens, keyboard shortcuts | Unambiguous characters (0/O, 1/l) when someone copies a code from the back row |

Scale (rem, 16 px base): `0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 · 3 · 4`. Line height 1.5 for text, 1.1 for headlines. Headlines with `letter-spacing: -0.02em`. Tabular figures (`font-variant-numeric: tabular-nums`) in clocks, counters and rankings.

On audience pages (weight-critical) only Inter is loaded, in a Latin subset; titles use Inter at weight 800 instead of Bricolage.

## 7. Fonts available for slide content

Different from the above: this is the **catalog the agent may use** inside presentations. Criteria: libre license, variable, good Latin coverage, and together they cover the basic registers. Initial proposal (confirm sizes and licenses when adding them):

| Register | Families |
|---|---|
| Neutral sans | Inter, IBM Plex Sans |
| Sans with character | Bricolage Grotesque, Space Grotesk |
| Serif | Source Serif 4, Fraunces |
| Mono | JetBrains Mono, IBM Plex Mono |
| High legibility | Atkinson Hyperlegible |

Budget: ≤ 3 MB in total. `get_authoring_guide` returns the exact list. User-uploaded fonts: after 1.0.

## 8. Shape, space and motion

**Shape**
- **The 16:9 ratio is the brand motif**: presentation cards, thumbnails, the eye of the isotype's P.
- Radii: 6 px (fields, labels), 14 px (cards), 999 px (buttons: pills, evoking a clicker button). 1 px borders; almost no shadows (a single elevation, for menus and dialogs).
- 4 px grid. Spacing: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`.
- Lots of air. Density is reserved for panel tables.

**Touch targets**
- Remote: huge "Next/Previous" buttons (minimum 96 px tall, "Next" larger than "Previous"), usable without looking. Brief vibration on press.
- Audience: quiz options at least 64 px tall, one per row, with **shape + color + letter** (never color alone).
- General minimum 44×44 px.

**Motion**
- Fast and dry: 120–200 ms, curve `cubic-bezier(.2, 0, 0, 1)`. No bounce.
- The brand gesture is **the curtain fade**: appearing = opacity + 8 px vertical shift.
- The player animates nothing of its own over the content: transitions between slides belong to the deck.
- `prefers-reduced-motion` is respected (everything becomes fades of ≤ 100 ms, or nothing).
- The only allowed celebration: the quiz podium.

## 9. Iconography and illustration

- **Icons**: Phosphor Icons (MIT license), *regular* weight, 1.5 px optical stroke, rounded caps. Bundled locally as SVG; only the ones in use. (The founder already used them in `ppt`.)
- **Illustration**: sparse, geometric, two-ink (Ink + Spotlight). Motifs: light beams as wedges, the 16:9 rectangle, stage spike marks (floor tape), the curtain arc. No 3D characters and no "AI" gradients.
- **Mascot: not in v1.** If one is wanted later, the direction is **"Cue", a small theatre spotlight** with character (tilts its head, blinks its light), drawn with the same two inks. Two warnings: do not use a frog (the name "Pepe" has unwanted meme associations) and never let the mascot appear in the player.

## 10. Logo (direction and sketch)

- **Isotype**: a **P whose eye is a 16:9 slide lit in Spotlight**, with the "next" arrow inside; the stem is the screen stand. It reads at once as a letter, as a screen on its stand and as an advance button. Sketch in `assets/logo-pptaken.svg`.
- **Logotype**: `PPTaken` in Bricolage Grotesque; "PP" at weight 800 and "Taken" at 500, no space. Alternative to explore: the second P as the offset shadow of the first (the agent and the person).
- **Needed versions**: isotype alone (favicon, app icon), horizontal, monochrome Ink, monochrome Chalk, and a one-ink version for stamping.
- **Clear space**: the width of the P's stem all around. **Minimum size**: 16 px for the isotype (at that size the arrow is dropped).
- **Don't**: rotate it, change the amber, add a shadow, enclose it in an orange square.
- The delivered SVG is a direction sketch; the final one must convert text to paths and refine the optics.

## 11. The player is neutral (hard rule)

The presentation player carries no brand. While presenting:

1. **Pure black `#000000` letterbox** (it melts into the switched-off projector). No Backstage color and no textures.
2. **Zero persistent chrome.** No bar, no logo, no footer. Progress is optional and 2 px tall.
3. The interface (slide number, clock, QR, notices) appears **only on demand** (key or mouse movement), in neutral gray `#8B8FA0` over translucent black, in JetBrains Mono, and fades after 2 s.
4. **Brand colors do not enter the canvas.** Exceptions: the Laser dot and the keyboard focus ring.
5. Status notices ("offline") are an 8 px dot in a corner, not a banner.
6. On the public link, a single discreet mention outside the canvas and only on the loading screen: "Presented with PPTaken".
7. Audience modules on the projector (questions, ranking) **do** use the PPTaken design system, in its dark variant, because at that moment the content is ours.

## 12. Design tokens

The tokens live in `packages/ui/tokens.json` (source of truth) and are generated into CSS variables. Three levels: **primitives** (raw values) → **semantic** (role) → **component** (only if needed). The implemented version supersedes the sketch that used to be in this section; see `packages/ui/README.md` and `docs/brand/README.md`.

PPTaken tokens use the `--ppt-` prefix and are **never injected into the content iframe**: the deck has its own visual world.

## 13. Brief for the next design phase (completed)

This brief was delivered to a design model; the result is in `packages/ui` and `docs/brand`. For reference, it asked for:

1. Final logo in all its versions from the sketch and §10.
2. A Svelte component library on the tokens: button, field, presentation card (16:9), table, dialog, notice, tabs, status badge, big code, framed QR.
3. Five reference screens: welcome / "Connect your agent", presentations list, phone remote, quiz question on phone, podium on the projector.
4. Each screen checked in light and dark, at 360 px wide and with `prefers-reduced-motion`.
5. Do not touch the neutral player rule (§11).
