<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Language selector: a radio group with the same keyboard model and look as ThemeToggle. -->
<script lang="ts">
  import type { Locale } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { prefs, setLocale, t } from "../lib/state.svelte";

  const options: { id: Locale; short: string }[] = [
    { id: "en", short: "EN" },
    { id: "es", short: "ES" },
  ];
  const buttons: HTMLButtonElement[] = $state([]);

  function choose(id: Locale) {
    setLocale(id);
  }

  function onkeydown(event: KeyboardEvent) {
    const i = options.findIndex((o) => o.id === prefs.locale);
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(i + step + options.length) % options.length];
    if (next) choose(next.id);
  }

  // The whole tree is re-created on a language change: give focus back to the switch.
  onMount(() => {
    if (!prefs.refocusLang) return;
    prefs.refocusLang = false;
    buttons[options.findIndex((o) => o.id === prefs.locale)]?.focus();
  });
</script>

<div class="ppt-segmented lang-switch" role="radiogroup" aria-label={t("nav.language")} tabindex="-1" {onkeydown}>
  {#each options as option, i (option.id)}
    <button
      bind:this={buttons[i]}
      type="button"
      class="ppt-segmented__opt"
      role="radio"
      lang={option.id}
      aria-checked={prefs.locale === option.id}
      aria-label={t(`lang.${option.id}`)}
      title={t(`lang.${option.id}`)}
      tabindex={prefs.locale === option.id ? 0 : -1}
      onclick={() => choose(option.id)}
    >
      <span aria-hidden="true">{option.short}</span>
    </button>
  {/each}
</div>
