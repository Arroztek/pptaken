<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Button, DeckCard, Dialog, EmptyState, Icon, Notice } from "@pptaken/ui";
  import { onDestroy, onMount } from "svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import {
    ApiError,
    api,
    type DeckSummary,
    exportUrl,
    type ImportKind,
    type ImportProgress,
    type ImportResult,
    MAX_IMPORT_MB,
    uploadImport,
  } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { debounce, describeWhen } from "../lib/format";
  import { countOfflineCopies, forgetOfflineCopies } from "../lib/offline";
  import { handleAuthError, prefs, t } from "../lib/state.svelte";
  import { checkImportFile, groupWarnings, IMPORT_ACCEPT, importKindOf } from "../lib/transfer";
  import type { Key } from "../lib/translate";

  // Export: one dialog for the deck whose menu was opened.
  let exportDeck = $state<DeckSummary | null>(null);
  let exportOpen = $state(false);
  let htmlNotes = $state(false);
  function openExport(deck: DeckSummary) {
    exportDeck = deck;
    htmlNotes = false;
    exportOpen = true;
  }

  // Import: a dialog explains what can be imported, then a hidden file input; one upload at a time.
  let fileInput: HTMLInputElement | undefined = $state();
  let importOpen = $state(false);
  let importing = $state<string | null>(null);
  let importingKind = $state<ImportKind>("archive");
  let progress = $state<ImportProgress | null>(null);
  let imported = $state<ImportResult | null>(null);
  let importError = $state<{ title: string; text: string } | null>(null);
  const warningGroups = $derived(imported ? groupWarnings(imported.warnings) : []);

  function chooseFile() {
    importOpen = false;
    fileInput?.click();
  }

  async function importFile(file: File) {
    imported = null;
    importError = null;
    const problem = checkImportFile(file);
    if (problem !== null) {
      importError = {
        title: t("transfer.importFailed", { name: file.name }),
        text:
          problem === "tooLarge"
            ? t("transfer.tooLarge", { n: MAX_IMPORT_MB })
            : problem === "legacyPpt"
              ? t("transfer.legacyPpt")
              : t("transfer.wrongType"),
      };
      return;
    }
    importing = file.name;
    importingKind = importKindOf(file.name) ?? "archive";
    progress = { phase: "upload", fraction: 0 };
    try {
      imported = await uploadImport(file, importingKind, (p) => {
        progress = p;
      });
      query = "";
      search.cancel();
      await load("");
    } catch (e) {
      if (handleAuthError(e)) return;
      // The server explains what is wrong with the archive (English); other codes get the usual message.
      const detail =
        e instanceof ApiError && e.code === "VALIDATION_ERROR" && e.message
          ? e.hint
            ? `${e.message}. ${e.hint}`
            : e.message
          : errorMessage(e, t);
      importError = { title: t("transfer.importFailed", { name: file.name }), text: detail };
    } finally {
      importing = null;
      progress = null;
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

  // Offline copies kept by the player on this device (secure contexts only); a control deletes them.
  let offlineCopies = $state(0);
  async function forgetCopies() {
    await forgetOfflineCopies();
    offlineCopies = await countOfflineCopies();
  }

  const search = debounce((q: string) => void load(q.trim()), 250);
  onMount(() => {
    void load("");
    void countOfflineCopies().then((n) => {
      offlineCopies = n;
    });
  });
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

<PageLayout title={t("decks.title")} subtitle={t("decks.subtitle")} actions={!empty && !loading ? headActions : undefined}>
  <input
    bind:this={fileInput}
    class="ppt-sr-only"
    type="file"
    accept={IMPORT_ACCEPT}
    tabindex="-1"
    aria-hidden="true"
    onchange={onFileChosen}
  />

  {#if importing}
    <div class="import-progress" role="status">
      <p class="ppt-muted import-status">
        <Icon name="circle-notch" size={16} class="spin" />
        {progress?.phase === "process"
          ? importingKind === "pptx"
            ? t("transfer.converting", { name: importing })
            : t("transfer.importing", { name: importing })
          : t("transfer.uploading", { name: importing })}
      </p>
      <progress
        class="import-progress__bar"
        max="1"
        value={progress?.phase === "upload" && progress.fraction !== null ? progress.fraction : undefined}
        aria-label={t("transfer.uploading", { name: importing })}
      ></progress>
    </div>
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
      {#if warningGroups.length > 0}
        <div class="import-groups">
          {#each warningGroups as group, i (group.group)}
            <details class="import-group" open={i === 0}>
              <summary>{t(`transfer.groups.${group.group}` as Key)} ({group.items.length})</summary>
              <ul class="import-warnings">
                {#each group.items.slice(0, 100) as warning, j (j)}
                  <li>{warning.message}</li>
                {/each}
              </ul>
            </details>
          {/each}
        </div>
      {/if}
      <p class="import-open">
        <a class="ppt-btn ppt-btn--secondary ppt-btn--sm" href="/p/{encodeURIComponent(imported.deck.id)}" target="_blank" rel="noopener"
          >{t("transfer.openDeck")}</a
        >
      </p>
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
            href="/decks/{encodeURIComponent(deck.id)}"
            presentHref="/p/{encodeURIComponent(deck.id)}"
            newTab
            titleNewTab={false}
            meta={meta(deck)}
            onmore={() => openExport(deck)}
          >
            {#snippet thumbnail()}
              <div class="thumb" lang={deck.lang ?? undefined} aria-hidden="true">
                <span class="thumb__rule"></span>
                <span class="thumb__title">{deck.title}</span>
              </div>
              <span class="ppt-badge ppt-deck__badge" class:badge-agent={deck.createdBy === "agent"}>
                <span class="ppt-badge__dot" aria-hidden="true"></span>
                {deck.createdBy === "agent" ? t("decks.byAgent") : t("decks.byOwner")}
              </span>
              {#if deck.scripts === "pending" || deck.scripts === "approved"}
                {@const failing = deck.scripts === "approved" && (deck.scriptErrors ?? 0) > 0}
                <span
                  class="ppt-badge deck-interactive"
                  class:badge-ok={deck.scripts === "approved" && !failing}
                  class:badge-pending={deck.scripts === "pending" || failing}
                  data-scripts={deck.scripts}
                  data-script-errors={failing ? deck.scriptErrors : undefined}
                >
                  <span class="ppt-badge__dot" aria-hidden="true"></span>
                  {failing
                    ? deck.scriptErrors === 1
                      ? t("decks.interactiveErrorsOne")
                      : t("decks.interactiveErrors", { n: deck.scriptErrors ?? 0 })
                    : deck.scripts === "approved"
                      ? t("decks.interactiveApproved")
                      : t("decks.interactivePending")}
                </span>
              {/if}
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
  {#if offlineCopies > 0}
    <p class="offline-copies ppt-muted">
      <span>{t("decks.offlineCopies", { n: offlineCopies })}</span>
      <Button variant="ghost" size="sm" onclick={forgetCopies}>{t("decks.offlineForget")}</Button>
    </p>
  {/if}
</PageLayout>

{#snippet headActions()}
  <CopyButton label={t("welcome.copyExample")} text={t("decks.examplePrompt")} />
  {@render importButton("secondary")}
{/snippet}

{#snippet importButton(variant: "secondary" | "ghost")}
  <Button {variant} loading={importing !== null} onclick={() => (importOpen = true)}>{t("transfer.import")}</Button>
{/snippet}

<Dialog bind:open={importOpen} title={t("transfer.importTitle")}>
  <div class="export-options">
    <section class="export-option">
      <p>{t("transfer.importText")}</p>
    </section>
    <section class="export-option" aria-labelledby="import-pptx-title">
      <h3 class="export-option__title" id="import-pptx-title">{t("transfer.pptxTitle")}</h3>
      <p class="ppt-muted">{t("transfer.pptxText")}</p>
      <p class="ppt-muted">{t("transfer.pptxNotCarried")}</p>
      <p class="ppt-muted">{t("transfer.pptxLegacy")}</p>
    </section>
    <div>
      <Button variant="primary" onclick={chooseFile}>{t("transfer.chooseFile")}</Button>
    </div>
  </div>
</Dialog>

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
