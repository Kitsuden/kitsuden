<!--
  tallao — DashboardItem
  A cell of a DashboardGrid for content that has no `span` of its own (a table, a BigNumber,
  a paragraph): `span` is the number of columns it takes, `"full"` the whole row. A plain
  `<div>`: layout only. KpiCard and ChartCard take `span` directly and need no wrapper.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "../utils";

  interface Props {
    /** Columns it takes (`"full"`: the whole row). */
    span?: 1 | 2 | 3 | 4 | "full";
    class?: string;
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const { span = 1, class: className = "", children, ...rest }: Props = $props();
</script>

<div {...rest} class={cn("ta-dash-item", className)} data-ta-span={span}>
  {@render children?.()}
</div>

<style>
  .ta-dash-item { min-width: 0; }
</style>
