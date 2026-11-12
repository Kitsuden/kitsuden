<script lang="ts">
  import { t } from "$lib/i18n";
  import { Network, FileText, Tag } from "lucide-svelte";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CodeBlock,
    EmptyState,
    Progress,
    Spinner,
  } from "$lib/tallao";

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

<Card class="flex flex-col h-full w-full min-w-0 lg:min-w-[280px] lg:max-w-[360px]">
  {#if !note}
    <EmptyState
      size="sm"
      icon={false}
      title={t("noteDetailPanel.selectANodeFromThe")}
      level={null}
    />
  {:else}
    <div class="flex-1 overflow-y-auto p-5 space-y-5">
      <!-- Header -->
      <div>
        <Badge variant="accent">{displayCategory}</Badge>
        <h3 class="mt-2 text-lg font-semibold text-kitsuden-text leading-tight break-words">
          {displayTitle}
        </h3>
      </div>

      {#if loading}
        <div class="flex items-center gap-2 text-sm text-kitsuden-text-dim">
          <Spinner size="sm" label={t("noteDetailPanel.loadingDetails")} />
          <span aria-hidden="true">{t("noteDetailPanel.loadingDetails")}</span>
        </div>
      {/if}

      {#if error && !loading}
        <Alert variant="error">{error}</Alert>
      {/if}

      <!-- Metrics -->
      <div class="grid grid-cols-2 gap-3">
        <Progress
          label={t("noteDetailPanel.importance")}
          value={Math.round(displayImportance * 100)}
          showValue
        />
        {#if displayConfidence !== null}
          <Progress
            label={t("noteDetailPanel.confidence")}
            value={Math.round(displayConfidence * 100)}
            showValue
          />
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
              <Badge variant="secondary">{tag}</Badge>
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
          <CodeBlock code={JSON.stringify(detail.metadata, null, 2)} language="json" />
        </div>
      {:else if note?.metadata && Object.keys(note.metadata).length > 0 && !detail}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("noteDetailPanel.metadata")}
          </p>
          <CodeBlock code={JSON.stringify(note.metadata, null, 2)} language="json" />
        </div>
      {/if}

      <!-- Content snippet -->
      {#if detail?.content}
        <div>
          <p class="text-xs uppercase tracking-wider text-kitsuden-subtle mb-2">
            {t("common.content")}
          </p>
          <div
            class="rounded-lg bg-kitsuden-bg border border-kitsuden-border p-3 text-xs text-kitsuden-text-dim max-h-48 overflow-y-auto break-words"
          >
            {detail.content}
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer action -->
    <div class="border-t border-kitsuden-border p-4">
      <Button
        variant="secondary"
        class="w-full"
        onclick={handleExpand}
        loading={expanding}
        disabled={expanding}
      >
        {#if !expanding}<Network class="w-4 h-4" aria-hidden="true" />{/if}
        {t("noteDetailPanel.expandNeighborhood")}
      </Button>
    </div>
  {/if}
</Card>
