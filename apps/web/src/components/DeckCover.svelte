<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  The cover of a presentation in the grid: its first slide as rendered, in a 16:9 (or 4:3) frame with a hairline.

  Slide content is untrusted, so it never enters this page. The cover is a static document (no script, a CSP
  sandbox that grants nothing) served on the content origin and shown in an iframe that is sandboxed again with an
  empty `sandbox` attribute, decorative (aria-hidden, not focusable, no pointer events). The document is drawn at the
  deck's canvas size (1920x1080 or 1440x1080) and scaled down here with a CSS transform.

  Loading is lazy and capped: nothing starts until the card is near the viewport, then it waits for one of the
  shared slots. While it loads the frame is a quiet skeleton; if the cover cannot load (no slide, offline, a slow or
  failed answer) the frame shows the title on a neutral surface instead. The state is never an error message.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { CoverState, Limiter } from "../lib/covers";

  interface Props {
    title: string;
    lang?: string | undefined;
    /** Resolves the (cached, batched) signed URL of this deck's cover. Never rejects. */
    resolve: () => Promise<CoverState>;
    limiter: Limiter;
    /** The longest a started load may take before the fallback is shown. */
    timeoutMs?: number;
  }

  let { title, lang, resolve, limiter, timeoutMs = 12_000 }: Props = $props();

  type Phase = "idle" | "queued" | "loading" | "ready" | "fallback";
  let phase = $state<Phase>("idle");
  let src = $state("");
  let canvas = $state({ width: 1920, height: 1080 });
  let boxWidth = $state(0);
  let boxHeight = $state(0);
  let box: HTMLElement | undefined = $state();

  // The frame is always 16:9 so a grid row stays even; a 4:3 slide keeps its shape, centered, with quiet bars.
  const scale = $derived(
    boxWidth > 0 && boxHeight > 0 ? Math.min(boxWidth / canvas.width, boxHeight / canvas.height) : 0,
  );
  const left = $derived(Math.max(0, (boxWidth - canvas.width * scale) / 2));
  const top = $derived(Math.max(0, (boxHeight - canvas.height * scale) / 2));

  let cancel: (() => void) | null = null;
  let release: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function settle(next: "ready" | "fallback") {
    clearTimeout(timer);
    phase = next;
    if (next === "fallback") src = "";
    release?.();
    release = null;
  }

  function start() {
    if (phase !== "idle") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      phase = "fallback";
      return;
    }
    phase = "queued";
    cancel = limiter.acquire((done) => {
      release = done;
      void begin();
    });
  }

  async function begin() {
    const cover = await resolve();
    if (release === null) return; // destroyed while waiting
    if (cover.status !== "ready") return settle("fallback");
    canvas = { width: cover.width, height: cover.height };
    src = cover.url;
    phase = "loading";
    // The iframe's own load event never fires for a document that never answers; this is the bound.
    timer = setTimeout(() => settle("fallback"), timeoutMs);
  }

  onMount(() => {
    if (typeof IntersectionObserver === "undefined" || box === undefined) {
      start();
      return () => cancel?.();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(box);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      cancel?.();
      release?.();
      release = null;
    };
  });
</script>

<div
  class="cover"
  class:cover--ready={phase === "ready"}
  class:cover--fallback={phase === "fallback"}
  data-phase={phase}
  bind:this={box}
  bind:clientWidth={boxWidth}
  bind:clientHeight={boxHeight}
>
  {#if phase === "fallback"}
    <p class="cover__title"><span {lang}>{title}</span></p>
  {:else if phase !== "ready"}
    <span class="cover__skeleton" aria-hidden="true"></span>
  {/if}
  {#if src}
    <iframe
      class="cover__frame"
      {src}
      {title}
      sandbox=""
      referrerpolicy="no-referrer"
      aria-hidden="true"
      tabindex="-1"
      style:width="{canvas.width}px"
      style:height="{canvas.height}px"
      style:left="{left}px"
      style:top="{top}px"
      style:transform="scale({scale})"
      onload={() => settle("ready")}
      onerror={() => settle("fallback")}
    ></iframe>
  {/if}
</div>
