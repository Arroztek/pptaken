<script lang="ts" module>
  export type Status = "draft" | "live" | "offline" | "connected" | "revoked";
</script>

<script lang="ts">
  import { getI18n } from "../i18n";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  interface Props {
    status: Status;
    /** Override the default label from the dictionary (e.g. "Quiz draft"). */
    label?: string;
    class?: string;
  }

  let { status, label, class: className = "" }: Props = $props();
  const t = getI18n();

  // Every status has a mark (dot or icon) AND text: meaning never depends on colour alone.
  const icon: Partial<Record<Status, IconName>> = { draft: "pencil-simple", offline: "wifi-slash", revoked: "x" };
  const variant: Record<Status, string> = {
    draft: "draft",
    live: "live",
    offline: "offline",
    connected: "connected",
    revoked: "danger",
  };
</script>

<span class={["ppt-badge", `ppt-badge--${variant[status]}`, className].filter(Boolean).join(" ")}>
  {#if icon[status]}
    <Icon name={icon[status]} size={14} />
  {:else}
    <span class="ppt-badge__dot" aria-hidden="true"></span>
  {/if}
  {label ?? t(`status.${status}`)}
</span>
