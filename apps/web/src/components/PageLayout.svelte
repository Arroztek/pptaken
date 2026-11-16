<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  Every signed-in page: one container, one header, one rhythm (the --ppt-rhythm-* tokens). Pages never set
  their own outer margins; sections inside use PageSection.
  width "wide": lists and tables (content-max). "column": step-by-step and form pages (column-max), left-aligned
  with the same header position as the wide pages.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title?: string;
    subtitle?: string;
    eyebrow?: string;
    width?: "wide" | "column";
    /** Header actions (right of the title on wide screens, below it on narrow ones). */
    actions?: Snippet;
    children: Snippet;
  }

  let { title, subtitle, eyebrow, width = "wide", actions, children }: Props = $props();
</script>

<div class="page" class:page--column={width === "column"}>
  {#if title}
    <header class="page-head">
      <div class="page-head__text">
        {#if eyebrow}<p class="ppt-eyebrow">{eyebrow}</p>{/if}
        <h1 class="ppt-h1">{title}</h1>
        {#if subtitle}<p class="page-head__subtitle">{subtitle}</p>{/if}
      </div>
      {#if actions}<div class="page-head__actions">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class="page-body">
    {@render children()}
  </div>
</div>
