<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /security: your password, and the optional presenter password (ADR-021). Connected apps and access keys live in
  Connected apps (/apps).
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
