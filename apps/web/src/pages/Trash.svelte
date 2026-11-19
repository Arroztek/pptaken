<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  /trash: presentations moved to the trash, newest first, with the days left before they go for good. Restore is
  one click; Delete forever asks once, naming the presentation and saying it cannot be undone.
-->
<script lang="ts">
  import { Button, Dialog, EmptyState, Notice, toast } from "@pptaken/ui";
  import { onMount } from "svelte";
  import PageLayout from "../components/PageLayout.svelte";
  import { api, type TrashedDeck } from "../lib/api";
  import { errorMessage } from "../lib/errors";
  import { handleAuthError, t } from "../lib/state.svelte";

  const DAY = 86_400_000;
  let items = $state<TrashedDeck[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state("");
  let busy = $state<string | null>(null);
  let pending = $state<TrashedDeck | null>(null);
  let confirmOpen = $state(false);
  const now = Date.now();

  async function load(cursor: string | null = null) {
    loading = true;
    error = "";
    try {
      const page = await api.listTrash({ cursor });
      items = cursor ? [...items, ...page.decks] : page.decks;
      nextCursor = page.nextCursor;
    } catch (e) {
      if (!handleAuthError(e)) error = errorMessage(e, t);
    } finally {
      loading = false;
    }
  }

  onMount(() => void load());

  function left(item: TrashedDeck): string {
    const days = Math.floor((Date.parse(item.restorableUntil) - now) / DAY);
    if (days <= 0) return t("trash.lastDay");
    return days === 1 ? t("trash.dayLeft") : t("trash.daysLeft", { n: days });
  }

  async function restore(item: TrashedDeck) {
    busy = item.id;
    error = "";
    try {
      await api.restoreDeck(item.id);
      items = items.filter((i) => i.id !== item.id);
      toast.show(t("decks.restoredToast", { title: item.title }));
    } catch (e) {
      if (!handleAuthError(e)) error = errorMessage(e, t);
    } finally {
      busy = null;
    }
  }

  function askForever(item: TrashedDeck) {
    pending = item;
    confirmOpen = true;
  }

  async function forever() {
    const item = pending;
    if (!item) return;
    busy = item.id;
    error = "";
    try {
      await api.purgeDeck(item.id);
      items = items.filter((i) => i.id !== item.id);
      confirmOpen = false;
      toast.show(t("trash.deletedToast"), { icon: "trash" });
    } catch (e) {
      confirmOpen = false;
      if (!handleAuthError(e)) error = errorMessage(e, t);
    } finally {
      busy = null;
    }
  }
</script>

<PageLayout back={{ href: "/decks", label: t("trash.back") }} title={t("trash.title")} subtitle={t("trash.subtitle")}>
  {#if error}
    <Notice tone="danger" title={error} ondismiss={() => (error = "")} />
  {/if}
  {#if loading && items.length === 0}
    <p class="ppt-muted loading-line" role="status">{t("common.loading")}…</p>
  {:else if items.length === 0}
    <EmptyState title={t("trash.emptyTitle")} text={t("trash.emptyText")} headingLevel={2}>
      {#snippet actions()}
        <Button variant="secondary" href="/decks">{t("trash.back")}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="trash-list" data-testid="trash-list">
      {#each items as item (item.id)}
        <li class="trash-item ppt-card" data-id={item.id}>
          <div class="trash-item__text">
            <p class="trash-item__title">{item.title}</p>
            <p class="trash-item__meta">
              {item.slideCount === 1 ? t("decks.slidesOne") : t("decks.slides", { n: item.slideCount })} · {left(item)}
            </p>
          </div>
          <div class="trash-item__actions">
            <Button size="sm" variant="secondary" icon="arrow-u-up-left" loading={busy === item.id && !confirmOpen}
              onclick={() => restore(item)}>{t("trash.restore")}</Button>
            <Button size="sm" variant="ghost" onclick={() => askForever(item)}>{t("trash.deleteForever")}</Button>
          </div>
        </li>
      {/each}
    </ul>
    {#if nextCursor}
      <div class="load-more">
        <Button variant="secondary" loading={loading} onclick={() => load(nextCursor)}>{t("decks.loadMore")}</Button>
      </div>
    {/if}
  {/if}
</PageLayout>

<Dialog bind:open={confirmOpen} title={pending ? t("trash.foreverTitle", { title: pending.title }) : ""} dismissible={false}>
  <p>{t("trash.foreverText")}</p>
  {#snippet actions()}
    <Button variant="secondary" onclick={() => (confirmOpen = false)}>{t("common.cancel")}</Button>
    <Button variant="danger" loading={busy !== null} onclick={forever}>{t("trash.foreverConfirm")}</Button>
  {/snippet}
</Dialog>
