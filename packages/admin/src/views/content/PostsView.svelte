<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";
  /**
   * PostsView.svelte
   *
   * Blog Posts management view - Core Grimoire
   * Uses DataExplorer with custom field types and calculated fields
   */
  import { Edit2, Eye, Trash2, FileText, Megaphone, Plus } from "lucide-svelte";

  import DataExplorer from "$lib/components/DataExplorer.svelte";
  import { calculatedHelpers } from "$lib/data-explorer/fieldRegistry";

  import { goto } from "$app/navigation";

  // Column configuration with field types
  const columns = [
    {
      field: "title",
      label: t("common.title"),
      width: "30%",
      fieldConfig: {
        type: "text",
        options: { maxLength: 200 },
      },
    },
    {
      field: "status",
      label: t("common.status"),
      width: "120px",
      fieldConfig: {
        type: "status-badge",
        options: {
          colors: {
            draft: "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20",
            scheduled: "bg-kitsuden-info/10 text-kitsuden-info border-kitsuden-info/20",
            published: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
            archived: "bg-kitsuden-subtle/10 text-kitsuden-text-dim border-kitsuden-subtle/20",
          },
        },
      },
    },
    /**
     * The language, to be able to tell apart the versions of the same article.
     *
     * Without this column, an article and its translation are two rows with different
     * titles and no hint that they are the same: the list looks full of
     * duplicates and there is no way to know which one to edit.
     */
    {
      field: "locale",
      label: t("common.language"),
      width: "90px",
      fieldConfig: {
        type: "calculated",
        options: {
          calculate: (row: any) => (row.locale || "es").toUpperCase(),
        },
      },
    },
    {
      field: "author",
      label: t("common.author"),
      width: "150px",
      fieldConfig: {
        type: "calculated",
        options: {
          calculate: (row: any) => row.author?.name || row.author?.email || "—",
        },
      },
    },
    {
      field: "readingTime",
      label: t("postsView.readTime"),
      width: "100px",
      fieldConfig: {
        type: "calculated",
        options: {
          calculate: (row: any) => {
            if (!row.content) return "—";
            const words = String(row.content).split(/\s+/).length;
            const minutes = Math.ceil(words / 200);
            return `${minutes} min`;
          },
          format: "text",
        },
      },
    },
    {
      field: "publishedAt",
      label: t("common.published"),
      width: "120px",
      fieldConfig: {
        type: "calculated",
        options: {
          calculate: (row: any) => {
            if (!row.publishedAt) return "—";
            return calculatedHelpers.timeAgo(row.publishedAt);
          },
          format: "text",
        },
      },
    },
    {
      field: "isLive",
      label: t("common.visibility"),
      width: "100px",
      fieldConfig: {
        type: "calculated",
        options: {
          calculate: (row: any) => {
            if (row.status !== "published") return "Draft";
            const pubDate = new Date(row.publishedAt);
            return pubDate <= new Date() ? "Live" : "Scheduled";
          },
          format: "badge",
        },
      },
    },
  ];

  // Row actions
  const rowActions = [
    {
      id: "edit",
      label: t("common.edit"),
      icon: Edit2,
      handler: (row: any) => {
        goto(`/content/edit?collection=blog-posts&id=${row.id}`);
      },
    },
    {
      id: "view",
      label: t("postsView.view"),
      icon: Eye,
      handler: (row: any) => {
        window.open(`/blog/${row.slug}`, "_blank");
      },
    },
  ];

  // Bulk actions
  const bulkActions = [
    {
      id: "publish",
      label: t("postsView.publishSelected"),
      icon: Megaphone,
      handler: async (ids: string[]) => {
        console.log("Publishing:", ids);
      },
    },
    {
      id: "delete",
      label: t("common.delete"),
      icon: Trash2,
      variant: "danger" as const,
      handler: async (ids: string[]) => {
        if (await confirmDialog(t("postsView.deletePosts", { idsCount: ids.length }))) {
          console.log("Deleting:", ids);
        }
      },
    },
  ];

  // Complete configuration
  const config = {
    table: "blog_posts",
    label: t("common.blogPosts"),
    columns,
    searchableFields: ["title", "excerpt"],
    filterableFields: ["status", "authorId"],
    rowActions,
    bulkActions,
  };

  function handleRowClick(row: any) {
    goto(`/content/edit?collection=blog-posts&id=${row.id}`);
  }
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
        >
          <FileText class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("common.blogPosts")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("postsView.manageYourContentWithRich")}
      </p>
    </div>
    <a
      href="/content/edit?collection=blog-posts"
      class="group inline-flex items-center gap-2 px-5 py-2.5 bg-kitsuden-accent text-kitsuden-on-accent rounded-xl font-semibold shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200"
    >
      <Plus class="w-4 h-4" />
      <span>{t("postsView.newPost")}</span>
    </a>
  </div>

  <!-- DataExplorer -->
  <!--
    ── WHY `status: "all"` ───────────────────────────────────────────────────

    This screen is called "All Posts" and did not show them all: `GET /api/blog`
    defaults `status` to `published`, so the list of an
    installation with a draft and nothing published came out EMPTY. And there was no
    way to request the rest — the parameter only switched from one status to another,
    never removed them.

    From the outside it reads as "there are no posts", which is exactly the opposite of
    what is happening. That is why "Drafts" did show the post and "All Posts" did not.

    `all` is only honored by the API for `admin` and `editor`; for anyone without a
    session it still returns what is published and nothing else.
  -->
  <DataExplorer
    table="blog_posts"
    {config}
    apiEndpoint="/api/blog"
    queryParams={{ status: "all" }}
    onRowClick={handleRowClick}
  />
</div>
