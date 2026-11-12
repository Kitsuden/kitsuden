<!--
  tallao — Breadcrumb
  Where you are within the site: a named <nav> with an ordered list of links;
  the last one is the current page (aria-current="page", no link). The
  separators are decorative (aria-hidden).
-->
<script lang="ts" module>
  export interface BreadcrumbItem {
    label: string;
    href?: string;
  }
</script>

<script lang="ts">
  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  const L = useLabels();
  const {
    items,
    ariaLabel = L.breadcrumb,
    separator = "/",
    class: className = "",
  }: { items: BreadcrumbItem[]; ariaLabel?: string; separator?: string; class?: string } = $props();
</script>

<nav class={cn("ta-breadcrumb", className)} aria-label={ariaLabel}>
  <ol>
    {#each items as it, i (i)}
      {@const isLast = i === items.length - 1}
      <li>
        {#if isLast || !it.href}
          <span aria-current={isLast ? "page" : undefined} class:ta-breadcrumb-current={isLast}
            >{it.label}</span
          >
        {:else}
          <a href={it.href}>{it.label}</a>
        {/if}
        {#if !isLast}<span class="ta-breadcrumb-sep" aria-hidden="true">{separator}</span>{/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .ta-breadcrumb ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }
  .ta-breadcrumb li {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-breadcrumb a {
    color: rgb(var(--ta-text-dim));
    text-decoration: none;
    border-radius: var(--ta-radius-sm);
  }
  .ta-breadcrumb a:hover {
    color: rgb(var(--ta-text));
    text-decoration: underline;
  }
  .ta-breadcrumb a:focus-visible {
    outline: 2px solid rgb(var(--ta-accent) / 0.6);
    outline-offset: 2px;
  }
  .ta-breadcrumb-current {
    color: rgb(var(--ta-text));
    font-weight: 500;
  }
  .ta-breadcrumb-sep {
    opacity: 0.6;
  }

  /* On touch screens: 44px-tall links for the finger. */
  @media (pointer: coarse) {
    .ta-breadcrumb a {
      display: inline-flex;
      align-items: center;
      min-height: 2.75rem;
    }
  }
</style>
