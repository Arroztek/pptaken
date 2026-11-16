<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
  A titled block of a page: heading, optional description, then the content, always with the same gaps
  (--ppt-rhythm-title-text, --ppt-rhythm-section-head) and the same distance to the next section
  (--ppt-rhythm-section). `card` puts the whole section on a surface (forms); tables and lists stay flat.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Prefix for the heading id (aria-labelledby). Unique on the page. */
    id: string;
    title: string;
    description?: string;
    card?: boolean;
    actions?: Snippet;
    children: Snippet;
  }

  let { id, title, description, card = false, actions, children }: Props = $props();
</script>

<section class="page-section" class:page-section--card={card} class:ppt-card={card} aria-labelledby="{id}-title">
  <div class="section-head">
    <div class="section-head__text">
      <h2 class="ppt-h2" id="{id}-title">{title}</h2>
      {#if description}<p class="section-head__description">{description}</p>{/if}
    </div>
    {#if actions}<div class="section-head__actions">{@render actions()}</div>{/if}
  </div>
  <div class="section-body">
    {@render children()}
  </div>
</section>
