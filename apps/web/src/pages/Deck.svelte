<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /decks/:id: one presentation (urls.manage, and the agents' approve_url with #scripts). The header says what it is
  and presents it; the Interactive section is the owner's approval screen (ADR-021): instance switch, approval
  state, fingerprint, every script and library, what the static version loses, the content-origin capability, and
  Approve (binds the fingerprint shown) / Revoke. Decks without scripts get a calm "Static deck" note.
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Icon, Notice, toast } from "@pptaken/ui";
  import { tick } from "svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import PageSection from "../components/PageSection.svelte";
  import ScriptViewer from "../components/ScriptViewer.svelte";
  import { ApiError, api, type DeckDetail, type ScriptsReview, type VendoredResource } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatBytes, shortDigest } from "../lib/format";
  import { deckIdOf } from "../lib/router";
  import { handleAuthError, prefs, route, t } from "../lib/state.svelte";

  const DOCS_CONTENT_ORIGIN =
    "https://github.com/arroztek/pptaken/blob/main/docs/guides/interactive-decks.md#a-separate-site-for-content";

  const id = $derived(deckIdOf(route.path) ?? "");
  let deck = $state<DeckDetail | null>(null);
  let review = $state<ScriptsReview | null>(null);
  let loading = $state(true);
  let missing = $state(false);
  let loadError = $state("");
  let actionError = $state("");
  let changed = $state(false);

  let approveOpen = $state(false);
  let confirmed = $state(false);
  let approving = $state(false);
  /** The fingerprint shown when the dialog opened: exactly what the owner approves. */
  let reviewedDigest = $state<string | null>(null);
  let revokeOpen = $state(false);
  let revoking = $state(false);

  async function load(deckId: string, quiet = false) {
    if (!quiet) loading = true;
    loadError = "";
    missing = false;
    try {
      const [d, r] = await Promise.all([api.getDeck(deckId), api.scriptsReview(deckId)]);
      if (deckId !== id) return;
      deck = d;
      review = r;
    } catch (e) {
      if (handleAuthError(e)) return;
      if (e instanceof ApiError && e.code === "NOT_FOUND") missing = true;
      else loadError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const deckId = id;
    deck = null;
    review = null;
    changed = false;
    actionError = "";
    void load(deckId).then(async () => {
      // Arriving from an agent's approve_url (#scripts): bring the section into view.
      if (location.hash === "#scripts") {
        await tick();
        document.getElementById("scripts")?.scrollIntoView({ block: "start" });
      }
    });
  });

  type ApprovalState = "none" | "pending" | "approved" | "stale";
  const approval = $derived<ApprovalState>(
    !review || review.digest === null
      ? "none"
      : review.state === "approved"
        ? "approved"
        : review.approvedDigest !== null
          ? "stale"
          : "pending",
  );
  const interactive = $derived(review !== null && review.digest !== null);
  const vendored = $derived<VendoredResource[]>(deck?.vendored ?? []);
  const failedCount = $derived(vendored.filter((v) => v.status === "failed").length);

  function kindLabel(kind: VendoredResource["kind"]): string {
    return t(`vendor.kind_${kind}`);
  }

  /** The redirect chain recorded for a vendored library (ADR-022), by its hash. */
  function redirectsOf(sha256: string): string[] {
    return vendored.find((v) => v.kind === "script" && v.sha256 === sha256)?.redirects ?? [];
  }
  const freeze = $derived(review !== null && review.enabled && review.capability.freezeWarning);

  function meta(d: DeckDetail): string {
    const slides = d.slideCount === 1 ? t("decks.slidesOne") : t("decks.slides", { n: d.slideCount });
    const when = describeWhen(d.updatedAt, prefs.locale);
    const edited = when.kind === "relative" ? t("decks.edited", { ago: when.text }) : t("decks.editedOn", { date: when.text });
    const by = d.createdBy === "agent" ? t("decks.byAgent") : t("decks.byOwner");
    return `${slides} · ${t("deck.revision", { n: d.revision })} · ${edited} · ${by}`;
  }

  const badge = $derived.by(() => {
    if (!review || review.digest === null) return { label: t("deck.statusStatic"), tone: "static" };
    if (!review.enabled) return { label: t("deck.statusOff"), tone: "off" };
    if (review.state === "approved") return { label: t("deck.statusApproved"), tone: "approved" };
    return { label: t("deck.statusPending"), tone: "pending" };
  });

  function stateText(s: ApprovalState): string {
    return s === "approved" ? t("scripts.stateApproved") : s === "stale" ? t("scripts.stateStale") : t("scripts.statePending");
  }

  function originText(r: ScriptsReview): string {
    const o = r.capability.contentOrigin;
    return o === "separate-site" ? t("scripts.originSeparate") : o === "same-site" ? t("scripts.originSameSite") : t("scripts.originSame");
  }

  function openApprove() {
    if (!review?.digest) return;
    reviewedDigest = review.digest;
    confirmed = false;
    actionError = "";
    approveOpen = true;
  }

  async function approve() {
    if (!reviewedDigest || !confirmed) return;
    approving = true;
    actionError = "";
    try {
      await api.approveScripts(id, reviewedDigest);
      approveOpen = false;
      changed = false;
      toast.show(t("scripts.approvedToast"));
      await load(id, true);
    } catch (e) {
      if (handleAuthError(e)) return;
      approveOpen = false;
      if (e instanceof ApiError && e.status === 409) {
        // The deck changed after this page loaded: nothing was approved. Show the new code.
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
      toast.show(t("scripts.revokedToast"));
      await load(id, true);
    } catch (e) {
      if (handleAuthError(e)) return;
      revokeOpen = false;
      actionError = errorMessage(e, t);
    } finally {
      revoking = false;
    }
  }
</script>

{#if loading && !deck}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={t("deck.pageTitle")}>
    <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
  </PageLayout>
{:else if missing}
  <PageLayout back={{ href: "/decks", label: t("deck.back") }} title={t("deck.pageTitle")}>
    <EmptyState title={t("deck.notFoundTitle")} text={t("deck.notFoundText")} headingLevel={2}>
      {#snippet actions()}
        <Button variant="secondary" href="/decks">{t("deck.back")}</Button>
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

    <PageSection id="scripts" title={t("scripts.title")} description={interactive ? t("scripts.sectionText") : undefined}>
      {#if !interactive}
        <div class="static-note" data-testid="static-deck">
          <Notice title={t("scripts.staticTitle")} text={t("scripts.staticText")} />
        </div>
      {:else}
        {#if changed}
          <Notice tone="warning" title={t("scripts.changed")} ondismiss={() => (changed = false)} />
        {/if}

        <dl class="facts ppt-card" data-testid="scripts-facts">
          <div class="facts__row">
            <dt>{t("scripts.instanceLabel")}</dt>
            <dd>
              <span class="ppt-badge" class:badge-ok={r.enabled} class:badge-off={!r.enabled}>
                <span class="ppt-badge__dot" aria-hidden="true"></span>
                {r.enabled ? t("scripts.instanceOn") : t("scripts.instanceOff")}
              </span>
            </dd>
          </div>
          <div class="facts__row">
            <dt>{t("scripts.stateLabel")}</dt>
            <dd>
              <span
                class="ppt-badge"
                class:badge-ok={approval === "approved"}
                class:badge-pending={approval !== "approved"}
                data-state={approval}
              >
                <span class="ppt-badge__dot" aria-hidden="true"></span>
                {stateText(approval)}
              </span>
              {#if approval === "approved" && r.approvedAt}
                {@const when = describeWhen(r.approvedAt, prefs.locale)}
                <span class="facts__note">{t("scripts.approvedAt", { when: when.text })}</span>
              {/if}
            </dd>
          </div>
          <div class="facts__row">
            <dt>{t("scripts.capabilityLabel")}</dt>
            <dd><span class="facts__value">{originText(r)}</span></dd>
          </div>
          <div class="facts__row facts__row--digest">
            <dt>{t("scripts.digestLabel")}</dt>
            <dd>
              <div class="digest">
                <code class="digest__short" data-testid="digest-short">{shortDigest(r.digest ?? "")}</code>
                <CopyButton size="sm" variant="secondary" label={t("scripts.copyDigest")} text={r.digest ?? ""} />
              </div>
              <code class="digest__full" data-testid="digest-full">{r.digest}</code>
              <span class="facts__note">{t("scripts.digestHint")}</span>
            </dd>
          </div>
        </dl>

        {#if !r.enabled}
          <Notice tone="warning" title={t("scripts.instanceOff")} text={t("scripts.offHow")} />
        {/if}
        {#if approval === "stale"}
          <Notice tone="warning" title={t("scripts.stateStale")} text={t("scripts.staleText")} />
        {/if}
        {#if freeze}
          <div class="freeze" data-testid="freeze-warning">
            <Notice tone="warning" title={t("scripts.freezeWarning")}>
              <a class="ppt-link ppt-small" href={DOCS_CONTENT_ORIGIN} target="_blank" rel="noopener noreferrer">{t("scripts.docsLink")}</a>
            </Notice>
          </div>
        {:else if r.enabled && r.capability.separateSiteContent}
          <Notice tone="success" title={t("scripts.capabilitySeparate")} />
        {/if}

        <section class="meaning" aria-labelledby="meaning-title">
          <h3 class="ppt-h3 meaning__title" id="meaning-title">
            <Icon name="shield-check" size={20} />
            <span>{t("scripts.meaningTitle")}</span>
          </h3>
          <p class="meaning__text">{t("scripts.meaningText")}</p>
          <p class="meaning__scope">{t("scripts.meaningScope")}</p>
          <div class="meaning__actions">
            {#if r.enabled}
              {#if approval !== "approved"}
                <Button variant="primary" icon="check" onclick={openApprove}>{t("scripts.approve")}</Button>
              {/if}
              {#if r.approvedDigest !== null}
                <Button variant="secondary" onclick={() => (revokeOpen = true)}>{t("scripts.revoke")}</Button>
              {/if}
            {:else}
              <p class="ppt-muted ppt-small">{t("scripts.approveOff")}</p>
              {#if r.approvedDigest !== null}
                <Button variant="secondary" onclick={() => (revokeOpen = true)}>{t("scripts.revoke")}</Button>
              {/if}
            {/if}
          </div>
          <p class="meaning__presenter ppt-small">
            <span>{r.presenterPassword.set ? t("scripts.presenterSet") : t("scripts.presenterUnset")}</span>
            <a class="ppt-link" href="/security#presenter">{t("scripts.presenterManage")}</a>
          </p>
        </section>

        <div class="block" aria-labelledby="scripts-list-title">
          <h3 class="ppt-h3" id="scripts-list-title">{t("scripts.scriptsTitle", { n: r.sources.length + (r.deckSource ? 1 : 0) })}</h3>
          {#if r.deckSource}
            <p class="ppt-muted ppt-small">{t("scripts.deckScriptText")}</p>
            <ScriptViewer
              script={{ slideId: "deck", index: 0, ...r.deckSource }}
              title={t("scripts.deckScriptTitle")}
              open={true} />
          {/if}
          {#each r.sources as script, i (script.slideId)}
            <ScriptViewer {script} open={i < 3} />
          {/each}
        </div>

        {#if r.libs.length > 0}
          <div class="block" aria-labelledby="libs-title">
            <div class="block__head">
              <h3 class="ppt-h3" id="libs-title">{t("scripts.librariesTitle", { n: r.libs.length })}</h3>
              <p class="ppt-muted ppt-small">{t("scripts.librariesText")}</p>
            </div>
            <ul class="libs">
              {#each r.libs as lib, i (i)}
                <li class="lib ppt-card">
                  <p class="lib__name">
                    <strong>{lib.name}</strong>
                    {#if lib.version}<span class="ppt-muted">{t("scripts.libVersion", { v: lib.version })}</span>{/if}
                  </p>
                  <p class="lib__line"><span class="lib__label">SHA-256</span> <code class="lib__mono">{lib.sha256}</code></p>
                  <p class="lib__line">
                    <span class="lib__label">{t("scripts.libSource")}</span>
                    {#if lib.source}<code class="lib__mono">{lib.source}</code>{:else}<span class="ppt-muted">{t("scripts.libNoSource")}</span>{/if}
                  </p>
                  {#if lib.finalUrl && lib.finalUrl !== lib.source}
                    <p class="lib__line"><span class="lib__label">{t("scripts.libFinalUrl")}</span> <code class="lib__mono">{lib.finalUrl}</code></p>
                  {/if}
                  {#if redirectsOf(lib.sha256).length > 0}
                    <p class="lib__line"><span class="lib__label">{t("scripts.libRedirects")}</span> <code class="lib__mono">{redirectsOf(lib.sha256).join(" → ")}</code></p>
                  {/if}
                  {#if lib.bytes !== null}
                    <p class="lib__line"><span class="lib__label">{t("scripts.libSize")}</span> <span>{formatBytes(lib.bytes, prefs.locale)}</span></p>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#if r.warnings.length > 0}
          <div class="block" aria-labelledby="warnings-title">
            <div class="block__head">
              <h3 class="ppt-h3" id="warnings-title">{t("scripts.warningsTitle", { n: r.warnings.length })}</h3>
              <p class="ppt-muted ppt-small">{t("scripts.warningsText")}</p>
            </div>
            <ul class="warnings">
              {#each r.warnings as w, i (i)}
                <li><code class="lib__mono">{w.path ?? ""}</code> {w.message}</li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </PageSection>

    {#if vendored.length > 0 || d.vendorFetch === "off"}
      <PageSection id="vendored" title={t("vendor.title")} description={t("vendor.sectionText")}>
        {#if d.vendorFetch === "off"}
          <Notice tone="warning" title={t("vendor.offTitle")} text={t("vendor.offText")} />
        {/if}
        {#if failedCount > 0}
          <div data-testid="vendor-failed">
            <Notice tone="danger" title={t("vendor.failedTitle", { n: failedCount })} text={t("vendor.failedText")} />
          </div>
        {/if}
        {#if vendored.length > 0}
          <ul class="vendored" aria-label={t("vendor.listLabel")} data-testid="vendored-list">
            {#each vendored as res, i (i)}
              <li class="lib ppt-card" data-status={res.status} data-kind={res.kind}>
                <p class="lib__name">
                  <span class="ppt-badge" class:badge-ok={res.status === "vendored"} class:badge-pending={res.status === "failed"}>
                    <span class="ppt-badge__dot" aria-hidden="true"></span>
                    {kindLabel(res.kind)}
                  </span>
                  {#if res.status === "failed"}
                    <span class="ppt-muted ppt-small">{t("vendor.failed")}</span>
                  {:else}
                    {@const when = describeWhen(new Date(res.fetchedAt).toISOString(), prefs.locale)}
                    <span class="ppt-muted ppt-small">{t("vendor.fetched", { when: when.text })}</span>
                  {/if}
                </p>
                <p class="lib__line"><span class="lib__label">{t("vendor.original")}</span> <code class="lib__mono">{res.url}</code></p>
                {#if res.finalUrl && res.finalUrl !== res.url}
                  <p class="lib__line"><span class="lib__label">{t("vendor.final")}</span> <code class="lib__mono">{res.finalUrl}</code></p>
                {/if}
                {#if res.redirects && res.redirects.length > 0}
                  <p class="lib__line"><span class="lib__label">{t("vendor.redirects")}</span> <code class="lib__mono">{res.redirects.join(" → ")}</code></p>
                {/if}
                {#if res.via}
                  <p class="lib__line"><span class="lib__label">{t("vendor.via")}</span> <code class="lib__mono">{res.via}</code></p>
                {/if}
                {#if res.bytes !== null}
                  <p class="lib__line"><span class="lib__label">{t("vendor.size")}</span> <span>{formatBytes(res.bytes, prefs.locale)}</span></p>
                {/if}
                {#if res.sha256}
                  <p class="lib__line"><span class="lib__label">SHA-256</span> <code class="lib__mono">{res.sha256}</code></p>
                {/if}
                {#if res.error}
                  <p class="lib__line"><span class="lib__label">{t("vendor.error")}</span> <code class="lib__mono">{res.error}</code></p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </PageSection>
    {/if}
  </PageLayout>

  <Dialog bind:open={approveOpen} title={t("scripts.confirmTitle")} dismissible={false}>
    <div class="confirm">
      <p>{t("scripts.meaningText")}</p>
      <p class="ppt-muted ppt-small">{t("scripts.confirmText")}</p>
      <code class="confirm__digest" data-testid="confirm-digest">{shortDigest(reviewedDigest ?? "")}</code>
      <label class="check">
        <input type="checkbox" bind:checked={confirmed} name="confirm-approve" />
        <span>{t("scripts.confirmCheck")}</span>
      </label>
    </div>
    {#snippet actions()}
      <Button variant="secondary" onclick={() => (approveOpen = false)}>{t("scripts.cancel")}</Button>
      <Button variant="primary" disabled={!confirmed} loading={approving} onclick={approve}>{t("scripts.confirmApprove")}</Button>
    {/snippet}
  </Dialog>

  <Dialog bind:open={revokeOpen} title={t("scripts.revokeTitle")} dismissible={false}>
    <p>{t("scripts.revokeText")}</p>
    {#snippet actions()}
      <Button variant="secondary" onclick={() => (revokeOpen = false)}>{t("scripts.cancel")}</Button>
      <Button variant="danger" loading={revoking} onclick={revoke}>{t("scripts.revoke")}</Button>
    {/snippet}
  </Dialog>
{/if}

{#snippet headActions()}
  <span
    class="ppt-badge deck-status"
    class:badge-ok={badge.tone === "approved"}
    class:badge-pending={badge.tone === "pending" || badge.tone === "off"}
    data-testid="deck-status">
    <span class="ppt-badge__dot" aria-hidden="true"></span>
    {badge.label}
  </span>
  {#if deck}
    <!-- Secondary here: the approval is this page's main action when it is waiting. -->
    <Button variant={badge.tone === "pending" ? "secondary" : "primary"} icon="play" href="/p/{encodeURIComponent(deck.id)}" target="_blank"
      >{t("deck.present")}<span class="ppt-sr-only"> {t("deck.newTab")}</span></Button
    >
  {/if}
{/snippet}
