<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /apps (and the old /tokens): Connected apps first, in plain words; access keys under an "Advanced" fold that is
  closed unless Developer details are on or the old /tokens address was used.
-->
<script lang="ts">
  import AccessKeys from "../components/AccessKeys.svelte";
  import ConnectedApps from "../components/ConnectedApps.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import { prefs, route, t } from "../lib/state.svelte";

  const openKeys = prefs.dev || route.path === "/tokens";
</script>

<PageLayout title={t("apps.title")} subtitle={t("apps.subtitle")}>
  <ConnectedApps />
  <details class="fold page-section" open={openKeys} data-testid="keys-fold">
    <summary class="fold__summary">
      <span class="fold__title">{t("keys.advancedTitle")}</span>
      <span class="fold__text">{t("keys.advancedText")}</span>
    </summary>
    <div class="fold__body">
      <AccessKeys />
    </div>
  </details>
</PageLayout>
