<script lang="ts" module>
  export type ThemeChoice = "system" | "light" | "dark";
  const STORAGE_KEY = "pptaken.theme";

  /** Apply a theme choice to <html>. "system" removes the attribute so prefers-color-scheme decides. */
  export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
  }

  /** Read the stored choice. Storage can be unavailable (private mode): fall back to the default. */
  export function readTheme(fallback: ThemeChoice = "system"): ThemeChoice {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === "light" || v === "dark" || v === "system" ? v : fallback;
    } catch {
      return fallback;
    }
  }
</script>

<script lang="ts">
  import { getI18n } from "../i18n";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  interface Props {
    /** Panel default: "system". Player and remote pass "dark" (05 §5.3 rule 5). */
    value?: ThemeChoice;
    /** Persist to localStorage. */
    persist?: boolean;
  }

  let { value = $bindable("system"), persist = true }: Props = $props();
  const t = getI18n();
  const options: { id: ThemeChoice; icon: IconName }[] = [
    { id: "system", icon: "desktop" },
    { id: "light", icon: "sun" },
    { id: "dark", icon: "moon" },
  ];
  const buttons: HTMLButtonElement[] = $state([]);

  $effect(() => {
    applyTheme(value);
    if (!persist) return;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* storage blocked: the choice still applies for this page view */
    }
  });

  // Radio group keyboard model: arrows move and select.
  function onkeydown(event: KeyboardEvent) {
    const i = options.findIndex((o) => o.id === value);
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const n = (i + step + options.length) % options.length;
    const next = options[n];
    if (next) {
      value = next.id;
      buttons[n]?.focus();
    }
  }
</script>

<div class="ppt-segmented" role="radiogroup" aria-label={t("theme.label")} tabindex="-1" {onkeydown}>
  {#each options as option, i (option.id)}
    <button
      bind:this={buttons[i]}
      type="button"
      class="ppt-segmented__opt"
      role="radio"
      aria-checked={value === option.id}
      aria-label={t(`theme.${option.id}`)}
      title={t(`theme.${option.id}`)}
      tabindex={value === option.id ? 0 : -1}
      onclick={() => (value = option.id)}
    >
      <Icon name={option.icon} size={18} />
    </button>
  {/each}
</div>
