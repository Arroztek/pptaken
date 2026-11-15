<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, DeckCard, Dialog, EmptyState, Icon, Notice } from "@pptaken/ui";
  import { onDestroy, onMount } from "svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import {
    ApiError,
    api,
    type DeckSummary,
    exportUrl,
    type ImportResult,
    MAX_IMPORT_MB,
  } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { debounce, describeWhen } from "../lib/format";
  import { handleAuthError, prefs, t } from "../lib/state.svelte";
  import { checkImportFile } from "../lib/transfer";

  // Export: one dialog for the deck whose menu was opened.
  let exportDeck = $state<DeckSummary | null>(null);
  let exportOpen = $state(false);
  let htmlNotes = $state(false);
  function openExport(deck: DeckSummary) {
    exportDeck = deck;
    htmlNotes = false;
    exportOpen = true;
  }

  // Import: a hidden file input behind a button; one upload at a time.
  let fileInput: HTMLInputElement | undefined = $state();
  let importing = $state<string | null>(null);
  let imported = $state<ImportResult | null>(null);
  let importError = $state<{ title: string; text: string } | null>(null);

  async function importFile(file: File) {
    imported = null;
    importError = null;
    const problem = checkImportFile(file);
    if (problem !== null) {
      importError = {
        title: t("transfer.importFailed", { name: file.name }),
        text: problem === "tooLarge" ? t("transfer.tooLarge", { n: MAX_IMPORT_MB }) : t("transfer.wrongType"),
      };
      return;
    }
    importing = file.name;
    try {
      imported = await api.importDeck(file);
      query = "";
      search.cancel();
      await load("");
    } catch (e) {
      if (handleAuthError(e)) return;
      // The server explains what is wrong with the archive (English); other codes get the usual message.
      const detail =
        e instanceof ApiError && e.code === "VALIDATION_ERROR" && e.message ? e.message : errorMessage(e, t);
      importError = { title: t("transfer.importFailed", { name: file.name }), text: detail };
    } finally {
      importing = null;
    }
  }

  function onFileChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void importFile(file);
  }

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
        {@render importButton("secondary")}
      </div>
    {/if}
    <input
      bind:this={fileInput}
      class="ppt-sr-only"
      type="file"
      accept=".pptaken,application/zip"
      tabindex="-1"
      aria-hidden="true"
      onchange={onFileChosen}
    />
  </div>

  {#if importing}
    <p class="ppt-muted import-status" role="status">
      <Icon name="circle-notch" size={16} class="spin" />
      {t("transfer.importing", { name: importing })}
    </p>
  {/if}
  {#if importError}
    <Notice tone="danger" title={importError.title} text={importError.text} ondismiss={() => (importError = null)} />
  {/if}
  {#if imported}
    <Notice
      tone={imported.warnings.length === 0 ? "success" : "warning"}
      title={t("transfer.importedTitle", { title: imported.deck.title })}
      text={imported.warnings.length === 0
        ? t("transfer.importedClean")
        : imported.warnings.length === 1
          ? t("transfer.importedAdjustedOne")
          : t("transfer.importedAdjusted", { n: imported.warnings.length })}
      ondismiss={() => (imported = null)}
    >
      {#if imported.warnings.length > 0}
        <ul class="import-warnings">
          {#each imported.warnings.slice(0, 10) as warning, i (i)}
            <li>{warning.message}</li>
          {/each}
        </ul>
      {/if}
    </Notice>
  {/if}

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
        {@render importButton("ghost")}
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
            onmore={() => openExport(deck)}
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

{#snippet importButton(variant: "secondary" | "ghost")}
  <Button {variant} loading={importing !== null} onclick={() => fileInput?.click()}>{t("transfer.import")}</Button>
{/snippet}

<Dialog bind:open={exportOpen} title={exportDeck ? t("transfer.exportTitle", { title: exportDeck.title }) : ""}>
  {#if exportDeck}
    <div class="export-options">
      <section class="export-option" aria-labelledby="export-html-title">
        <h3 class="export-option__title" id="export-html-title">{t("transfer.htmlTitle")}</h3>
        <p class="ppt-muted">{t("transfer.htmlText")}</p>
        <label class="check">
          <input type="checkbox" bind:checked={htmlNotes} aria-describedby="export-notes-hint" />
          <span>{t("transfer.includeNotes")}</span>
        </label>
        {#if htmlNotes}
          <p class="ppt-field__hint" id="export-notes-hint">{t("transfer.includeNotesHint")}</p>
        {/if}
        <div>
          <a class="ppt-btn ppt-btn--primary" href={exportUrl(exportDeck.id, "html", htmlNotes)} download
            >{t("transfer.downloadHtml")}</a
          >
        </div>
      </section>
      <section class="export-option" aria-labelledby="export-archive-title">
        <h3 class="export-option__title" id="export-archive-title">{t("transfer.archiveTitle")}</h3>
        <p class="ppt-muted">{t("transfer.archiveText")}</p>
        <div>
          <a class="ppt-btn ppt-btn--secondary" href={exportUrl(exportDeck.id, "pptaken", true)} download
            >{t("transfer.downloadArchive")}</a
          >
        </div>
      </section>
    </div>
  {/if}
</Dialog>
