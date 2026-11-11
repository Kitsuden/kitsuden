<script lang="ts">
  import { Button } from "$lib/tallao";
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

  function statusColor(status: string): string {
    switch (status) {
      case "published":
        return "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20";
      case "draft":
        return "bg-kitsuden-yellow/10 text-kitsuden-yellow border-kitsuden-yellow/20";
      case "archived":
        return "bg-kitsuden-subtle/10 text-kitsuden-subtle border-kitsuden-subtle/20";
      default:
        return "bg-kitsuden-surface text-kitsuden-text-dim";
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
        <div
          class="w-6 h-6 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
        ></div>
      </div>
    {:else if pages.length === 0}
      <div class="card p-16 text-center">
        <div class="text-4xl mb-3">🎯</div>
        <p class="text-kitsuden-text-dim">{t("blocksView.noPagesYet")}</p>
        <p class="text-xs text-kitsuden-subtle mt-1">
          {t("blocksView.createYourFirstLandingPage")}
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each pages as page}
          <a
            href="/g/system-tools/builder?id={page.id}"
            class="card p-4 flex items-center justify-between group hover:border-kitsuden-accent/30 transition-colors"
          >
            <div class="flex items-center gap-4">
              <div
                class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center text-xl"
              >
                {layoutIcon(page.layout)}
              </div>
              <div>
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
            <span class="px-2 py-1 text-xs rounded-full border {statusColor(page.status)}">
              {STATUSES[page.status] ?? page.status}
            </span>
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
