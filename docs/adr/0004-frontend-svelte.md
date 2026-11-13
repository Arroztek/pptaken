# ADR-004 · Frontend: Svelte 5 + multi-page Vite; framework-free player engine

**Context.** Five surfaces with different needs:

| Surface | Device | Priority |
|---|---|---|
| Player (trusted interface around the iframe) | Laptop / projector | Fluidity, offline, zero distractions |
| Slide runtime (inside the iframe) | Laptop / phone | Tiny (< 5 KB), no dependencies |
| Remote control | Phone | Instant load, big buttons |
| Audience pages | Phones on saturated WiFi | Minimal weight (< 60 KB) |
| Owner panel | Laptop / phone | Productivity (forms, lists) |

**Decision.**
- **`@pptaken/player`**: navigation, steps, scaling and messaging engine in **framework-free TypeScript**. It is the heart and must be embeddable anywhere (HTML export, cloud, future integrations).
- **Interface**: **Svelte 5** compiled with **Vite** as a multi-page app (one entry per surface). **No SvelteKit**: we need neither server rendering nor its router.

**Alternatives.** React (the best known, but ~45 KB base and more ceremony); Preact (4 KB and a React API: the second-best option); Solid; Lit; all vanilla (viable for player and remote, painful for the panel).

**Why Svelte:** it compiles to JS without a heavy runtime (key for audience pages), its syntax is close to HTML (low barrier for new contributors) and Svelte 5 is stable and well supported by coding assistants. **Honest trade-off:** there are fewer Svelte developers than React ones. We mitigate by keeping logic in framework-free packages; the Svelte layer is thin and replaceable.
