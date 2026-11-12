<script lang="ts">
  import { Badge, Button, Card, EmptyState, Spinner } from "$lib/tallao";
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { t } from "$lib/i18n";
  import { Plus, Database } from "lucide-svelte";
  import { onMount } from "svelte";

  import { api } from "$lib/api";
  import PageFromDataset from "$lib/components/blocks/PageFromDataset.svelte";

  interface Page {
    id: string;
    title: string;
    slug: string;
    status: "draft" | "published" | "archived";
    layout: string;
    publishedAt?: string;
  }

  const STATUSES: Record<string, string> = {
    draft: t("common.draft"),
    published: t("common.published"),
    archived: t("common.archived"),
  };

  let pages = $state<Page[]>([]);
  let loading = $state(true);
  let showDatasetModal = $state(false);

  /**
   * All the pages, in any status. The API responds `{ docs }` (reading
   * `pages` left the list empty) and without `?status` it only gives published ones, so
   * a freshly created draft never appeared. Each status is requested.
   */
  async function loadPages(): Promise<Page[]> {
    const lists = await Promise.all(
      ["draft", "published", "archived"].map((statusValue) =>
        api
          .get<{ docs?: Page[] }>(`/page-builder/pages?status=${statusValue}&limit=100`)
          .then((r) => r.docs ?? [])
          .catch(() => [] as Page[])
      )
    );
    return lists.flat();
  }

  onMount(async () => {
    try {
      pages = await loadPages();
    } catch {
      // empty
    } finally {
      loading = false;
    }
  });

  function statusVariant(status: string): "success" | "warning" | "secondary" | "default" {
    switch (status) {
      case "published":
        return "success";
      case "draft":
        return "warning";
      case "archived":
        return "secondary";
      default:
        return "default";
    }
  }

  function layoutIcon(layout: string): string {
    switch (layout) {
      case "landing":
        return "🎯";
      case "content":
        return "📝";
      case "sidebar":
        return "📑";
      default:
        return "📄";
    }
  }

  async function handleDatasetSelect(data: any) {
    try {
      // Create the page via API with the blocks generated from dataset
      const page = await api.createPage({
        title: data.title,
        slug: data.slug,
        status: "draft",
        layout: "landing",
      });

      // Create blocks for the page
      if (data.blocks && data.blocks.length > 0) {
        for (const block of data.blocks) {
          await api.createBlock(page.id, {
            type: block.type,
            name: block.name,
            content: block.content,
            columnSpan: block.columnSpan || 12,
            sortOrder: block.sortOrder || 0,
          });
        }
      }

      // Refresh pages list
      pages = await loadPages();
    } catch (err: any) {
      console.error("Failed to create page from dataset:", err);
    }
  }
</script>

<ViewPage title={t("blocksView.pages")} description={t("blocksView.manageYourLandingPagesAnd")}>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (showDatasetModal = true)}>
      <Database class="w-4 h-4" />
      {t("blocksView.fromDataset")}
    </Button>
    <Button href="/g/system-tools/builder">
      <Plus class="w-4 h-4" />
      {t("blocksView.newPage")}
    </Button>
  {/snippet}

  <div class="space-y-4">
    {#if loading}
      <div class="flex justify-center py-20">
        <Spinner />
      </div>
    {:else if pages.length === 0}
      <Card>
        <EmptyState
          title={t("blocksView.noPagesYet")}
          description={t("blocksView.createYourFirstLandingPage")}
          actionLabel={t("blocksView.newPage")}
          actionHref="/g/system-tools/builder"
        />
      </Card>
    {:else}
      <div class="space-y-3">
        {#each pages as page}
          <a href="/g/system-tools/builder?id={page.id}" class="block group rounded-xl">
            <Card
              class="p-4 flex items-center justify-between gap-3 group-hover:border-kitsuden-accent/30 transition-colors"
            >
              <div class="flex items-center gap-4 min-w-0">
                <div
                  class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center text-xl"
                >
                  {layoutIcon(page.layout)}
                </div>
                <div class="min-w-0">
                  <h3
                    class="font-semibold text-kitsuden-text group-hover:text-kitsuden-accent transition-colors"
                  >
                    {page.title}
                  </h3>
                  <p class="text-xs text-kitsuden-subtle mt-0.5">
                    /{page.slug} · {page.layout}
                  </p>
                </div>
              </div>
              <Badge variant={statusVariant(page.status)}>
                {STATUSES[page.status] ?? page.status}
              </Badge>
            </Card>
          </a>
        {/each}
      </div>
    {/if}
  </div>

  <!-- From Dataset Modal -->
  <PageFromDataset
    isOpen={showDatasetModal}
    onClose={() => (showDatasetModal = false)}
    onSelect={handleDatasetSelect}
  />
</ViewPage>
