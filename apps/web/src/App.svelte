<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, Notice, ToastRegion } from "@pptaken/ui";
  import type { Component } from "svelte";
  import { onMount, tick } from "svelte";
  import AppHeader from "./components/AppHeader.svelte";
  import I18nScope from "./components/I18nScope.svelte";
  import { decide, type Page } from "./lib/router";
  import { loadSession, navigate, network, prefs, route, session, t } from "./lib/state.svelte";
  import type { Key } from "./lib/translate";

  // One chunk per page: the welcome page does not pay for the presentation list, and so on.
  const loaders: Record<Page, () => Promise<{ default: Component }>> = {
    setup: () => import("./pages/Setup.svelte"),
    connect: () => import("./pages/Connect.svelte"),
    login: () => import("./pages/Login.svelte"),
    decks: () => import("./pages/Decks.svelte"),
    tokens: () => import("./pages/Tokens.svelte"),
    notFound: () => import("./pages/NotFound.svelte"),
  };
  const titles: Record<Page, Key> = {
    setup: "setup.pageTitle",
    connect: "connect.pageTitle",
    login: "login.pageTitle",
    decks: "decks.title",
    tokens: "tokens.title",
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
  const withNav = $derived(session.signedIn && (page === "connect" || page === "decks" || page === "tokens"));

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

{#key prefs.locale}
  <I18nScope locale={prefs.locale}>
    <a class="skip-link" href="#main">{t("app.skip")}</a>
    <AppHeader nav={withNav} />
    {#if !network.online}
      <div class="offline-bar">
        <Notice tone="warning" title={t("app.offlineTitle")} text={t("app.offlineText")} />
      </div>
    {/if}
    <main id="main" tabindex="-1" bind:this={main}>
      {#if session.boot === "error" || pageError}
        <div class="welcome">
          <Notice tone="danger" title={t("app.bootErrorTitle")} text={t("app.bootErrorText")}>
            <div><Button size="sm" onclick={() => (pageError ? location.reload() : loadSession())}>{t("app.retry")}</Button></div>
          </Notice>
        </div>
      {:else if session.boot === "loading" || !PageComponent || shownPage !== page}
        <p class="boot-loading" role="status">{t("app.loading")}</p>
      {:else}
        <PageComponent />
      {/if}
    </main>
    <ToastRegion />
  </I18nScope>
{/key}
