<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  interface Props extends Omit<HTMLButtonAttributes, "children" | "aria-label"> {
    icon: IconName;
    /** Required: an icon-only button needs an accessible name. Also used as tooltip. */
    label: string;
    variant?: "ghost" | "secondary";
    size?: "sm" | "md";
    /** Toggle buttons: pass a boolean to expose aria-pressed. */
    pressed?: boolean;
  }

  let {
    icon,
    label,
    variant = "ghost",
    size = "md",
    pressed,
    type = "button",
    class: className = "",
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  class={["ppt-icon-btn", variant === "secondary" && "ppt-icon-btn--secondary", size === "sm" && "ppt-icon-btn--sm", className]
    .filter(Boolean)
    .join(" ")}
  aria-label={label}
  title={label}
  aria-pressed={pressed === undefined ? undefined : pressed}
>
  <Icon name={icon} size={size === "sm" ? 18 : 20} />
</button>
