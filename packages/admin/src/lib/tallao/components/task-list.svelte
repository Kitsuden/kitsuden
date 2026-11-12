<!--
  tallao — TaskList
  The live status of what an agent is working on: one row per task, pending, running (a
  progress ring, with a count when the task has parts), done or failed.

    <TaskList tasks={[
      { id: "a", title: "Collect match data", status: "done", meta: "12 s" },
      { id: "b", title: "Recompute tier list", status: "running", done: 3, total: 8, detail: "Fire, Water, Grass done" },
      { id: "c", title: "Write the summary", status: "pending" },
    ]} />
    <TaskList variant="capsule" {tasks} />

  - Steps shows a plan (what will happen, in order). TaskList shows work in flight: progress
    per task, details per row, and a one-line summary for a tight space.
  - `variant="list"` (default): every row. A task with `detail` (or when the `details` snippet
    is given) is a disclosure button (`aria-expanded`, `aria-controls`) that unfolds it.
  - `variant="capsule"`: one pill with an overall ring and "3 of 5 done" plus the running
    task's title; it is a disclosure button that unfolds the list. `open` is bindable.
  - Status is an icon and a word for screen readers, never colour alone; the running row is
    `aria-current="step"` and the block is `aria-busy` while anything runs. The rings are
    `role="progressbar"` with their values when the task has a count.
  - Reduced motion: the indeterminate ring stops spinning (it stays as a dashed ring).
    Same HTML on the server.
-->
<script lang="ts" module>
  export type TaskStatus = "pending" | "running" | "done" | "failed";

  export interface TaskItem {
    id: string;
    title: string;
    status?: TaskStatus;
    /** Parts finished and in total, for a running task that can count them. */
    done?: number;
    total?: number;
    /** A quiet note at the end of the row (a duration, a count). */
    meta?: string;
    /** Text shown when the row is unfolded. */
    detail?: string;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { collapse } from "../motion";
  import { cn } from "../utils";

  import Icon from "./icon.svelte";

  interface Props {
    tasks: TaskItem[];
    variant?: "list" | "capsule";
    /** Capsule: the list is unfolded (bindable). */
    open?: boolean;
    /** Ids of the rows whose details are shown (bindable). */
    expanded?: string[];
    /** Accessible name of the list. */
    label?: string;
    /** Word per status, read by screen readers; the kit's labels by default. */
    labels?: Partial<Record<TaskStatus, string>>;
    class?: string;
    /** Draws a row's details yourself; gets the task. */
    details?: Snippet<[TaskItem]>;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  let {
    tasks,
    variant = "list",
    open = $bindable(false),
    expanded = $bindable([]),
    label = L.tasks,
    labels = {},
    class: className = "",
    details,
    ...rest
  }: Props = $props();

  const id = $props.id();
  const words = $derived<Record<TaskStatus, string>>({
    pending: L.pending,
    running: L.running,
    done: L.done,
    failed: L.failed,
    ...labels,
  });
  const statusOf = (task: TaskItem): TaskStatus => task.status ?? "pending";
  const finished = $derived(tasks.filter((t) => statusOf(t) === "done").length);
  const running = $derived(tasks.find((t) => statusOf(t) === "running"));
  const failed = $derived(tasks.some((t) => statusOf(t) === "failed"));
  const summary = $derived(
    L.tasksDone.replace("{done}", String(finished)).replace("{total}", String(tasks.length))
  );
  const share = (done: number, total: number) =>
    total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;

  const R = 6.5;
  const C = 2 * Math.PI * R;

  const canOpen = (task: TaskItem) => !!details || !!task.detail;
  const isOpen = (task: TaskItem) => expanded.includes(task.id);
  const toggleRow = (task: TaskItem) =>
    (expanded = isOpen(task) ? expanded.filter((k) => k !== task.id) : [...expanded, task.id]);
</script>

{#snippet ring(value: number | null, name: string | undefined, tone: string)}
  <svg
    class={cn("ta-tasks-ring", value === null && "ta-tasks-ring--spin", `ta-tasks-ring--${tone}`)}
    width="16"
    height="16"
    viewBox="0 0 16 16"
    role={name ? "progressbar" : undefined}
    aria-label={name}
    aria-valuemin={name ? 0 : undefined}
    aria-valuemax={name ? 100 : undefined}
    aria-valuenow={name && value !== null ? Math.round(value * 100) : undefined}
    aria-hidden={name ? undefined : "true"}
  >
    <circle class="ta-tasks-ring-track" cx="8" cy="8" r={R} />
    <circle
      class="ta-tasks-ring-bar"
      cx="8"
      cy="8"
      r={R}
      stroke-dasharray={C}
      stroke-dashoffset={C * (1 - (value ?? 0.28))}
    />
  </svg>
{/snippet}

{#snippet mark(task: TaskItem)}
  {@const status = statusOf(task)}
  <span class={cn("ta-tasks-mark", `ta-tasks-mark--${status}`)}>
    {#if status === "running"}
      {@render ring(
        task.total ? share(task.done ?? 0, task.total) : null,
        task.total ? task.title : undefined,
        "accent"
      )}
    {:else if status === "done"}
      <Icon name="check" size={12} strokeWidth={3} />
    {:else if status === "failed"}
      <Icon name="x" size={12} strokeWidth={3} />
    {:else}
      <span class="ta-tasks-dot" aria-hidden="true"></span>
    {/if}
  </span>
{/snippet}

{#snippet row(task: TaskItem)}
  {@const status = statusOf(task)}
  {@render mark(task)}
  <span class="ta-tasks-title">{task.title}</span>
  <span class="ta-tasks-hidden">({words[status]})</span>
  {#if status === "running" && task.total}
    <span class="ta-tasks-count">{task.done ?? 0}/{task.total}</span>
  {/if}
  {#if task.meta}<span class="ta-tasks-meta">{task.meta}</span>{/if}
{/snippet}

{#snippet list()}
  <ol class="ta-tasks-list" id={`${id}-list`} aria-label={label}>
    {#each tasks as task (task.id)}
      {@const status = statusOf(task)}
      <li
        class={cn("ta-tasks-item", `ta-tasks-item--${status}`)}
        aria-current={status === "running" ? "step" : undefined}
      >
        {#if canOpen(task)}
          <button
            type="button"
            class="ta-tasks-row"
            aria-expanded={isOpen(task)}
            aria-controls={`${id}-${task.id}`}
            onclick={() => toggleRow(task)}
          >
            {@render row(task)}
            <Icon
              name="chevron-down"
              size={12}
              class={cn("ta-tasks-caret", isOpen(task) && "ta-tasks-caret--open")}
            />
          </button>
          {#if isOpen(task)}
            <div class="ta-tasks-detail" id={`${id}-${task.id}`} transition:collapse>
              {#if details}{@render details(task)}{:else}{task.detail}{/if}
            </div>
          {/if}
        {:else}
          <div class="ta-tasks-row">{@render row(task)}</div>
        {/if}
      </li>
    {/each}
  </ol>
{/snippet}

<div {...rest} class={cn("ta-tasks", `ta-tasks--${variant}`, className)} aria-busy={!!running}>
  {#if variant === "capsule"}
    <button
      type="button"
      class="ta-tasks-capsule"
      aria-expanded={open}
      aria-controls={`${id}-list`}
      onclick={() => (open = !open)}
    >
      {#if failed && !running}
        <span class="ta-tasks-mark ta-tasks-mark--failed"
          ><Icon name="x" size={12} strokeWidth={3} /></span
        >
      {:else if finished === tasks.length && tasks.length > 0}
        <span class="ta-tasks-mark ta-tasks-mark--done"
          ><Icon name="check" size={12} strokeWidth={3} /></span
        >
      {:else}
        {@render ring(share(finished, tasks.length), undefined, running ? "accent" : "idle")}
      {/if}
      <span class="ta-tasks-summary">{summary}</span>
      {#if running}<span class="ta-tasks-now">{running.title}</span>{/if}
      <Icon
        name="chevron-down"
        size={12}
        class={cn("ta-tasks-caret", open && "ta-tasks-caret--open")}
      />
    </button>
    {#if open}
      <div class="ta-tasks-panel" transition:collapse>{@render list()}</div>
    {/if}
  {:else}
    {@render list()}
  {/if}
</div>

<style>
  .ta-tasks {
    min-width: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-tasks-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ta-tasks-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 1.875rem;
    padding: 0.1875rem 0.5rem 0.1875rem 0.375rem;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--ta-radius);
  }
  button.ta-tasks-row {
    cursor: pointer;
    transition: background-color var(--ta-duration-fast, 120ms);
  }
  button.ta-tasks-row:hover {
    background: rgb(var(--ta-elevated) / 0.5);
  }
  button.ta-tasks-row:focus-visible,
  .ta-tasks-capsule:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }

  .ta-tasks-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
  }
  .ta-tasks-mark--done {
    color: rgb(var(--ta-on-success));
    background: rgb(var(--ta-success));
  }
  .ta-tasks-mark--failed {
    color: rgb(var(--ta-on-danger));
    background: rgb(var(--ta-danger));
  }
  .ta-tasks-dot {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px dashed rgb(var(--ta-muted));
    border-radius: 50%;
  }

  .ta-tasks-ring {
    flex-shrink: 0;
    transform: rotate(-90deg);
  }
  .ta-tasks-ring circle {
    fill: none;
    stroke-width: 2;
  }
  .ta-tasks-ring-track {
    stroke: rgb(var(--ta-muted) / 0.7);
  }
  .ta-tasks-ring-bar {
    stroke: rgb(var(--ta-accent));
    stroke-linecap: round;
    transition: stroke-dashoffset var(--ta-duration-slow, 240ms) var(--ta-ease-out, ease-out);
  }
  .ta-tasks-ring--idle .ta-tasks-ring-bar {
    stroke: rgb(var(--ta-text-dim));
  }
  .ta-tasks-ring--spin {
    animation: ta-tasks-spin 0.9s linear infinite;
  }
  @keyframes ta-tasks-spin {
    from {
      transform: rotate(-90deg);
    }
    to {
      transform: rotate(270deg);
    }
  }

  .ta-tasks-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ta-tasks-item--running .ta-tasks-title {
    color: rgb(var(--ta-text));
    font-weight: 500;
  }
  .ta-tasks-item--done .ta-tasks-title {
    color: rgb(var(--ta-text-dim));
  }
  .ta-tasks-item--failed .ta-tasks-title {
    color: rgb(var(--ta-text));
  }

  .ta-tasks-count,
  .ta-tasks-meta {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .ta-tasks-count {
    color: rgb(var(--ta-text));
  }
  .ta-tasks-count + .ta-tasks-meta {
    margin-left: 0;
  }
  .ta-tasks-row > :global(.ta-tasks-caret) {
    margin-left: auto;
  }
  .ta-tasks-count ~ :global(.ta-tasks-caret),
  .ta-tasks-meta ~ :global(.ta-tasks-caret) {
    margin-left: 0;
  }

  .ta-tasks :global(.ta-tasks-caret) {
    flex-shrink: 0;
    opacity: 0.7;
    transition: transform var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }
  .ta-tasks :global(.ta-tasks-caret--open) {
    transform: rotate(180deg);
  }

  .ta-tasks-detail {
    margin: 0.125rem 0 0.375rem 0.8125rem;
    padding: 0.125rem 0 0.125rem 1rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border-left: 1px solid rgb(var(--ta-border));
  }

  /* — Capsule — */
  .ta-tasks-capsule {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 100%;
    min-height: 2rem;
    padding: 0.25rem 0.625rem 0.25rem 0.5rem;
    font: inherit;
    color: inherit;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: 9999px;
    cursor: pointer;
    transition:
      border-color var(--ta-duration-fast, 120ms),
      background-color var(--ta-duration-fast, 120ms);
  }
  .ta-tasks-capsule:hover {
    border-color: rgb(var(--ta-muted));
    background: rgb(var(--ta-elevated) / 0.6);
  }
  .ta-tasks-summary {
    flex-shrink: 0;
    font-weight: 500;
    color: rgb(var(--ta-text));
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ta-tasks-now {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ta-tasks-now::before {
    content: "·";
    margin-right: 0.5rem;
    opacity: 0.6;
  }
  .ta-tasks-panel {
    margin-top: 0.375rem;
    padding: 0.375rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }

  .ta-tasks-hidden {
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

  @media (pointer: coarse) {
    button.ta-tasks-row,
    .ta-tasks-capsule {
      min-height: 2.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-tasks-ring--spin {
      animation: none;
    }
    .ta-tasks-ring--spin .ta-tasks-ring-bar {
      stroke-dasharray: 3 3;
      stroke-dashoffset: 0;
    }
    .ta-tasks-ring-bar,
    .ta-tasks :global(.ta-tasks-caret) {
      transition: none;
    }
  }
</style>
