<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import Icon from "./Icon.svelte";

  interface Props extends Omit<HTMLInputAttributes, "value"> {
    label: string;
    value?: string;
    hint?: string;
    /** Error message. Shown with an icon and linked via aria-describedby; never colour alone. */
    error?: string;
    /** Monospace input for tokens, URLs and codes. */
    mono?: boolean;
  }

  let { label, value = $bindable(""), hint, error, mono = false, id, class: className = "", ...rest }: Props = $props();

  const uid = $props.id();
  const inputId = $derived(id ?? `${uid}-input`);
  const describedBy = $derived(
    [hint && `${uid}-hint`, error && `${uid}-error`].filter(Boolean).join(" ") || undefined,
  );
</script>

<div class={["ppt-field", className].filter(Boolean).join(" ")}>
  <label class="ppt-field__label" for={inputId}>{label}</label>
  <input
    {...rest}
    id={inputId}
    class={["ppt-input", mono && "ppt-input--mono"].filter(Boolean).join(" ")}
    bind:value
    aria-invalid={error ? "true" : undefined}
    aria-describedby={describedBy}
  />
  {#if hint}
    <span class="ppt-field__hint" id="{uid}-hint">{hint}</span>
  {/if}
  {#if error}
    <span class="ppt-field__error" id="{uid}-error"><Icon name="warning-circle" size={16} />{error}</span>
  {/if}
</div>
