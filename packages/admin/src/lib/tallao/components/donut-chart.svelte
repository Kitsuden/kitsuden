<!--
  tallao — DonutChart
  Parts of a whole: a ring (or a pie with `innerRadius={0}`) with the total in the centre
  and a legend that carries every label, value and percentage in text, so the drawing is
  decorative for a screen reader and colour is never the only cue.
  - More slices than `maxSlices` (8, the number of series colours) are grouped into "Other".
  - Values that are zero, negative or not a number are left out; with nothing left it
    shows a labelled empty state (`emptyText`).
  - Not interactive: every figure is already on screen. Renders the same on the server.
  `data` is plain JSON: `[{ "label": "Fire", "value": 42 }, { "label": "Water", "value": 31 }]`
  (an optional `"color"` per slice takes any CSS colour).
-->
<script lang="ts" module>
  export interface DonutSlice {
    label: string;
    value: number;
    /** Any CSS colour; by default the series colour of its position. */
    color?: string;
  }
</script>

<script lang="ts">
  import ChartFigure from "../internal/chart-figure.svelte";
  import { useLabels } from "../i18n";
  import { arcPath, compactNumber, finite, percentOf, seriesColor, MAX_SERIES } from "../internal/chart";
  import { cn } from "../utils";

  import ChartLegend from "./chart-legend.svelte";

  const L = useLabels();
  const {
    data,
    title,
    hideTitle = false,
    innerRadius = 0.64,
    size = 200,
    centerLabel = L.total,
    centerValue,
    legend = "right",
    maxSlices = MAX_SERIES,
    otherLabel = L.other,
    locale,
    format = (n: number) => compactNumber(n, locale),
    emptyText = L.noData,
    class: className = "",
  }: {
    data: DonutSlice[];
    /** What the chart shows: its accessible name and the figure caption. */
    title: string;
    /** Keeps the title for screen readers only (inside a ChartCard that already shows it). */
    hideTitle?: boolean;
    /** Hole as a fraction of the radius, 0 to 0.9; `0` draws a pie. */
    innerRadius?: number;
    /** Diameter in px (it shrinks to fit a narrow container). */
    size?: number;
    /** Caption under the figure in the centre ("Total" by default). */
    centerLabel?: string;
    /** Figure in the centre; by default the formatted total. */
    centerValue?: string;
    /** Where the legend goes; `hidden` keeps it for screen readers only. */
    legend?: "right" | "bottom" | "hidden";
    /** Slices drawn before the rest are grouped into "Other". */
    maxSlices?: number;
    otherLabel?: string;
    locale?: string;
    /** Format of the values in the legend and the centre. */
    format?: (n: number) => string;
    /** Text shown when there is nothing to draw. */
    emptyText?: string;
    class?: string;
  } = $props();

  const slices = $derived.by(() => {
    const valid = data.filter((d) => (finite(d.value) ?? 0) > 0);
    const limit = Math.max(2, Math.min(MAX_SERIES, maxSlices));
    if (valid.length <= limit) return valid;
    const rest = valid.slice(limit - 1).reduce((sum, d) => sum + d.value, 0);
    return [...valid.slice(0, limit - 1), { label: otherLabel, value: rest, color: "rgb(var(--ta-subtle))" }];
  });
  const total = $derived(slices.reduce((sum, d) => sum + d.value, 0));
  const hole = $derived(Math.min(0.9, Math.max(0, innerRadius)));

  const R = 96;
  const arcs = $derived.by(() => {
    const pad = slices.length > 1 ? 0.012 : 0;
    let angle = 0;
    return slices.map((slice, i) => {
      const sweep = (slice.value / total) * Math.PI * 2;
      const from = angle + pad;
      const to = Math.max(from + 0.001, angle + sweep - pad);
      angle += sweep;
      return { d: arcPath(100, 100, R, R * hole, from, to), color: slice.color ?? seriesColor(i) };
    });
  });

  const items = $derived(
    slices.map((slice, i) => ({
      label: slice.label,
      value: `${format(slice.value)} · ${percentOf(slice.value, total, locale)}`,
      color: slice.color ?? seriesColor(i),
    }))
  );
</script>

<ChartFigure {title} {hideTitle} empty={slices.length === 0} {emptyText} class={className}>
  <div class={cn("ta-donut", `ta-donut--${legend}`)}>
    <svg class="ta-donut-svg" viewBox="0 0 200 200" style:width={`${size}px`} aria-hidden="true">
      {#each arcs as arc, i (i)}<path d={arc.d} fill={arc.color} />{/each}
      {#if hole >= 0.4}
        <text x="100" y={centerLabel ? 98 : 108} class="ta-donut-value" text-anchor="middle">{centerValue ?? format(total)}</text>
        {#if centerLabel}<text x="100" y="118" class="ta-donut-label" text-anchor="middle">{centerLabel}</text>{/if}
      {/if}
    </svg>
    <div class={cn("ta-donut-key", legend === "hidden" && "ta-donut-hidden")}>
      <ChartLegend {items} orientation="vertical" />
      <p class="ta-donut-hidden">{centerLabel || L.total}: {centerValue ?? format(total)}</p>
    </div>
  </div>
</ChartFigure>

<style>
  .ta-donut { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem 1.5rem; min-width: 0; }
  .ta-donut--bottom { flex-direction: column; align-items: stretch; }
  .ta-donut--hidden { justify-content: center; }
  .ta-donut-svg { flex: 0 1 auto; max-width: 100%; height: auto; aspect-ratio: 1; }
  .ta-donut--bottom .ta-donut-svg { align-self: center; }
  .ta-donut-key { flex: 1 1 10rem; min-width: 0; }

  .ta-donut-value { fill: rgb(var(--ta-text)); font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ta-donut-label { fill: rgb(var(--ta-text-dim)); font-size: 12px; }

  .ta-donut-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
