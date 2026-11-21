<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /decks/:id: one presentation, calm. Title, Present, and ONE status line with at most one primary action:
  Ready · Needs your OK for its interactive parts (Allow) · Some interactive parts had problems (Copy a message for
  Claude). Everything else appears only when relevant, in plain words: "What will run" (behind a quiet link: reading
  the code is the heart of consent), "Changes since your last OK" (ADR-024 automatic updates), "Files saved from
  the web". Fingerprints, raw errors, library provenance and instance mechanics are under Developer details.
  Error text is untrusted: text interpolation only, never {@html}.
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Loader, Notice, toast } from "@pptaken/ui";
  import { tick } from "svelte";
  import ActionMenu from "../components/ActionMenu.svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import PageSection from "../components/PageSection.svelte";
  import ScriptViewer from "../components/ScriptViewer.svelte";
  import SharePanel from "../components/SharePanel.svelte";
  import {
    ApiError,
    api,
    type DeckDetail,
    exportUrl,
    type ScriptErrors,
    type ScriptsReview,
    type VendoredResource,
  } from "../lib/api";
  import { codeChanges, deckStatus } from "../lib/deck-status";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatBytes, shortDigest } from "../lib/format";
  import { deckIdOf } from "../lib/router";
  import { agentSummary, hintText, slideLabel } from "../lib/script-errors";
  import { handleAuthError, navigate, prefs, route, t } from "../lib/state.svelte";

  const DOCS_CONTENT_ORIGIN =
    "https://github.com/arroztek/pptaken/blob/main/docs/guides/interactive-decks.md#a-separate-site-for-content";

  const id = $derived(deckIdOf(route.path) ?? "");
  let deck = $state<DeckDetail | null>(null);
  let review = $state<ScriptsReview | null>(null);
  let errors = $state<ScriptErrors | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  let loadError = $state("");
  let actionError = $state("");
  let changed = $state(false);

  let showCode = $state(false);
  let showChanges = $state(false);
  let approving = $state(false);
  let syntaxOk = $state(false);
  let revokeOpen = $state(false);
  let revoking = $state(false);
  let clearing = $state(false);
  let deleteOpen = $state(false);
  let deleting = $state(false);
  let exportOpen = $state(false);
  let htmlNotes = $state(false);
  // ADR-026: the Share panel (a dialog, not a page) and how many links are active right now.
  let shareOpen = $state(false);
  let sharedLinks = $state(0);

  async function load(deckId: string, quiet = false) {
    if (!quiet) loading = true;
    loadError = "";
    missing = false;
    try {
      const [d, r] = await Promise.all([api.getDeck(deckId), api.scriptsReview(deckId)]);
      if (deckId !== id) return;
      deck = d;
      review = r;
      sharedLinks = d.sharedLinks ?? 0;
      await loadErrors(deckId);
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.code === "NOT_FOUND") missing = true;
      else loadError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  /** Problems never block the page: if they cannot load, the status line simply does not mention them. */
  async function loadErrors(deckId: string) {
    if (review?.digest === null) {
      errors = null;
      return;
    }
    try {
      const e = await api.scriptErrors(deckId);
      if (deckId === id) errors = e;
    } catch (e) {
      handleAuthError(e);
      errors = null;
    }
  }

  $effect(() => {
    const deckId = id;
    deck = null;
    review = null;
    errors = null;
    changed = false;
    showCode = false;
    showChanges = false;
    actionError = "";
    shareOpen = false;
    void load(deckId).then(async () => {
      // The list's "Shared" chip points at #share: open the Share panel.
      if (location.hash === "#share" && deck !== null) shareOpen = true;
      // Old links (#scripts, #script-errors): open what they pointed at.
      if (location.hash === "#scripts") showCode = true;
      if (location.hash === "#scripts" || location.hash === "#script-errors") {
        await tick();
        document.getElementById("status")?.scrollIntoView({ block: "start" });
      }
    });
  });

  const status = $derived(deckStatus(review, errors));
  const interactive = $derived(review !== null && review.digest !== null);
  const vendored = $derived<VendoredResource[]>(deck?.vendored ?? []);
  const saved = $derived(vendored.filter((v) => v.status === "vendored").length);
  const failedCount = $derived(vendored.filter((v) => v.status === "failed").length);
  const checks = $derived(review?.checks ?? []);
  const syntaxError = $derived(checks.some((c) => c.code === "SCRIPT_SYNTAX_ERROR"));
  const errorList = $derived(errors?.current ?? []);
  const previousList = $derived(errors?.previous ?? []);
  const changes = $derived(
    review?.previous ? codeChanges(review.previous, { sources: review.sources, deckSource: review.deckSource }) : [],
  );
  const newLibKeys = $derived(new Set((review?.newLibs ?? []).map((l) => `${l.sha256} ${l.source ?? ""}`)));

  function meta(d: DeckDetail): string {
    const slides = d.slideCount === 1 ? t("decks.slidesOne") : t("decks.slides", { n: d.slideCount });
    const when = describeWhen(d.updatedAt, prefs.locale);
    const edited = when.kind === "relative" ? t("decks.edited", { ago: when.text }) : t("decks.editedOn", { date: when.text });
    return prefs.dev ? `${slides} · ${edited} · ${t("dev.revision", { n: d.revision })}` : `${slides} · ${edited}`;
  }

  function statusLabel(): string {
    switch (status.kind) {
      case "needsOk":
        return t("deck.statusNeedsOk");
      case "problems":
        return t("deck.statusProblems");
      case "off":
        return t("deck.statusOff");
      default:
        return t("deck.statusReady");
    }
  }

  function needsOkText(): string {
    if (status.reason === "newLib") return t("deck.needsOkNewLib");
    if (status.reason === "changed") return t("deck.needsOkChanged");
    return t("deck.needsOkText");
  }

  function originText(r: ScriptsReview): string {
    const o = r.capability.contentOrigin;
    return o === "separate-site" ? t("dev.originSeparate") : o === "same-site" ? t("dev.originSameSite") : t("dev.originSame");
  }

  async function allow() {
    if (!review?.digest || (syntaxError && !syntaxOk)) return;
    approving = true;
    actionError = "";
    changed = false;
    try {
      // The digest of the code this page shows: if Claude changed it meanwhile, nothing is approved (409).
      await api.approveScripts(id, review.digest);
      toast.show(t("deck.allowedToast"));
      await load(id, true);
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.status === 409) {
        changed = true;
        await load(id, true);
      } else {
        actionError = errorMessage(e, t);
      }
    } finally {
      approving = false;
    }
  }

  async function revoke() {
    revoking = true;
    actionError = "";
    try {
      await api.revokeScripts(id);
      revokeOpen = false;
      toast.show(t("deck.turnedOffToast"));
      await load(id, true);
    } catch (e) {
      revokeOpen = false;
      if (!handleAuthError(e)) actionError = errorMessage(e, t);
    } finally {
      revoking = false;
    }
  }

  async function clearProblems() {
    clearing = true;
    actionError = "";
    try {
      await api.clearScriptErrors(id);
      toast.show(t("deck.clearedToast"));
      await loadErrors(id);
    } catch (e) {
      if (!handleAuthError(e)) actionError = errorMessage(e, t);
    } finally {
      clearing = false;
    }
  }

  async function moveToTrash() {
    if (!deck) return;
    const current = deck;
    deleting = true;
    try {
      await api.trashDeck(current.id);
      deleteOpen = false;
      toast.show(t("decks.deletedToast", { title: current.title }), {
        icon: "trash",
        action: {
          label: t("decks.undo"),
          run: async () => {
            try {
              // Undo puts the shared links back too (ADR-026: the owner is taking the deletion back).
              await api.restoreDeck(current.id, { restoreLinks: true });
              toast.show(t("decks.restoredToast", { title: current.title }));
              navigate(`/decks/${encodeURIComponent(current.id)}`);
            } catch {
              toast.show(t("decks.actionError"), { icon: "warning-circle" });
            }
          },
        },
      });
      navigate("/decks");
    } catch (e) {
      deleteOpen = false;
      if (!handleAuthError(e)) actionError = errorMessage(e, t);
    } finally {
      deleting = false;
    }
  }
</script>

{#if loading && !deck}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={t("deck.pageTitle")}>
    <Loader />
  </PageLayout>
{:else if missing}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={t("deck.pageTitle")}>
    <EmptyState title={t("deck.notFoundTitle")} text={t("deck.notFoundText")} headingLevel={2}>
      {#snippet actions()}
        <Button variant="secondary" href="/decks">{t("deck.back")}</Button>
        <Button variant="ghost" href="/trash">{t("deck.openTrash")}</Button>
      {/snippet}
    </EmptyState>
  </PageLayout>
{:else if loadError || !deck || !review}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={t("deck.pageTitle")}>
    <Notice tone="danger" title={t("deck.loadError")} text={loadError}>
      <div><Button size="sm" onclick={() => load(id)}>{t("app.retry")}</Button></div>
    </Notice>
  </PageLayout>
{:else}
  {@const d = deck}
  {@const r = review}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={d.title} subtitle={meta(d)} actions={headActions}>
    {#if actionError}
      <Notice tone="danger" title={actionError} ondismiss={() => (actionError = "")} />
    {/if}

    <!-- The one status line. Calm surface; colour only on the dot, and warning only when the owner must act. -->
    <section class="status-card ppt-card" id="status" aria-labelledby="status-title" data-testid="deck-status" data-kind={status.kind}
      data-reason={status.reason ?? undefined}>
      <h2 class="ppt-sr-only" id="status-title">{t("deck.statusLabel")}</h2>
      <p class="status-card__label">
        <span
          class="ppt-dot"
          class:ppt-dot--success={status.kind === "ready" || status.kind === "interactive" || status.kind === "off"}
          class:ppt-dot--warning={status.kind === "needsOk" || status.kind === "problems"}
          aria-hidden="true"></span>
        <span>{statusLabel()}</span>
      </p>

      {#if changed}
        <p class="status-card__text" role="status">{t("deck.changedWhileOpen")}</p>
      {/if}

      {#if status.kind === "needsOk"}
        <p class="status-card__text">{needsOkText()}</p>
        {#if syntaxError}
          <p class="status-card__text" data-testid="syntax-note">{t("deck.syntaxNote")}</p>
          <label class="check">
            <input type="checkbox" bind:checked={syntaxOk} name="allow-anyway" />
            <span>{t("deck.syntaxCheck")}</span>
          </label>
        {/if}
        <div class="status-card__actions">
          <Button variant="primary" icon="check" loading={approving} disabled={syntaxError && !syntaxOk} onclick={allow}
            >{t("deck.allow")}</Button>
          <button type="button" class="link-btn" aria-expanded={showCode} aria-controls="code" onclick={() => (showCode = !showCode)}
            >{showCode ? t("deck.hideWhatRuns") : t("deck.seeWhatRuns")}</button>
        </div>
      {:else if status.kind === "problems"}
        <p class="status-card__text">{t("deck.problemsText")}</p>
        <div class="status-card__actions">
          <CopyButton variant="primary" label={t("deck.copyForClaude")} text={agentSummary(t, { id: d.id, title: d.title }, errorList)} />
          <Button variant="ghost" loading={clearing} onclick={clearProblems}>{t("deck.clearProblems")}</Button>
        </div>
      {:else if status.kind === "off"}
        <p class="status-card__text">{t("deck.offText")}</p>
        {#if prefs.dev}<p class="dev-line">{t("dev.offHow")}</p>{/if}
      {:else if status.kind === "interactive"}
        <p class="status-card__text">{t("deck.readyInteractive")}</p>
      {/if}

      {#if (status.kind === "interactive" || status.kind === "problems") && status.auto && r.approvedAt}
        <p class="status-card__text" data-testid="auto-line">
          {t("deck.autoLine", { when: describeWhen(r.approvedAt, prefs.locale).text })}
        </p>
      {/if}

      {#if status.kind === "interactive" || status.kind === "problems"}
        <div class="status-card__quiet">
          {#if status.auto && changes.length > 0}
            <button type="button" class="link-btn" aria-expanded={showChanges} aria-controls="changes"
              onclick={() => (showChanges = !showChanges)}>{showChanges ? t("deck.hideChanges") : t("deck.reviewChanges")}</button>
          {/if}
          <button type="button" class="link-btn" aria-expanded={showCode} aria-controls="code" onclick={() => (showCode = !showCode)}
            >{showCode ? t("deck.hideWhatRuns") : t("deck.seeWhatRuns")}</button>
          <button type="button" class="link-btn" onclick={() => (revokeOpen = true)}>{t("deck.turnOff")}</button>
        </div>
      {:else if status.kind === "off" && interactive}
        <div class="status-card__quiet">
          <button type="button" class="link-btn" aria-expanded={showCode} aria-controls="code" onclick={() => (showCode = !showCode)}
            >{showCode ? t("deck.hideWhatRuns") : t("deck.seeWhatRuns")}</button>
        </div>
      {/if}
    </section>

    {#if showChanges && changes.length > 0 && r.previous}
      <PageSection id="changes" title={t("deck.changesTitle")} description={t("deck.changesText")}>
        {#each changes as pair (pair.key)}
          {@const label = pair.key === "deck" ? t("scriptErrors.deckScript") : t("scriptErrors.slideUntitled", { n: pair.index + 1 })}
          <div class="diff">
            <div class="diff__side">
              <p class="diff__label">{t("deck.before")}</p>
              {#if pair.before !== null}
                <ScriptViewer compact title={label} script={{ slideId: pair.key, index: Math.max(0, pair.index), source: pair.before, sha256: "", bytes: 0 }} />
              {:else}
                <p class="ppt-muted ppt-small">{t("deck.noChange")}</p>
              {/if}
            </div>
            <div class="diff__side">
              <p class="diff__label">{t("deck.now")}</p>
              {#if pair.now !== null}
                <ScriptViewer compact title={label} script={{ slideId: pair.key, index: Math.max(0, pair.index), source: pair.now, sha256: "", bytes: 0 }} />
              {:else}
                <p class="ppt-muted ppt-small">{t("deck.noChange")}</p>
              {/if}
            </div>
          </div>
        {/each}
      </PageSection>
    {/if}

    {#if interactive && (showCode || prefs.dev)}
      <PageSection id="code" title={t("deck.codeTitle")} description={t("deck.codeText")}>
        {#if r.deckSource}
          <ScriptViewer script={{ slideId: "deck", index: 0, ...r.deckSource }} title={t("scriptErrors.deckScript")} />
        {/if}
        {#each r.sources as script, i (script.slideId)}
          <ScriptViewer {script} open={i < 3} />
        {/each}
        {#if r.libs.length > 0}
          <div class="block" data-testid="libs">
            <h3 class="ppt-h3">{t("dev.librariesTitle", { n: r.libs.length })}</h3>
            <ul class="libs">
              {#each r.libs as lib, i (i)}
                {@const isNew = newLibKeys.has(`${lib.sha256} ${lib.source ?? ""}`)}
                <li class="lib ppt-card" data-new={isNew}>
                  <p class="lib__name">
                    <strong>{lib.name}</strong>
                    {#if lib.version}<span class="ppt-muted">{t("dev.libVersion", { v: lib.version })}</span>{/if}
                    {#if isNew}<span class="ppt-badge badge-pending"><span class="ppt-badge__dot" aria-hidden="true"></span>{t("dev.libNew")}</span>{/if}
                  </p>
                  {#if lib.source}<p class="lib__line"><span class="lib__label">{t("dev.libSource")}</span> <code class="lib__mono">{lib.source}</code></p>{/if}
                  {#if prefs.dev}
                    <p class="lib__line"><span class="lib__label">SHA-256</span> <code class="lib__mono">{lib.sha256}</code></p>
                    {#if lib.finalUrl && lib.finalUrl !== lib.source}
                      <p class="lib__line"><span class="lib__label">{t("dev.libFinalUrl")}</span> <code class="lib__mono">{lib.finalUrl}</code></p>
                    {/if}
                    {#if lib.bytes !== null}
                      <p class="lib__line"><span class="lib__label">{t("dev.libSize")}</span> <span>{formatBytes(lib.bytes, prefs.locale)}</span></p>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </PageSection>
    {/if}

    {#if vendored.length > 0 || d.vendorFetch === "off"}
      <PageSection id="files" title={t("deck.filesTitle")}>
        <div class="quiet-block" data-testid="vendored-summary">
          {#if saved > 0}
            <p>{saved === 1 ? t("deck.filesSummaryOne") : t("deck.filesSummary", { n: saved })}</p>
          {/if}
          {#if failedCount > 0}
            <p data-testid="vendor-failed">{failedCount === 1 ? t("deck.filesFailedOne") : t("deck.filesFailed", { n: failedCount })}</p>
          {/if}
          {#if d.vendorFetch === "off"}
            <p>{t("deck.filesOff")}</p>
          {/if}
        </div>
        {#if prefs.dev && vendored.length > 0}
          <ul class="vendored" aria-label={t("dev.vendorTitle")} data-testid="vendored-list">
            {#each vendored as res, i (i)}
              <li class="lib ppt-card" data-status={res.status} data-kind={res.kind}>
                <p class="lib__name">
                  <span class="ppt-badge" class:badge-ok={res.status === "vendored"} class:badge-pending={res.status === "failed"}>
                    <span class="ppt-badge__dot" aria-hidden="true"></span>
                    {t(`dev.kind_${res.kind}`)}
                  </span>
                  {#if res.status === "failed"}
                    <span class="ppt-muted ppt-small">{t("dev.failed")}</span>
                  {:else}
                    <span class="ppt-muted ppt-small">{t("dev.fetched", { when: describeWhen(new Date(res.fetchedAt).toISOString(), prefs.locale).text })}</span>
                  {/if}
                </p>
                <p class="lib__line"><span class="lib__label">{t("dev.original")}</span> <code class="lib__mono">{res.url}</code></p>
                {#if res.finalUrl && res.finalUrl !== res.url}
                  <p class="lib__line"><span class="lib__label">{t("dev.final")}</span> <code class="lib__mono">{res.finalUrl}</code></p>
                {/if}
                {#if res.redirects && res.redirects.length > 0}
                  <p class="lib__line"><span class="lib__label">{t("dev.redirects")}</span> <code class="lib__mono">{res.redirects.join(" → ")}</code></p>
                {/if}
                {#if res.via}
                  <p class="lib__line"><span class="lib__label">{t("dev.via")}</span> <code class="lib__mono">{res.via}</code></p>
                {/if}
                {#if res.bytes !== null}
                  <p class="lib__line"><span class="lib__label">{t("dev.size")}</span> <span>{formatBytes(res.bytes, prefs.locale)}</span></p>
                {/if}
                {#if res.sha256}
                  <p class="lib__line"><span class="lib__label">SHA-256</span> <code class="lib__mono">{res.sha256}</code></p>
                {/if}
                {#if res.error}
                  <p class="lib__line"><span class="lib__label">{t("dev.error")}</span> <code class="lib__mono">{res.error}</code></p>
                {/if}
              </li>
            {/each}
          </ul>
          {#if d.vendorFetch === "off"}<p class="dev-line">{t("dev.vendorOff")}</p>{/if}
        {/if}
      </PageSection>
    {/if}

    {#if prefs.dev}
      <PageSection id="dev" title={t("dev.badge")}>
        <dl class="facts ppt-card" data-testid="dev-facts">
          <div class="facts__row"><dt>{t("dev.deckId")}</dt><dd><code class="lib__mono">{d.id}</code></dd></div>
          {#if interactive}
            <div class="facts__row facts__row--digest">
              <dt>{t("dev.digestLabel")}</dt>
              <dd>
                <div class="digest">
                  <code class="digest__short" data-testid="digest-short">{shortDigest(r.digest ?? "")}</code>
                  <CopyButton size="sm" variant="secondary" label={t("dev.copyDigest")} text={r.digest ?? ""} />
                </div>
                <code class="digest__full" data-testid="digest-full">{r.digest}</code>
                <span class="facts__note">{t("dev.digestHint")}</span>
              </dd>
            </div>
            <div class="facts__row">
              <dt>{t("dev.approvalLabel")}</dt>
              <dd>
                {#if r.state === "approved" && r.approvedAt}
                  {r.approvalMode === "auto"
                    ? t("dev.approvalAuto", { when: describeWhen(r.approvedAt, prefs.locale).text })
                    : t("dev.approvalOwner", { when: describeWhen(r.approvedAt, prefs.locale).text })}
                {:else if r.approvedDigest !== null}
                  {t("dev.approvalStale")}
                {:else}
                  {t("dev.approvalNone")}
                {/if}
              </dd>
            </div>
          {/if}
          <div class="facts__row"><dt>{t("dev.instanceLabel")}</dt><dd><code class="lib__mono">{r.enabled ? t("dev.instanceOn") : t("dev.instanceOff")}</code></dd></div>
          <div class="facts__row"><dt>{t("dev.capabilityLabel")}</dt><dd>{originText(r)}</dd></div>
        </dl>
        {#if r.enabled && r.capability.freezeWarning && interactive}
          <p class="dev-line" data-testid="freeze-warning">
            {t("dev.freezeWarning")}
            <a class="ppt-link" href={DOCS_CONTENT_ORIGIN} target="_blank" rel="noopener noreferrer">{t("dev.docsLink")}</a>
          </p>
        {/if}
        {#if checks.length > 0}
          <div class="block" data-testid="script-checks">
            <h3 class="ppt-h3">{t("dev.checksTitle", { n: checks.length })}</h3>
            <ul class="warnings">
              {#each checks as c, i (i)}
                <li data-code={c.code}><code class="lib__mono">{c.path ?? ""}</code> {c.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if r.warnings.length > 0}
          <div class="block">
            <h3 class="ppt-h3">{t("dev.warningsTitle", { n: r.warnings.length })}</h3>
            <ul class="warnings">
              {#each r.warnings as w, i (i)}
                <li><code class="lib__mono">{w.path ?? ""}</code> {w.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
        {#each [{ list: errorList, previous: false }, { list: previousList, previous: true }] as group (group.previous)}
          {#if group.list.length > 0}
            <div class="block" id={group.previous ? undefined : "script-errors"}>
              <h3 class="ppt-h3">{group.previous ? t("scriptErrors.previousTitle", { n: group.list.length }) : t("scriptErrors.title")}</h3>
              <ul class="serr__list" data-testid={group.previous ? "script-errors-previous" : "script-errors-list"}>
                {#each group.list as e, i (i)}
                  {@const hint = hintText(t, e.hint)}
                  <li class="serr__item ppt-card" data-kind={e.kind} data-slide={e.slideId}>
                    <p class="serr__where">
                      <strong>{slideLabel(t, e)}</strong>
                      {#if e.slideIndex !== null}<span class="serr__id">{e.slideId}</span>{/if}
                      <span class="ppt-muted">· {t(`scriptErrors.kind_${e.kind}`)}</span>
                    </p>
                    <p class="serr__msg"><span class="serr__name">{e.name}</span>{e.message ? `: ${e.message}` : ""}</p>
                    <p class="serr__meta">
                      <span>{e.count === 1 ? t("scriptErrors.countOne") : t("scriptErrors.countMany", { n: e.count })}</span>
                      <span>{t("scriptErrors.lastSeen", { when: describeWhen(e.lastSeen, prefs.locale).text })}</span>
                    </p>
                    {#if hint}
                      <p class="serr__hint"><span>{t("scriptErrors.hintLabel")}</span><span>{hint}</span></p>
                    {/if}
                  </li>
                {/each}
              </ul>
              <p class="serr__note">{t("scriptErrors.textNote")}</p>
            </div>
          {/if}
        {/each}
        {#if interactive && !r.presenterPassword.set}
          <p class="dev-line">{t("deck.presenterNote")} <a class="ppt-link" href="/security#presenter">{t("deck.presenterLink")}</a></p>
        {/if}
      </PageSection>
    {/if}
  </PageLayout>

  <Dialog bind:open={revokeOpen} title={t("deck.turnOffTitle")}>
    <p>{t("deck.turnOffText")}</p>
    {#snippet actions()}
      <Button variant="secondary" onclick={() => (revokeOpen = false)}>{t("common.cancel")}</Button>
      <Button variant="primary" loading={revoking} onclick={revoke}>{t("deck.turnOffConfirm")}</Button>
    {/snippet}
  </Dialog>

  <Dialog
    bind:open={shareOpen}
    title={t("share.title", { title: d.title })}
    onclose={() => {
      if (location.hash === "#share") history.replaceState(null, "", location.pathname + location.search);
    }}
  >
    {#if shareOpen}
      <SharePanel deckId={d.id} onchange={(n) => (sharedLinks = n)} />
    {/if}
  </Dialog>

  <Dialog bind:open={deleteOpen} title={t("decks.deleteTitle", { title: d.title })}>
    <p>{t("decks.deleteText")}</p>
    {#if sharedLinks > 0}
      <p data-testid="delete-links">{sharedLinks === 1 ? t("decks.deleteLinksOne") : t("decks.deleteLinks", { n: sharedLinks })}</p>
    {/if}
    {#snippet actions()}
      <Button variant="secondary" onclick={() => (deleteOpen = false)}>{t("common.cancel")}</Button>
      <Button variant="danger" icon="trash" loading={deleting} onclick={moveToTrash}>{t("decks.deleteConfirm")}</Button>
    {/snippet}
  </Dialog>

  <Dialog bind:open={exportOpen} title={t("transfer.exportTitle", { title: d.title })}>
    <div class="export-options">
      <section class="export-option" aria-labelledby="export-html-title">
        <h3 class="export-option__title" id="export-html-title">{t("transfer.htmlTitle")}</h3>
        <p class="ppt-muted">{t("transfer.htmlText")}</p>
        <label class="check">
          <input type="checkbox" bind:checked={htmlNotes} />
          <span>{t("transfer.includeNotes")}</span>
        </label>
        {#if htmlNotes}<p class="ppt-field__hint">{t("transfer.includeNotesHint")}</p>{/if}
        <div><a class="ppt-btn ppt-btn--primary" href={exportUrl(d.id, "html", htmlNotes)} download>{t("transfer.downloadHtml")}</a></div>
      </section>
      <section class="export-option" aria-labelledby="export-archive-title">
        <h3 class="export-option__title" id="export-archive-title">{t("transfer.archiveTitle")}</h3>
        <p class="ppt-muted">{t("transfer.archiveText")}</p>
        <div><a class="ppt-btn ppt-btn--secondary" href={exportUrl(d.id, "pptaken", true)} download>{t("transfer.downloadArchive")}</a></div>
      </section>
      {#if interactive}<p class="ppt-muted ppt-small">{t("transfer.simpleNote")}</p>{/if}
    </div>
  </Dialog>
{/if}

{#snippet headActions()}
  {#if deck}
    <Button variant={status.kind === "needsOk" ? "secondary" : "primary"} icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank"
      >{t("deck.present")}<span class="ppt-sr-only"> {t("deck.newTab")}</span></Button
    >
    <Button variant="secondary" icon="link" aria-haspopup="dialog" data-testid="share-button" onclick={() => (shareOpen = true)}
      >{t("share.button")}{#if sharedLinks > 0}<span class="share-count" aria-hidden="true">{sharedLinks}</span><span class="ppt-sr-only">
          · {sharedLinks === 1 ? t("share.chipLabelOne") : t("share.chipLabel", { n: sharedLinks })}</span
        >{/if}</Button
    >
    <ActionMenu
      label={t("deck.moreActions")}
      items={[
        { id: "download", label: t("deck.download"), icon: "download", run: () => { htmlNotes = false; exportOpen = true; } },
        { id: "delete", label: t("deck.delete"), icon: "trash", danger: true, run: () => (deleteOpen = true) },
      ]}
    />
  {/if}
{/snippet}
