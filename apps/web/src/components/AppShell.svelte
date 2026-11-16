<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  The signed-in dashboard frame: a left sidebar (logo, grouped navigation, this instance, preferences, sign out)
  and the page column. Desktop: the sidebar is always there and folds to icons (remembered per browser).
  Below 768 px it becomes a drawer behind a slim top bar: modal while open (the rest is inert, Tab stays inside,
  Escape or the scrim closes it and focus returns to the menu button).
-->
<script lang="ts">
  import { Icon, IconButton, ThemeToggle } from "@pptaken/ui";
  import type { Snippet } from "svelte";
  import { onMount, tick } from "svelte";
  import { api } from "../lib/api";
  import { isActive, NAV_GROUPS } from "../lib/nav";
  import { forgetOfflineCopies } from "../lib/offline";
  import { navigate, network, prefs, route, session, setSidebarCollapsed, shell, t } from "../lib/state.svelte";
  import BrandLogo from "./BrandLogo.svelte";
  import LangSwitch from "./LangSwitch.svelte";

  let { title, children }: { title: string; children: Snippet } = $props();

  const MOBILE = "(max-width: 767px)";
  const TABLET = "(max-width: 1023px)";
  let mobile = $state(typeof window !== "undefined" && window.matchMedia(MOBILE).matches);
  let tablet = $state(typeof window !== "undefined" && window.matchMedia(TABLET).matches);
  let sidebar: HTMLElement | undefined = $state();
  let menuButton: HTMLButtonElement | undefined = $state();
  let signingOut = $state(false);

  // Until the owner chooses, tablets get the icon rail so the page keeps its room.
  const collapsed = $derived((shell.collapsed ?? tablet) && !mobile);
  const drawer = $derived(mobile && shell.drawerOpen);
  const host = $derived.by(() => {
    try {
      return new URL(session.status?.publicUrl ?? location.origin).host;
    } catch {
      return location.host;
    }
  });

  const meta = $derived(
    [
      network.online ? t("nav.online") : t("nav.offline"),
      session.status?.version ? t("nav.version", { v: session.status.version }) : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

  onMount(() => {
    const query = window.matchMedia(MOBILE);
    const wide = window.matchMedia(TABLET);
    const sync = () => {
      mobile = query.matches;
      tablet = wide.matches;
      if (!mobile) shell.drawerOpen = false;
    };
    query.addEventListener("change", sync);
    wide.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
      wide.removeEventListener("change", sync);
    };
  });

  // Navigating closes the drawer (App moves focus to the new page). Not on mount: a language switch
  // re-creates this component and must leave the drawer as it was.
  let lastPath = route.path;
  $effect(() => {
    if (route.path === lastPath) return;
    lastPath = route.path;
    shell.drawerOpen = false;
  });

  // No page scrolling behind the open drawer.
  $effect(() => {
    document.documentElement.classList.toggle("drawer-open", drawer);
    return () => document.documentElement.classList.remove("drawer-open");
  });

  function focusables(): HTMLElement[] {
    return sidebar
      ? [...sidebar.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), [tabindex='0']")].filter(
          (el) => el.offsetParent !== null,
        )
      : [];
  }

  async function openDrawer() {
    shell.drawerOpen = true;
    await tick();
    focusables()[0]?.focus();
  }

  async function closeDrawer() {
    shell.drawerOpen = false;
    // The top bar is inert until the drawer state has rendered.
    await tick();
    menuButton?.focus();
  }

  function onkeydown(event: KeyboardEvent) {
    if (!drawer) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !sidebar?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !sidebar?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  async function signOut() {
    signingOut = true;
    // Offline copies of presentations hold private content: they go with the session.
    await forgetOfflineCopies();
    try {
      await api.logout();
    } catch {
      // Even if the server is unreachable, leave the signed-in screens.
    }
    signingOut = false;
    shell.drawerOpen = false;
    session.signedIn = false;
    navigate("/login", { replace: true });
  }
</script>

<svelte:window {onkeydown} />

<div class="shell" class:shell--collapsed={collapsed}>
  <header class="topbar" inert={drawer}>
    <button
      bind:this={menuButton}
      type="button"
      class="ppt-icon-btn topbar__menu"
      aria-label={t("nav.openMenu")}
      title={t("nav.openMenu")}
      aria-expanded={drawer}
      aria-controls="sidebar"
      onclick={openDrawer}
    >
      <Icon name="list" />
    </button>
    <a class="topbar__logo" href="/decks" aria-label={t("nav.home")}><BrandLogo variant="isotype" height={26} /></a>
    <span class="topbar__title">{title}</span>
  </header>

  {#if drawer}
    <!-- The scrim is a pointer convenience; keyboard users close with Escape or the close button. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim" onclick={closeDrawer}></div>
  {/if}

  <div
    bind:this={sidebar}
    id="sidebar"
    class="sidebar"
    class:sidebar--open={drawer}
    role={mobile ? "dialog" : undefined}
    aria-modal={drawer ? "true" : undefined}
    aria-label={mobile ? t("nav.label") : undefined}
    inert={mobile && !drawer}
  >
    <div class="sidebar__top">
      <a class="sidebar__logo" href="/decks" aria-label={t("nav.home")}>
        {#if collapsed}
          <BrandLogo variant="isotype" height={28} />
        {:else}
          <BrandLogo variant="lockup" height={28} />
        {/if}
      </a>
      {#if mobile}
        <IconButton icon="x" label={t("nav.closeMenu")} onclick={closeDrawer} />
      {:else}
        <IconButton
          icon="sidebar-simple"
          class="sidebar__toggle"
          label={collapsed ? t("nav.expand") : t("nav.collapse")}
          aria-expanded={!collapsed}
          aria-controls="sidebar"
          onclick={() => setSidebarCollapsed(!collapsed)}
        />
      {/if}
    </div>

    <nav class="sidebar__nav" aria-label={t("nav.label")}>
      {#each NAV_GROUPS as group (group.id)}
        <div class="nav-group">
          <p class="nav-group__label" id="nav-group-{group.id}">{t(group.label)}</p>
          <ul class="nav-list" aria-labelledby="nav-group-{group.id}">
            {#each group.items as item (item.href)}
              <li>
                <a
                  class="nav-link"
                  href={item.href}
                  aria-current={isActive(item, route.path) ? "page" : undefined}
                  title={collapsed ? t(item.label) : undefined}
                >
                  <Icon name={item.icon} />
                  <span class="nav-link__label">{t(item.label)}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>

    <div class="sidebar__foot">
      <div
        class="instance"
        class:instance--offline={!network.online}
        title={collapsed ? `${host} · ${network.online ? t("nav.online") : t("nav.offline")}` : undefined}
      >
        <span class="ppt-dot" class:ppt-dot--success={network.online} class:ppt-dot--warning={!network.online}></span>
        <span class="instance__text">
          <span class="instance__label">{t("nav.instance")}</span>
          <span class="instance__host" translate="no">{host}</span>
          <span class="instance__meta">{meta}</span>
        </span>
      </div>
      <div class="sidebar__prefs">
        <ThemeToggle bind:value={prefs.theme} />
        <LangSwitch />
      </div>
      <button
        type="button"
        class="nav-link nav-link--action"
        onclick={signOut}
        disabled={signingOut}
        title={collapsed ? t("nav.signOut") : undefined}
      >
        <Icon name="sign-out" />
        <span class="nav-link__label">{t("nav.signOut")}</span>
      </button>
    </div>
  </div>

  <div class="shell__content" inert={drawer}>
    {@render children()}
  </div>
</div>
