<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, Dialog, EmptyState, Notice, StatusBadge, Table, TextField, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import ConnectedApps from "../components/ConnectedApps.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import PageSection from "../components/PageSection.svelte";
  import SecretBlock from "../components/SecretBlock.svelte";
  import { api, type TokenListItem } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatDate } from "../lib/format";
  import { MASKED_SECRET } from "../lib/prompts";
  import { handleAuthError, prefs, secrets, t } from "../lib/state.svelte";

  let tokens = $state<TokenListItem[]>([]);
  let loading = $state(true);
  let listError = $state("");
  let name = $state("");
  let submitted = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let pending = $state<TokenListItem | null>(null);
  let confirmOpen = $state(false);
  let revoking = $state(false);
  let revokeError = $state("");
  const now = Date.now();

  const nameError = $derived(submitted && !name.trim() ? t("tokens.nameRequired") : "");

  async function load() {
    loading = true;
    listError = "";
    try {
      tokens = await api.listTokens();
    } catch (e) {
      if (!handleAuthError(e)) listError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  async function create(event: SubmitEvent) {
    event.preventDefault();
    submitted = true;
    createError = "";
    if (!name.trim()) return;
    creating = true;
    try {
      secrets.created = await api.createToken(name.trim());
      name = "";
      submitted = false;
      await load();
    } catch (e) {
      if (!handleAuthError(e)) createError = errorMessage(e, t);
    } finally {
      creating = false;
    }
  }

  function askRevoke(token: TokenListItem) {
    pending = token;
    revokeError = "";
    confirmOpen = true;
  }

  async function revoke() {
    if (!pending) return;
    revoking = true;
    revokeError = "";
    try {
      await api.revokeToken(pending.id);
      if (secrets.created?.token.id === pending.id) secrets.created = null;
      confirmOpen = false;
      toast.show(t("tokens.revoked"));
      await load();
    } catch (e) {
      if (!handleAuthError(e)) revokeError = errorMessage(e, t);
    } finally {
      revoking = false;
    }
  }

  type State = "active" | "revoked" | "expired";
  function stateOf(token: TokenListItem): State {
    if (token.revokedAt) return "revoked";
    if (token.expiresAt && Date.parse(token.expiresAt) <= now) return "expired";
    return "active";
  }

  function lastUsed(token: TokenListItem): string {
    if (!token.lastUsedAt) return t("tokens.never");
    return describeWhen(token.lastUsedAt, prefs.locale, now).text;
  }

  const columns = $derived([
    { key: "name", label: t("tokens.colName") },
    { key: "scopes", label: t("tokens.colScopes"), kind: "mono" as const },
    { key: "created", label: t("tokens.colCreated") },
    { key: "lastUsed", label: t("tokens.colLastUsed") },
    { key: "status", label: t("tokens.colStatus") },
    { key: "actions", label: t("tokens.colActions"), hiddenLabel: true },
  ]);
  const rows = $derived(tokens.map((token) => ({ id: token.id, token })));
</script>

<PageLayout title={t("tokens.title")} subtitle={t("tokens.subtitle")}>
  <PageSection id="create" title={t("tokens.createTitle")} description={t("tokens.createText")} card>
    {#if secrets.created}
      <Notice tone="success" title={t("tokens.createdTitle")} text={t("tokens.createdText")} />
      <SecretBlock label={t("tokens.secretLabel")} masked={MASKED_SECRET} secret={secrets.created.secret} />
      <div>
        <Button variant="secondary" onclick={() => (secrets.created = null)}>{t("tokens.done")}</Button>
      </div>
    {:else}
      <form class="token-form" novalidate onsubmit={create}>
        <TextField
          label={t("tokens.nameLabel")}
          hint={t("tokens.nameHint")}
          error={nameError}
          bind:value={name}
          name="name"
          maxlength={80}
          autocomplete="off"
          required
        />
        <div class="token-form__actions">
          <Button variant="primary" type="submit" loading={creating}>{t("tokens.create")}</Button>
        </div>
      </form>
      {#if createError}<Notice tone="danger" title={createError} />{/if}
    {/if}
  </PageSection>

  <PageSection id="tokens" title={t("tokens.listTitle")} description={t("tokens.listText")}>
    {#if listError}
      <Notice tone="danger" title={listError}>
        <div><Button size="sm" onclick={load}>{t("app.retry")}</Button></div>
      </Notice>
    {:else if loading && tokens.length === 0}
      <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
    {:else if tokens.length === 0}
      <EmptyState title={t("tokens.emptyTitle")} text={t("tokens.emptyText")} headingLevel={3} />
    {:else}
      <Table {columns} {rows} rowKey={(row) => row.id}>
        {#snippet cell(row, column)}
          {@const token = row.token}
          {#if column.key === "name"}
            <span class="token-name">{token.name}</span>
          {:else if column.key === "scopes"}
            {token.scopes.join(" ")}
          {:else if column.key === "created"}
            {formatDate(token.createdAt, prefs.locale, now)}
          {:else if column.key === "lastUsed"}
            {lastUsed(token)}
          {:else if column.key === "status"}
            {@const state = stateOf(token)}
            {#if state === "revoked"}
              <StatusBadge status="revoked" />
            {:else if state === "expired"}
              <StatusBadge status="offline" label={t("tokens.expired")} />
            {:else}
              <StatusBadge status="connected" label={t("tokens.active")} />
            {/if}
          {:else if column.key === "actions"}
            {#if stateOf(token) !== "revoked"}
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                aria-label={t("tokens.revokeFor", { name: token.name })}
                onclick={() => askRevoke(token)}>{t("tokens.revoke")}</Button
              >
            {/if}
          {/if}
        {/snippet}
      </Table>
    {/if}
  </PageSection>

  <ConnectedApps />
</PageLayout>

<Dialog bind:open={confirmOpen} title={t("tokens.confirmTitle", { name: pending?.name ?? "" })} dismissible={false}>
  <p class="ppt-muted">{t("tokens.confirmText")}</p>
  {#if revokeError}<Notice tone="danger" title={revokeError} />{/if}
  {#snippet actions()}
    <Button variant="secondary" onclick={() => (confirmOpen = false)}>{t("common.cancel")}</Button>
    <Button variant="danger" loading={revoking} onclick={revoke}>{t("tokens.revoke")}</Button>
  {/snippet}
</Dialog>