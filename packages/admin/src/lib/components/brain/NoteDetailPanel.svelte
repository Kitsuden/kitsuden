<script lang="ts">
  import { t } from "$lib/i18n";
  import { Network, FileText, Tag, AlertCircle, Loader2 } from "lucide-svelte";

  import { getBrainNeighborhood, getBrainNote } from "$lib/services/brain";
  import type { BrainNeighborhood, BrainNote, KnowledgeGraphNode } from "$lib/types/brain";

  interface Props {
    note: KnowledgeGraphNode | null;
    onExpand?: (neighborhood: BrainNeighborhood) => void;
  }

  let { note, onExpand }: Props = $props();

  let detail = $state<BrainNote | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let expanding = $state(false);

  async function loadNoteDetail(id: string) {
    loading = true;
    error = null;
    try {
      detail = await getBrainNote(id);
    } catch (e) {
      error = e instanceof Error ? e.message : t("noteDetailPanel.failedToLoadNoteDetails");
      detail = null;
    } finally {
      loading = false;
    }
  }

  async function handleExpand() {
    if (!note) return;
    expanding = true;
    try {
      const neighborhood = await getBrainNeighborhood(note.id, 1);
      onExpand?.(neighborhood);
    } catch (e) {
      error = e instanceof Error ? e.message : t("noteDetailPanel.failedToExpandNeighborhood");
    } finally {
      expanding = false;
    }
  }

  $effect(() => {
    if (note?.id) {
      loadNoteDetail(note.id);
    } else {
      detail = null;
      error = null;
    }
  });

  const currentDetail = $derived<BrainNote | null>(detail);
  const displayTitle = $derived.by(
    () => currentDetail?.title || note?.label || t("noteDetailPanel.selectANode")
  );
  const displayCategory = $derived.by(
    () => currentDetail?.category || note?.type || note?.group || "—"
  );
  const displaySource = $derived.by(() => currentDetail?.source || note?.metadata?.source || "—");
  const displayPath = $derived.by(
    () => currentDetail?.sourcePath || note?.metadata?.sourcePath || null
  );
  const displayTags = $derived.by(() => currentDetail?.tags || note?.metadata?.tags || []);
  const displayImportance = $derived.by(() => currentDetail?.importance ?? note?.importance ?? 0);
  const displayConfidence = $derived.by(
    () => currentDetail?.confidence ?? note?.metadata?.confidence ?? null
  );
</script>

<div
  class="flex flex-col h-full w-full min-w-[280px] max-w-[360px] rounded-xl border border-kitsuden-border bg-kitsuden-card"
>
  {#if !note}
    <div class="flex-1 flex flex-col items-center justify-center p-6 text-kitsuden-text-dim">
      <Network class="w-8 h-8 mb-3 text-kitsuden-subtle" />
      <p class="text-sm text-center">{t("noteDetailPanel.selectANodeFromThe")}</p>
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto p-5 space-y-5">
      <!-- Header -->
      <div>
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wider bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/20"
        >
          {displayCategory}
        </span>
        <h3 class="mt-2 text-lg font-semibold text-kitsuden-text leading-tight">
          {displayTitle}
        </h3>
      </div>

      {#if loading}
        <div class="flex items-center gap-2 text-sm text-kitsuden-text-dim">
          <Loader2 class="w-4 h-4 animate-spin" />
          <span>{t("noteDetailPanel.loadingDetails")}</span>
        </div>
      {/if}

      {#if error && !loading}
        <div
          class="flex items-start gap-2 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/20 p-3"
        >
          <AlertCircle class="w-4 h-4 text-kitsuden-accent-2 shrink-0 mt-0.5" />
          <p class="text-xs text-kitsuden-accent-2">{error}</p>
        </div>
      {/if}

      <!-- Metrics -->
      <div class="grid grid-cols-2 gap-3">
        <div class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3">
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-1">
            {t("noteDetailPanel.importance")}
          </p>
          <div class="flex items-center gap-2">
            <div class="flex-1 h-1.5 rounded-full bg-kitsuden-border overflow-hidden">
              <div
                class="h-full rounded-full bg-kitsuden-accent"
                style="width: {Math.round(displayImportance * 100)}%"
              ></div>
            </div>
            <span class="text-xs font-medium text-kitsuden-text"
              >{Math.round(displayImportance * 100)}%</span
            >
          </div>
        </div>

        {#if displayConfidence !== null}
          <div class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3">
            <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-1">
              {t("noteDetailPanel.confidence")}
            </p>
            <div class="flex items-center gap-2">
              <div class="flex-1 h-1.5 rounded-full bg-kitsuden-border overflow-hidden">
                <div
                  class="h-full rounded-full bg-kitsuden-purple"
                  style="width: {Math.round(displayConfidence * 100)}%"
                ></div>
              </div>
              <span class="text-xs font-medium text-kitsuden-text"
                >{Math.round(displayConfidence * 100)}%</span
              >
            </div>
          </div>
        {/if}
      </div>

      <!-- Source -->
      <div class="space-y-3">
        <div class="flex items-start gap-2 text-sm">
          <FileText class="w-4 h-4 text-kitsuden-text-dim shrink-0 mt-0.5" />
          <div class="min-w-0">
            <p class="text-kitsuden-subtle text-xs uppercase tracking-wider">
              {t("common.source")}
            </p>
            <p class="text-kitsuden-text truncate">{displaySource}</p>
          </div>
        </div>

        {#if displayPath}
          <div class="flex items-start gap-2 text-sm">
            <Tag class="w-4 h-4 text-kitsuden-text-dim shrink-0 mt-0.5" />
            <div class="min-w-0">
              <p class="text-kitsuden-subtle text-xs uppercase tracking-wider">
                {t("noteDetailPanel.path")}
              </p>
              <p class="text-kitsuden-text-dim text-xs break-all font-mono">{displayPath}</p>
            </div>
          </div>
        {/if}
      </div>

      <!-- Tags -->
      {#if displayTags.length > 0}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("common.tags")}
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each displayTags as tag}
              <span
                class="inline-flex items-center rounded-md bg-kitsuden-bg border border-kitsuden-border px-2 py-1 text-xs text-kitsuden-text-dim"
              >
                {tag}
              </span>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Metadata -->
      {#if detail?.metadata && Object.keys(detail.metadata).length > 0}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("noteDetailPanel.metadata")}
          </p>
          <pre
            class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3 text-xs text-kitsuden-text-dim overflow-x-auto">{JSON.stringify(
              detail.metadata,
              null,
              2
            )}</pre>
        </div>
      {:else if note?.metadata && Object.keys(note.metadata).length > 0 && !detail}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("noteDetailPanel.metadata")}
          </p>
          <pre
            class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3 text-xs text-kitsuden-text-dim overflow-x-auto">{JSON.stringify(
              note.metadata,
              null,
              2
            )}</pre>
        </div>
      {/if}

      <!-- Content snippet -->
      {#if detail?.content}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("common.content")}
          </p>
          <div
            class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3 text-xs text-kitsuden-text-dim max-h-48 overflow-y-auto"
          >
            {detail.content}
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer action -->
    <div class="border-t border-kitsuden-border p-4">
      <button onclick={handleExpand} disabled={expanding} class="kitsuden-btn-primary w-full">
        {#if expanding}
          <Loader2 class="w-4 h-4 animate-spin" />
        {:else}
          <Network class="w-4 h-4" />
        {/if}
        <span>{t("noteDetailPanel.expandNeighborhood")}</span>
      </button>
    </div>
  {/if}
</div>
