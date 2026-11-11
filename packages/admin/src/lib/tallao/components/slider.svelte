<!--
  tallao — Slider
  A numeric value between two bounds, on a native <input type="range">: the keyboard
  (arrows, PageUp/PageDown, Home/End), the screen reader and submission in a <form>
  come from the browser.
  - `label` visible above, with the value on the right (`valueText` formats it: "Lv. 30",
    "45 %"); without it, `ariaLabel` gives the name.
  - `valueText` is also what the screen reader hears (aria-valuetext).
  - `marks` draws labels under the track ("1", "30", "60"), placed at their value.
  - `oninput` on every step of the drag; `onchange` on release (the final value).
-->
<script lang="ts">
  import { tick } from "svelte";

  import { cn } from "../utils";

  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    label,
    ariaLabel,
    valueText,
    showValue = true,
    marks = [],
    name,
    id,
    disabled = false,
    class: className = "",
    oninput,
    onchange,
  }: {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    /** Visible label above the track. */
    label?: string;
    /** Accessible name when there is no visible `label`. */
    ariaLabel?: string;
    /** How the value is read out and shown. */
    valueText?: (value: number) => string;
    /** Shows the value next to the label. */
    showValue?: boolean;
    /** Labels under the track, placed at their value. */
    marks?: { value: number; label: string }[];
    name?: string;
    id?: string;
    disabled?: boolean;
    class?: string;
    oninput?: (value: number) => void;
    onchange?: (value: number) => void;
  } = $props();

  const ownId = $props.id();
  let track: HTMLInputElement | undefined = $state();

  // On release: if the caller did not accept the value (left it as it was or corrected it),
  // the track moves to the value that actually stuck, not to where it was released.
  async function release() {
    onchange?.(value);
    await tick();
    if (track && track.valueAsNumber !== value) track.value = String(value);
  }
  const cid = $derived(id ?? `${ownId}-slider`);
  const pct = (v: number) => (max > min ? ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100 : 0);
  const text = $derived(valueText ? valueText(value) : String(value));
  // Marks spread evenly from one bound to the other (the usual case: "1 · 30 · 60") go in a
  // row that shares out the width and lets long texts wrap onto two lines, instead of each
  // being placed at its own point and overlapping on a narrow card.
  const evenlySpread = $derived.by(() => {
    if (marks.length < 2) return false;
    const sorted = [...marks].sort((a, b) => a.value - b.value);
    if (sorted[0].value !== min || sorted.at(-1)!.value !== max) return false;
    const gap = (max - min) / (sorted.length - 1);
    return sorted.every((m, i) => Math.abs(m.value - (min + i * gap)) < gap * 0.05);
  });
</script>

<div class={cn("ta-slider", disabled && "ta-slider--off", className)}>
  {#if label}
    <div class="ta-slider-header">
      <label class="ta-slider-label" for={cid}>{label}</label>
      {#if showValue}<output class="ta-slider-value" for={cid}>{text}</output>{/if}
    </div>
  {/if}
  <input
    id={cid}
    class="ta-slider-track"
    type="range"
    {min}
    {max}
    {step}
    {name}
    {disabled}
    aria-label={label ? undefined : ariaLabel}
    aria-valuetext={valueText ? text : undefined}
    style:--ta-slider-pct={`${pct(value)}%`}
    bind:value
    bind:this={track}
    oninput={() => oninput?.(value)}
    onchange={release}
  />
  {#if marks.length && evenlySpread}
    <div class="ta-slider-marks ta-slider-marks--row" aria-hidden="true">
      {#each [...marks].sort((a, b) => a.value - b.value) as m (m.value)}<span>{m.label}</span>{/each}
    </div>
  {:else if marks.length}
    <div class="ta-slider-marks" aria-hidden="true">
      {#each marks as m (m.value)}
        <span style:left={`${pct(m.value)}%`} class:ta-slider-mark--start={pct(m.value) <= 0} class:ta-slider-mark--end={pct(m.value) >= 100}>{m.label}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ta-slider { display: flex; flex-direction: column; gap: 0.375rem; min-width: 0; }
  .ta-slider--off { opacity: 0.5; }

  .ta-slider-header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
  .ta-slider-label { font-size: 0.75rem; font-weight: 500; color: rgb(var(--ta-text-dim)); }
  .ta-slider-value { font-size: 0.8125rem; font-weight: 600; font-variant-numeric: tabular-nums; color: rgb(var(--ta-text)); }

  .ta-slider-track {
    --ta-slider-height: 0.375rem;
    width: 100%;
    height: 1.25rem;
    margin: 0;
    background: transparent;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  .ta-slider-track:disabled { cursor: not-allowed; }
  .ta-slider-track:focus { outline: none; }

  /* The track: the covered part in the accent color. */
  .ta-slider-track::-webkit-slider-runnable-track {
    height: var(--ta-slider-height);
    border-radius: 999px;
    background: linear-gradient(
      to right,
      rgb(var(--ta-accent)) 0 var(--ta-slider-pct),
      rgb(var(--ta-elevated)) var(--ta-slider-pct) 100%
    );
  }
  .ta-slider-track::-moz-range-track {
    height: var(--ta-slider-height);
    border-radius: 999px;
    background: rgb(var(--ta-elevated));
  }
  .ta-slider-track::-moz-range-progress {
    height: var(--ta-slider-height);
    border-radius: 999px;
    background: rgb(var(--ta-accent));
  }

  .ta-slider-track::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 1rem;
    height: 1rem;
    margin-top: calc((var(--ta-slider-height) - 1rem) / 2);
    border-radius: 50%;
    background: rgb(var(--ta-text));
    border: 2px solid rgb(var(--ta-accent));
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
    transition: box-shadow 0.15s;
  }
  .ta-slider-track::-moz-range-thumb {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: rgb(var(--ta-text));
    border: 2px solid rgb(var(--ta-accent));
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
  }
  .ta-slider-track:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgb(var(--ta-accent) / 0.35); }
  .ta-slider-track:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px rgb(var(--ta-accent) / 0.35); }

  /* Labels sit at their place; the first and last do not overflow the sides. */
  .ta-slider-marks { position: relative; height: 1rem; font-size: 0.6875rem; color: rgb(var(--ta-text-dim)); font-variant-numeric: tabular-nums; }
  .ta-slider-marks span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
  .ta-slider-marks .ta-slider-mark--start { transform: none; }
  .ta-slider-marks .ta-slider-mark--end { transform: translateX(-100%); }
  .ta-slider-marks--row { display: flex; justify-content: space-between; gap: 0.5rem; height: auto; line-height: 1.3; }
  .ta-slider-marks--row span { position: static; flex: 0 1 auto; transform: none; white-space: normal; text-align: center; }
  .ta-slider-marks--row span:first-child { text-align: left; }
  .ta-slider-marks--row span:last-child { text-align: right; }

  /* On touch screens: the visual track keeps its size; the draggable area grows to 44px. */
  @media (pointer: coarse) {
    .ta-slider-track { height: 2.75rem; }
  }
</style>
