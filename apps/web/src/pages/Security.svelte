<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /security: the owner password. Tokens and connected applications live in Access & connections (/tokens). -->
<script lang="ts">
  import ChangePassword from "../components/ChangePassword.svelte";
  import { t } from "../lib/state.svelte";
</script>

<div class="page">
  <div class="page-head">
    <div class="page-head__text">
      <h1 class="ppt-h1">{t("security.title")}</h1>
      <p class="ppt-muted">{t("security.subtitle")}</p>
    </div>
  </div>

  <ChangePassword />
</div>
