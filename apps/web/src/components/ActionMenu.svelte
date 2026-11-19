<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  A small "More" menu (menu button pattern): the button opens a list of actions; arrow keys move, Enter or Space
  runs, Escape or a click outside closes and focus returns to the button. Destructive items go last and say so.
-->
<script lang="ts" module>
  import type { IconName } from "@pptaken/ui";

  export interface MenuItem {
    id: string;
    label: string;
    icon?: IconName;
    /** A link (in-app or a download) instead of an action. */
    href?: string;
    download?: boolean;
    danger?: boolean;
    run?: () => void;
  }
</script>

<script lang="ts">
  import { Icon } from "@pptaken/ui";
  import { tick } from "svelte";


  interface Props {
    label: string;
    items: readonly MenuItem[];
    /** Text next to the icon (a wider trigger); icon only when absent. */
    text?: string;
  }

  let { label, items, text }: Props = $props();
  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  const uid = $props.id();

  function entries(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>("[role='menuitem']")] : [];
  }

  async function show(focus: "first" | "last" = "first") {
    open = true;
    await tick();
    const all = entries();
    (focus === "first" ? all[0] : all[all.length - 1])?.focus();
  }

  function hide(refocus = true) {
    open = false;
    if (refocus) button?.focus();
  }

  function onButtonKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void show(event.key === "ArrowDown" ? "first" : "last");
    }
  }

  function onListKey(event: KeyboardEvent) {
    const all = entries();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      all[(i + step + all.length) % all.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    } else if (event.key === "Tab") {
      hide(false);
    }
  }

  function choose(item: MenuItem) {
    hide();
    item.run?.();
  }

  function onWindowPointer(event: PointerEvent) {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && (list?.contains(target) || button?.contains(target))) return;
    hide(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} />

<div class="menu">
  <button
    bind:this={button}
    type="button"
    class={text ? "ppt-btn ppt-btn--secondary ppt-btn--sm menu__trigger" : "ppt-icon-btn ppt-icon-btn--sm menu__trigger"}
    aria-label={text ? undefined : label}
    title={text ? undefined : label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="{uid}-menu"
    onclick={() => (open ? hide() : show())}
    onkeydown={onButtonKey}
  >
    <Icon name="dots-three" size={18} />
    {#if text}<span>{text}</span>{/if}
  </button>
  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <ul class="menu__list" id="{uid}-menu" role="menu" aria-label={label} bind:this={list} onkeydown={onListKey}>
      {#each items as item (item.id)}
        <li role="none">
          {#if item.href}
            <a
              role="menuitem"
              tabindex="-1"
              class="menu__item"
              class:menu__item--danger={item.danger}
              href={item.href}
              download={item.download ? "" : undefined}
              onclick={() => hide(false)}
            >
              {#if item.icon}<Icon name={item.icon} size={18} />{/if}<span>{item.label}</span>
            </a>
          {:else}
            <button
              type="button"
              role="menuitem"
              tabindex="-1"
              class="menu__item"
              class:menu__item--danger={item.danger}
              onclick={() => choose(item)}
            >
              {#if item.icon}<Icon name={item.icon} size={18} />{/if}<span>{item.label}</span>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
