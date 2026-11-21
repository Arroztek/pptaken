<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  The Share panel of a presentation (ADR-026), shown in a dialog from the deck page. Two plain choices: "Anyone with
  the link can watch" (the simple version, no notes) and "For the person who will present" (includes the notes; it
  says so plainly). Then: when the link stops working, an optional private name, "Freeze this version", Create. A
  created link shows with Copy and an optional QR code (drawn from the server's own QR encoder, /_rt/qr.js). Below,
  the shared links with their name, kind, end date and last opening, each with Copy and "Stop sharing" (asked inline,
  once). No hashes or tokens in the normal view; Developer details adds the link id. Labels are text only.
-->
<script lang="ts">
  import { Button, CopyField, FramedQR, Icon, Notice, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import { api, type ShareExpiry, type ShareKind, type ShareLink, type SharingState } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { describeWhen, formatDate } from "../lib/format";
  import { handleAuthError, prefs, t } from "../lib/state.svelte";
  import CopyButton from "./CopyButton.svelte";

  interface Props {
    deckId: string;
    /** Called with the number of active links after every change (the deck page and list show "Shared"). */
    onchange?: (active: number) => void;
  }

  let { deckId, onchange }: Props = $props();
  const uid = $props.id();
  const QR_MODULE = "/_rt/qr.js";

  let loading = $state(true);
  let loadError = $state("");
  let links = $state<ShareLink[]>([]);
  let sharing = $state<SharingState | null>(null);

  type ExpiryChoice = "never" | "1d" | "7d" | "30d" | "custom";
  let kind = $state<ShareKind>("view");
  let expiry = $state<ExpiryChoice>("never");
  let customDate = $state("");
  let label = $state("");
  let freeze = $state(false);
  let creating = $state(false);
  let createError = $state("");
  let dateError = $state("");
  let created = $state<ShareLink | null>(null);
  let qrPath = $state("");
  let qrSize = $state(0);
  let qrOpen = $state(false);
  let confirmStop = $state<string | null>(null);
  let confirmAll = $state(false);
  let busyId = $state<string | null>(null);

  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const minDate = day(1);
  const maxDate = day(365);

  async function load() {
    loading = true;
    loadError = "";
    try {
      const r = await api.listLinks(deckId);
      links = r.links;
      sharing = r.sharing;
      onchange?.(r.links.filter((l) => l.state === "active").length);
    } catch (e) {
      if (!handleAuthError(e)) loadError = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  function expiresValue(): ShareExpiry | undefined | "invalid" {
    if (expiry === "never") return null;
    if (expiry !== "custom") return expiry;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate) || customDate < minDate || customDate > maxDate) return "invalid";
    // The link works until the end of the chosen day, in this browser's time zone.
    return new Date(`${customDate}T23:59:59`).toISOString();
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    createError = "";
    dateError = "";
    const expires = expiresValue();
    if (expires === "invalid") {
      dateError = t("share.dateInvalid");
      return;
    }
    creating = true;
    try {
      created = await api.createLink(deckId, {
        kind,
        label: label.trim(),
        ...(expires === undefined ? {} : { expires }),
        ...(freeze ? { pinRevision: true } : {}),
      });
      qrOpen = false;
      qrPath = "";
      await load();
    } catch (e) {
      if (!handleAuthError(e)) createError = errorMessage(e, t);
    } finally {
      creating = false;
    }
  }

  function another() {
    created = null;
    qrOpen = false;
    label = "";
    freeze = false;
    expiry = "never";
    customDate = "";
  }

  async function toggleQr(url: string) {
    qrOpen = !qrOpen;
    if (!qrOpen || qrPath !== "") return;
    try {
      const mod = (await import(/* @vite-ignore */ QR_MODULE)) as {
        encodeQR(text: string, output: "raw", options: { ecc: string; border: number }): boolean[][];
      };
      const matrix = mod.encodeQR(url, "raw", { ecc: "medium", border: 2 });
      let d = "";
      matrix.forEach((row, y) => {
        row.forEach((dark, x) => {
          if (dark) d += `M${x} ${y}h1v1h-1z`;
        });
      });
      qrSize = matrix.length;
      qrPath = d;
    } catch {
      qrOpen = false;
    }
  }

  async function stop(link: ShareLink) {
    busyId = link.id;
    try {
      await api.revokeLink(deckId, link.id);
      confirmStop = null;
      if (created?.id === link.id) created = null;
      toast.show(t("share.stoppedToast"));
      await load();
    } catch (e) {
      if (!handleAuthError(e)) createError = errorMessage(e, t);
    } finally {
      busyId = null;
    }
  }

  async function stopAll() {
    busyId = "all";
    try {
      await api.revokeAllLinks(deckId);
      confirmAll = false;
      created = null;
      toast.show(t("share.stoppedAllToast"));
      await load();
    } catch (e) {
      if (!handleAuthError(e)) createError = errorMessage(e, t);
    } finally {
      busyId = null;
    }
  }

  async function extend(link: ShareLink) {
    busyId = link.id;
    try {
      await api.updateLink(deckId, link.id, { expires: "7d" });
      toast.show(t("share.extendedToast"));
      await load();
    } catch (e) {
      if (!handleAuthError(e)) createError = errorMessage(e, t);
    } finally {
      busyId = null;
    }
  }

  function endText(link: ShareLink): string {
    if (link.state === "expired" && link.expiresAt) {
      return t("share.expired", { date: formatDate(link.expiresAt, prefs.locale) });
    }
    return link.expiresAt ? t("share.until", { date: formatDate(link.expiresAt, prefs.locale) }) : t("share.noEnd");
  }

  function openedText(link: ShareLink): string {
    return link.lastOpenedAt
      ? t("share.opened", { ago: describeWhen(link.lastOpenedAt, prefs.locale).text })
      : t("share.openedNever");
  }

  /** One quiet line: what it opens · until when · last opened (· frozen). */
  function metaText(link: ShareLink): string {
    return [
      link.kind === "presenter" ? t("share.kindPresenter") : t("share.kindView"),
      endText(link),
      openedText(link),
      ...(link.pinnedRevision !== null ? [t("share.frozen")] : []),
    ].join(" · ");
  }
</script>

<div class="share-panel" data-testid="share-panel">
  {#if loading && sharing === null}
    <p class="ppt-muted" role="status">{t("common.loading")}…</p>
  {:else if loadError}
    <Notice tone="danger" title={t("share.loadError")} text={loadError}>
      <div><Button size="sm" onclick={load}>{t("app.retry")}</Button></div>
    </Notice>
  {:else if sharing}
    {#if !sharing.enabled}
      <Notice title={t("share.offTitle")} text={sharing.instance === "off" ? t("share.offInstance") : t("share.offOwner")}>
        {#if sharing.instance === "on"}
          <div><Button size="sm" href="/settings#sharing">{t("share.offOwnerButton")}</Button></div>
        {/if}
      </Notice>
    {:else if created}
      <div class="share-ready" data-testid="share-ready" data-kind={created.kind}>
        <p class="share-ready__title">
          <Icon name="check-circle" size={20} />
          <span role="status">{created.kind === "presenter" ? t("share.readyPresenter") : t("share.readyView")}</span>
        </p>
        {#if created.url}
          <CopyField value={created.url} label={t("share.linkLabel")} copyLabel={t("share.copy")} primary />
          <div class="share-ready__actions">
            <button type="button" class="link-btn" aria-expanded={qrOpen} aria-controls="{uid}-qr"
              onclick={() => created?.url && toggleQr(created.url)}>{qrOpen ? t("share.hideQr") : t("share.showQr")}</button>
            <button type="button" class="link-btn" onclick={another}>{t("share.another")}</button>
          </div>
          <div id="{uid}-qr" class="share-qr" hidden={!qrOpen || qrPath === ""}>
            {#if qrOpen && qrPath}
              <FramedQR caption={t("share.qrCaption")} size={176}>
                <svg viewBox="0 0 {qrSize} {qrSize}" role="img" aria-label={t("share.qrCaption")} shape-rendering="crispEdges"
                  ><path d={qrPath} fill="#000" /></svg
                >
              </FramedQR>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <form class="share-form" novalidate onsubmit={create} aria-labelledby="{uid}-choose">
        <p class="share-lead">{t("share.lead")}</p>
        <fieldset class="share-choice">
          <legend class="ppt-field__label" id="{uid}-choose">{t("share.chooseLabel")}</legend>
          <label class="share-option" data-kind="view">
            <input type="radio" name="share-kind" value="view" bind:group={kind} />
            <span class="share-option__body">
              <span class="share-option__title"><span class="share-option__name"><Icon name="eye" size={18} /><span>{t("share.viewTitle")}</span></span></span>
              <span class="share-option__text">{t("share.viewText")}</span>
            </span>
          </label>
          <label class="share-option" data-kind="presenter">
            <input type="radio" name="share-kind" value="presenter" bind:group={kind} />
            <span class="share-option__body">
              <span class="share-option__title"
                ><span class="share-option__name"><Icon name="presentation" size={18} /><span>{t("share.presenterTitle")}</span></span><span class="share-option__badge"
                  >{t("share.presenterBadge")}</span
                ></span
              >
              <span class="share-option__text">{t("share.presenterText")}</span>
            </span>
          </label>
        </fieldset>
        {#if kind === "presenter" && sharing.scripts === "owner"}
          <p class="share-note" data-testid="share-password-note">
            <Icon name="key" size={16} />
            <span>
              {sharing.presenterPassword ? t("share.passwordSet") : t("share.passwordUnset")}
              {#if !sharing.presenterPassword}
                <a class="ppt-link" href="/security#presenter">{t("share.passwordLink")}</a>
              {/if}
            </span>
          </p>
        {/if}
        <div class="share-fields">
          <div class="ppt-field">
            <label class="ppt-field__label" for="{uid}-expiry">{t("share.expiresLabel")}</label>
            <select class="ppt-input" id="{uid}-expiry" name="share-expiry" bind:value={expiry}>
              <option value="never">{t("share.expiresNever")}</option>
              <option value="1d">{t("share.expires1d")}</option>
              <option value="7d">{t("share.expires7d")}</option>
              <option value="30d">{t("share.expires30d")}</option>
              <option value="custom">{t("share.expiresCustom")}</option>
            </select>
          </div>
          {#if expiry === "custom"}
            <div class="ppt-field">
              <label class="ppt-field__label" for="{uid}-date">{t("share.expiresDate")}</label>
              <input class="ppt-input" id="{uid}-date" name="share-date" type="date" min={minDate} max={maxDate}
                bind:value={customDate} aria-invalid={dateError ? "true" : undefined}
                aria-describedby={dateError ? `${uid}-date-error` : undefined} />
              {#if dateError}<p class="ppt-field__error" id="{uid}-date-error">{dateError}</p>{/if}
            </div>
          {/if}
          <div class="ppt-field share-fields__wide">
            <label class="ppt-field__label" for="{uid}-label">{t("share.labelLabel")}</label>
            <input class="ppt-input" id="{uid}-label" name="share-label" maxlength="80" autocomplete="off"
              placeholder={t("share.labelPlaceholder")} bind:value={label} aria-describedby="{uid}-label-hint" />
            <p class="ppt-field__hint" id="{uid}-label-hint">{t("share.labelHint")}</p>
          </div>
        </div>
        <div class="check-field">
          <label class="check">
            <input type="checkbox" name="share-freeze" bind:checked={freeze} aria-describedby="{uid}-freeze-hint" />
            <span>{t("share.freezeLabel")}</span>
          </label>
          <p class="check-field__hint" id="{uid}-freeze-hint">{t("share.freezeHint")}</p>
        </div>
        {#if createError}
          <Notice tone="danger" title={t("share.createError")} text={createError} ondismiss={() => (createError = "")} />
        {/if}
        <div>
          <Button variant="primary" type="submit" icon="link" loading={creating}>{t("share.create")}</Button>
        </div>
      </form>
    {/if}

    <section class="share-list" aria-labelledby="{uid}-list" data-testid="share-list">
      <h3 class="ppt-h3" id="{uid}-list">{t("share.listTitle")}</h3>
      {#if links.length === 0}
        <p class="ppt-muted ppt-small">{t("share.listNone")}</p>
      {:else}
        <ul class="share-links">
          {#each links as link (link.id)}
            <li class="share-link" data-kind={link.kind} data-state={link.state} data-id={link.id}>
              <div class="share-link__text">
                <p class="share-link__name">{link.label || t("share.unnamed")}</p>
                <p class="share-link__meta">{metaText(link)}</p>
                {#if link.url === null}<p class="share-link__lost">{t("share.lostLink")}</p>{/if}
                {#if prefs.dev}
                  <p class="share-link__dev">
                    <code>{t("dev.linkId", { id: link.id })}</code>
                    {#if link.pinnedRevision !== null}<span>{t("dev.linkRevision", { n: link.pinnedRevision })}</span>{/if}
                    <span>{t("dev.linkOpens", { n: link.openCount })}</span>
                  </p>
                {/if}
              </div>
              <div class="share-link__actions">
                {#if link.url && link.state === "active"}
                  <CopyButton size="sm" variant="ghost" label={t("share.copy")} text={link.url} />
                {/if}
                {#if link.state === "expired"}
                  <Button size="sm" variant="ghost" loading={busyId === link.id} onclick={() => extend(link)}>{t("share.extend")}</Button>
                {/if}
                <Button size="sm" variant="ghost" aria-label={t("share.stopFor", { name: link.label || t("share.unnamed") })}
                  onclick={() => (confirmStop = confirmStop === link.id ? null : link.id)}>{t("share.stop")}</Button>
              </div>
              {#if confirmStop === link.id}
                <div class="share-confirm" role="group" aria-label={t("share.stopTitle")}>
                  <p><strong>{t("share.stopTitle")}</strong> {t("share.stopText")}</p>
                  <div class="share-confirm__actions">
                    <Button size="sm" variant="secondary" onclick={() => (confirmStop = null)}>{t("common.cancel")}</Button>
                    <Button size="sm" variant="danger" loading={busyId === link.id} onclick={() => stop(link)}>{t("share.stopConfirm")}</Button>
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if links.length > 1}
          {#if confirmAll}
            <div class="share-confirm" role="group" aria-label={t("share.stopAllTitle")}>
              <p><strong>{t("share.stopAllTitle")}</strong> {t("share.stopAllText", { n: links.length })}</p>
              <div class="share-confirm__actions">
                <Button size="sm" variant="secondary" onclick={() => (confirmAll = false)}>{t("common.cancel")}</Button>
                <Button size="sm" variant="danger" loading={busyId === "all"} onclick={stopAll}>{t("share.stopAllConfirm")}</Button>
              </div>
            </div>
          {:else}
            <div><button type="button" class="link-btn" onclick={() => (confirmAll = true)}>{t("share.stopAll")}</button></div>
          {/if}
        {/if}
      {/if}
    </section>
  {/if}
</div>
