<!--
  tallao — ContextCards
  What the model was given to work with (files, records, links, pasted text) as small cards:
  a type icon, the name, a quiet note (size, row count) and, when the user may take it away,
  a remove button.

    <ContextCards onRemove={drop} items={[
      { id: "1", title: "brief.md", type: "file", meta: "4.2 KB" },
      { id: "2", title: "Post #42", type: "record", meta: "posts", href: "/admin/posts/42" },
      { id: "3", title: "Patch notes 1.2", type: "link", meta: "valhalla.gg" },
    ]} />

  - A list (`<ul>`) with an accessible name (`label`, "Context"). A card with `href` is a
    link; `excerpt` adds two quiet lines of the content under the name.
  - `onRemove` shows a button per card named "Remove brief.md"; after removing, focus moves
    to the next card's button (or the previous one), so a keyboard user is not dropped.
  - `type` picks the icon ("file", "record", "link", "image", "text"); `icon` on an item
    overrides it with any kit icon. The type is also read as hidden text.
  - `layout="row"` (default) wraps the cards; `"stack"` puts one per line at full width.
    Same HTML on the server.
-->
<script lang="ts" module>
  import type { IconName } from "./icon.svelte";

  export interface ContextItem {
    id: string;
    title: string;
    type?: "file" | "record" | "link" | "image" | "text";
    /** A quiet note after the name: a size, a count, a domain. */
    meta?: string;
    /** A couple of lines of the content. */
    excerpt?: string;
    href?: string;
    /** A kit icon instead of the one of its type. */
    icon?: IconName;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Icon from "./icon.svelte";

  interface Props {
    items: ContextItem[];
    /** Accessible name of the list. */
    label?: string;
    layout?: "row" | "stack";
    /** Name of the remove button; "{item}" is replaced by the card's title. */
    removeLabel?: string;
    class?: string;
    /** Shows a remove button on every card. */
    onRemove?: (item: ContextItem) => void;
    /** Any other attribute goes to the <ul>. */
    [key: string]: unknown;
  }

  const L = useLabels();
  const {
    items,
    label = L.context,
    layout = "row",
    removeLabel = L.removeItem,
    class: className = "",
    onRemove,
    ...rest
  }: Props = $props();

  const ICON: Record<NonNullable<ContextItem["type"]>, IconName> = {
    file: "file",
    record: "database",
    link: "link",
    image: "image",
    text: "text",
  };
  let list: HTMLElement | undefined = $state();

  async function remove(item: ContextItem, index: number) {
    onRemove?.(item);
    await tick();
    const buttons = list?.querySelectorAll<HTMLElement>(".ta-context-remove");
    buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)]?.focus();
  }
</script>

<ul
  {...rest}
  bind:this={list}
  class={cn("ta-context", `ta-context--${layout}`, className)}
  aria-label={label}
>
  {#each items as item, i (item.id)}
    <li class="ta-context-card">
      <span class="ta-context-icon" aria-hidden="true"
        ><Icon name={item.icon ?? ICON[item.type ?? "file"]} size={14} /></span
      >
      <span class="ta-context-main">
        <span class="ta-context-line">
          {#if item.href}
            <a class="ta-context-title" href={item.href}>{item.title}</a>
          {:else}
            <span class="ta-context-title">{item.title}</span>
          {/if}
          {#if item.meta}<span class="ta-context-meta">{item.meta}</span>{/if}
        </span>
        {#if item.excerpt}<span class="ta-context-excerpt">{item.excerpt}</span>{/if}
      </span>
      {#if onRemove}
        <button
          type="button"
          class="ta-context-remove"
          aria-label={removeLabel.replace("{item}", item.title)}
          onclick={() => remove(item, i)}
        >
          <Icon name="x" size={12} />
        </button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .ta-context {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .ta-context--stack {
    flex-direction: column;
    flex-wrap: nowrap;
  }

  .ta-context-card {
    display: inline-flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
    max-width: min(100%, 20rem);
    padding: 0.375rem 0.375rem 0.375rem 0.5rem;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-surface));
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius);
    transition: border-color var(--ta-duration-fast, 120ms);
  }
  .ta-context-card:hover {
    border-color: rgb(var(--ta-muted));
  }
  .ta-context--stack .ta-context-card {
    display: flex;
    max-width: 100%;
  }

  .ta-context-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    color: rgb(var(--ta-text-dim));
    background: rgb(var(--ta-elevated) / 0.8);
    border-radius: var(--ta-radius-sm);
  }

  .ta-context-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .ta-context-line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    min-height: 1.375rem;
  }
  .ta-context-title {
    position: relative;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: inherit;
    text-decoration: none;
    border-radius: var(--ta-radius-sm);
  }
  a.ta-context-title:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  a.ta-context-title:focus-visible,
  .ta-context-remove:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 1px;
  }
  .ta-context-meta {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    font-variant-numeric: tabular-nums;
  }
  .ta-context-excerpt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 0.75rem;
    line-height: 1.45;
    color: rgb(var(--ta-text-dim));
  }

  .ta-context-remove {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    color: rgb(var(--ta-text-dim));
    background: none;
    border: none;
    border-radius: var(--ta-radius-sm);
    cursor: pointer;
  }
  .ta-context-remove:hover {
    color: rgb(var(--ta-text));
    background: rgb(var(--ta-elevated));
  }

  /* The hit areas grow to 44px without changing the card. */
  @media (pointer: coarse) {
    .ta-context-card {
      padding-top: 0.625rem;
      padding-bottom: 0.625rem;
    }
    .ta-context-remove::after,
    a.ta-context-title::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 2.75rem);
      height: 2.75rem;
      transform: translate(-50%, -50%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-context-card {
      transition: none;
    }
  }
</style>
