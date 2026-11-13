<script lang="ts" module>
  export type Tone = "info" | "success" | "warning" | "danger";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { getI18n } from "../i18n";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";

  interface Props {
    tone?: Tone;
    title: string;
    text?: string;
    children?: Snippet;
    /** Shows a dismiss button. */
    ondismiss?: () => void;
    class?: string;
  }

  let { tone = "info", title, text, children, ondismiss, class: className = "" }: Props = $props();
  const t = getI18n();

  // Icon + text, always. Colour is a third cue, never the only one.
  const icons: Record<Tone, IconName> = {
    info: "info",
    success: "check-circle",
    warning: "warning",
    danger: "warning-circle",
  };
</script>

<div
  class={["ppt-notice", tone !== "info" && `ppt-notice--${tone}`, className].filter(Boolean).join(" ")}
  role={tone === "danger" ? "alert" : "status"}
>
  <Icon name={icons[tone]} />
  <div class="ppt-notice__body">
    <span class="ppt-notice__title">{title}</span>
    {#if text}<span class="ppt-notice__text">{text}</span>{/if}
    {#if children}{@render children()}{/if}
  </div>
  {#if ondismiss}
    <IconButton icon="x" size="sm" label={t("common.dismiss")} onclick={ondismiss} />
  {/if}
</div>
