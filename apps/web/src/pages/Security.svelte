<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /security: the owner password, and the presenter password for interactive presentations (ADR-021). Tokens and
  connected applications live in Access & connections (/tokens).
-->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import ChangePassword from "../components/ChangePassword.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import PresenterPassword from "../components/PresenterPassword.svelte";
  import { t } from "../lib/state.svelte";

  onMount(async () => {
    // Linked from a presentation's page (/security#presenter).
    if (location.hash === "#presenter") {
      await tick();
      document.getElementById("presenter-title")?.scrollIntoView({ block: "start" });
    }
  });
</script>

<PageLayout title={t("security.title")} subtitle={t("security.subtitle")} width="column">
  <ChangePassword />
  <PresenterPassword />
</PageLayout>
