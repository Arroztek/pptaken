<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** The QR itself (an <svg>, <img> or <canvas>), provided by the caller. This component only frames it. */
    children: Snippet;
    caption?: string;
    /** Rendered QR size in px. */
    size?: number;
  }

  let { children, caption, size = 176 }: Props = $props();
</script>

<!-- The plate stays white in both themes: scanners need dark modules on light. Corner spike marks evoke stage tape. -->
<figure class="ppt-qr" style="--ppt-qr-size: {size}px">
  <div class="ppt-qr__frame">
    <div class="ppt-qr__plate">{@render children()}</div>
  </div>
  {#if caption}<figcaption class="ppt-qr__caption">{caption}</figcaption>{/if}
</figure>
