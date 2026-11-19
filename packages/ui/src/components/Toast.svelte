<script lang="ts">
  import { getI18n } from "../i18n";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";
  import IconButton from "./IconButton.svelte";
  import type { ToastAction } from "./toast-queue.svelte";

  interface Props {
    message: string;
    icon?: IconName;
    /** One optional action, like Undo. */
    action?: ToastAction;
    ondismiss?: () => void;
  }

  let { message, icon = "check", action, ondismiss }: Props = $props();
  const t = getI18n();

  async function run() {
    if (!action) return;
    ondismiss?.();
    await action.run();
  }
</script>

<div class="ppt-toast">
  <Icon name={icon} />
  <span>{message}</span>
  {#if action}
    <button type="button" class="ppt-toast__action" onclick={run}>{action.label}</button>
  {/if}
  {#if ondismiss}
    <IconButton icon="x" size="sm" label={t("common.dismiss")} onclick={ondismiss} />
  {/if}
</div>
