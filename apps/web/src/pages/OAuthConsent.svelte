<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  OAuth consent (ADR-0018). Reached from GET /oauth/authorize, which validated the client and the redirect URI and
  stored the request. The owner decides here; nothing is ever approved automatically. The headline is the redirect
  host (where access goes), never the client-supplied name, which is shown only as "calls itself …" (sanitized by
  the server). The logo_uri of a client is never fetched.
-->
<script lang="ts">
  import { Button, Notice } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { ApiError, api, type OAuthRequest } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { consentRequestId } from "../lib/router";
  import { handleAuthError, route, t } from "../lib/state.svelte";
  import type { Key } from "../lib/translate";

  const SCOPE_LABELS: Record<string, Key> = {
    "decks:read": "consent.scopeRead",
    "decks:write": "consent.scopeWrite",
    "quiz:draft": "consent.scopeQuiz",
  };

  let request = $state<OAuthRequest | null>(null);
  let loading = $state(true);
  let gone = $state(false);
  let loadError = $state("");
  let kept = $state<Record<string, boolean>>({});
  let busy = $state<"approve" | "deny" | null>(null);
  let decideError = $state("");
  let leaving = $state(false);

  const id = $derived(consentRequestId(route.path));
  const keptScopes = $derived(request ? request.scopes.filter((s) => kept[s]) : []);

  async function load() {
    loading = true;
    loadError = "";
    gone = false;
    try {
      if (!id) throw new ApiError("NOT_FOUND", 404, "bad id");
      request = await api.oauthRequest(id);
      kept = Object.fromEntries(request.scopes.map((s) => [s, true]));
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.code === "NOT_FOUND") gone = true;
      else loadError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  async function decide(decision: "approve" | "deny") {
    if (!request || !id || busy) return;
    decideError = "";
    if (decision === "approve" && keptScopes.length === 0) {
      decideError = t("consent.scopesRequired");
      return;
    }
    busy = decision;
    try {
      const target = await api.decideOAuthRequest(
        id,
        decision,
        decision === "approve" ? keptScopes : undefined,
      );
      leaving = true;
      // A full navigation to the client's registered redirect URI (validated by the server); not a form post,
      // so the app CSP's form-action 'self' does not apply.
      window.location.assign(target);
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.code === "NOT_FOUND") {
        gone = true;
        request = null;
      } else decideError = errorMessage(e, t);
    } finally {
      busy = null;
    }
  }
</script>

<div class="focused consent">
  {#if loading}
    <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
  {:else if gone || !request}
    {#if loadError}
      <Notice tone="danger" title={loadError}>
        <div><Button size="sm" onclick={load}>{t("app.retry")}</Button></div>
      </Notice>
    {:else}
      <section class="hero">
        <h1 class="ppt-display">{t("consent.expiredTitle")}</h1>
        <p class="ppt-lead">{t("consent.expiredText")}</p>
      </section>
    {/if}
  {:else}
    <section class="hero ppt-curtain-in">
      <h1 class="ppt-display consent__title">{t("consent.title", { host: request.redirectHost })}</h1>
      <p class="ppt-lead">{t("consent.lead")}</p>
    </section>

    <div class="form-card ppt-card consent__card">
      <div class="consent__about">
        <dl class="consent__facts">
          <dt>{t("consent.redirectLabel")}</dt>
          <dd>
            <code class="consent__uri" data-testid="consent-redirect">{request.redirectUri}</code>
            {#if request.redirectKind === "claude"}
              <span class="consent__badge" data-testid="consent-claude">{t("consent.claudeBadge")}</span>
            {/if}
          </dd>
        </dl>
        {#if request.client.idHost}
          <p class="ppt-small">{t("consent.publishedBy", { host: request.client.idHost })}</p>
        {/if}
        <p class="ppt-small ppt-muted" data-testid="consent-name">
          {request.client.name ? t("consent.callsItself", { name: request.client.name }) : t("consent.noName")}
        </p>
      </div>

      {#if request.redirectKind === "loopback"}
        <Notice
          tone="warning"
          title={t("consent.loopbackTitle")}
          text={t("consent.loopbackText", { host: request.redirectHost })}
        />
      {:else if request.redirectKind === "web"}
        <Notice tone="warning" title={t("consent.webTitle")} text={t("consent.webText")} />
      {/if}

      <fieldset class="consent__scopes">
        <legend class="ppt-h2">{t("consent.scopesTitle")}</legend>
        <p class="ppt-field__hint">{t("consent.scopesHint")}</p>
        {#each request.scopes as scope (scope)}
          <label class="check">
            <input type="checkbox" bind:checked={kept[scope]} name="scope" value={scope} />
            <span>{SCOPE_LABELS[scope] ? t(SCOPE_LABELS[scope]) : scope} <code class="ppt-small">{scope}</code></span>
          </label>
        {/each}
      </fieldset>

      <div class="consent__never">
        <h2 class="ppt-h2">{t("consent.neverTitle")}</h2>
        <p class="ppt-small ppt-muted">{t("consent.neverText")}</p>
      </div>

      {#if decideError}
        <Notice tone="danger" title={decideError} />
      {/if}
      {#if leaving}
        <p class="ppt-muted" role="status">{t("consent.redirecting", { host: request.redirectHost })}</p>
      {/if}
      <div class="form-actions consent__actions">
        <Button variant="secondary" loading={busy === "deny"} disabled={busy !== null || leaving} onclick={() => decide("deny")}
          >{t("consent.deny")}</Button
        >
        <Button variant="primary" loading={busy === "approve"} disabled={busy !== null || leaving} onclick={() => decide("approve")}
          >{t("consent.approve")}</Button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .consent__title {
    overflow-wrap: anywhere;
  }
  .consent__card {
    display: grid;
    gap: var(--ppt-rhythm-form);
  }
  .consent__about {
    display: grid;
    gap: var(--ppt-space-2);
  }
  .consent__facts {
    margin: 0;
    display: grid;
    gap: var(--ppt-space-1);
  }
  .consent__facts dt {
    font-size: var(--ppt-text-sm);
    font-weight: var(--ppt-weight-semibold);
  }
  .consent__facts dd {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--ppt-space-2);
  }
  .consent__uri {
    font-family: var(--ppt-font-mono);
    font-size: var(--ppt-text-sm);
    overflow-wrap: anywhere;
  }
  .consent__badge {
    display: inline-block;
    padding: 2px var(--ppt-space-2);
    border-radius: var(--ppt-radius-pill);
    border: var(--ppt-border-width) solid currentColor;
    font-size: var(--ppt-text-xs);
    font-weight: var(--ppt-weight-semibold);
  }
  .consent__scopes {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--ppt-space-2);
    min-width: 0;
  }
  .consent__scopes legend {
    padding: 0;
    margin-bottom: var(--ppt-space-1);
  }
  .consent__never {
    display: grid;
    gap: var(--ppt-space-1);
    padding-top: var(--ppt-rhythm-form);
    border-top: var(--ppt-border-width) solid var(--ppt-border);
  }
  .consent__actions {
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--ppt-space-2);
  }
</style>