<script lang="ts">
  import PageCrumbs from "$lib/components/admin/PageCrumbs.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  /**
   * Editor for a Page Builder page (create and edit).
   *
   * Before, "Save" was a `setTimeout` that wrote to the console: no page could be
   * created or edited from the panel, and every page in the list
   * opened this editor empty. Now:
   *
   *   · without `?id=`  → new page: POST /page-builder/pages with its blocks.
   *   · with `?id=`  → loads the page and, on save, PATCH of the page and of
   *     each block by its id. Blocks keep their uuid (Inti hooks its editorial
   *     layer to it), so they are NOT deleted and recreated: the new
   *     ones are created, the existing ones are updated and the removed ones are deleted.
   */
  import { t } from "$lib/i18n";
  import { Save, ArrowLeft, Eye, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast, Button } from "$lib/tallao";

  import { api } from "$lib/api";
  import PageBuilder from "$lib/components/builder/PageBuilder.svelte";
  import type { PageBlock } from "$types/blocks";

  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/stores";

  const SITE = import.meta.env.VITE_SITE_URL ?? "";
  const LISTING = "/g/kon-blocks";

  let pageId = $state<string | null>($page.url.searchParams.get("id"));
  let pageTitle = $state(t("builderView.newPage"));
  let pageSlug = $state("");
  let blocks = $state<PageBlock[]>([]);
  let saving = $state(false);
  let loading = $state(false);
  let deleting = $state(false);
  /** Block ids that exist on the server (to know what to create, update or delete). */
  let savedIds = new Set<string>();

  interface BlockApi {
    id: string;
    type: PageBlock["type"];
    content?: Record<string, unknown> | null;
    sortOrder?: number;
  }

  function fromApi(b: BlockApi, i: number): PageBlock {
    return {
      id: b.id,
      type: b.type,
      data: (b.content ?? {}) as Record<string, unknown>,
      order: b.sortOrder ?? i,
    };
  }

  onMount(async () => {
    if (!pageId) return;
    loading = true;
    try {
      const p = await api.getPage(pageId);
      pageTitle = p.title ?? "";
      pageSlug = p.slug ?? "";
      const list: BlockApi[] = Array.isArray(p.blocks) ? p.blocks : [];
      blocks = list.map(fromApi);
      savedIds = new Set(list.map((b) => b.id));
    } catch (err) {
      toast.error(t("builderView.couldNotLoad"), { description: (err as Error)?.message });
    } finally {
      loading = false;
    }
  });

  async function handleSave() {
    if (!pageTitle.trim()) {
      toast.error(t("builderView.missingTitle"));
      return;
    }
    saving = true;
    try {
      const slug = pageSlug.trim() || undefined;
      if (!pageId) {
        const createdOne = await api.createPage({
          title: pageTitle.trim(),
          slug,
          status: "draft",
          blocks: blocks.map((b, i) => ({ type: b.type, content: b.data, sortOrder: i })),
        });
        pageId = createdOne.id;
        pageSlug = createdOne.slug ?? pageSlug;
        // Reload the real ids of the newly created blocks
        const p = await api.getPage(createdOne.id);
        const list: BlockApi[] = Array.isArray(p.blocks) ? p.blocks : [];
        blocks = list.map(fromApi);
        savedIds = new Set(list.map((b) => b.id));
        replaceState(`?id=${createdOne.id}`, {});
      } else {
        const id = pageId;
        await api.updatePage(id, { title: pageTitle.trim(), ...(slug ? { slug } : {}) });
        const current = new Set(blocks.map((b) => b.id));
        for (const old of savedIds) {
          if (!current.has(old)) await api.deleteBlock(id, old);
        }
        const newIds = new Set<string>();
        for (const [i, b] of blocks.entries()) {
          if (savedIds.has(b.id)) {
            await api.updateBlock(id, b.id, { content: b.data, sortOrder: i });
            newIds.add(b.id);
          } else {
            const createdItem = await api.createBlock(id, {
              type: b.type,
              content: b.data,
              sortOrder: i,
            });
            if (createdItem?.id) {
              b.id = createdItem.id;
              newIds.add(createdItem.id);
            }
          }
        }
        savedIds = newIds;
        blocks = [...blocks];
      }
      toast.success(t("builderView.savedPage"));
    } catch (err) {
      toast.error(t("builderView.couldNotSave"), { description: (err as Error)?.message });
    } finally {
      saving = false;
    }
  }

  async function handleDelete() {
    if (!pageId || !(await confirmDialog(t("builderView.confirmDelete", { title: pageTitle }))))
      return;
    deleting = true;
    try {
      await api.deletePage(pageId);
      toast.success(t("builderView.deletedPage"));
      goto(LISTING);
    } catch (err) {
      toast.error(t("builderView.couldNotDelete"), { description: (err as Error)?.message });
    } finally {
      deleting = false;
    }
  }

  function handlePreview() {
    // The page is seen on the public web; without VITE_SITE_URL the panel does not know where it is.
    window.open(`${SITE.replace(/\/$/, "")}/${pageSlug}`, "_blank");
  }
</script>

<PageCrumbs crumbs={[{ label: pageTitle.trim() || t("builderView.title") }]} />

<div class="h-[calc(100dvh-6.5rem)] flex flex-col">
  <h1 class="sr-only">{t("builderView.title")}</h1>
  <div
    class="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-kitsuden-border bg-kitsuden-card"
  >
    <div class="flex items-center gap-4">
      <Button
        onclick={() => goto(LISTING)}
        variant="ghost"
        size="icon"
        aria-label={t("builderView.comeBack")}
      >
        <ArrowLeft class="w-5 h-5" />
      </Button>
      <div>
        <input
          bind:value={pageTitle}
          type="text"
          placeholder={t("common.pageTitle")}
          class="bg-transparent text-xl font-bold text-kitsuden-text outline-hidden border-b border-transparent focus:border-kitsuden-accent/50 transition-colors placeholder:text-kitsuden-subtle"
        />
        <div class="flex items-center gap-2 mt-1">
          <span class="text-xs text-kitsuden-subtle">/</span>
          <input
            bind:value={pageSlug}
            type="text"
            placeholder="page-slug"
            class="bg-transparent text-xs text-kitsuden-text-dim outline-hidden border-b border-transparent focus:border-kitsuden-accent/50 transition-colors placeholder:text-kitsuden-subtle font-mono"
          />
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      {#if pageId}
        <Button
          onclick={handleDelete}
          disabled={deleting}
          variant="danger-ghost"
          size="sm"
          data-testid="delete-page"
        >
          <Trash2 class="w-4 h-4" />
          {t("common.delete")}
        </Button>
      {/if}
      <Button
        onclick={handlePreview}
        disabled={!SITE || !pageId || !pageSlug}
        title={!SITE ? t("builderView.previewWithoutSite") : undefined}
        variant="ghost"
        size="sm"
      >
        <Eye class="w-4 h-4" />
        {t("common.preview")}
      </Button>
      <Button onclick={handleSave} disabled={saving || loading} size="sm">
        {#if saving}
          <span
            class="w-4 h-4 border-2 border-kitsuden-bg border-t-transparent rounded-full animate-spin"
          ></span>
          {t("common.saving")}
        {:else}
          <Save class="w-4 h-4" /> {t("builderView.savePage")}
        {/if}
      </Button>
    </div>
  </div>

  <div class="flex-1 p-6 overflow-hidden">
    <PageBuilder {blocks} onChange={(b) => (blocks = b)} />
  </div>
</div>
