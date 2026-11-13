<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    text?: string;
    /** Two-ink illustration (Ink via currentColor + Spotlight). Decorative: give it aria-hidden. */
    art?: Snippet;
    actions?: Snippet;
    headingLevel?: 2 | 3;
  }

  let { title, text, art, actions, headingLevel = 2 }: Props = $props();
</script>

<div class="ppt-empty">
  {#if art}{@render art()}{/if}
  <svelte:element this={`h${headingLevel}`} class="ppt-empty__title">{title}</svelte:element>
  {#if text}<p class="ppt-empty__text">{text}</p>{/if}
  {#if actions}<div class="ppt-empty__actions">{@render actions()}</div>{/if}
</div>
