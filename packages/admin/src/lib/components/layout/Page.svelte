<!--
  The page template: tallao's PageHeader at the top of every route, so the left edge, the
  title size and where the actions sit are the same everywhere.

    <Page title="Players" crumbs={[{ label: "Players" }]} description="…">
      {#snippet meta()}128 entries{/snippet}
      {#snippet actions()}<Button>New entry</Button>{/snippet}
      …the page…
    </Page>

  `crumbs` is what this page adds to the breadcrumb AFTER its section (the sidebar entry it
  belongs to): nothing for a section's own page, the dataset and the record for a detail
  page. The shell draws the trail and `<title>` from it (see `$lib/page-meta.svelte.ts`).
-->
<script lang="ts">
  import { onDestroy, setContext, untrack, type Snippet } from "svelte";

  import type { Crumb } from "$lib/nav";
  import { pageMeta } from "$lib/page-meta.svelte";
  import { PageHeader } from "$lib/tallao";

  import { page } from "$app/stores";

  interface Props {
    title: string;
    description?: string;
    crumbs?: Crumb[];
    /** `false` drops the rule under the header (a page that starts with a card). */
    divider?: boolean;
    status?: Snippet;
    meta?: Snippet;
    actions?: Snippet;
    tabs?: Snippet;
    children?: Snippet;
  }

  const {
    title,
    description,
    crumbs = [],
    divider,
    status,
    meta,
    actions,
    tabs,
    children,
  }: Props = $props();

  // `untrack`: the store is written here, and reading it back must not re-run the effect.
  // A view mounted inside this page (a tab of a kon) can tell it already has a header.
  setContext("kitsuden-page", true);

  let own = "";
  $effect(() => {
    const path = $page.url.pathname;
    const next = crumbs;
    const name = title;
    own = path;
    untrack(() => pageMeta.set(path, next, name));
  });
  onDestroy(() => pageMeta.clear(own));
</script>

<div class="kitsuden-page" data-testid="page">
  <PageHeader {title} {description} {divider} {status} {meta} {actions} {tabs} />
  {@render children?.()}
</div>

<style>
  .kitsuden-page {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100rem;
    margin-inline: auto;
  }
</style>
