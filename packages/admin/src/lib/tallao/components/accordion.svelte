<!--
  tallao — Accordion
  Collapsible sections on native <details>/<summary>: keyboard, screen
  reader, browser find (Ctrl+F opens the section that contains the text)
  and SSR without JavaScript. With `single`, opening one closes the others
  (shared `name` attribute, the browser's "exclusive accordion").

    <Accordion single items={[{ id: "a", title: "What is it?", content: text }]} />
  or with custom content:
    <Accordion items={items}>{#snippet item(it)}…{/snippet}</Accordion>
-->
<script lang="ts" module>
  export interface AccordionItem {
    id: string;
    title: string;
    /** Section text; for custom content, the `item` snippet. */
    content?: string;
    open?: boolean;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import { cn } from "../utils";

  const {
    items,
    single = false,
    class: className = "",
    item,
  }: {
    items: AccordionItem[];
    single?: boolean;
    class?: string;
    item?: import("svelte").Snippet<[AccordionItem]>;
  } = $props();

  const id = $props.id();
</script>

<div class={cn("ta-accordion", className)}>
  {#each items as it (it.id)}
    <details
      class="ta-accordion-section"
      name={single ? `ta-accordion-${id}` : undefined}
      open={it.open}
      aria-disabled={it.disabled ? "true" : undefined}
      ontoggle={(e) => {
        // A disabled section does not open (details has no `disabled`).
        if (it.disabled && (e.currentTarget as HTMLDetailsElement).open)
          (e.currentTarget as HTMLDetailsElement).open = false;
      }}
    >
      <summary class="ta-accordion-title" tabindex={it.disabled ? -1 : undefined}>
        <span>{it.title}</span>
        <svg
          class="ta-accordion-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg
        >
      </summary>
      <div class="ta-accordion-content">
        {#if item}{@render item(it)}{:else}{it.content}{/if}
      </div>
    </details>
  {/each}
</div>

<style>
  .ta-accordion {
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
    overflow: hidden;
  }

  .ta-accordion-section + .ta-accordion-section {
    border-top: 1px solid rgb(var(--ta-border));
  }

  .ta-accordion-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: rgb(var(--ta-text));
    cursor: pointer;
    list-style: none;
  }
  .ta-accordion-title::-webkit-details-marker {
    display: none;
  }
  .ta-accordion-title:hover {
    background: rgb(var(--ta-elevated) / 0.4);
  }
  .ta-accordion-title:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: -2px;
  }

  .ta-accordion-chevron {
    flex-shrink: 0;
    color: rgb(var(--ta-text-dim));
    transition: transform var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }
  details[open] > .ta-accordion-title .ta-accordion-chevron {
    transform: rotate(180deg);
  }

  .ta-accordion-content {
    padding: 0 1rem 0.875rem;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }

  /* An opened section's content settles in; closing is the browser's (instant). */
  details[open] > .ta-accordion-content {
    animation: ta-accordion-open var(--ta-duration-base, 180ms) var(--ta-ease-out, ease-out);
  }
  @keyframes ta-accordion-open {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  details[aria-disabled="true"] > .ta-accordion-title {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .ta-accordion-chevron {
      transition: none;
    }
    details[open] > .ta-accordion-content {
      animation: none;
    }
  }

  /* On touch screens: a 44px header for the finger. */
  @media (pointer: coarse) {
    .ta-accordion-title {
      min-height: 2.75rem;
    }
  }
</style>
