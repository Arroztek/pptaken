<script lang="ts">
  import { getI18n } from "../i18n";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";

  interface Props {
    message: string;
    icon?: IconName;
    ondismiss?: () => void;
  }

  let { message, icon = "check", ondismiss }: Props = $props();
  const t = getI18n();
</script>

<div class="ppt-toast">
  <Icon name={icon} />
  <span>{message}</span>
  {#if ondismiss}
    <IconButton icon="x" size="sm" label={t("common.dismiss")} onclick={ondismiss} />
  {/if}
</div>
