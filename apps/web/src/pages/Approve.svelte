<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /decks/:id/approve: the one-click approval screen (the agents' approve_url, ADR-024). One plain sentence of what
  is being allowed, one primary button (Allow), a quiet "See what will run", then "Done. You can present." with
  Present. Signed out, the router sends the owner through sign-in and back here (internal `next` only).
  The digest sent is the one this screen loaded: if Claude changed the code meanwhile, nothing is approved (409)
  and the screen reloads the new code.
-->
<script lang="ts">
  import { Button, Notice } from "@pptaken/ui";
  import ScriptViewer from "../components/ScriptViewer.svelte";
  import { ApiError, api, type DeckDetail, type ScriptsReview } from "../lib/api";
  import { deckStatus } from "../lib/deck-status";
  import { errorMessage } from "../lib/errors";
  import { deckIdOf } from "../lib/router";
  import { handleAuthError, route, t } from "../lib/state.svelte";

  const id = $derived(deckIdOf(route.path) ?? "");
  let deck = $state<DeckDetail | null>(null);
  let review = $state<ScriptsReview | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  let error = $state("");
  let changed = $state(false);
  let showCode = $state(false);
  let allowing = $state(false);
  let done = $state(false);
  let syntaxOk = $state(false);

  async function load(deckId: string) {
    error = "";
    try {
      const [d, r] = await Promise.all([api.getDeck(deckId), api.scriptsReview(deckId)]);
      if (deckId !== id) return;
      deck = d;
      review = r;
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.code === "NOT_FOUND") missing = true;
      else error = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const deckId = id;
    loading = true;
    done = false;
    void load(deckId);
  });

  const status = $derived(deckStatus(review, null));
  const syntaxError = $derived((review?.checks ?? []).some((c) => c.code === "SCRIPT_SYNTAX_ERROR"));

  async function allow() {
    if (!review?.digest || (syntaxError && !syntaxOk)) return;
    allowing = true;
    error = "";
    changed = false;
    try {
      await api.approveScripts(id, review.digest);
      done = true;
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.status === 409) {
        changed = true;
        await load(id);
      } else {
        error = errorMessage(e, t);
      }
    } finally {
      allowing = false;
    }
  }
</script>

<div class="focused approve" data-testid="approve-screen">
  {#if loading}
    <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
  {:else if missing}
    <div class="hero">
      <h1 class="ppt-display">{t("deck.notFoundTitle")}</h1>
      <p class="ppt-lead">{t("deck.notFoundText")}</p>
    </div>
    <div class="row">
      <Button variant="secondary" href="/decks">{t("deck.back")}</Button>
      <Button variant="ghost" href="/trash">{t("deck.openTrash")}</Button>
    </div>
  {:else if error && !deck}
    <Notice tone="danger" title={t("deck.loadError")} text={error}>
      <div><Button size="sm" onclick={() => load(id)}>{t("app.retry")}</Button></div>
    </Notice>
  {:else if deck && review}
    {#if done}
      <div class="hero ppt-curtain-in" data-testid="approve-done">
        <h1 class="ppt-display">{t("approve.doneTitle")}</h1>
        <p class="ppt-lead">{review.autoApproveUpdates === false ? t("approve.doneEvery") : t("approve.doneAuto")}</p>
      </div>
      <div class="row">
        <Button variant="primary" icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank"
          >{t("approve.present")}<span class="ppt-sr-only"> {t("deck.newTab")}</span></Button
        >
        <Button variant="ghost" href="/decks/{encodeURIComponent(deck.id)}">{t("approve.openDeck")}</Button>
      </div>
    {:else if status.kind === "needsOk"}
      <div class="hero">
        <h1 class="ppt-display approve__title">{t("approve.title", { title: deck.title })}</h1>
        <p class="ppt-lead">{status.reason === "newLib" ? t("approve.leadNewLib") : t("approve.lead")}</p>
        <p class="approve__safe">{t("approve.safe")}</p>
      </div>
      {#if changed}
        <p class="status-card__text" role="status">{t("deck.changedWhileOpen")}</p>
      {/if}
      {#if error}
        <Notice tone="danger" title={error} />
      {/if}
      {#if syntaxError}
        <p class="status-card__text" data-testid="syntax-note">{t("deck.syntaxNote")}</p>
        <label class="check">
          <input type="checkbox" bind:checked={syntaxOk} name="allow-anyway" />
          <span>{t("deck.syntaxCheck")}</span>
        </label>
      {/if}
      <div class="approve__actions">
        <Button variant="primary" icon="check" loading={allowing} disabled={syntaxError && !syntaxOk} onclick={allow}
          >{t("approve.allow")}</Button>
        <Button variant="ghost" href="/decks/{encodeURIComponent(deck.id)}">{t("approve.notNow")}</Button>
      </div>
      <p class="approve__more">
        <button type="button" class="link-btn" aria-expanded={showCode} aria-controls="approve-code" onclick={() => (showCode = !showCode)}
          >{showCode ? t("deck.hideWhatRuns") : t("deck.seeWhatRuns")}</button>
      </p>
      {#if showCode}
        <div class="stack" id="approve-code">
          <p class="ppt-muted ppt-small">{t("deck.codeText")}</p>
          {#if review.deckSource}
            <ScriptViewer script={{ slideId: "deck", index: 0, ...review.deckSource }} title={t("scriptErrors.deckScript")} />
          {/if}
          {#each review.sources as script, i (script.slideId)}
            <ScriptViewer {script} open={i < 2} />
          {/each}
          {#each review.newLibs ?? [] as lib (lib.sha256)}
            <p class="lib__line"><strong>{lib.name}</strong> <code class="lib__mono">{lib.source ?? ""}</code></p>
          {/each}
        </div>
      {/if}
    {:else if status.kind === "off"}
      <div class="hero">
        <h1 class="ppt-display">{t("approve.offTitle")}</h1>
        <p class="ppt-lead">{t("approve.offText")}</p>
      </div>
      <div class="row">
        <Button variant="primary" icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank">{t("approve.present")}</Button>
      </div>
    {:else}
      <div class="hero" data-testid="approve-nothing">
        <h1 class="ppt-display">{t("approve.nothingTitle")}</h1>
        <p class="ppt-lead">{t("approve.nothingText")}</p>
      </div>
      <div class="row">
        <Button variant="primary" icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank"
          >{t("approve.present")}<span class="ppt-sr-only"> {t("deck.newTab")}</span></Button
        >
        <Button variant="ghost" href="/decks/{encodeURIComponent(deck.id)}">{t("approve.openDeck")}</Button>
      </div>
    {/if}
  {/if}
</div>
