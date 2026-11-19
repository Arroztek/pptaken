<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- "Waiting for Claude…" → "Claude is connected." One persistent live region, so screen readers hear the change.
     The tool name of the last call only with Developer details. -->
<script lang="ts">
  import { Notice } from "@pptaken/ui";
  import type { ConnectStatus } from "../lib/api";
  import { describeWhen } from "../lib/format";
  import { prefs, t } from "../lib/state.svelte";

  let { status, pollError = false, now }: { status: ConnectStatus | null; pollError?: boolean; now: number } =
    $props();

  const connected = $derived(status?.agentConnected === true);
  const detail = $derived.by(() => {
    if (!status?.agentConnected || !status.lastCallAt) return "";
    const line = t("connect.connectedText", {
      client: status.clientName ?? t("connect.yourAgent"),
      ago: describeWhen(status.lastCallAt, prefs.locale, now).text,
    });
    return prefs.dev && status.lastTool ? `${line} ${t("devConnect.lastCall", { tool: status.lastTool })}` : line;
  });
</script>

<div class="connect-status" aria-live="polite">
  {#if connected}
    <Notice tone="success" title={t("connect.connectedTitle")} text={detail || undefined} class="ppt-curtain-in" />
  {:else}
    <div class="waiting">
      <div class="waiting__text">
        <span class="waiting__title"
          ><span class="ppt-dot" aria-hidden="true"></span><span>{t("connect.waiting")}</span></span
        >
        <span class="waiting__hint">{pollError ? t("connect.pollError") : t("connect.waitingHint")}</span>
      </div>
    </div>
  {/if}
</div>
