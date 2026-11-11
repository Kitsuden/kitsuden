<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";
  /**
   * BlogDataExplorer - Blog view using the generic DataExplorer
   *
   * This view demonstrates how to use the extensible DataExplorer
   * with computed fields and custom field types.
   */
  import { Edit2, Eye, Trash2, FileText, Megaphone } from "lucide-svelte";

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
      label: t("blogDataExplorer.readTime"),
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

  // Per-row actions
  const rowActions = [
    {
      id: "edit",
      label: t("common.edit"),
      icon: Edit2,
      handler: (row: any) => {
        goto(`/blog/posts/${row.id}/edit`);
      },
    },
    {
      id: "view",
      label: t("blogDataExplorer.view"),
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
      label: t("blogDataExplorer.publishSelected"),
      icon: Megaphone,
      handler: async (ids: string[]) => {
        // Implement bulk publish
        console.log("Publishing:", ids);
      },
    },
    {
      id: "delete",
      label: t("common.delete"),
      icon: Trash2,
      variant: "danger" as const,
      handler: async (ids: string[]) => {
        if (await confirmDialog(t("blogDataExplorer.deletePosts", { idsCount: ids.length }))) {
          console.log("Deleting:", ids);
        }
      },
    },
  ];

  // Full configuration
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
    goto(`/blog/posts/${row.id}`);
  }
</script>

<div class="space-y-6">
  <!-- Header with actions -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-kitsuden-accent/10 flex items-center justify-center">
          <FileText class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("common.blogPosts")}
      </h1>
      <p class="text-kitsuden-subtle mt-1">{t("blogDataExplorer.manageYourContentWithThe")}</p>
    </div>
    <a
      href="/content/edit?collection=blog-posts"
      class="group inline-flex items-center gap-2 px-5 py-2.5 bg-kitsuden-accent text-kitsuden-on-accent rounded-xl font-semibold shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"
        ><path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M12 4v16m8-8H4"
        /></svg
      >
      <span>{t("blogDataExplorer.newPost")}</span>
    </a>
  </div>

  <!-- DataExplorer -->
  <DataExplorer table="blog_posts" {config} apiEndpoint="/api/blog" onRowClick={handleRowClick} />
</div>
