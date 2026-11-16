<script lang="ts">
  import type { Snippet } from "svelte";
  import { getI18n } from "../i18n";
  import IconButton from "./IconButton.svelte";
  import Button from "./Button.svelte";
  import StatusBadge, { type Status } from "./StatusBadge.svelte";

  interface Props {
    title: string;
    /** Where the card (its title link) goes, e.g. the deck's manage page. */
    href: string;
    /** Secondary line, e.g. "14 slides · edited 2 h ago". */
    meta?: string;
    /** Thumbnail image URL (16:9). Use the `thumbnail` snippet for custom content. */
    thumbnailSrc?: string;
    thumbnail?: Snippet;
    status?: Status;
    statusLabel?: string;
    /** Present action. The live deck says "Back on stage". */
    presentHref?: string;
    /** Open the title link and the present button in a new tab (the player has no way back to the panel). */
    newTab?: boolean;
    onmore?: (event: MouseEvent) => void;
    actions?: Snippet;
  }

  let {
    title,
    href,
    meta,
    thumbnailSrc,
    thumbnail,
    status,
    statusLabel,
    presentHref,
    newTab = false,
    onmore,
    actions,
  }: Props = $props();
  const t = getI18n();
</script>

<article class="ppt-deck">
  <div class="ppt-deck__thumb">
    {#if thumbnail}
      {@render thumbnail()}
    {:else if thumbnailSrc}
      <img src={thumbnailSrc} alt="" loading="lazy" decoding="async" />
    {/if}
    {#if status}
      <StatusBadge {status} label={statusLabel} class="ppt-deck__badge" />
    {/if}
  </div>
  <div class="ppt-deck__body">
    <h3 class="ppt-deck__title"><a {href} target={newTab ? "_blank" : undefined} rel={newTab ? "noopener noreferrer" : undefined}>{title}</a></h3>
    {#if meta}<p class="ppt-deck__meta">{meta}</p>{/if}
    <div class="ppt-deck__actions">
      {#if actions}
        {@render actions()}
      {:else}
        {#if presentHref}
          <Button size="sm" icon="play" href={presentHref} target={newTab ? "_blank" : undefined}>
            {status === "live" ? t("decks.backOnStage") : t("decks.present")}
          </Button>
        {/if}
        {#if onmore}
          <IconButton icon="dots-three" size="sm" label={t("decks.moreFor", { title })} onclick={onmore} />
        {/if}
      {/if}
    </div>
  </div>
</article>
