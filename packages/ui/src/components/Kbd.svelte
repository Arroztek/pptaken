<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    /** Spoken name when the glyph is a symbol, e.g. "Right arrow" for "→". */
    label?: string;
  }

  let { children, label }: Props = $props();
</script>

<kbd class="ppt-kbd"
  >{#if label}<span aria-hidden="true">{@render children()}</span><span class="ppt-sr-only">{label}</span
    >{:else}{@render children()}{/if}</kbd
>
