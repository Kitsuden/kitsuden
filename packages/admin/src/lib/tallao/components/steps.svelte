<!--
  tallao — Steps
  An agent's plan, step by step: what it is going to do, what it is doing and how
  each thing ended (done, failed, skipped). Companion to ToolCallCard: the card
  shows ONE call; this shows the whole plan.

  Ordered list with `aria-current="step"` on the running step; the status is
  told apart by icon and color (never by color alone).
-->
<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";
  import Spinner from "./spinner.svelte";

  const L = useLabels();

  export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

  export interface Step {
    title: string;
    description?: string;
    status?: StepStatus;
  }

  interface Props {
    steps: Step[];
    /** Accessible name of the list. */
    label?: string;
    /** Text per status; defaults to the kit's labels. */
    labels?: Partial<Record<StepStatus, string>>;
    /** Vertical (default) or a row that scrolls on narrow screens. */
    orientation?: "vertical" | "horizontal";
    class?: string;
    [key: string]: unknown;
  }

  const {
    steps,
    label = L.planSteps,
    labels = {},
    orientation = "vertical",
    class: className = "",
    ...rest
  }: Props = $props();

  const text = $derived<Record<StepStatus, string>>({
    pending: L.pending,
    running: L.running,
    done: L.done,
    failed: L.failed,
    skipped: L.skipped,
    ...labels,
  });
</script>

<ol
  {...rest}
  class={cn("ta-steps", `ta-steps--${orientation}`, className)}
  aria-label={label}
>
  {#each steps as step, i (i)}
    {@const status = step.status ?? "pending"}
    <li
      class={cn("ta-steps-step", `ta-steps-step--${status}`)}
      aria-current={status === "running" ? "step" : undefined}
    >
      <span class="ta-steps-icon" aria-hidden="true">
        {#if status === "running"}
          <Spinner size="sm" label={text.running} />
        {:else if status === "done"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        {:else if status === "failed"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        {:else if status === "skipped"}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16"/><path d="m14 6 6 6-6 6"/></svg>
        {:else}
          <span class="ta-steps-dot"></span>
        {/if}
      </span>
      <span class="ta-steps-body">
        <span class="ta-steps-title">{step.title}</span>
        {#if step.description}
          <span class="ta-steps-description">{step.description}</span>
        {/if}
      </span>
      <span class="ta-steps-status">{text[status]}</span>
      {#if i < steps.length - 1}
        <span class="ta-steps-connector" aria-hidden="true"></span>
      {/if}
    </li>
  {/each}
</ol>

<style>
  .ta-steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  .ta-steps-step {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.375rem 0;
  }

  .ta-steps-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
    color: rgb(var(--ta-text-dim));
  }

  .ta-steps-step--running .ta-steps-icon {
    border-color: rgb(var(--ta-accent) / 0.5);
    color: rgb(var(--ta-accent-hover));
  }
  .ta-steps-step--done .ta-steps-icon {
    border-color: rgb(var(--ta-success) / 0.5);
    color: rgb(var(--ta-success));
  }
  .ta-steps-step--failed .ta-steps-icon {
    border-color: rgb(var(--ta-danger) / 0.5);
    color: rgb(var(--ta-danger));
  }

  .ta-steps-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: rgb(var(--ta-muted));
  }

  .ta-steps-connector {
    position: absolute;
    left: 0.71875rem;
    top: 2rem;
    bottom: -0.125rem;
    width: 1px;
    background: rgb(var(--ta-border));
  }

  .ta-steps-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .ta-steps-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: rgb(var(--ta-text));
  }
  .ta-steps-step--pending .ta-steps-title,
  .ta-steps-step--skipped .ta-steps-title {
    color: rgb(var(--ta-text-dim));
  }
  .ta-steps-step--skipped .ta-steps-title {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--ta-muted));
  }

  .ta-steps-description {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-steps-status {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgb(var(--ta-text-dim));
    padding-top: 0.1875rem;
  }
  .ta-steps-step--running .ta-steps-status { color: rgb(var(--ta-accent-hover)); }
  .ta-steps-step--done .ta-steps-status { color: rgb(var(--ta-success)); }
  .ta-steps-step--failed .ta-steps-status { color: rgb(var(--ta-danger)); }

  /* Horizontal: a row that scrolls, no vertical connector */
  .ta-steps--horizontal {
    flex-direction: row;
    overflow-x: auto;
    gap: 0.25rem;
  }
  .ta-steps--horizontal .ta-steps-step {
    flex-direction: column;
    align-items: center;
    text-align: center;
    min-width: 6rem;
    padding: 0.375rem 0.5rem;
  }
  .ta-steps--horizontal .ta-steps-body { align-items: center; }
  .ta-steps--horizontal .ta-steps-status { padding-top: 0; }
  .ta-steps--horizontal .ta-steps-connector { display: none; }
</style>
