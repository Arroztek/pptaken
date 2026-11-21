<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import Loader from "./Loader.svelte";

  type Variant = "primary" | "secondary" | "ghost" | "danger";

  interface Props extends Omit<HTMLButtonAttributes, "children"> {
    /** primary = Spotlight. Use it for THE main action, once per screen. */
    variant?: Variant;
    size?: "sm" | "md" | "lg";
    block?: boolean;
    icon?: IconName;
    iconEnd?: IconName;
    /** Shows the inline loader (in place of `icon`), sets aria-busy and blocks clicks. */
    loading?: boolean;
    /** Renders a link styled as a button. */
    href?: string;
    target?: HTMLAnchorAttributes["target"];
    children: Snippet;
  }

  let {
    variant = "secondary",
    size = "md",
    block = false,
    icon,
    iconEnd,
    loading = false,
    href,
    target,
    type = "button",
    disabled = false,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const classes = $derived(
    [
      "ppt-btn",
      `ppt-btn--${variant}`,
      size !== "md" && `ppt-btn--${size}`,
      block && "ppt-btn--block",
      className,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const iconSize = $derived(size === "sm" ? 16 : 18);
</script>

{#snippet content()}
  {#if loading}
    <!-- The button's aria-busy says it; the loader itself stays silent. -->
    <Loader size="inline" announce={false} />
  {:else if icon}
    <Icon name={icon} size={iconSize} />
  {/if}
  {@render children()}
  {#if iconEnd}
    <Icon name={iconEnd} size={iconSize} />
  {/if}
{/snippet}

{#if href && !disabled}
  <a class={classes} {href} {target} rel={target === "_blank" ? "noopener noreferrer" : undefined}>
    {@render content()}
  </a>
{:else}
  <button
    {...rest}
    class={classes}
    {type}
    disabled={disabled || loading}
    aria-busy={loading ? "true" : undefined}
  >
    {@render content()}
  </button>
{/if}
