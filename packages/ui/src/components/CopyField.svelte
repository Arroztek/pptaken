<script lang="ts">
  import type { Snippet } from "svelte";
  import { getI18n } from "../i18n";
  import Button from "./Button.svelte";

  interface Props {
    value: string;
    /** Accessible name of the value, e.g. "Connector URL". */
    label: string;
    /** Multi-line block (setup prompts). */
    multiline?: boolean;
    /** Button text; defaults to "Copy". */
    copyLabel?: string;
    /** Use the Spotlight button. Only when copying IS the main action of the screen. */
    primary?: boolean;
    /** Extra content in the multi-line bar, left of the button (e.g. permissions). */
    note?: Snippet;
    oncopy?: () => void;
  }

  let { value, label, multiline = false, copyLabel, primary = false, note, oncopy }: Props = $props();
  const t = getI18n();
  const uid = $props.id();
  let copied = $state(false);
  let announcement = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for http:// on a LAN, where the async clipboard API is unavailable.
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    copied = true;
    announcement = t("common.copiedAnnouncement");
    oncopy?.();
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
      announcement = "";
    }, 2000);
  }
</script>

{#snippet button()}
  <Button
    variant={primary ? "primary" : "secondary"}
    size={multiline ? "md" : "sm"}
    icon={copied ? "check" : "copy"}
    class={copied ? "is-copied" : ""}
    aria-describedby="{uid}-value"
    onclick={copy}
  >
    {copied ? t("common.copied") : (copyLabel ?? t("common.copy"))}
  </Button>
{/snippet}

{#if multiline}
  <div class="ppt-copyblock">
    <!-- Scrollable region: it must be reachable by keyboard (WCAG 2.1.1). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="ppt-copyblock__value" id="{uid}-value" role="region" aria-label={label} tabindex="0">{value}</pre>
    <div class="ppt-copyblock__bar">
      <span class="ppt-small ppt-muted">{#if note}{@render note()}{/if}</span>
      {@render button()}
    </div>
  </div>
{:else}
  <div class="ppt-copyfield">
    <span class="ppt-sr-only">{label}</span>
    <span class="ppt-copyfield__value" id="{uid}-value">{value}</span>
    {@render button()}
  </div>
{/if}
<span class="ppt-sr-only" aria-live="polite">{announcement}</span>
