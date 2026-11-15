<script lang="ts">
  import { logo } from "../logo";

  interface Props {
    /** "lockup" (isotype + wordmark), "isotype", or "small" (16 to 23 px: no arrow, pixel-snapped). */
    variant?: "lockup" | "isotype" | "small";
    /** Height in px. Minimum: 24 for the lockup, 24 for the isotype, 16 for "small". */
    height?: number;
    /** Accessible name. Pass "" when a visible "PPTaken" text sits next to it. */
    label?: string;
  }

  let { variant = "lockup", height = 28, label = "PPTaken" }: Props = $props();
  const art = $derived(logo[variant === "small" ? "isotypeSmall" : variant]);
</script>

<!-- Frame and wordmark follow currentColor (Ink on light, Chalk on dark). The slide stays Spotlight. Never inside the player. -->
<svg
  class="ppt-logo"
  viewBox={art.viewBox}
  {height}
  focusable="false"
  role={label ? "img" : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : "true"}
>
  {@html art.body}
</svg>
