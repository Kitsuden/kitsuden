<!--
  tallao — BigNumber
  The headline figure of an infographic: a large number with an optional prefix and unit,
  and a caption under it ("1.2M matches analysed this patch").
  - The server (and a browser without JavaScript) renders the final value. In the browser
    the number counts up from zero the first time it scrolls into view; it does not when
    the user prefers reduced motion or when `animate` is off.
  - A screen reader always gets the final value: the counting figure is hidden from it.
  - Not interactive.
  Plain JSON: `{ "value": 1240000, "unit": "matches", "label": "analysed this patch" }`,
  with `format` for the number (a text `value` is shown as is and never animates).
-->
<script lang="ts">
  import { compactNumber } from "../internal/chart";
  import { cn } from "../utils";

  interface Props {
    /** A number (formatted with `format`, animated) or a text shown as is. */
    value: number | string;
    /** Text before the figure ("$", "#"). */
    prefix?: string;
    /** Text after the figure, smaller ("%", "players"). */
    unit?: string;
    /** Caption under the figure. */
    label?: string;
    size?: "md" | "lg" | "xl";
    align?: "start" | "center";
    /** Counts up from zero when it comes into view. */
    animate?: boolean;
    /** Length of the count, in ms. */
    duration?: number;
    /** Any CSS colour for the figure; by default the text colour. */
    color?: string;
    locale?: string;
    /** Format of the number. */
    format?: (n: number) => string;
    class?: string;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const {
    value,
    prefix = "",
    unit,
    label,
    size = "lg",
    align = "start",
    animate = true,
    duration = 1200,
    color,
    locale,
    format = (n: number) => compactNumber(n, locale),
    class: className = "",
    ...rest
  }: Props = $props();

  let root: HTMLElement | undefined = $state();
  /** The figure on screen while it counts; null shows the real value. */
  let counting = $state<number | null>(null);

  const text = (v: number | string) => (typeof v === "number" ? format(v) : v);

  $effect(() => {
    const target = value;
    const length = duration;
    if (!animate || typeof target !== "number" || !Number.isFinite(target) || !root) return;
    if (typeof IntersectionObserver === "undefined" || typeof matchMedia === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const whole = Number.isInteger(target);
    let frame = 0;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / Math.max(1, length));
        const eased = target * (1 - (1 - t) ** 3);
        counting = t < 1 ? (whole ? Math.round(eased) : eased) : null;
        if (t < 1) frame = requestAnimationFrame(step);
      };
      counting = 0;
      frame = requestAnimationFrame(step);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      counting = null;
    };
  });
</script>

<div
  {...rest}
  bind:this={root}
  class={cn("ta-bignumber", `ta-bignumber--${size}`, `ta-bignumber--${align}`, className)}
>
  <p class="ta-bignumber-figure" style:color>
    {#if counting != null}
      <span aria-hidden="true">{prefix}{text(counting)}</span><span class="ta-bignumber-hidden"
        >{prefix}{text(value)}</span
      >
    {:else}
      <span>{prefix}{text(value)}</span>
    {/if}{#if unit}<span class="ta-bignumber-unit">{unit}</span>{/if}
  </p>
  {#if label}<p class="ta-bignumber-label">{label}</p>{/if}
</div>

<style>
  .ta-bignumber {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    color: rgb(var(--ta-text));
  }
  .ta-bignumber--center {
    align-items: center;
    text-align: center;
  }

  .ta-bignumber-figure {
    margin: 0;
    font-size: 3rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .ta-bignumber--md .ta-bignumber-figure {
    font-size: 2.25rem;
  }
  .ta-bignumber--xl .ta-bignumber-figure {
    font-size: clamp(3rem, 12vw, 4.5rem);
  }
  .ta-bignumber-unit {
    margin-left: 0.375rem;
    font-size: 0.35em;
    font-weight: 600;
    letter-spacing: 0;
    color: rgb(var(--ta-text-dim));
  }
  .ta-bignumber-label {
    margin: 0;
    max-width: 28ch;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-bignumber-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
