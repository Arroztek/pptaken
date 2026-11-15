<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- "Waiting for your agent's first call…" → "Claude connected." One persistent live region,
     so screen readers hear the change. -->
<script lang="ts">
  import { Notice } from "@pptaken/ui";
  import type { ConnectStatus } from "../lib/api";
  import { describeWhen } from "../lib/format";
  import { prefs, t } from "../lib/state.svelte";

  let { status, pollError = false, now }: { status: ConnectStatus | null; pollError?: boolean; now: number } =
    $props();

  const connected = $derived(status?.agentConnected === true);
  const detail = $derived.by(() => {
    if (!status?.agentConnected) return "";
    if (!status.lastCallAt) return "";
    return t("connect.connectedText", {
      client: status.clientName ?? t("connect.yourAgent"),
      tool: status.lastTool ?? "whoami",
      ago: describeWhen(status.lastCallAt, prefs.locale, now).text,
    });
  });
</script>

<div class="connect-status" aria-live="polite">
  {#if connected}
    <Notice tone="success" title={t("welcome.connectedTitle")} text={detail || undefined} class="ppt-curtain-in" />
  {:else}
    <div class="waiting">
      <div class="waiting__text">
        <span class="waiting__title"
          ><span class="ppt-dot" aria-hidden="true"></span><span>{t("welcome.waiting")}</span></span
        >
        <span class="waiting__hint">{pollError ? t("connect.pollError") : t("welcome.waitingHint")}</span>
      </div>
    </div>
  {/if}
</div>
