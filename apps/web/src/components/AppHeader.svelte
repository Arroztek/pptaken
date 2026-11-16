<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { IconButton, ThemeToggle } from "@pptaken/ui";
  import { api } from "../lib/api";
  import { forgetOfflineCopies } from "../lib/offline";
  import { navigate, prefs, route, session, t } from "../lib/state.svelte";
  import BrandLogo from "./BrandLogo.svelte";
  import LangSwitch from "./LangSwitch.svelte";

  let { nav = false }: { nav?: boolean } = $props();
  let signingOut = $state(false);

  const links = $derived([
    { href: "/decks", label: t("nav.decks") },
    { href: "/tokens", label: t("nav.tokens") },
    { href: "/security", label: t("nav.security") },
    { href: "/welcome", label: t("nav.connect") },
  ]);

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
    session.signedIn = false;
    navigate("/login", { replace: true });
  }
</script>

{#snippet navLinks()}
  {#each links as link (link.href)}
    <a href={link.href} aria-current={route.path === link.href ? "page" : undefined}>{link.label}</a>
  {/each}
{/snippet}

<header class="app-header">
  <a class="app-header__logo" href="/" aria-label={t("nav.home")}>
    <span class="logo-wide"><BrandLogo variant="lockup" /></span>
    <span class="logo-narrow"><BrandLogo variant="isotype" /></span>
  </a>
  {#if nav}
    <nav class="app-nav" aria-label={t("nav.label")}>{@render navLinks()}</nav>
  {/if}
  <span class="app-header__spacer"></span>
  <ThemeToggle bind:value={prefs.theme} />
  <LangSwitch />
  {#if nav}
    <IconButton icon="sign-out" label={t("nav.signOut")} onclick={signOut} disabled={signingOut} />
  {/if}
</header>
{#if nav}
  <nav class="app-subnav" aria-label={t("nav.label")}>{@render navLinks()}</nav>
{/if}
