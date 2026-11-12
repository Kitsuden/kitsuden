<!--
  tallao — Thinking
  A model's reasoning as a block that stays out of the way: one quiet line while it runs,
  "Thought for 12 s" when it is done, and the trace behind a disclosure for whoever wants it.

    <Thinking running={busy} summary={currentStep}>{reasoning}</Thinking>
    <Thinking seconds={12} steps={["Read the brief", "Compared three sources"]} />

  - While `running`: the label shimmers softly, `summary` shows what it is doing right now
    (one line, cut with an ellipsis) and the elapsed time counts up. The time is counted here
    from the moment `running` turns true, unless `seconds` is given.
  - Done: the line reads "Thought for {time}" with the final time.
  - The line is a disclosure button (`aria-expanded`, `aria-controls`; Enter or Space): it
    opens the trace, which is `steps` (a list) and / or `children` (free text). With neither,
    it is plain text and not a button. `open` is bindable; it starts closed.
  - Screen readers: the block is `aria-busy` while running; the ticking time and the changing
    summary are not announced (they would never stop talking). The end is announced once, in
    a polite status ("Thought for 12 s").
  - Reduced motion: no shimmer, the trace opens without the height animation.
  - On the server it renders the state it is given; the clock starts in the browser.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { collapse } from "../motion";
  import { cn } from "../utils";

  import Icon from "./icon.svelte";

  interface Props {
    /** The model is still reasoning. */
    running?: boolean;
    /** What it is doing right now, in one line. */
    summary?: string;
    /** Elapsed seconds; without it the component counts while `running`. */
    seconds?: number;
    /** The trace as a list of steps. */
    steps?: string[];
    /** The trace is shown (bindable). */
    open?: boolean;
    /** Label while running ("Thinking…"). */
    runningLabel?: string;
    /** Label once done; "{time}" is replaced ("Thought for {time}"). */
    doneLabel?: string;
    class?: string;
    onOpenChange?: (open: boolean) => void;
    /** The trace as free content (the reasoning text). */
    children?: Snippet;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  let {
    running = false,
    summary,
    seconds,
    steps = [],
    open = $bindable(false),
    runningLabel = L.thinking,
    doneLabel = L.thoughtFor,
    class: className = "",
    onOpenChange,
    children,
    ...rest
  }: Props = $props();

  const id = $props.id();

  // The component's own clock, when the caller does not keep the time.
  let counted = $state(0);
  $effect(() => {
    if (!running || seconds !== undefined) return;
    const start = Date.now() - counted * 1000;
    const timer = setInterval(() => (counted = Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(timer);
  });

  const elapsed = $derived(Math.max(0, Math.round(seconds ?? counted)));
  const timeText = $derived(
    elapsed < 60
      ? L.secondsShort.replace("{n}", String(elapsed))
      : L.minutesShort
          .replace("{m}", String(Math.floor(elapsed / 60)))
          .replace("{s}", String(elapsed % 60))
  );
  const doneText = $derived(doneLabel.replace("{time}", timeText));
  const hasTrace = $derived(steps.length > 0 || !!children);

  // The end is announced once: the status region is filled when `running` turns false.
  let announced = $state("");
  let wasRunning = false;
  $effect(() => {
    if (wasRunning && !running) announced = doneText;
    if (running) announced = "";
    wasRunning = running;
  });

  function toggle() {
    open = !open;
    onOpenChange?.(open);
  }
</script>

{#snippet line()}
  <span class={cn("ta-thinking-mark", running && "ta-thinking-mark--busy")} aria-hidden="true">
    <Icon name="sparkle" size={14} />
  </span>
  {#if running}
    <span class="ta-thinking-label ta-thinking-label--busy">{runningLabel}</span>
    {#if summary}<span class="ta-thinking-summary">{summary}</span>{/if}
    <span class="ta-thinking-time" aria-hidden="true">{timeText}</span>
  {:else}
    <span class="ta-thinking-label">{doneText}</span>
  {/if}
{/snippet}

<div
  {...rest}
  class={cn("ta-thinking", running && "ta-thinking--running", className)}
  aria-busy={running}
>
  {#if hasTrace}
    <button
      type="button"
      class="ta-thinking-line"
      aria-expanded={open}
      aria-controls={`${id}-trace`}
      onclick={toggle}
    >
      {@render line()}
      <Icon
        name="chevron-down"
        size={12}
        class={cn("ta-thinking-caret", open && "ta-thinking-caret--open")}
      />
    </button>
    {#if open}
      <div class="ta-thinking-trace" id={`${id}-trace`} transition:collapse>
        {#if steps.length}
          <ol class="ta-thinking-steps">
            {#each steps as step, i (i)}
              <li class={cn(running && i === steps.length - 1 && "ta-thinking-step--current")}>
                {step}
              </li>
            {/each}
          </ol>
        {/if}
        {#if children}<div class="ta-thinking-text">{@render children()}</div>{/if}
      </div>
    {/if}
  {:else}
    <div class="ta-thinking-line">{@render line()}</div>
  {/if}
  <span class="ta-thinking-status" role="status">{announced}</span>
</div>

<style>
  .ta-thinking {
    position: relative;
    min-width: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-thinking-line {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    max-width: 100%;
    min-height: 1.75rem;
    padding: 0.125rem 0.5rem 0.125rem 0.375rem;
    margin-left: -0.375rem;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--ta-radius);
  }
  button.ta-thinking-line {
    cursor: pointer;
    transition:
      background-color var(--ta-duration-fast, 120ms),
      color var(--ta-duration-fast, 120ms);
  }
  button.ta-thinking-line:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated) / 0.5);
  }
  button.ta-thinking-line:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }

  .ta-thinking-mark {
    display: inline-flex;
    flex-shrink: 0;
    color: rgb(var(--ta-text-dim));
  }
  .ta-thinking-mark--busy {
    color: color-mix(in srgb, rgb(var(--ta-accent)) 70%, rgb(var(--ta-text)));
    animation: ta-thinking-pulse 1.6s ease-in-out infinite;
  }

  .ta-thinking-label {
    flex-shrink: 0;
    font-weight: 500;
    white-space: nowrap;
  }
  /* The shimmer: a band of the text colour travelling over dimmed text. */
  .ta-thinking-label--busy {
    color: transparent;
    background: linear-gradient(
        100deg,
        rgb(var(--ta-text-dim)) 35%,
        rgb(var(--ta-text)) 50%,
        rgb(var(--ta-text-dim)) 65%
      )
      0 0 / 250% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    animation: ta-thinking-sweep 1.8s linear infinite;
  }

  .ta-thinking-summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ta-thinking-summary::before {
    content: "·";
    margin-right: 0.4375rem;
    opacity: 0.6;
  }

  .ta-thinking-time {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .ta-thinking-time::before {
    content: "·";
    margin-right: 0.4375rem;
    opacity: 0.8;
  }

  .ta-thinking :global(.ta-thinking-caret) {
    flex-shrink: 0;
    opacity: 0.7;
    transition: transform var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }
  .ta-thinking :global(.ta-thinking-caret--open) {
    transform: rotate(180deg);
  }

  .ta-thinking-trace {
    margin: 0.25rem 0 0 0.3125rem;
    padding: 0.125rem 0 0.25rem 0.875rem;
    border-left: 1px solid rgb(var(--ta-border));
  }
  .ta-thinking-steps {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ta-thinking-steps li {
    position: relative;
  }
  .ta-thinking-steps li::before {
    content: "";
    position: absolute;
    left: calc(-0.875rem - 3px);
    top: 0.5625rem;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: rgb(var(--ta-muted));
  }
  .ta-thinking-step--current {
    color: rgb(var(--ta-text));
  }
  .ta-thinking-steps li.ta-thinking-step--current::before {
    background: rgb(var(--ta-accent));
    box-shadow: 0 0 0 3px rgb(var(--ta-accent) / 0.2);
  }
  .ta-thinking-steps + .ta-thinking-text {
    margin-top: 0.5rem;
  }
  .ta-thinking-text {
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .ta-thinking-status {
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

  @keyframes ta-thinking-sweep {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: -150% 0;
    }
  }
  @keyframes ta-thinking-pulse {
    0%,
    100% {
      opacity: 0.55;
      transform: scale(0.92);
    }
    50% {
      opacity: 1;
      transform: scale(1.05);
    }
  }

  @media (pointer: coarse) {
    button.ta-thinking-line {
      min-height: 2.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-thinking-label--busy {
      animation: none;
      color: inherit;
      background: none;
    }
    .ta-thinking-mark--busy {
      animation: none;
    }
    .ta-thinking :global(.ta-thinking-caret) {
      transition: none;
    }
  }
</style>
