<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  interface Tab {
    id: string;
    label: string;
    icon?: IconName;
  }

  interface Props {
    tabs: Tab[];
    /** Id of the selected tab. */
    selected?: string;
    /** Accessible name of the tab list. */
    label: string;
    /** Renders the active panel; receives the selected id. */
    panel: Snippet<[string]>;
    onchange?: (id: string) => void;
  }

  let { tabs, selected = $bindable(tabs[0]?.id ?? ""), label, panel, onchange }: Props = $props();
  const uid = $props.id();
  const buttons: HTMLButtonElement[] = $state([]);

  function select(id: string, focus = false) {
    selected = id;
    onchange?.(id);
    if (focus) buttons[tabs.findIndex((t) => t.id === id)]?.focus();
  }

  // WAI-ARIA tabs with automatic activation: arrows, Home and End move and select.
  function onkeydown(event: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === selected);
    const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const tab = tabs[(target + tabs.length) % tabs.length];
    if (tab) select(tab.id, true);
  }
</script>

<div class="ppt-tabs" role="tablist" aria-label={label} tabindex="-1" {onkeydown}>
  {#each tabs as tab, i (tab.id)}
    <button
      bind:this={buttons[i]}
      type="button"
      class="ppt-tab"
      role="tab"
      id="{uid}-tab-{tab.id}"
      aria-controls="{uid}-panel"
      aria-selected={tab.id === selected}
      tabindex={tab.id === selected ? 0 : -1}
      onclick={() => select(tab.id)}
    >
      {#if tab.icon}<Icon name={tab.icon} size={18} />{/if}
      {tab.label}
    </button>
  {/each}
</div>
<div class="ppt-tabpanel" role="tabpanel" id="{uid}-panel" aria-labelledby="{uid}-tab-{selected}" tabindex="0">
  {@render panel(selected)}
</div>
