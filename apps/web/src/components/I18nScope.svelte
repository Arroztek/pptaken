<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Sets @pptaken/ui's translator for everything below. The parent re-creates this scope
     (with {#key}) when the language changes, because the ui translator is read once per component. -->
<script lang="ts">
  import { type Locale, setI18n } from "@pptaken/ui";
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";

  let { locale, children }: { locale: Locale; children: Snippet } = $props();
  untrack(() => setI18n(locale));
</script>

{@render children()}
