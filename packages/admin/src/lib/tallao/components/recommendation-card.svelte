<!--
  tallao — RecommendationCard
  A suggestion from the model that the user can take or leave: what it proposes, why, how
  sure it is, and one primary action.

    <RecommendationCard
      title="Feature “Patch 1.2 notes” on the home page"
      description="It is the most read post of the week and the slot is free until Friday."
      reasons={["9,810 views in 7 days, 3× the average", "No featured post since Monday"]}
      confidence="high"
      actionLabel="Feature it" onAction={feature}
      secondaryLabel="Alternatives" onSecondary={more}
      onDismiss={hide} />

  - `reasons` is a short list under a "Why" heading: a recommendation without its reasons is
    an order. `children` adds anything else (a preview, a figure).
  - `confidence` ("low", "medium", "high") draws three bars and says it in words: the bars are
    decorative, the text is what is read.
  - The primary action is a button (`onAction`) or a link (`actionHref`); it may be async and
    shows busy while it runs. `secondaryLabel` + `onSecondary` adds a quiet second button and
    `onDismiss` a close button in the corner.
  - An `<article>` named by its title (`level`, h3 by default). Same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Button from "./button.svelte";
  import Icon from "./icon.svelte";

  interface Props {
    title: string;
    description?: string;
    /** Why it is suggested, one line each. */
    reasons?: string[];
    confidence?: "low" | "medium" | "high";
    level?: 2 | 3 | 4 | 5 | 6;
    actionLabel?: string;
    onAction?: () => void | Promise<void>;
    actionHref?: string;
    secondaryLabel?: string;
    onSecondary?: () => void;
    /** Shows a close button. */
    onDismiss?: () => void;
    dismissLabel?: string;
    /** Heading of the reasons ("Why"). */
    reasonsLabel?: string;
    class?: string;
    children?: Snippet;
    /** Any other attribute goes to the <article>. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    title,
    description,
    reasons = [],
    confidence,
    level = 3,
    actionLabel,
    onAction,
    actionHref,
    secondaryLabel,
    onSecondary,
    onDismiss,
    dismissLabel = L.dismiss,
    reasonsLabel = L.reasons,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const id = $props.id();
  let busy = $state(false);
  const bars = $derived(confidence === "high" ? 3 : confidence === "medium" ? 2 : 1);
  const confidenceText = $derived(
    confidence === "high"
      ? L.confidenceHigh
      : confidence === "medium"
        ? L.confidenceMedium
        : L.confidenceLow
  );

  async function act() {
    if (busy || !onAction) return;
    busy = true;
    try {
      await onAction();
    } catch {
      // The caller shows the error; the card stays so the action can be retried.
    } finally {
      busy = false;
    }
  }
</script>

<article {...rest} class={cn("ta-reco", className)} aria-labelledby={`${id}-title`}>
  <div class="ta-reco-head">
    <span class="ta-reco-mark" aria-hidden="true"><Icon name="sparkle" size={14} /></span>
    <svelte:element this={`h${level}`} class="ta-reco-title" id={`${id}-title`}
      >{title}</svelte:element
    >
    {#if onDismiss}
      <button type="button" class="ta-reco-close" aria-label={dismissLabel} onclick={onDismiss}
        ><Icon name="x" size={14} /></button
      >
    {/if}
  </div>
  {#if description}<p class="ta-reco-text">{description}</p>{/if}
  {#if reasons.length}
    <div class="ta-reco-reasons">
      <p class="ta-reco-label" id={`${id}-why`}>{reasonsLabel}</p>
      <ul aria-labelledby={`${id}-why`}>
        {#each reasons as reason, i (i)}<li>{reason}</li>{/each}
      </ul>
    </div>
  {/if}
  {@render children?.()}
  {#if confidence || actionLabel || secondaryLabel}
    <div class="ta-reco-foot">
      {#if confidence}
        <span class={cn("ta-reco-confidence", `ta-reco-confidence--${confidence}`)}>
          <span class="ta-reco-bars" aria-hidden="true">
            {#each [1, 2, 3] as n (n)}<span
                class={cn("ta-reco-bar", n <= bars && "ta-reco-bar--on")}
              ></span>{/each}
          </span>
          {confidenceText}
        </span>
      {/if}
      <span class="ta-reco-actions">
        {#if secondaryLabel && onSecondary}<Button variant="ghost" size="sm" onclick={onSecondary}
            >{secondaryLabel}</Button
          >{/if}
        {#if actionLabel && (onAction || actionHref)}
          <Button
            variant="primary"
            size="sm"
            href={actionHref}
            loading={busy}
            onclick={actionHref ? undefined : act}>{actionLabel}</Button
          >
        {/if}
      </span>
    </div>
  {/if}
</article>

<style>
  .ta-reco {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.875rem 1rem;
    color: rgb(var(--ta-text));
    background:
      linear-gradient(180deg, rgb(var(--ta-accent) / 0.06), transparent 4.5rem),
      rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }

  .ta-reco-head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .ta-reco-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    color: color-mix(in srgb, rgb(var(--ta-accent)) 70%, rgb(var(--ta-text)));
  }
  .ta-reco-title {
    flex: 1 1 auto;
    margin: 0;
    min-width: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .ta-reco-close {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    margin: -0.125rem -0.25rem 0 0;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-reco-close:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
  }
  .ta-reco-close:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }

  .ta-reco-text {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: rgb(var(--ta-text-dim));
  }

  .ta-reco-label {
    margin: 0 0 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--ta-text-dim));
  }
  .ta-reco-reasons ul {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }
  .ta-reco-reasons li {
    position: relative;
    padding-left: 0.875rem;
    line-height: 1.45;
  }
  .ta-reco-reasons li::before {
    content: "";
    position: absolute;
    left: 0.125rem;
    top: 0.5em;
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 50%;
    background: rgb(var(--ta-accent) / 0.7);
  }

  .ta-reco-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    margin-top: 0.25rem;
  }
  .ta-reco-confidence {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-reco-bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 0.75rem;
  }
  .ta-reco-bar {
    width: 3px;
    border-radius: 1px;
    background: rgb(var(--ta-muted));
  }
  .ta-reco-bar:nth-child(1) {
    height: 45%;
  }
  .ta-reco-bar:nth-child(2) {
    height: 72%;
  }
  .ta-reco-bar:nth-child(3) {
    height: 100%;
  }
  .ta-reco-confidence--high .ta-reco-bar--on {
    background: rgb(var(--ta-success));
  }
  .ta-reco-confidence--medium .ta-reco-bar--on {
    background: rgb(var(--ta-warning));
  }
  .ta-reco-confidence--low .ta-reco-bar--on {
    background: rgb(var(--ta-text-dim));
  }
  .ta-reco-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  @media (pointer: coarse) {
    .ta-reco-close::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 2.75rem;
      height: 2.75rem;
      transform: translate(-50%, -50%);
    }
  }
</style>
