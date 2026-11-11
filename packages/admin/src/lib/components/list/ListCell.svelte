<!--
  A cell of the list template, drawn by the kind of its field: yes/no as a badge, a choice
  as a badge, a date in the reader's locale, a relation by the related record's name, an
  image as a thumbnail, JSON as a short code sample. Empty is a dash, never a blank.
-->
<script lang="ts">
  import { localeFormat, t } from "$lib/i18n";
  import type { ListField } from "$lib/list/model-filters";
  import { Badge } from "$lib/tallao";

  const {
    field,
    value,
    title = false,
  }: { field: ListField; value: unknown; title?: boolean } = $props();

  const empty = $derived(value === null || value === undefined || value === "");

  const date = $derived.by(() => {
    if (field.kind !== "date" && field.kind !== "datetime") return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    return {
      iso: d.toISOString(),
      text: new Intl.DateTimeFormat(localeFormat(), {
        dateStyle: "medium",
        ...(field.kind === "datetime" ? { timeStyle: "short" } : {}),
      }).format(d),
    };
  });

  const option = $derived(field.options?.find((o) => o.value === String(value))?.label);

  /** A status-like choice gets the tone people expect; anything else stays neutral. */
  const tone = $derived.by(() => {
    const v = String(value).toLowerCase();
    if (/^(published|active|approved|done|completed|success|enabled|paid)$/.test(v))
      return "success";
    if (/^(draft|pending|scheduled|in_review|review|open)$/.test(v)) return "warning";
    if (/^(archived|rejected|failed|error|cancelled|canceled|disabled|revoked)$/.test(v))
      return "error";
    return "default";
  });

  const short = (text: string, max = 80) =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

  /** Only http(s) or same-origin paths become an <img>: a `javascript:` value stays text. */
  const imageSrc = $derived(
    typeof value === "string" &&
      (/^https?:\/\//i.test(value) || (value.startsWith("/") && !value.startsWith("//")))
      ? value
      : null
  );
</script>

{#if empty}
  <span class="kitsuden-cell-empty" aria-label={t("list.emptyValue")}>—</span>
{:else if field.kind === "boolean"}
  <Badge variant={value === true || value === "true" ? "success" : "default"} size="sm">
    {value === true || value === "true" ? t("common.yes") : t("common.no")}
  </Badge>
{:else if date}
  <time datetime={date.iso}>{date.text}</time>
{:else if field.kind === "select"}
  <Badge variant={tone} size="sm">{option ?? String(value)}</Badge>
{:else if field.kind === "multiselect" && Array.isArray(value)}
  <span class="kitsuden-cell-tags">
    {#each value.slice(0, 3) as item}<Badge size="sm">{String(item)}</Badge>{/each}
    {#if value.length > 3}<span class="kitsuden-cell-more">+{value.length - 3}</span>{/if}
  </span>
{:else if field.kind === "relation"}
  {#if option}{option}{:else}<code class="kitsuden-cell-code">{short(String(value), 12)}</code>{/if}
{:else if field.kind === "image" && imageSrc}
  <img class="kitsuden-cell-image" src={imageSrc} alt="" loading="lazy" />
{:else if field.kind === "number" && typeof value === "number"}
  {value.toLocaleString(localeFormat())}
{:else if typeof value === "object"}
  <code class="kitsuden-cell-code">{short(JSON.stringify(value), 60)}</code>
{:else if field.kind === "id"}
  <code class="kitsuden-cell-code">{short(String(value), 12)}</code>
{:else}
  <span class:kitsuden-cell-title={title}>{short(String(value), title ? 120 : 80)}</span>
{/if}

<style>
  .kitsuden-cell-empty,
  .kitsuden-cell-more {
    color: rgb(var(--ta-text-dim));
  }
  .kitsuden-cell-title {
    display: inline-block;
    min-width: 9rem;
    max-width: 28rem;
    font-weight: 500;
    white-space: normal;
    vertical-align: middle;
  }
  .kitsuden-cell-tags {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
  }
  .kitsuden-cell-more {
    font-size: 0.75rem;
  }
  .kitsuden-cell-image {
    display: block;
    width: 2rem;
    height: 2rem;
    object-fit: cover;
    border-radius: var(--ta-radius-sm);
  }
  .kitsuden-cell-code {
    font-family: var(--ta-font-mono);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
</style>
