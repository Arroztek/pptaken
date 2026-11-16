<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- The slim bar of the focused pages (setup, sign-in, OAuth consent, signed-out screens): logo and preferences
     only. Signed-in pages use AppShell's sidebar instead. -->
<script lang="ts">
  import { ThemeToggle } from "@pptaken/ui";
  import { prefs, t } from "../lib/state.svelte";
  import BrandLogo from "./BrandLogo.svelte";
  import LangSwitch from "./LangSwitch.svelte";
</script>

<header class="app-header">
  <a class="app-header__logo" href="/" aria-label={t("nav.home")}>
    <span class="logo-wide"><BrandLogo variant="lockup" /></span>
    <span class="logo-narrow"><BrandLogo variant="isotype" /></span>
  </a>
  <span class="app-header__spacer"></span>
  <ThemeToggle bind:value={prefs.theme} />
  <LangSwitch />
</header>
