<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, Loader, Notice, ToastRegion } from "@pptaken/ui";
  import type { Component } from "svelte";
  import { onMount, tick } from "svelte";
  import AppHeader from "./components/AppHeader.svelte";
  import AppShell from "./components/AppShell.svelte";
  import I18nScope from "./components/I18nScope.svelte";
  import { decide, layoutFor, type Page } from "./lib/router";
  import { loadSession, navigate, network, prefs, route, session, t } from "./lib/state.svelte";
  import type { Key } from "./lib/translate";

  // One chunk per page: the welcome page does not pay for the presentation list, and so on.
  const loaders: Record<Page, () => Promise<{ default: Component }>> = {
    setup: () => import("./pages/Setup.svelte"),
    connect: () => import("./pages/Connect.svelte"),
    login: () => import("./pages/Login.svelte"),
    decks: () => import("./pages/Decks.svelte"),
    deck: () => import("./pages/Deck.svelte"),
    approve: () => import("./pages/Approve.svelte"),
    trash: () => import("./pages/Trash.svelte"),
    apps: () => import("./pages/Apps.svelte"),
    security: () => import("./pages/Security.svelte"),
    settings: () => import("./pages/Settings.svelte"),
    oauthConsent: () => import("./pages/OAuthConsent.svelte"),
    notFound: () => import("./pages/NotFound.svelte"),
  };
  const titles: Record<Page, Key> = {
    setup: "setup.pageTitle",
    connect: "connect.pageTitle",
    login: "login.pageTitle",
    decks: "decks.title",
    deck: "deck.pageTitle",
    approve: "approve.pageTitle",
    trash: "trash.pageTitle",
    apps: "apps.title",
    security: "security.title",
    settings: "settings.pageTitle",
    oauthConsent: "consent.pageTitle",
    notFound: "notFound.pageTitle",
  };

  let PageComponent = $state<Component | null>(null);
  let shownPage = $state<Page | null>(null);
  let pageError = $state(false);
  let main: HTMLElement | undefined = $state();
  let firstPage = true;

  const decision = $derived(
    session.boot === "ready"
      ? decide(route.path, route.search, { installed: session.installed, signedIn: session.signedIn })
      : null,
  );
  const page = $derived(decision?.kind === "render" ? decision.page : null);
  // Nothing framed until the session is known: no header flashing before the sidebar.
  const layout = $derived(page ? layoutFor(page, session.signedIn) : session.boot === "error" ? "focused" : null);

  onMount(() => void loadSession());

  $effect(() => {
    if (decision?.kind === "redirect") navigate(decision.to, { replace: true });
  });

  $effect(() => {
    const next = page;
    if (!next) return;
    let cancelled = false;
    pageError = false;
    loaders[next]()
      .then(async (mod) => {
        if (cancelled) return;
        PageComponent = mod.default;
        shownPage = next;
        await tick();
        // Move focus to the new page for keyboard and screen reader users (not on first load).
        if (!firstPage) main?.focus({ preventScroll: true });
        firstPage = false;
      })
      .catch(() => {
        if (!cancelled) pageError = true;
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (shownPage) document.title = t("app.title", { page: t(titles[shownPage]) });
  });
</script>

{#snippet content()}
  {#if !network.online}
    <div class="offline-bar">
      <Notice tone="warning" title={t("app.offlineTitle")} text={t("app.offlineText")} />
    </div>
  {/if}
  <main id="main" tabindex="-1" bind:this={main}>
    {#if session.boot === "error" || pageError}
      <div class="focused">
        <Notice tone="danger" title={t("app.bootErrorTitle")} text={t("app.bootErrorText")}>
          <div><Button size="sm" onclick={() => (pageError ? location.reload() : loadSession())}>{t("app.retry")}</Button></div>
        </Notice>
      </div>
    {:else if session.boot === "loading" || !PageComponent || shownPage !== page}
      <Loader size="page" label={t("common.loading")} caption={t("app.loading")} />
    {:else}
      <PageComponent />
    {/if}
  </main>
{/snippet}

{#key prefs.locale}
  <I18nScope locale={prefs.locale}>
    <a class="skip-link" href="#main">{t("app.skip")}</a>
    {#if layout === "shell" && page}
      <AppShell title={t(titles[page])}>{@render content()}</AppShell>
    {:else}
      {#if layout === "focused"}<AppHeader />{/if}
      {@render content()}
    {/if}
    <ToastRegion />
  </I18nScope>
{/key}
