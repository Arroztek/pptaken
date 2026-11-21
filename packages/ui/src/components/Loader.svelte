<script lang="ts" module>
  export type LoaderSize = "inline" | "section" | "page";
</script>

<script lang="ts">
  import { getI18n } from "../i18n";

  interface Props {
    /**
     * `inline`: an icon-sized slide that lights up (buttons, a line of text). `section`: the cue (lamp, signal,
     * slide) for a list or a card. `page`: the cue, larger and centered, with an optional visible caption.
     */
    size?: LoaderSize;
    /** Spoken text. Default: "Loading" in the current language. */
    label?: string;
    /** Visible caption under the cue (`page` only), for example "Setting the stage…". */
    caption?: string;
    /**
     * `true` (default): a polite live region with the label. `false` when something else already says it (a busy
     * button, a status line with its own text): the loader is then decorative and hidden from assistive tech.
     */
    announce?: boolean;
    class?: string;
  }

  let { size = "section", label, caption, announce = true, class: className = "" }: Props = $props();
  const t = getI18n();
  const text = $derived(label ?? t("common.loading"));
</script>

<!-- Pure CSS animation (components.css, "loader"): appears after a short delay so fast loads never flash, and
     holds still under prefers-reduced-motion except for a slow fade of the lit slide. -->
<span
  class={["ppt-loader", `ppt-loader--${size}`, className].filter(Boolean).join(" ")}
  role={announce ? "status" : undefined}
  aria-live={announce ? "polite" : undefined}
  aria-hidden={announce ? undefined : "true"}
  data-loader={size}
>
  {#if size === "inline"}
    <svg class="ppt-loader__art" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect class="ppt-loader__fill" x="2.5" y="5.25" width="13" height="7.5" rx="1" />
      <rect class="ppt-loader__frame" x="1.75" y="4.5" width="14.5" height="9" rx="1.75" />
    </svg>
  {:else}
    <svg class="ppt-loader__art" viewBox="0 0 64 20" aria-hidden="true" focusable="false">
      <circle class="ppt-loader__halo" cx="7" cy="10" r="5.75" />
      <circle class="ppt-loader__lamp" cx="7" cy="10" r="3.25" />
      <path class="ppt-loader__wire" d="M16 10H37" />
      <circle class="ppt-loader__signal" cx="16" cy="10" r="1.6" />
      <rect class="ppt-loader__fill" x="42.75" y="3.75" width="20" height="12.5" rx="1.5" />
      <path class="ppt-loader__arrow" d="M51 7.5L54 10L51 12.5" />
      <rect class="ppt-loader__frame" x="42.75" y="3.75" width="20" height="12.5" rx="1.5" />
    </svg>
  {/if}
  {#if announce}<span class="ppt-sr-only">{text}</span>{/if}
  {#if size === "page" && caption}<span class="ppt-loader__caption" aria-hidden="true">{caption}</span>{/if}
</span>
