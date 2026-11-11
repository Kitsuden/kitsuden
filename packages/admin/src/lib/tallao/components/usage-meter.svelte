<!--
  tallao — UsageMeter
  How much of a quota has been spent (tokens, requests, minutes): a bar with
  token and the numbers, which turns to warning past a threshold and red at the
  limit. The bar is a native `meter`: the screen reader announces the percentage on its own.
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();

  interface Props {
    used: number;
    max: number;
    /** What is counted ("tokens", "minutes"…). */
    unit?: string;
    /** Visible label; by default "Usage" / "Uso". */
    label?: string;
    /** Percentage from which to warn (default 80). */
    warnAt?: number;
    /** Cost in currency, if known (shown as is, e.g. "$0.42"). */
    cost?: string;
    /** Only the numbers, no bar. */
    compact?: boolean;
    class?: string;
    [key: string]: unknown;
  }

  const {
    used,
    max,
    unit = "tokens",
    label = L.usage,
    warnAt = 80,
    cost,
    compact = false,
    class: className = "",
    ...rest
  }: Props = $props();

  const percentage = $derived(max > 0 ? Math.min(100, (used / max) * 100) : 0);
  const level = $derived(percentage >= 100 ? "exhausted" : percentage >= warnAt ? "warning" : "ok");

  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const count = $derived(`${numberFormat.format(used)} / ${numberFormat.format(max)} ${unit}`);
</script>

<div {...rest} class={cn("ta-usage", `ta-usage--${level}`, compact && "ta-usage--compact", className)}>
  <div class="ta-usage-row">
    <span class="ta-usage-label">{label}</span>
    <span class="ta-usage-count">{count}{#if cost} · {cost}{/if}</span>
  </div>
  {#if !compact}
    <meter
      class="ta-usage-bar"
      min="0"
      max={max}
      value={Math.min(used, max)}
      low={max * (warnAt / 100)}
      high={max * (warnAt / 100)}
      optimum="0"
      aria-label={label}
    ></meter>
  {/if}
</div>

<style>
  .ta-usage {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 10rem;
  }

  .ta-usage-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.75rem;
  }

  .ta-usage-label {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgb(var(--ta-text-dim));
  }

  .ta-usage-count {
    font-family: var(--ta-font-mono);
    color: rgb(var(--ta-text));
  }

  .ta-usage-bar {
    width: 100%;
    height: 0.375rem;
    appearance: none;
  }

  .ta-usage-bar::-webkit-meter-bar {
    background: rgb(var(--ta-elevated));
    border: none;
    border-radius: 9999px;
  }
  .ta-usage-bar::-webkit-meter-inner-element { display: block; }
  .ta-usage-bar::-webkit-meter-optimum-value,
  .ta-usage-bar::-webkit-meter-suboptimum-value,
  .ta-usage-bar::-webkit-meter-even-less-good-value {
    border-radius: 9999px;
  }
  .ta-usage-bar::-webkit-meter-optimum-value { background: rgb(var(--ta-accent)); }
  .ta-usage-bar::-webkit-meter-suboptimum-value { background: rgb(var(--ta-warning)); }
  .ta-usage-bar::-webkit-meter-even-less-good-value { background: rgb(var(--ta-danger)); }

  .ta-usage-bar::-moz-meter-bar {
    border-radius: 9999px;
    background: rgb(var(--ta-accent));
  }
  .ta-usage-bar:-moz-meter-sub-optimum::-moz-meter-bar { background: rgb(var(--ta-warning)); }
  .ta-usage-bar:-moz-meter-sub-sub-optimum::-moz-meter-bar { background: rgb(var(--ta-danger)); }

  /* The number's color follows the bar's (two channels, not just one) */
  .ta-usage--warning .ta-usage-count { color: rgb(var(--ta-warning)); }
  .ta-usage--exhausted .ta-usage-count { color: rgb(var(--ta-danger)); }

  .ta-usage--compact {
    min-width: 0;
  }
</style>
