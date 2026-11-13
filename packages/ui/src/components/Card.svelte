<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends Omit<HTMLAttributes<HTMLElement>, "children"> {
    as?: "div" | "section" | "article" | "aside";
    variant?: "default" | "sunken" | "flush";
    children: Snippet;
  }

  let { as = "div", variant = "default", class: className = "", children, ...rest }: Props = $props();
</script>

<svelte:element
  this={as}
  {...rest}
  class={["ppt-card", variant !== "default" && `ppt-card--${variant}`, className].filter(Boolean).join(" ")}
>
  {@render children()}
</svelte:element>
