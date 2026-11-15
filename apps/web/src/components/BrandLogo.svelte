<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Same output as @pptaken/ui's Logo, minus its inline style attribute, which the panel's CSP
     (style-src 'self') blocks. Styling comes from .ppt-logo in app.css. Proposed upstream fix:
     move Logo's inline style into components.css. -->
<script lang="ts">
  import { logo } from "@pptaken/ui";

  let { variant = "lockup", height = 28 }: { variant?: "lockup" | "isotype"; height?: number } = $props();
  const art = $derived(logo[variant]);
</script>

<svg class="ppt-logo" viewBox={art.viewBox} {height} focusable="false" aria-hidden="true">
  <!-- Markup comes from the packaged brand files (src/logo.ts), never from user input. -->
  {@html art.body}
</svg>
