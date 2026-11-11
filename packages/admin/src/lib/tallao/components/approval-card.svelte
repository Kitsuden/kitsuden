<!--
  tallao — ApprovalCard
  A human-in-the-loop request as one card: who asks, what will happen, exactly what changes,
  what could go wrong, and the decision.

    <ApprovalCard
      requester="Publisher agent"
      title="Publish “Patch 1.2 notes” on Valhalla"
      description="The post goes live now and the home page is rebuilt."
      changes={[{ field: "status", label: "Status", before: "In review", after: "Published" }]}
      risk="Visible to every visitor. It can be unpublished, but feeds may already have it."
      riskLevel="medium"
      onApprove={approve} onReject={reject} onEdit={openEditor} />

  - Body, in this order when given: `description`, the field changes (`changes`, a DiffView),
    the call (`tool` + `args`, as indented JSON), your own `children`, and the risk note with
    its level in words ("Medium risk": an icon and text, not only a colour).
  - Decision: Reject, "Edit first" (only with `onEdit`) and Approve. `onApprove` / `onReject`
    may be async: the pressed button shows busy, the others lock, and if it throws the card
    stays pending so it can be retried.
  - `status` is the caller's: "pending" (default), "approved", "rejected" or "expired". Once
    decided the buttons give way to an outcome line (`outcome`, or the status in words) and
    the card is quiet. The outcome is a polite status, announced once.
  - Keyboard, while focus is inside a pending card: Mod+Enter approves, Mod+Backspace rejects
    (shown next to the buttons with Kbd; `shortcuts={false}` turns both off). Nothing is
    listened for globally, so several cards on a page do not fight.
  - An `<article>` named by its title. Same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Button from "./button.svelte";
  import DiffView, { type DiffChange } from "./diff-view.svelte";
  import Icon from "./icon.svelte";
  import Kbd from "./kbd.svelte";

  type Status = "pending" | "approved" | "rejected" | "expired";

  interface Props {
    /** What will happen if approved, as one sentence. */
    title: string;
    /** Who asks (an agent, a person). */
    requester?: string;
    description?: string;
    /** The record's field changes. */
    changes?: DiffChange[];
    /** The tool the agent wants to call, and its arguments. */
    tool?: string;
    args?: Record<string, unknown>;
    /** What could go wrong, in a sentence. */
    risk?: string;
    riskLevel?: "low" | "medium" | "high";
    status?: Status;
    /** The line shown once decided ("Approved by Ana · 2 min ago"). */
    outcome?: string;
    /** Heading level of the title. */
    level?: 2 | 3 | 4 | 5 | 6;
    /** Mod+Enter and Mod+Backspace while focus is in the card, and their hints. */
    shortcuts?: boolean;
    approveLabel?: string;
    rejectLabel?: string;
    editLabel?: string;
    /** The eyebrow over the title ("Approval requested"). */
    requestLabel?: string;
    class?: string;
    onApprove?: () => void | Promise<void>;
    onReject?: () => void | Promise<void>;
    /** Shows "Edit first". */
    onEdit?: () => void;
    /** Your own content between the call and the risk note. */
    children?: Snippet;
    /** Any other attribute goes to the <article>. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    title,
    requester,
    description,
    changes,
    tool,
    args,
    risk,
    riskLevel = "medium",
    status = "pending",
    outcome,
    level = 3,
    shortcuts = true,
    approveLabel = L.approve,
    rejectLabel = L.reject,
    editLabel = L.editFirst,
    requestLabel = L.approvalRequested,
    class: className = "",
    onApprove,
    onReject,
    onEdit,
    children,
    ...rest
  }: Props = $props();

  const id = $props.id();
  let busy = $state<"approve" | "reject" | null>(null);
  const pending = $derived(status === "pending");
  const riskText = $derived(riskLevel === "high" ? L.riskHigh : riskLevel === "low" ? L.riskLow : L.riskMedium);
  const outcomeText = $derived(outcome ?? (status === "approved" ? L.approved : status === "rejected" ? L.rejected : status === "expired" ? L.expired : ""));

  async function decide(kind: "approve" | "reject") {
    const handler = kind === "approve" ? onApprove : onReject;
    if (!pending || busy || !handler) return;
    busy = kind;
    try {
      await handler();
    } catch {
      // The caller shows the error; the card stays pending to retry.
    } finally {
      busy = null;
    }
  }

  function onkeydown(event: KeyboardEvent) {
    if (!shortcuts || !pending || !(event.metaKey || event.ctrlKey)) return;
    // Not while typing in a field of the card's own content.
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "Enter" && onApprove) {
      event.preventDefault();
      decide("approve");
    } else if (event.key === "Backspace" && onReject) {
      event.preventDefault();
      decide("reject");
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
  {...rest}
  class={cn("ta-approval", `ta-approval--${status}`, className)}
  aria-labelledby={`${id}-title`}
  aria-busy={busy !== null}
  data-status={status}
  {onkeydown}
>
  <header class="ta-approval-head">
    <span class="ta-approval-badge" aria-hidden="true">
      <Icon name={status === "approved" ? "check" : status === "rejected" ? "x" : status === "expired" ? "clock" : "shield"} size={15} />
    </span>
    <div class="ta-approval-heading">
      <p class="ta-approval-eyebrow">{requestLabel}{#if requester}<span class="ta-approval-who">{requester}</span>{/if}</p>
      <svelte:element this={`h${level}`} class="ta-approval-title" id={`${id}-title`}>{title}</svelte:element>
    </div>
  </header>

  <div class="ta-approval-body">
    {#if description}<p class="ta-approval-text">{description}</p>{/if}
    {#if changes?.length}<DiffView {changes} />{/if}
    {#if tool}
      <div class="ta-approval-call">
        <code class="ta-approval-tool">{tool}</code>
        {#if args && Object.keys(args).length}<pre class="ta-approval-args">{JSON.stringify(args, null, 2)}</pre>{/if}
      </div>
    {/if}
    {@render children?.()}
    {#if risk}
      <p class={cn("ta-approval-risk", `ta-approval-risk--${riskLevel}`)}>
        <Icon name="alert" size={14} />
        <span><strong>{riskText}.</strong> {risk}</span>
      </p>
    {/if}
  </div>

  <footer class="ta-approval-foot">
    <p class={cn("ta-approval-outcome", !outcomeText || pending ? "ta-approval-outcome--empty" : "")} role="status">{pending ? "" : outcomeText}</p>
    {#if pending}
      <div class="ta-approval-actions">
        {#if onReject}
          <Button variant="ghost" size="sm" loading={busy === "reject"} disabled={busy !== null} onclick={() => decide("reject")}>
            {rejectLabel}{#if shortcuts}<Kbd keys={["Mod", "Backspace"]} size="sm" class="ta-approval-keys" />{/if}
          </Button>
        {/if}
        {#if onEdit}
          <Button variant="secondary" size="sm" disabled={busy !== null} onclick={onEdit}>{editLabel}</Button>
        {/if}
        {#if onApprove}
          <Button variant="primary" size="sm" loading={busy === "approve"} disabled={busy !== null} onclick={() => decide("approve")}>
            {approveLabel}{#if shortcuts}<Kbd keys={["Mod", "Enter"]} size="sm" class="ta-approval-keys ta-approval-keys--on-fill" />{/if}
          </Button>
        {/if}
      </div>
    {/if}
  </footer>
</article>

<style>
  .ta-approval {
    container-type: inline-size;
    min-width: 0;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    box-shadow: 0 1px 0 rgb(var(--ta-text) / 0.03) inset, 0 8px 24px -16px rgb(0 0 0 / 0.5);
    transition: border-color var(--ta-duration-base, 180ms), opacity var(--ta-duration-base, 180ms);
  }
  .ta-approval--pending { border-color: rgb(var(--ta-warning) / 0.45); }
  .ta-approval--approved { border-color: rgb(var(--ta-success) / 0.4); }
  .ta-approval--rejected,
  .ta-approval--expired { box-shadow: none; }

  .ta-approval-head { display: flex; align-items: flex-start; gap: 0.75rem; padding: 0.875rem 1rem 0; }
  .ta-approval-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.875rem;
    height: 1.875rem;
    color: rgb(var(--ta-warning));
    background: rgb(var(--ta-warning) / 0.12);
    border: 1px solid rgb(var(--ta-warning) / 0.3);
    border-radius: var(--ta-radius);
  }
  .ta-approval--approved .ta-approval-badge { color: rgb(var(--ta-success)); background: rgb(var(--ta-success) / 0.12); border-color: rgb(var(--ta-success) / 0.3); }
  .ta-approval--rejected .ta-approval-badge,
  .ta-approval--expired .ta-approval-badge { color: rgb(var(--ta-text-dim)); background: rgb(var(--ta-elevated)); border-color: rgb(var(--ta-border)); }

  .ta-approval-heading { min-width: 0; }
  .ta-approval-eyebrow {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    margin: 0;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }
  .ta-approval-who { font-weight: 500; letter-spacing: 0; text-transform: none; }
  .ta-approval-who::before { content: "·"; margin-right: 0.5rem; }
  .ta-approval-title { margin: 0.125rem 0 0; font-size: 0.9375rem; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .ta-approval--rejected .ta-approval-title,
  .ta-approval--expired .ta-approval-title { color: rgb(var(--ta-text-dim)); }

  .ta-approval-body { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem 1rem 0; }
  .ta-approval-text { margin: 0; font-size: 0.875rem; color: rgb(var(--ta-text-dim)); }

  .ta-approval-call { min-width: 0; border: 1px solid rgb(var(--ta-border)); border-radius: var(--ta-radius); overflow: hidden; }
  .ta-approval-tool {
    display: block;
    padding: 0.375rem 0.75rem;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    background: rgb(var(--ta-elevated) / 0.4);
  }
  .ta-approval-args {
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: rgb(var(--ta-text-dim));
    border-top: 1px solid rgb(var(--ta-border));
  }

  .ta-approval-risk {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-warning) / 0.07);
    border-radius: var(--ta-radius);
  }
  .ta-approval-risk :global(svg) { flex-shrink: 0; margin-top: 0.125rem; color: rgb(var(--ta-warning)); }
  .ta-approval-risk strong { font-weight: 600; color: rgb(var(--ta-text)); }
  .ta-approval-risk--high { background: rgb(var(--ta-danger) / 0.08); }
  .ta-approval-risk--high :global(svg) { color: rgb(var(--ta-danger)); }
  .ta-approval-risk--low { background: rgb(var(--ta-elevated) / 0.5); }
  .ta-approval-risk--low :global(svg) { color: rgb(var(--ta-text-dim)); }

  .ta-approval-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    margin-top: 0.875rem;
    padding: 0.625rem 1rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  .ta-approval-outcome { margin: 0; font-size: 0.8125rem; font-weight: 500; color: rgb(var(--ta-text-dim)); }
  .ta-approval--approved .ta-approval-outcome { color: rgb(var(--ta-text)); }
  .ta-approval-outcome--empty { display: none; }
  .ta-approval-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin-left: auto; }
  .ta-approval :global(.ta-approval-keys) { margin-left: 0.125rem; opacity: 0.85; }
  .ta-approval :global(.ta-approval-keys--on-fill .ta-kbd-key) { color: rgb(var(--ta-on-accent)); background: rgb(var(--ta-on-accent) / 0.16); border-color: rgb(var(--ta-on-accent) / 0.3); }
  .ta-approval :global(.ta-approval-keys--on-fill .ta-kbd-sep) { color: rgb(var(--ta-on-accent) / 0.8); }

  /* A narrow card (a phone, a side panel): the buttons share the row, the hints go. */
  @container (max-width: 26rem) {
    .ta-approval-actions { width: 100%; }
    .ta-approval-actions > :global(.ta-btn) { flex: 1 1 auto; }
    .ta-approval :global(.ta-approval-keys) { display: none; }
  }
  /* A touch screen has no Mod key. */
  @media (pointer: coarse) {
    .ta-approval :global(.ta-approval-keys) { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-approval { transition: none; }
  }
</style>
