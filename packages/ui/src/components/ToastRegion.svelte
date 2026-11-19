<script lang="ts">
  import Toast from "./Toast.svelte";
  import { toast } from "./toast-queue.svelte";
</script>

<!-- One polite live region for every toast. Render once per page. -->
<div class="ppt-toast-region" role="status" aria-live="polite" aria-atomic="false">
  {#each toast.items as item (item.id)}
    <Toast message={item.message} icon={item.icon} action={item.action} ondismiss={() => toast.dismiss(item.id)} />
  {/each}
</div>
