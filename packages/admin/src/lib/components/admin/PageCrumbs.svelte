<!--
  For a full-screen tool (the post editor, the page builder) that keeps its own toolbar
  instead of the page template: it still tells the shell what it is, so the breadcrumb and
  the document title name it. Renders nothing.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  import type { Crumb } from "$lib/nav";
  import { pageMeta } from "$lib/page-meta.svelte";

  import { page } from "$app/stores";

  const { crumbs }: { crumbs: Crumb[] } = $props();

  let own = "";
  $effect(() => {
    const path = $page.url.pathname;
    const next = crumbs;
    own = path;
    untrack(() => pageMeta.set(path, next));
  });
  onDestroy(() => pageMeta.clear(own));
</script>
