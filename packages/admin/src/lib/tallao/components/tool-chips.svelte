<!--
  tallao — ToolChips
  What an agent did, as a compact run of chips: one line per tool call with an icon, a verb
  and its target ("Write · ChurnSchedule.tsx"), and for files the lines added and removed.

    <ToolChips messages={2} calls={[
      { id: "1", verb: "Read", target: "brief.md", icon: "file" },
      { id: "2", verb: "Write", target: "Schedule.tsx", icon: "edit", added: 74, removed: 41 },
      { id: "3", verb: "Run", target: "pnpm test", icon: "terminal", status: "running" },
      { id: "4", verb: "Publish", target: "post #42", name: "publish_post", args: { id: 42 }, result: "ok" },
    ]} />

  - The header is a disclosure button ("4 tool calls, 2 messages"; `aria-expanded`) that folds
    the whole run; `collapsible={false}` leaves only the list. `open` is bindable.
  - A call with `name` (and `args` / `result`) can be opened: its chip is a button
    (`aria-expanded`) and unfolds a ToolCallCard with the arguments and the result. A call
    without them is a plain row.
  - Status per call: `running` (a spinning ring, and the row is `aria-busy`), `done` (default)
    or `failed` (a cross and the word, not only red). Diff figures are "+74 −41" with the
    signs, and are spelled out for screen readers ("74 lines added, 41 lines removed").
  - A list (`<ul>`) named by the header. Same HTML on the server.
-->
<script lang="ts" module>
  import type { IconName } from "./icon.svelte";

  export interface ToolChipCall {
    id: string;
    /** What it did, as a verb ("Read", "Write", "Search"). */
    verb: string;
    /** What it did it to (a file, a query, a record). */
    target?: string;
    icon?: IconName;
    status?: "running" | "done" | "failed";
    /** Lines added and removed, for a file edit. */
    added?: number;
    removed?: number;
    /** With a tool name the chip opens a ToolCallCard. */
    name?: string;
    args?: Record<string, unknown>;
    result?: string;
  }
</script>

<script lang="ts">
  import { useLabels } from "../i18n";
  import { collapse } from "../motion";
  import { cn } from "../utils";

  import Icon from "./icon.svelte";
  import ToolCallCard from "./tool-call-card.svelte";

  interface Props {
    calls: ToolChipCall[];
    /** How many messages the run produced, for the header. */
    messages?: number;
    /** The header's text, instead of the generated count. */
    summary?: string;
    /** The run is shown (bindable). */
    open?: boolean;
    /** `false`: no header, only the list. */
    collapsible?: boolean;
    /** Accessible name of the list when there is no header. */
    ariaLabel?: string;
    class?: string;
    onOpenChange?: (open: boolean) => void;
    /** Any other attribute goes to the root element. */
    [key: string]: unknown;
  }

  const L = useLabels();
  let {
    calls,
    messages,
    summary,
    open = $bindable(true),
    collapsible = true,
    ariaLabel,
    class: className = "",
    onOpenChange,
    ...rest
  }: Props = $props();

  const id = $props.id();
  const count = (n: number, one: string, many: string) =>
    n === 1 ? one : many.replace("{n}", String(n));
  const header = $derived(
    summary ??
      [
        count(calls.length, L.toolCallOne, L.toolCalls),
        messages ? count(messages, L.messageOne, L.messages) : "",
      ]
        .filter(Boolean)
        .join(", ")
  );
  const busy = $derived(calls.some((c) => c.status === "running"));

  let expanded = $state<Record<string, boolean>>({});
  const cardStatus = (call: ToolChipCall) =>
    call.status === "running" ? "executing" : call.status === "failed" ? "failed" : "executed";

  function toggle() {
    open = !open;
    onOpenChange?.(open);
  }
</script>

{#snippet face(call: ToolChipCall)}
  <span class="ta-toolchips-icon" aria-hidden="true">
    {#if call.status === "running"}
      <span class="ta-toolchips-ring"></span>
    {:else if call.status === "failed"}
      <Icon name="x" size={13} />
    {:else}
      <Icon name={call.icon ?? "settings"} size={13} />
    {/if}
  </span>
  <span class="ta-toolchips-verb">{call.verb}</span>
  {#if call.target}<code class="ta-toolchips-target">{call.target}</code>{/if}
  {#if call.status === "failed"}<span class="ta-toolchips-failed">{L.failed}</span>{/if}
  {#if call.added != null || call.removed != null}
    <span class="ta-toolchips-stats">
      {#if call.added != null}<span class="ta-toolchips-added"
          ><span aria-hidden="true">+{call.added}</span><span class="ta-toolchips-hidden"
            >{L.linesAdded.replace("{n}", String(call.added))}</span
          ></span
        >{/if}
      {#if call.removed != null}<span class="ta-toolchips-removed"
          ><span aria-hidden="true">−{call.removed}</span><span class="ta-toolchips-hidden"
            >{L.linesRemoved.replace("{n}", String(call.removed))}</span
          ></span
        >{/if}
    </span>
  {/if}
{/snippet}

<div {...rest} class={cn("ta-toolchips", className)} aria-busy={busy}>
  {#if collapsible}
    <button
      type="button"
      class="ta-toolchips-header"
      id={`${id}-header`}
      aria-expanded={open}
      aria-controls={`${id}-list`}
      onclick={toggle}
    >
      <Icon
        name="chevron-right"
        size={12}
        class={cn("ta-toolchips-caret", open && "ta-toolchips-caret--open")}
      />
      {header}
    </button>
  {/if}
  {#if open || !collapsible}
    <ul
      class="ta-toolchips-list"
      id={`${id}-list`}
      aria-labelledby={collapsible ? `${id}-header` : undefined}
      aria-label={collapsible ? undefined : (ariaLabel ?? header)}
      transition:collapse
    >
      {#each calls as call (call.id)}
        <li
          class={cn("ta-toolchips-item", `ta-toolchips-item--${call.status ?? "done"}`)}
          aria-busy={call.status === "running" || undefined}
        >
          {#if call.name}
            <button
              type="button"
              class="ta-toolchips-chip"
              aria-expanded={!!expanded[call.id]}
              aria-controls={`${id}-${call.id}`}
              onclick={() => (expanded[call.id] = !expanded[call.id])}
            >
              {@render face(call)}
              <Icon
                name="chevron-down"
                size={11}
                class={cn("ta-toolchips-more", expanded[call.id] && "ta-toolchips-more--open")}
              />
            </button>
            {#if expanded[call.id]}
              <div class="ta-toolchips-card" id={`${id}-${call.id}`} transition:collapse>
                <ToolCallCard
                  name={call.name}
                  args={call.args}
                  result={call.result}
                  status={cardStatus(call)}
                />
              </div>
            {/if}
          {:else}
            <span class="ta-toolchips-chip">{@render face(call)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ta-toolchips {
    min-width: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }

  .ta-toolchips-header {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 1.75rem;
    margin-left: -0.375rem;
    padding: 0.125rem 0.5rem 0.125rem 0.375rem;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    border-radius: var(--ta-radius);
    cursor: pointer;
    transition:
      background-color var(--ta-duration-fast, 120ms),
      color var(--ta-duration-fast, 120ms);
  }
  .ta-toolchips-header:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated) / 0.5);
  }
  .ta-toolchips-header:focus-visible,
  button.ta-toolchips-chip:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }
  .ta-toolchips :global(.ta-toolchips-caret),
  .ta-toolchips :global(.ta-toolchips-more) {
    flex-shrink: 0;
    opacity: 0.7;
    transition: transform var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }
  .ta-toolchips :global(.ta-toolchips-caret--open) {
    transform: rotate(90deg);
  }
  .ta-toolchips :global(.ta-toolchips-more--open) {
    transform: rotate(180deg);
  }

  .ta-toolchips-list {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
  }
  .ta-toolchips-item {
    min-width: 0;
  }

  .ta-toolchips-chip {
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
  button.ta-toolchips-chip {
    cursor: pointer;
    transition: background-color var(--ta-duration-fast, 120ms);
  }
  button.ta-toolchips-chip:hover {
    background: rgb(var(--ta-elevated) / 0.5);
  }

  .ta-toolchips-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
  }
  .ta-toolchips-item--failed .ta-toolchips-icon {
    color: rgb(var(--ta-danger));
  }
  .ta-toolchips-ring {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid rgb(var(--ta-muted));
    border-top-color: rgb(var(--ta-accent));
    border-radius: 50%;
    animation: ta-toolchips-spin 0.8s linear infinite;
  }
  @keyframes ta-toolchips-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .ta-toolchips-verb {
    flex-shrink: 0;
    font-weight: 600;
    color: rgb(var(--ta-text));
    white-space: nowrap;
  }
  .ta-toolchips-target {
    min-width: 0;
    padding: 0.0625rem 0.375rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-elevated) / 0.7);
    border-radius: var(--ta-radius-sm);
  }
  .ta-toolchips-failed {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }

  .ta-toolchips-stats {
    display: inline-flex;
    flex-shrink: 0;
    gap: 0.375rem;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .ta-toolchips-added {
    color: rgb(var(--ta-success));
  }
  .ta-toolchips-removed {
    color: rgb(var(--ta-danger));
  }

  .ta-toolchips-card {
    margin: 0.25rem 0 0.375rem 1.0625rem;
  }

  .ta-toolchips-hidden {
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
    .ta-toolchips-header,
    button.ta-toolchips-chip {
      min-height: 2.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-toolchips-ring {
      animation: none;
      border-top-color: rgb(var(--ta-muted));
      border-style: dashed;
    }
    .ta-toolchips :global(.ta-toolchips-caret),
    .ta-toolchips :global(.ta-toolchips-more) {
      transition: none;
    }
  }
</style>
