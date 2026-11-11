<!--
  The header of a view bundled in the panel (Media, Blog, Games…).

  Such a view is mounted in two ways by GrimoirePage: alone, as the whole page of its kon
  (then it needs the page template, `<Page>`, with its title as the only h1), or as one tab
  of a kon whose `<Page>` GrimoirePage has already drawn (then a second header would be a
  second h1 and a second left edge). This component looks at where it is and draws the
  right one: the full `<Page>`, or just the description and the actions in a quiet row.
-->
<script lang="ts">
  import { hasContext, type Snippet } from "svelte";

  import Page from "$lib/components/layout/Page.svelte";
  import type { Crumb } from "$lib/nav";

  interface Props {
    title: string;
    description?: string;
    crumbs?: Crumb[];
    status?: Snippet;
    meta?: Snippet;
    actions?: Snippet;
    tabs?: Snippet;
    children?: Snippet;
  }

  const { title, description, crumbs, status, meta, actions, tabs, children }: Props = $props();

  /** Set by `<Page>` for everything it contains. */
  const nested = hasContext("kitsuden-page");
</script>

{#if nested}
  <div class="kitsuden-view" data-testid="view-page">
    {#if description || meta || actions || status}
      <div class="kitsuden-view-bar">
        <div class="kitsuden-view-text">
          {#if description}<p>{description}</p>{/if}
          {#if meta || status}
            <p class="kitsuden-view-meta">{@render status?.()}{@render meta?.()}</p>
          {/if}
        </div>
        {#if actions}<div class="kitsuden-view-actions">{@render actions()}</div>{/if}
      </div>
    {/if}
    {@render tabs?.()}
    {@render children?.()}
  </div>
{:else}
  <Page {title} {description} {crumbs} {status} {meta} {actions} {tabs}>
    {@render children?.()}
  </Page>
{/if}

<style>
  .kitsuden-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .kitsuden-view-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .kitsuden-view-text {
    min-width: 0;
    font-size: 0.875rem;
    color: rgb(var(--ta-text-dim));
  }
  .kitsuden-view-text p {
    margin: 0;
  }
  .kitsuden-view-meta {
    font-size: 0.8125rem;
  }
  .kitsuden-view-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
</style>
