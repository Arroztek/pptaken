<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  One piece of interactive code, read-only ("See what will run"): monospace with line numbers, collapsible. Long code
  shows the first lines and a "show all" button, so a 128 KB script does not render thousands of nodes before the
  owner asks. The code is plain text: never HTML, never executed here. Size and SHA-256 only with Developer details.
-->
<script lang="ts">
  import { Button } from "@pptaken/ui";
  import { untrack } from "svelte";
  import type { ScriptSource } from "../lib/api";
  import { formatBytes } from "../lib/format";
  import { prefs, t } from "../lib/state.svelte";
  import CopyButton from "./CopyButton.svelte";

  interface Props {
    script: ScriptSource;
    open?: boolean;
    /** Heading override (the deck-level script has no slide). */
    title?: string;
    /** A quieter frame, for the side-by-side "Review changes" view. */
    compact?: boolean;
  }

  /** Lines rendered before "show all". */
  const CAP = 200;

  let { script, open = true, title, compact = false }: Props = $props();
  let expanded = $state(false);
  let shown = $state(untrack(() => open));

  const lines = $derived(script.source.split(/\r\n|\r|\n/));
  const visible = $derived(expanded ? lines : lines.slice(0, CAP));
  const gutter = $derived(visible.map((_, i) => i + 1).join("\n"));
  const heading = $derived(
    title ??
      (prefs.dev
        ? t("dev.scriptFor", { n: script.index + 1, id: script.slideId })
        : t("scriptErrors.slideUntitled", { n: script.index + 1 })),
  );
  const uid = $props.id();
</script>

<article class="script" class:script--compact={compact} aria-labelledby="{uid}-title" data-slide-id={script.slideId}>
  <header class="script__head">
    <div class="script__title">
      <h4 class="ppt-h3" id="{uid}-title">{heading}</h4>
      <p class="script__meta">
        <span>{lines.length === 1 ? t("dev.lineOne") : t("dev.lines", { n: lines.length })}</span>
        {#if prefs.dev}
          <span aria-hidden="true">·</span>
          <span>{formatBytes(script.bytes, prefs.locale)}</span>
          <span aria-hidden="true">·</span>
          <span class="script__sha" title={script.sha256}>SHA-256 {script.sha256.slice(0, 12)}…</span>
        {/if}
      </p>
    </div>
    <div class="script__actions">
      {#if prefs.dev}
        <CopyButton size="sm" variant="ghost" label="SHA-256" text={script.sha256} />
      {/if}
      <Button
        size="sm"
        variant="secondary"
        aria-expanded={shown}
        aria-controls="{uid}-code"
        onclick={() => (shown = !shown)}>{shown ? t("dev.hideCode") : t("dev.showCode")}</Button
      >
    </div>
  </header>
  <div class="script__code" id="{uid}-code" hidden={!shown}>
    <!-- One scroll box: the gutter and the code scroll together vertically; only the code scrolls sideways. -->
    <!-- A scrollable region must be reachable by keyboard (arrow keys scroll it). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="code" role="region" aria-label={title ?? t("dev.codeLabel", { n: script.index + 1 })} tabindex="0">
      <pre class="code__gutter" aria-hidden="true">{gutter}</pre>
      <pre class="code__text"><code>{visible.join("\n")}</code></pre>
    </div>
    {#if lines.length > CAP && !expanded}
      <div class="script__more">
        <Button size="sm" variant="ghost" onclick={() => (expanded = true)}>{t("dev.showAll", { n: lines.length })}</Button>
      </div>
    {/if}
  </div>
</article>
