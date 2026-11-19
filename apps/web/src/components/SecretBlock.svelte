<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copy field for text that contains a secret. The DOM only holds the masked version until the
     owner chooses Show; Copy always copies the real text. Same look as @pptaken/ui's CopyField. -->
<script lang="ts">
  import { Button } from "@pptaken/ui";
  import type { Snippet } from "svelte";
  import { t } from "../lib/state.svelte";
  import CopyButton from "./CopyButton.svelte";

  interface Props {
    /** Accessible name, e.g. "Token". */
    label: string;
    /** Text with the secret masked. */
    masked: string;
    /** Real text. */
    secret: string;
    multiline?: boolean;
    note?: Snippet;
  }

  let { label, masked, secret, multiline = false, note }: Props = $props();
  const uid = $props.id();
  let revealed = $state(false);
</script>

{#snippet controls()}
  <Button
    variant="ghost"
    size="sm"
    aria-controls="{uid}-value"
    aria-label={revealed ? t("devConnect.hide") : t("devConnect.showLabel", { name: label })}
    onclick={() => (revealed = !revealed)}
  >
    {revealed ? t("devConnect.hide") : t("devConnect.show")}
  </Button>
  <CopyButton text={secret} label={t("common.copy")} size="sm" describedby="{uid}-value" />
{/snippet}

{#if multiline}
  <div class="ppt-copyblock">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="ppt-copyblock__value" id="{uid}-value" role="region" aria-label={label} tabindex="0">{revealed ? secret : masked}</pre>
    <div class="ppt-copyblock__bar">
      <span class="ppt-small ppt-muted">{#if note}{@render note()}{/if}</span>
      <span class="secret-controls">{@render controls()}</span>
    </div>
  </div>
{:else}
  <div class="ppt-copyfield secret-field">
    <span class="ppt-sr-only">{label}</span>
    <span class="ppt-copyfield__value" id="{uid}-value">{revealed ? secret : masked}</span>
    <span class="secret-controls">{@render controls()}</span>
  </div>
{/if}
