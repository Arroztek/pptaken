<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, EmptyState } from "@pptaken/ui";
  import { t } from "../lib/state.svelte";
</script>

<div class="page">
  <EmptyState title={t("notFound.title")} text={t("notFound.text")} headingLevel={2}>
    {#snippet actions()}
      <Button variant="secondary" href="/">{t("notFound.back")}</Button>
    {/snippet}
  </EmptyState>
</div>
