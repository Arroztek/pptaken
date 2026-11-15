<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, DeckCard, EmptyState, Icon, Notice } from "@pptaken/ui";
  import { onDestroy, onMount } from "svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import { api, type DeckSummary } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { debounce, describeWhen } from "../lib/format";
  import { handleAuthError, prefs, t } from "../lib/state.svelte";

  let decks = $state<DeckSummary[]>([]);
  let nextCursor = $state<string | null>(null);
  let query = $state("");
  /** The query the visible list belongs to (the box may already hold a newer one). */
  let shownQuery = $state("");
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state("");
  let request = 0;
  const now = Date.now();

  async function load(q: string) {
    const id = ++request;
    loading = true;
    error = "";
    try {
      const page = await api.listDecks({ q: q || undefined });
      if (id !== request) return;
      decks = page.decks;
      nextCursor = page.nextCursor;
      shownQuery = q;
    } catch (e) {
      if (id !== request || handleAuthError(e)) return;
      error = errorMessage(e, t);
    } finally {
      if (id === request) loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    const id = request;
    loadingMore = true;
    error = "";
    try {
      const page = await api.listDecks({ cursor: nextCursor, q: shownQuery || undefined });
      if (id !== request) return;
      decks = [...decks, ...page.decks];
      nextCursor = page.nextCursor;
    } catch (e) {
      if (!handleAuthError(e)) error = errorMessage(e, t);
    } finally {
      loadingMore = false;
    }
  }

  const search = debounce((q: string) => void load(q.trim()), 250);
  onMount(() => void load(""));
  onDestroy(() => search.cancel());

  function clearSearch() {
    query = "";
    search.cancel();
    void load("");
  }

  function meta(deck: DeckSummary): string {
    const slides = deck.slideCount === 1 ? t("decks.slidesOne") : t("decks.slides", { n: deck.slideCount });
    const when = describeWhen(deck.updatedAt, prefs.locale, now);
    const edited =
      when.kind === "relative" ? t("decks.edited", { ago: when.text }) : t("decks.editedOn", { date: when.text });
    return `${slides} · ${t("decks.revision", { n: deck.revision })} · ${edited}`;
  }

  const empty = $derived(!loading && !error && decks.length === 0 && shownQuery === "" && query.trim() === "");
  const countText = $derived(
    nextCursor
      ? t("decks.countMore", { n: decks.length })
      : decks.length === 1
        ? t("decks.countOne")
        : t("decks.count", { n: decks.length }),
  );
</script>

<div class="page">
  <div class="page-head">
    <div class="page-head__text">
      <h1 class="ppt-h1">{t("decks.title")}</h1>
      <p class="ppt-muted">{t("decks.subtitle")}</p>
    </div>
    {#if !empty && !loading}
      <div class="page-head__actions">
        <CopyButton label={t("welcome.copyExample")} text={t("decks.examplePrompt")} />
      </div>
    {/if}
  </div>

  {#if error}
    <Notice tone="danger" title={error}>
      <div><Button size="sm" onclick={() => load(query.trim())}>{t("app.retry")}</Button></div>
    </Notice>
  {/if}

  {#if empty}
    <EmptyState title={t("decks.emptyTitle")} text={t("decks.emptyText")}>
      {#snippet art()}
        <svg class="ppt-empty__art" viewBox="0 0 240 160" fill="none" aria-hidden="true"
          ><path d="M111 15H129L178 131H62Z" fill="#FFB224" fill-opacity=".22" /><ellipse
            cx="120"
            cy="131.5"
            rx="58"
            ry="7.5"
            fill="#FFB224"
          /><path
            d="M107 4.5C107 3.67 107.67 3 108.5 3H131.5C132.33 3 133 3.67 133 4.5V9L129 15H111L107 9Z"
            fill="currentColor"
          /><path d="M14 131.5H226" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><rect
            x="89"
            y="58"
            width="72"
            height="40.5"
            rx="3"
            stroke="currentColor"
            stroke-width="2.5"
          /><path d="M90.25 98.5V131" stroke="currentColor" stroke-width="5" stroke-linecap="round" /><path
            d="M34 141H44M39 136V146M196 141H206M201 136V146"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          /></svg
        >
      {/snippet}
      {#snippet actions()}
        <CopyButton variant="primary" label={t("welcome.copyExample")} text={t("decks.examplePrompt")} />
        <Button variant="ghost" href="/welcome">{t("decks.connectAnother")}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="toolbar">
      <label class="search">
        <span class="ppt-sr-only">{t("decks.search")}</span>
        <Icon name="magnifying-glass" size={18} class="search__icon" />
        <input
          class="ppt-input"
          type="search"
          name="q"
          placeholder={t("decks.search")}
          autocomplete="off"
          bind:value={query}
          oninput={() => search(query)}
        />
      </label>
      {#if !loading}
        <span class="count" aria-live="polite">{countText}</span>
      {/if}
    </div>

    {#if loading && decks.length === 0}
      <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
    {:else if decks.length === 0 && !error}
      <EmptyState title={t("decks.noMatchTitle", { q: shownQuery })} text={t("decks.noMatchText")} headingLevel={2}>
        {#snippet actions()}
          <Button variant="secondary" onclick={clearSearch}>{t("decks.clearSearch")}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="deck-grid" aria-busy={loading}>
        {#each decks as deck (deck.id)}
          <DeckCard
            title={deck.title}
            href="/p/{encodeURIComponent(deck.id)}"
            presentHref="/p/{encodeURIComponent(deck.id)}"
            meta={meta(deck)}
          >
            {#snippet thumbnail()}
              <div class="thumb" lang={deck.lang} aria-hidden="true">
                <span class="thumb__rule"></span>
                <span class="thumb__title">{deck.title}</span>
              </div>
              <span class="ppt-badge ppt-deck__badge" class:badge-agent={deck.createdBy === "agent"}>
                <span class="ppt-badge__dot" aria-hidden="true"></span>
                {deck.createdBy === "agent" ? t("decks.byAgent") : t("decks.byOwner")}
              </span>
            {/snippet}
          </DeckCard>
        {/each}
      </div>
      {#if nextCursor}
        <div class="load-more">
          <Button variant="secondary" loading={loadingMore} onclick={loadMore}>{t("decks.loadMore")}</Button>
        </div>
      {/if}
    {/if}
  {/if}
</div>
