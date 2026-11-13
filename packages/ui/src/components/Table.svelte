<script lang="ts" generics="Row extends Record<string, unknown>">
  import type { Snippet } from "svelte";

  interface Column {
    key: string;
    label: string;
    /** "num" right-aligns with tabular figures; "mono" uses JetBrains Mono. */
    kind?: "text" | "num" | "mono";
    /** Hide the header text visually (e.g. an actions column) but keep it for screen readers. */
    hiddenLabel?: boolean;
  }

  interface Props {
    columns: Column[];
    rows: Row[];
    caption?: string;
    /** Custom cell renderer. Falls back to String(row[key]). */
    cell?: Snippet<[Row, Column]>;
    rowKey?: (row: Row, index: number) => string | number;
  }

  let { columns, rows, caption, cell, rowKey = (_row, i) => i }: Props = $props();

  const cls = (c: Column) => (c.kind === "num" ? "is-num" : c.kind === "mono" ? "is-mono" : undefined);
</script>

<div class="ppt-table-wrap">
  <table class="ppt-table">
    {#if caption}<caption>{caption}</caption>{/if}
    <thead>
      <tr>
        {#each columns as c (c.key)}
          <th scope="col" class={cls(c)}>
            {#if c.hiddenLabel}<span class="ppt-sr-only">{c.label}</span>{:else}{c.label}{/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, i (rowKey(row, i))}
        <tr>
          {#each columns as c (c.key)}
            <td class={cls(c)}>
              {#if cell}{@render cell(row, c)}{:else}{String(row[c.key] ?? "")}{/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
