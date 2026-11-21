<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  Access keys (API tokens, ADR-009) for tools that connect without signing in, like Claude Code. Shown under the
  "Advanced" fold of Connected apps. A new key is shown once (memory only, cleared when the page is left).
  Permissions (scopes) only with Developer details.
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Loader, Notice, StatusBadge, Table, TextField, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { api, type TokenListItem } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatDate } from "../lib/format";
  import { MASKED_SECRET } from "../lib/prompts";
  import { handleAuthError, prefs, secrets, t } from "../lib/state.svelte";
  import SecretBlock from "./SecretBlock.svelte";

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

  const nameError = $derived(submitted && !name.trim() ? t("keys.nameRequired") : "");

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
      toast.show(t("keys.removedToast"));
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
    if (!token.lastUsedAt) return t("keys.never");
    return describeWhen(token.lastUsedAt, prefs.locale, now).text;
  }

  const columns = $derived([
    { key: "name", label: t("keys.colName") },
    ...(prefs.dev ? [{ key: "scopes", label: t("devConnect.permissions"), kind: "mono" as const }] : []),
    { key: "created", label: t("keys.colCreated") },
    { key: "lastUsed", label: t("keys.colLastUsed") },
    { key: "status", label: t("keys.colStatus") },
    { key: "actions", label: t("keys.colActions"), hiddenLabel: true },
  ]);
  const rows = $derived(tokens.map((token) => ({ id: token.id, token })));
</script>

<div class="stack" data-testid="access-keys">
  <div class="ppt-card keys-create">
    <h3 class="ppt-h3">{t("keys.createTitle")}</h3>
    {#if secrets.created}
      <Notice tone="success" title={t("keys.createdTitle")} text={t("keys.createdText")} />
      <SecretBlock label={t("keys.secretLabel")} masked={MASKED_SECRET} secret={secrets.created.secret} />
      <div>
        <Button variant="secondary" onclick={() => (secrets.created = null)}>{t("keys.done")}</Button>
      </div>
    {:else}
      <form class="token-form" novalidate onsubmit={create}>
        <TextField
          label={t("keys.nameLabel")}
          hint={t("keys.nameHint")}
          error={nameError}
          bind:value={name}
          name="name"
          maxlength={80}
          autocomplete="off"
          required
        />
        <div class="token-form__actions">
          <Button variant="primary" type="submit" loading={creating}>{t("keys.create")}</Button>
        </div>
      </form>
      {#if createError}<Notice tone="danger" title={createError} />{/if}
    {/if}
  </div>

  <h3 class="ppt-h3">{t("keys.listTitle")}</h3>
  {#if listError}
    <Notice tone="danger" title={listError}>
      <div><Button size="sm" onclick={load}>{t("app.retry")}</Button></div>
    </Notice>
  {:else if loading && tokens.length === 0}
    <Loader />
  {:else if tokens.length === 0}
    <EmptyState title={t("keys.emptyTitle")} text={t("keys.emptyText")} headingLevel={3} />
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
            <StatusBadge status="revoked" label={t("keys.removed")} />
          {:else if state === "expired"}
            <StatusBadge status="offline" label={t("keys.expired")} />
          {:else}
            <StatusBadge status="connected" label={t("keys.active")} />
          {/if}
        {:else if column.key === "actions"}
          {#if stateOf(token) !== "revoked"}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("keys.removeFor", { name: token.name })}
              onclick={() => askRevoke(token)}>{t("keys.remove")}</Button
            >
          {/if}
        {/if}
      {/snippet}
    </Table>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title={t("keys.confirmTitle", { name: pending?.name ?? "" })} dismissible={false}>
  <p class="ppt-muted">{t("keys.confirmText")}</p>
  {#if revokeError}<Notice tone="danger" title={revokeError} />{/if}
  {#snippet actions()}
    <Button variant="secondary" onclick={() => (confirmOpen = false)}>{t("common.cancel")}</Button>
    <Button variant="danger" loading={revoking} onclick={revoke}>{t("keys.remove")}</Button>
  {/snippet}
</Dialog>
