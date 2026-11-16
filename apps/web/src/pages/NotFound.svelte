<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, EmptyState } from "@pptaken/ui";
  import PageLayout from "../components/PageLayout.svelte";
  import { t } from "../lib/state.svelte";
</script>

<PageLayout>
  <EmptyState title={t("notFound.title")} text={t("notFound.text")} headingLevel={1}>
    {#snippet actions()}
      <Button variant="secondary" href="/">{t("notFound.back")}</Button>
    {/snippet}
  </EmptyState>
</PageLayout>
