<script lang="ts">
  import { icons, type IconName } from "../icons";

  interface Props {
    name: IconName;
    /** Pixel size. Defaults to 20 (Phosphor regular reads as a 1.5 px stroke at 24). */
    size?: number | string;
    /** Accessible label. Without it the icon is decorative (aria-hidden). */
    label?: string;
    class?: string;
  }

  let { name, size = 20, label, class: className = "" }: Props = $props();
</script>

<!-- Markup comes from the packaged Phosphor SVGs (src/icons.ts), never from user input. -->
<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 256 256"
  fill="currentColor"
  focusable="false"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  {@html icons[name]}
</svg>
