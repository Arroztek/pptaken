<script lang="ts">
  import { getI18n } from "../i18n";

  interface Props {
    /** The audience join code, e.g. "K7M2QX". Use an alphabet without 0/O, 1/I/l. */
    code: string;
    /** Join address shown in the hint, e.g. "slides.example.com/a". */
    joinUrl?: string;
    /** Small label above the code. */
    label?: string;
  }

  let { code, joinUrl, label }: Props = $props();
  const t = getI18n();

  const clean = $derived(code.replace(/[^0-9A-Za-z]/g, "").toUpperCase());
  const half = $derived(Math.ceil(clean.length / 2));
  // Screen readers spell it out in groups: "K 7 M, 2 Q X".
  const spoken = $derived(`${clean.slice(0, half).split("").join(" ")}, ${clean.slice(half).split("").join(" ")}`);
  const hint = $derived(joinUrl ? t("quiz.joinHint", { url: "\u0000" }).split("\u0000") : null);
</script>

<div class="ppt-bigcode">
  <span class="ppt-eyebrow">{label ?? t("quiz.audienceCode")}</span>
  <!-- user-select: all, so one tap selects the whole code; the separator is not selectable. Screen readers get the spelled-out version. -->
  <span class="ppt-bigcode__value" aria-hidden="true"
    >{clean.slice(0, half)}<span class="ppt-bigcode__sep">·</span>{clean.slice(half)}</span
  >
  <span class="ppt-sr-only">{spoken}</span>
  {#if hint && joinUrl}
    <span class="ppt-bigcode__hint">{hint[0]}<strong>{joinUrl}</strong>{hint[1]}</span>
  {/if}
</div>
