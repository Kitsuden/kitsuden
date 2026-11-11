<!--
  Blog posts, on the list template: search, the status / language filters, sort and pages
  in the URL, saved views, export and delete; the title opens the post editor.

  The list asks GET /api/blog with `status=all`: the route defaults to `published`, so an
  installation with a draft and nothing published used to show an EMPTY "All posts" (`all`
  is honoured for the team only). The route pages but has no search of its own that this
  panel can rely on, so every page is fetched (a few hundred posts at most) and search,
  filters and sort happen here, like the other lists the API returns whole.
-->
<script lang="ts">
  import { api } from "$lib/api";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import { t } from "$lib/i18n";
  import { memorySource, type Row } from "$lib/list/source";
  import { Button, MenuItem } from "$lib/tallao";

  import { postRow } from "./posts";

  const NEW = "/content/edit?collection=blog-posts";
  /** Pages of 100 (the route's cap), up to this many: a blog beyond it needs a real search. */
  const MAX_PAGES = 10;

  let total = $state<number | null>(null);
  let languages = $state<string[]>([]);
  let cache: Row[] | null = null;

  async function loadPosts(): Promise<Row[]> {
    const posts: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await api.getPosts({ limit: 100, page, status: "all" });
      posts.push(...((r.docs ?? []) as unknown as Record<string, unknown>[]));
      if (!r.hasNextPage) break;
    }
    const rows = posts.map((p) => postRow(p, new Date()));
    const found = [...new Set(rows.map((r) => String(r.locale)))].sort();
    if (found.join() !== languages.join()) languages = found;
    return rows;
  }

  const option = (value: string, label: string) => ({ value, label });

  const source = $derived(
    memorySource({
      id: "blog-posts",
      label: t("common.blogPosts"),
      singular: t("postsView.post"),
      titleField: "title",
      fields: [
        { key: "title", label: t("common.title"), kind: "text", sortable: true },
        {
          key: "status",
          label: t("common.status"),
          kind: "select",
          sortable: true,
          options: ["draft", "scheduled", "published", "archived"].map((s) => option(s, s)),
        },
        {
          key: "locale",
          label: t("common.language"),
          kind: "select",
          sortable: true,
          options: languages.map((l) => option(l, l)),
        },
        { key: "author", label: t("common.author"), kind: "text", sortable: true },
        { key: "readingMinutes", label: t("postsView.readTime"), kind: "number", sortable: true },
        { key: "publishedAt", label: t("common.published"), kind: "datetime", sortable: true },
        {
          key: "visibility",
          label: t("common.visibility"),
          kind: "select",
          options: [
            option("live", t("postsView.live")),
            option("scheduled", t("postsView.scheduled")),
            option("hidden", t("postsView.hidden")),
          ],
        },
        { key: "slug", label: t("common.slug"), kind: "id", hidden: true },
      ],
      // Fetched once per visit; a filter or a sort works on what is already here.
      rows: async () => (cache ??= await loadPosts()),
      remove: async (id) => {
        await api.deletePost(id);
        cache = null;
      },
    })
  );

  const hrefFor = (row: Row) => `${NEW}&id=${encodeURIComponent(String(row.id))}`;
</script>

<ViewPage title={t("common.blogPosts")} description={t("postsView.manageYourContentWithRich")}>
  {#snippet meta()}
    {#if total !== null}{t("postsView.count", { n: total })}{/if}
  {/snippet}
  {#snippet actions()}
    <Button href={NEW}>{t("postsView.newPost")}</Button>
  {/snippet}

  <ListView {source} bind:total {hrefFor} newHref={NEW}>
    {#snippet rowMenu(row)}
      {#if row.slug}
        <MenuItem onSelect={() => window.open(`/blog/${String(row.slug)}`, "_blank", "noopener")}>
          {t("postsView.view")}
        </MenuItem>
      {/if}
    {/snippet}
  </ListView>
</ViewPage>
