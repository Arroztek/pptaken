<script lang="ts">
  import type { Snippet } from "svelte";
  import { getI18n } from "../i18n";
  import IconButton from "./IconButton.svelte";

  interface Props {
    open?: boolean;
    title: string;
    /** Body content. */
    children?: Snippet;
    /** Footer buttons. Put the safe option first; the destructive one uses variant="danger". */
    actions?: Snippet;
    onclose?: () => void;
    /** Close when clicking the backdrop. Off for destructive confirmations. */
    dismissible?: boolean;
  }

  let { open = $bindable(false), title, children, actions, onclose, dismissible = true }: Props = $props();
  const t = getI18n();
  const uid = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();

  // Native <dialog>: focus trap, Escape and focus return come from the platform.
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  function handleClose() {
    open = false;
    onclose?.();
  }

  function handleClick(event: MouseEvent) {
    if (dismissible && event.target === dialog) dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="ppt-dialog" aria-labelledby="{uid}-title" onclose={handleClose} onclick={handleClick}>
  <div class="ppt-dialog__inner">
    <div class="ppt-dialog__head">
      <h2 class="ppt-h2" id="{uid}-title">{title}</h2>
      <IconButton icon="x" label={t("common.close")} onclick={() => dialog?.close()} />
    </div>
    {#if children}{@render children()}{/if}
    {#if actions}
      <div class="ppt-dialog__actions">{@render actions()}</div>
    {/if}
  </div>
</dialog>
