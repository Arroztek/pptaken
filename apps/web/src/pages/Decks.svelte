<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /decks: the presentations, as a calm typeset list or as a grid of covers (the first slide as rendered; the choice is
  remembered in this browser, the list is the default). Each item: the title, one quiet line (slides · edited), at
  most ONE chip and only when something needs the owner (needs your OK, had a problem), Present, and a "More" menu
  (Details, Download, Move to trash). Deleting asks once, then a toast offers Undo. The empty state says what to do
  next. Server error text is never shown as-is (Developer details adds it under the plain sentence).
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Icon, Loader, Notice, toast } from "@pptaken/ui";
  import { onDestroy, onMount } from "svelte";
  import ActionMenu from "../components/ActionMenu.svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import DeckCover from "../components/DeckCover.svelte";
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
  import { COVER_CONCURRENCY, createCoverStore, createLimiter } from "../lib/covers";
  import { type DeckView, readDeckView, saveDeckView } from "../lib/deck-view";
  import { errorMessage } from "../lib/errors";
  import { debounce, describeWhen } from "../lib/format";
  import { countOfflineCopies, forgetOfflineCopies } from "../lib/offline";
  import { handleAuthError, navigate, prefs, t } from "../lib/state.svelte";
  import { checkImportFile, groupWarnings, IMPORT_ACCEPT, importKindOf } from "../lib/transfer";
  import type { Key } from "../lib/translate";

  // Download: one dialog for the deck whose menu was used.
  let exportDeck = $state<DeckSummary | null>(null);
  let exportOpen = $state(false);
  let htmlNotes = $state(false);
  function openExport(deck: DeckSummary) {
    exportDeck = deck;
    htmlNotes = false;
    exportOpen = true;
  }

  // Delete: a short friendly confirmation, then Undo in a toast.
  let deleteDeck = $state<DeckSummary | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let actionError = $state("");
  function askDelete(deck: DeckSummary) {
    deleteDeck = deck;
    deleteOpen = true;
  }

  async function confirmDelete() {
    const deck = deleteDeck;
    if (!deck) return;
    deleting = true;
    actionError = "";
    try {
      await api.trashDeck(deck.id);
      deleteOpen = false;
      decks = decks.filter((d) => d.id !== deck.id);
      toast.show(t("decks.deletedToast", { title: deck.title }), {
        icon: "trash",
        action: { label: t("decks.undo"), run: () => undoDelete(deck) },
      });
    } catch (e) {
      deleteOpen = false;
      if (!handleAuthError(e)) actionError = errorMessage(e, t);
    } finally {
      deleting = false;
    }
  }

  async function undoDelete(deck: DeckSummary) {
    try {
      // Undo puts everything back as it was, the shared links the trash turned off included (the owner just
      // confirmed "This also turns off N shared links" and is now taking it back).
      await api.restoreDeck(deck.id, { restoreLinks: true });
      toast.show(t("decks.restoredToast", { title: deck.title }));
      await load(shownQuery);
    } catch (e) {
      if (!handleAuthError(e)) actionError = t("decks.actionError");
    }
  }

  // Import: a dialog explains what can be imported, then a hidden file input; one upload at a time.
  let fileInput: HTMLInputElement | undefined = $state();
  let importOpen = $state(false);
  let importing = $state<string | null>(null);
  let importingKind = $state<ImportKind>("archive");
  let progress = $state<ImportProgress | null>(null);
  let imported = $state<ImportResult | null>(null);
  let importError = $state<{ title: string; text: string; detail: string | null } | null>(null);
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
        detail: null,
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
      // Plain words always; the server's own (English, technical) explanation only with Developer details.
      const validation = e instanceof ApiError && e.code === "VALIDATION_ERROR";
      const detail =
        validation && e.message ? (e.hint ? `${e.message}. ${e.hint}` : e.message) : null;
      importError = {
        title: t("transfer.importFailed", { name: file.name }),
        text: validation ? t("transfer.importFailedText") : errorMessage(e, t),
        detail,
      };
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

  // List or grid. The grid shows each deck's first slide (DeckCover); the signed cover URLs of the page come in one
  // request, and the covers load a few at a time as they near the viewport.
  let view = $state<DeckView>(readDeckView());
  function chooseView(next: DeckView) {
    view = next;
    saveDeckView(next);
  }
  const coverStore = createCoverStore((ids) => api.deckCovers(ids));
  const coverSlots = createLimiter(COVER_CONCURRENCY);
  $effect(() => {
    if (view === "grid" && decks.length > 0)
      void coverStore.resolve(decks.map((d) => ({ id: d.id, revision: d.revision })));
  });

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
    return `${slides} · ${edited}`;
  }

  /**
   * The one chip a card may show: something that needs the owner first; otherwise a quiet "Shared" when the deck has
   * active public links (ADR-026), so the owner always knows what is out there.
   */
  function attention(deck: DeckSummary): "needsOk" | "problems" | "shared" | null {
    if (deck.scripts === "pending") return "needsOk";
    if (deck.scripts === "approved" && (deck.scriptErrors ?? 0) > 0) return "problems";
    if ((deck.sharedLinks ?? 0) > 0) return "shared";
    return null;
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

<PageLayout title={t("decks.title")} subtitle={t("decks.lead")} actions={!empty && !loading ? headActions : undefined}>
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
        <Loader size="inline" announce={false} />
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
    <Notice tone="danger" title={importError.title} text={importError.text} ondismiss={() => (importError = null)}>
      {#if prefs.dev && importError.detail}
        <p class="dev-line">{t("dev.importDetail", { text: importError.detail })}</p>
      {/if}
    </Notice>
  {/if}
  {#if actionError}
    <Notice tone="danger" title={actionError} ondismiss={() => (actionError = "")} />
  {/if}
  {#if imported}
    <Notice
      tone="success"
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
        <a class="ppt-btn ppt-btn--secondary ppt-btn--sm" href="/decks/{encodeURIComponent(imported.deck.id)}"
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
    <EmptyState title={t("decks.noneTitle")} text={t("decks.noneText")}>
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
        <div class="example-prompt">
          <p class="example-prompt__text" data-testid="example-prompt">{t("decks.examplePrompt")}</p>
          <div class="row">
            <CopyButton variant="primary" label={t("decks.copyExample")} text={t("decks.examplePrompt")} />
            <Button variant="ghost" href="/welcome">{t("decks.connectClaude")}</Button>
          </div>
          <div class="row empty-more">
            {@render importButton("ghost")}
            <a class="ppt-link ppt-small" href="/trash">{t("decks.trashLink")}</a>
          </div>
        </div>
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
      <div class="seg" role="group" aria-label={t("decks.viewLabel")} data-testid="view-switch">
        <button type="button" class="seg__btn" aria-pressed={view === "list"} onclick={() => chooseView("list")}>
          <Icon name="list" size={16} /><span>{t("decks.viewList")}</span>
        </button>
        <button type="button" class="seg__btn" aria-pressed={view === "grid"} onclick={() => chooseView("grid")}>
          <Icon name="squares-four" size={16} /><span>{t("decks.viewGrid")}</span>
        </button>
      </div>
    </div>

    {#if loading && decks.length === 0}
      <Loader />
    {:else if decks.length === 0 && !error}
      <EmptyState title={t("decks.noMatchTitle", { q: shownQuery })} text={t("decks.noMatchText")} headingLevel={2}>
        {#snippet actions()}
          <Button variant="secondary" onclick={clearSearch}>{t("decks.clearSearch")}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      {#if view === "list"}
        <!-- A list that reads like a well-set index: title, one quiet line, at most one chip, Present and More. -->
        <ul class="deck-list" aria-busy={loading} data-testid="deck-list">
          {#each decks as deck (deck.id)}
            <li class="deck-row" data-id={deck.id}>
              <div class="deck-row__text">
                <h2 class="deck-row__title" lang={deck.lang ?? undefined}>
                  <a href="/decks/{encodeURIComponent(deck.id)}">{deck.title}</a>
                </h2>
                <p class="deck-row__meta">
                  <span>{meta(deck)}</span>
                  {@render chipOf(deck)}
                </p>
              </div>
              <div class="deck-row__actions">{@render actionsOf(deck)}</div>
            </li>
          {/each}
        </ul>
      {:else}
        <!-- A grid of covers: the first slide as rendered, then the same quiet text and actions as the list. -->
        <ul class="deck-cards" aria-busy={loading} data-testid="deck-grid">
          {#each decks as deck (deck.id)}
            <li class="deck-card" data-id={deck.id}>
              {#key deck.revision}
                <DeckCover
                  title={deck.title}
                  lang={deck.lang ?? undefined}
                  limiter={coverSlots}
                  resolve={() =>
                    coverStore.get(
                      { id: deck.id, revision: deck.revision },
                      decks.map((d) => ({ id: d.id, revision: d.revision })),
                    )}
                />
              {/key}
              <div class="deck-card__body">
                <h2 class="deck-card__title" lang={deck.lang ?? undefined}>
                  <a href="/decks/{encodeURIComponent(deck.id)}">{deck.title}</a>
                </h2>
                <div class="deck-card__more">{@render moreOf(deck)}</div>
                <p class="deck-card__meta">{meta(deck)}</p>
                <div class="deck-card__foot">
                  {@render presentOf(deck)}
                  {@render chipOf(deck)}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      {#if nextCursor}
        <div class="load-more">
          <Button variant="secondary" loading={loadingMore} onclick={loadMore}>{t("decks.loadMore")}</Button>
        </div>
      {/if}
    {/if}
    <p class="list-foot">
      <a class="ppt-link ppt-small" href="/trash"><Icon name="trash" size={16} />{t("decks.trashLink")}</a>
    </p>
  {/if}
  {#if offlineCopies > 0}
    <p class="offline-copies ppt-muted">
      <span>{t("decks.offlineCopies", { n: offlineCopies })}</span>
      <Button variant="ghost" size="sm" onclick={forgetCopies}>{t("decks.offlineForget")}</Button>
    </p>
  {/if}
</PageLayout>

{#snippet chipOf(deck: DeckSummary)}
  {@const chip = attention(deck)}
  {#if chip === "shared"}
    {@const n = deck.sharedLinks ?? 0}
    <a
      class="deck-chip deck-chip--quiet"
      data-chip="shared"
      href="/decks/{encodeURIComponent(deck.id)}#share"
      aria-label={n === 1 ? t("share.chipLabelOne") : t("share.chipLabel", { n })}
      ><Icon name="link" size={14} />{t("share.chip")}</a
    >
  {:else if chip}
    <a
      class="deck-chip"
      data-chip={chip}
      data-scripts={deck.scripts}
      href={chip === "needsOk" ? `/decks/${encodeURIComponent(deck.id)}/approve` : `/decks/${encodeURIComponent(deck.id)}`}
      ><span class="ppt-dot ppt-dot--warning" aria-hidden="true"></span>{chip === "needsOk" ? t("decks.chipNeedsOk") : t("decks.chipProblems")}</a
    >
  {/if}
{/snippet}

{#snippet presentOf(deck: DeckSummary)}
  <Button size="sm" variant="secondary" icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank"
    >{t("decks.present")}<span class="ppt-sr-only"> {deck.title} {t("deck.newTab")}</span></Button
  >
{/snippet}

{#snippet moreOf(deck: DeckSummary)}
  <ActionMenu
    label={t("decks.moreFor", { title: deck.title })}
    items={[
      { id: "open", label: t("decks.menuOpen"), icon: "info", run: () => navigate(`/decks/${encodeURIComponent(deck.id)}`) },
      { id: "download", label: t("decks.menuDownload"), icon: "download", run: () => openExport(deck) },
      { id: "delete", label: t("decks.menuDelete"), icon: "trash", danger: true, run: () => askDelete(deck) },
    ]}
  />
{/snippet}

{#snippet actionsOf(deck: DeckSummary)}
  {@render presentOf(deck)}
  {@render moreOf(deck)}
{/snippet}

{#snippet headActions()}
  {@render importButton("secondary")}
{/snippet}

{#snippet importButton(variant: "secondary" | "ghost")}
  <Button {variant} loading={importing !== null} onclick={() => (importOpen = true)}>{t("transfer.import")}</Button>
{/snippet}

<Dialog bind:open={deleteOpen} title={deleteDeck ? t("decks.deleteTitle", { title: deleteDeck.title }) : ""}>
  <p>{t("decks.deleteText")}</p>
  {#if (deleteDeck?.sharedLinks ?? 0) > 0}
    <p data-testid="delete-links">
      {deleteDeck?.sharedLinks === 1 ? t("decks.deleteLinksOne") : t("decks.deleteLinks", { n: deleteDeck?.sharedLinks ?? 0 })}
    </p>
  {/if}
  {#snippet actions()}
    <Button variant="secondary" onclick={() => (deleteOpen = false)}>{t("common.cancel")}</Button>
    <Button variant="danger" icon="trash" loading={deleting} onclick={confirmDelete}>{t("decks.deleteConfirm")}</Button>
  {/snippet}
</Dialog>

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
      {#if exportDeck.scripts && exportDeck.scripts !== "none"}
        <p class="ppt-muted ppt-small">{t("transfer.simpleNote")}</p>
      {/if}
    </div>
  {/if}
</Dialog>
