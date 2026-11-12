<!--
  tallao — InsightCard
  Something the model noticed in the data, said in a sentence and backed by the figure: a
  headline, the number with its change and trend (a KpiCard, without its frame), a line of
  explanation and an optional action.

    <InsightCard
      title="Kaela's pick rate doubled after patch 1.1"
      label="Pick rate" value={18.4} unit="%" delta={9.1} deltaLabel="vs patch 1.0"
      trend={[9, 9.3, 9.1, 14.2, 17.8, 18.4]}
      text="The dash reset on takedown made her the default opener in ranked."
      actionLabel="Open the matchup table" actionHref="/meta/kaela" />

  - The figure is the kit's KpiCard: the change has a direction (▲ ▼ and words) and a meaning
    (`goodWhen="down"` when falling is good) that are never colour alone, and the sparkline is
    an image named with the trend in words.
  - `tone` tints the mark: "info" (default), "positive", "warning", "negative". The tone is
    decoration; what happened is in the sentence.
  - The action is a link (`actionHref`) or a button (`onAction`). An `<article>` named by its
    title (`level`, h3 by default). Plain JSON in, same HTML on the server.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  import { cn } from "../utils";

  import Button from "./button.svelte";
  import Icon from "./icon.svelte";
  import KpiCard from "./kpi-card.svelte";

  interface Props {
    /** The insight as one sentence. */
    title: string;
    /** What the figure measures ("Pick rate"). */
    label?: string;
    value?: number | string;
    unit?: string;
    delta?: number | null;
    deltaLabel?: string;
    goodWhen?: "up" | "down" | "none";
    /** Recent values, oldest first. */
    trend?: number[];
    /** A line of explanation under the figure. */
    text?: string;
    tone?: "info" | "positive" | "warning" | "negative";
    level?: 2 | 3 | 4 | 5 | 6;
    locale?: string;
    format?: (n: number) => string;
    deltaFormat?: (n: number) => string;
    actionLabel?: string;
    actionHref?: string;
    onAction?: () => void;
    class?: string;
    children?: Snippet;
    /** Any other attribute goes to the <article>. */
    [key: string]: unknown;
  }

  const {
    title,
    label,
    value,
    unit,
    delta,
    deltaLabel,
    goodWhen = "none",
    trend,
    text,
    tone = "info",
    level = 3,
    locale,
    format,
    deltaFormat,
    actionLabel,
    actionHref,
    onAction,
    class: className = "",
    children,
    ...rest
  }: Props = $props();

  const id = $props.id();
</script>

<article
  {...rest}
  class={cn("ta-insight", `ta-insight--${tone}`, className)}
  aria-labelledby={`${id}-title`}
>
  <div class="ta-insight-head">
    <span class="ta-insight-mark" aria-hidden="true"
      ><Icon
        name={tone === "warning" || tone === "negative" ? "alert" : "sparkle"}
        size={14}
      /></span
    >
    <svelte:element this={`h${level}`} class="ta-insight-title" id={`${id}-title`}
      >{title}</svelte:element
    >
  </div>
  {#if label && value !== undefined}
    <KpiCard
      {label}
      {value}
      {unit}
      {delta}
      {deltaLabel}
      {goodWhen}
      {trend}
      {locale}
      {format}
      {deltaFormat}
      class="ta-insight-figure"
    />
  {/if}
  {#if text}<p class="ta-insight-text">{text}</p>{/if}
  {@render children?.()}
  {#if actionLabel && (actionHref || onAction)}
    <div class="ta-insight-foot">
      <Button
        variant="ghost"
        size="sm"
        href={actionHref}
        onclick={onAction}
        class="ta-insight-action">{actionLabel}<Icon name="arrow-right" size={13} /></Button
      >
    </div>
  {/if}
</article>

<style>
  .ta-insight {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    min-width: 0;
    padding: 0.875rem 1rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }

  .ta-insight-head {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .ta-insight-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    color: rgb(var(--ta-info));
    background: rgb(var(--ta-info) / 0.12);
    border-radius: var(--ta-radius-sm);
  }
  .ta-insight--positive .ta-insight-mark {
    color: rgb(var(--ta-success));
    background: rgb(var(--ta-success) / 0.12);
  }
  .ta-insight--warning .ta-insight-mark {
    color: rgb(var(--ta-warning));
    background: rgb(var(--ta-warning) / 0.12);
  }
  .ta-insight--negative .ta-insight-mark {
    color: rgb(var(--ta-danger));
    background: rgb(var(--ta-danger) / 0.12);
  }

  .ta-insight-title {
    margin: 0;
    min-width: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .ta-insight-text {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgb(var(--ta-text-dim));
  }

  /* The KpiCard without its own frame: this card is the frame. */
  .ta-insight :global(.ta-insight-figure) {
    padding: 0;
    background: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }

  .ta-insight-foot {
    margin: 0 -0.5rem -0.25rem;
  }
  .ta-insight :global(.ta-insight-action) {
    color: color-mix(in srgb, rgb(var(--ta-accent)) 65%, rgb(var(--ta-text)));
  }
</style>
