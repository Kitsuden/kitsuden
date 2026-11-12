<!--
  tallao — ToolCallCard
  Card that shows an agent's tool call: name, arguments, result and — if it
  is pending — approve/reject actions.
  Inspired by the ProposalInbox and ChatInterface of the Kitsuden admin.
-->
<script lang="ts">
  import { useLabels, type Labels } from "../i18n";
  import { cn } from "../utils";

  import Badge from "./badge.svelte";
  import Button from "./button.svelte";

  type Status = "pending" | "executing" | "executed" | "rejected" | "failed";
  type LabelKey =
    | "approve"
    | "reject"
    | "pending"
    | "running"
    | "done"
    | "rejected"
    | "failed"
    | "arguments"
    | "result";

  interface Props {
    /** Name of the tool (e.g. "publish_post"). */
    name: string;
    /** Arguments of the call; shown as JSON. */
    args?: Record<string, unknown>;
    /** Result of the execution, if any. */
    result?: string;
    status?: Status;
    /** When pending: decision buttons. */
    onApprove?: () => void;
    onReject?: () => void;
    /** This card's own texts; the rest come from setLabels (English by default). */
    labels?: Partial<Pick<Labels, LabelKey>>;
    class?: string;
  }

  const L = useLabels();
  const {
    name,
    args = {},
    result,
    status = "pending",
    onApprove,
    onReject,
    labels = {},
    class: className = "",
  }: Props = $props();

  const T = $derived({ ...L, ...labels });

  const statusBadge: Record<
    Status,
    { variant: "warning" | "info" | "success" | "default" | "error"; text: LabelKey }
  > = {
    pending: { variant: "warning", text: "pending" },
    executing: { variant: "info", text: "running" },
    executed: { variant: "success", text: "done" },
    rejected: { variant: "default", text: "rejected" },
    failed: { variant: "error", text: "failed" },
  };

  let argsOpen = $state(false);
  const argsJson = $derived(JSON.stringify(args, null, 2));
  const argsLong = $derived(argsJson.length > 120);
</script>

<div class={cn("ta-toolcall", `ta-toolcall--${status}`, className)}>
  <div class="ta-toolcall-header">
    <span class="ta-toolcall-icon" aria-hidden="true">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><path
          d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
        /></svg
      >
    </span>
    <span class="ta-toolcall-name">{name}</span>
    <Badge variant={statusBadge[status].variant}>{T[statusBadge[status].text]}</Badge>
  </div>

  {#if Object.keys(args).length > 0}
    <div class="ta-toolcall-block">
      <button
        type="button"
        class="ta-toolcall-collapsible"
        onclick={() => (argsOpen = !argsOpen)}
        aria-expanded={argsOpen}
      >
        {T.arguments}
        {#if argsLong}
          <span class="ta-toolcall-more">{argsOpen ? "▾" : "▸"}</span>
        {/if}
      </button>
      <pre
        class="ta-toolcall-json"
        class:ta-toolcall-json--collapsed={!argsOpen && argsLong}>{argsJson}</pre>
    </div>
  {/if}

  {#if result}
    <div class="ta-toolcall-block">
      <span class="ta-toolcall-label">{T.result}</span>
      <p class="ta-toolcall-result">{result}</p>
    </div>
  {/if}

  {#if status === "pending" && (onApprove || onReject)}
    <div class="ta-toolcall-actions">
      {#if onReject}
        <Button variant="ghost" size="sm" onclick={onReject}>{T.reject}</Button>
      {/if}
      {#if onApprove}
        <Button variant="primary" size="sm" onclick={onApprove}>{T.approve}</Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ta-toolcall {
    background: rgb(var(--ta-bg) / 0.6);
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    padding: 0.75rem;
    font-size: 0.8125rem;
  }

  .ta-toolcall--executing {
    border-color: rgb(var(--ta-info) / 0.4);
  }

  .ta-toolcall-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .ta-toolcall-icon {
    display: flex;
    padding: 0.375rem;
    border-radius: var(--ta-radius-sm);
    background: rgb(var(--ta-accent) / 0.1);
    color: rgb(var(--ta-accent-hover));
  }

  .ta-toolcall-name {
    font-weight: 600;
    font-family: var(--ta-font-mono);
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
  }

  .ta-toolcall-header :global(.ta-badge) {
    margin-left: auto;
  }

  .ta-toolcall-block {
    margin-top: 0.625rem;
  }

  .ta-toolcall-label,
  .ta-toolcall-collapsible {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .ta-toolcall-json {
    margin: 0.375rem 0 0;
    padding: 0.5rem 0.625rem;
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-sm);
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ta-toolcall-json--collapsed {
    max-height: 2.75rem;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black 50%, transparent);
  }

  .ta-toolcall-result {
    margin: 0.25rem 0 0;
    color: rgb(var(--ta-text-dim));
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ta-toolcall-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.625rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  @media (pointer: coarse) {
    .ta-toolcall-collapsible {
      position: relative;
    }
    .ta-toolcall-collapsible::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 2.75rem);
      height: max(100%, 2.75rem);
      transform: translate(-50%, -50%);
    }
  }
</style>
