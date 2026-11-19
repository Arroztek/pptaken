<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  Connected apps: the apps the owner allowed by signing in (OAuth grants, ADR-0018), in plain words. Disconnecting
  revokes the grant and everything under it. Return address and raw permissions only with Developer details.
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Notice, Table, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { api, type ConnectedApp } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatDate } from "../lib/format";
  import { handleAuthError, prefs, t } from "../lib/state.svelte";

  let apps = $state<ConnectedApp[]>([]);
  let loading = $state(true);
  let listError = $state("");
  let pending = $state<ConnectedApp | null>(null);
  let confirmOpen = $state(false);
  let revoking = $state(false);
  let revokeError = $state("");
  const now = Date.now();

  export async function reload() {
    loading = true;
    listError = "";
    try {
      apps = await api.listConnectedApps();
    } catch (e) {
      if (!handleAuthError(e)) listError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  onMount(() => void reload());

  const nameOf = (app: ConnectedApp) => app.clientName ?? t("apps.unnamed");
  const accessOf = (app: ConnectedApp) =>
    app.scopes.includes("decks:write") ? t("apps.accessEdit") : t("apps.accessRead");

  function askRevoke(app: ConnectedApp) {
    pending = app;
    revokeError = "";
    confirmOpen = true;
  }

  async function revoke() {
    if (!pending) return;
    revoking = true;
    revokeError = "";
    try {
      await api.disconnectApp(pending.id);
      confirmOpen = false;
      toast.show(t("apps.disconnected"));
      await reload();
    } catch (e) {
      if (!handleAuthError(e)) revokeError = errorMessage(e, t);
    } finally {
      revoking = false;
    }
  }

  const columns = $derived([
    { key: "name", label: t("apps.colName") },
    ...(prefs.dev ? [{ key: "redirect", label: t("apps.colRedirect"), kind: "mono" as const }] : []),
    { key: "access", label: t("apps.colAccess"), ...(prefs.dev ? { kind: "mono" as const } : {}) },
    { key: "created", label: t("apps.colCreated") },
    { key: "lastUsed", label: t("apps.colLastUsed") },
    { key: "actions", label: t("apps.colActions"), hiddenLabel: true },
  ]);
  const rows = $derived(apps.map((app) => ({ id: app.id, app })));
</script>

<section class="page-section" aria-label={t("apps.title")} data-testid="connected-apps">
  {#if listError}
    <Notice tone="danger" title={listError}>
      <div><Button size="sm" onclick={reload}>{t("app.retry")}</Button></div>
    </Notice>
  {:else if loading && apps.length === 0}
    <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
  {:else if apps.length === 0}
    <EmptyState title={t("apps.emptyTitle")} text={t("apps.emptyText")} headingLevel={2}>
      {#snippet actions()}
        <Button variant="secondary" href="/welcome">{t("apps.connectClaude")}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <Table {columns} {rows} rowKey={(row) => row.id}>
      {#snippet cell(row, column)}
        {@const app = row.app}
        {#if column.key === "name"}
          <span class="token-name">{nameOf(app)}</span>
        {:else if column.key === "redirect"}
          {app.redirectHost}
        {:else if column.key === "access"}
          {prefs.dev ? app.scopes.join(" ") : accessOf(app)}
        {:else if column.key === "created"}
          {formatDate(app.createdAt, prefs.locale, now)}
        {:else if column.key === "lastUsed"}
          {app.lastUsedAt ? describeWhen(app.lastUsedAt, prefs.locale, now).text : t("apps.never")}
        {:else if column.key === "actions"}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("apps.disconnectFor", { name: nameOf(app) })}
            onclick={() => askRevoke(app)}>{t("apps.disconnect")}</Button
          >
        {/if}
      {/snippet}
    </Table>
  {/if}

  <Dialog
    bind:open={confirmOpen}
    title={t("apps.confirmTitle", { name: pending ? nameOf(pending) : "" })}
    dismissible={false}
  >
    <p class="ppt-muted">{t("apps.confirmText")}</p>
    {#if revokeError}<Notice tone="danger" title={revokeError} />{/if}
    {#snippet actions()}
      <Button variant="secondary" onclick={() => (confirmOpen = false)}>{t("common.cancel")}</Button>
      <Button variant="danger" loading={revoking} onclick={revoke}>{t("apps.disconnect")}</Button>
    {/snippet}
  </Dialog>
</section>
