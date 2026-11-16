<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /security: the owner password. Tokens and connected applications live in Access & connections (/tokens). -->
<script lang="ts">
  import ChangePassword from "../components/ChangePassword.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import { t } from "../lib/state.svelte";
</script>

<PageLayout title={t("security.title")} subtitle={t("security.subtitle")} width="column">
  <ChangePassword />
</PageLayout>
