<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- A Button that copies text, possibly produced on click (a token created on demand).
     Announces the result through its own polite live region. -->
<script lang="ts">
  import { Button } from "@pptaken/ui";
  import { copyText } from "../lib/clipboard";
  import { errorMessage } from "../lib/errors";
  import { t } from "../lib/state.svelte";

  interface Props {
    /** The text, or a function that produces it (called on each click). */
    text: string | (() => Promise<string>);
    label: string;
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md" | "lg";
    class?: string;
    describedby?: string;
    /** Called with the error when producing or copying the text fails. */
    onerror?: (error: unknown) => void;
    oncopied?: () => void;
  }

  let {
    text,
    label,
    variant = "secondary",
    size = "md",
    class: className = "",
    describedby,
    onerror,
    oncopied,
  }: Props = $props();

  let busy = $state(false);
  let copied = $state(false);
  let announcement = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    if (busy) return;
    busy = true;
    announcement = "";
    try {
      await copyText(typeof text === "string" ? text : text());
      copied = true;
      announcement = t("common.copiedAnnouncement");
      oncopied?.();
      clearTimeout(timer);
      timer = setTimeout(() => {
        copied = false;
        announcement = "";
      }, 2000);
    } catch (error) {
      copied = false;
      if (onerror) onerror(error);
      else announcement = error instanceof Error && error.name === "CopyError" ? t("errors.copyFailed") : errorMessage(error, t);
    } finally {
      busy = false;
    }
  }
</script>

<Button
  {variant}
  {size}
  icon={copied ? "check" : "copy"}
  loading={busy}
  class={[copied && "is-copied", className].filter(Boolean).join(" ")}
  aria-describedby={describedby}
  onclick={copy}
>
  {copied ? t("common.copied") : label}
</Button>
<span class="ppt-sr-only" aria-live="polite">{announcement}</span>
