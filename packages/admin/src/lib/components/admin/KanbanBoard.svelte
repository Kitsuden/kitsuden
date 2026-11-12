<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { Plus, MoreHorizontal } from "lucide-svelte";
  import { onMount } from "svelte";

  import { Button, EmptyState, Spinner } from "$lib/tallao";

  import type { KanbanView } from "$lib/types/admin";

  interface Props {
    view: KanbanView;
    apiEndpoint?: string;
  }

  const { view, apiEndpoint }: Props = $props();

  const API_URL = import.meta.env.VITE_API_URL ?? "";
  const endpoint = $derived(apiEndpoint || `/api/explorer/${view.table}`);

  let data = $state<any[]>([]);
  let loading = $state(true);
  let dragItem = $state<any | null>(null);
  let dragOverColumn = $state<string | null>(null);

  // Validation state
  let hasValidGroupBy = $state(true);

  // Discover unique values for the groupBy field
  const stages = $derived.by<string[]>(() => {
    const unique = new Set<string>();
    for (const item of data) {
      const val = item[view.groupBy];
      if (val !== undefined && val !== null) unique.add(String(val));
    }
    const sorted = Array.from(unique);
    return sorted.length > 0 ? sorted : [t("kanbanBoard.noStage")];
  });

  // Group data by stage
  const grouped = $derived.by<Record<string, any[]>>(() => {
    const groups: Record<string, any[]> = {};
    for (const stage of stages) {
      groups[stage] = [];
    }
    for (const item of data) {
      const stage = String(item[view.groupBy] || t("kanbanBoard.noStage"));
      if (!groups[stage]) groups[stage] = [];
      groups[stage].push(item);
    }
    return groups;
  });

  // Card display fields
  const cardFields = $derived(view.cardFields || []);

  // ── FK Display for groupBy relations ──
  let groupByDisplayMap = $state<Record<string, string>>({});

  function isRelationColumn(colName: string): boolean {
    return colName.endsWith("_id") || (colName.endsWith("Id") && colName !== "id");
  }

  const FK_TABLE_MAP: Record<string, string> = {
    platform_id: "platforms",
    platformId: "platforms",
    tag_id: "tags",
    tagId: "tags",
    streamer_id: "streamers",
    streamerId: "streamers",
    collection_id: "collections",
    collectionId: "collections",
    user_id: "auth_users",
    userId: "auth_users",
    author_id: "auth_users",
    authorId: "auth_users",
    assigned_to_id: "auth_users",
    assignedToId: "auth_users",
    contact_id: "contacts",
    contactId: "contacts",
    company_id: "companies",
    companyId: "companies",
    project_id: "projects",
    projectId: "projects",
    state_id: "states",
    stateId: "states",
    status_id: "statuses",
    statusId: "statuses",
    dataset_id: "datasets",
    datasetId: "datasets",
    cover_art_id: "media",
    coverArtId: "media",
    featured_image_id: "media",
    featuredImageId: "media",
    avatar_id: "media",
    avatarId: "media",
    icon_id: "media",
    iconId: "media",
    thumbnail_id: "media",
    thumbnailId: "media",
    uploaded_by_id: "auth_users",
    uploadedById: "auth_users",
    created_by_id: "auth_users",
    createdById: "auth_users",
  };

  function getRelatedTable(colName: string): string | undefined {
    if (FK_TABLE_MAP[colName]) return FK_TABLE_MAP[colName];
    const base = colName.replace(/_id$/, "").replace(/Id$/, "");
    return base.endsWith("s") ? base : base + "s";
  }

  function resolveGroupDisplay(rawValue: any): string {
    if (rawValue === null || rawValue === undefined) return "—";
    const s = String(rawValue);
    return groupByDisplayMap[s] || s.slice(0, 8) + "…";
  }

  onMount(async () => {
    await loadData();
  });

  async function loadData() {
    loading = true;
    hasValidGroupBy = true;
    try {
      const res = await fetch(`${API_URL}${endpoint}?limit=200`, { credentials: "include" });
      if (res.ok) {
        const result = await res.json();
        data = result.data || result.docs || result;

        // Validate that at least one item has the groupBy field (or the dataset is empty)
        if (data.length > 0) {
          const sampleHasField = data.some((item) => view.groupBy in item);
          if (!sampleHasField) {
            hasValidGroupBy = false;
          }
        }

        // Load FK display values if groupBy is a relation
        if (isRelationColumn(view.groupBy)) {
          const relTable = getRelatedTable(view.groupBy);
          if (relTable) {
            try {
              const optRes = await fetch(`${API_URL}/api/explorer/${relTable}/options`, {
                credentials: "include",
              });
              if (optRes.ok) {
                const optData = await optRes.json();
                const map: Record<string, string> = {};
                for (const opt of optData.options || []) {
                  map[String(opt.value)] = opt.label;
                }
                groupByDisplayMap = map;
              }
            } catch {
              // Ignore FK load errors
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to load kanban data", e);
    } finally {
      loading = false;
    }
  }

  function handleDragStart(item: any) {
    dragItem = item;
  }

  function handleDragOver(e: DragEvent, stage: string) {
    e.preventDefault();
    dragOverColumn = stage;
  }

  function handleDragLeave() {
    dragOverColumn = null;
  }

  async function handleDrop(targetStage: string) {
    dragOverColumn = null;
    if (!dragItem || String(dragItem[view.groupBy]) === targetStage) {
      dragItem = null;
      return;
    }

    const itemId = dragItem.id;
    const oldStage = String(dragItem[view.groupBy]);

    // Optimistic update
    dragItem[view.groupBy] = targetStage;
    data = [...data];
    dragItem = null;

    // Persist via PATCH
    try {
      await fetch(`${API_URL}/api/explorer/${view.table}/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [view.groupBy]: targetStage }),
      });
    } catch (e) {
      console.error("Failed to update stage", e);
      // Revert on failure
      const item = data.find((d) => d.id === itemId);
      if (item) item[view.groupBy] = oldStage;
      data = [...data];
    }
  }

  function formatCardValue(value: any): string {
    if (value === null || value === undefined) return "-";
    if (typeof value === "number") return value.toLocaleString(localeFormat());
    if (typeof value === "boolean") return value ? "✓" : "✗";
    return String(value);
  }

  function getStageColor(stage: string, index: number): string {
    const palette = [
      "border-kitsuden-subtle/30",
      "border-kitsuden-info/30",
      "border-kitsuden-amber/30",
      "border-kitsuden-amber/30",
      "border-kitsuden-green/30",
      "border-kitsuden-danger/30",
      "border-kitsuden-purple/30",
      "border-kitsuden-accent-2/30",
    ];
    return palette[index % palette.length];
  }

  function getStageHeaderColor(stage: string, index: number): string {
    const palette = [
      "bg-kitsuden-subtle/10 text-kitsuden-text-dim",
      "bg-kitsuden-info/10 text-kitsuden-info",
      "bg-kitsuden-amber/10 text-kitsuden-amber",
      "bg-kitsuden-amber/10 text-kitsuden-amber",
      "bg-kitsuden-green/10 text-kitsuden-green",
      "bg-kitsuden-danger/10 text-kitsuden-danger",
      "bg-kitsuden-purple/10 text-kitsuden-purple",
      "bg-kitsuden-accent-2/10 text-kitsuden-accent-2",
    ];
    return palette[index % palette.length];
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold text-kitsuden-text">{view.title}</h2>
    <span class="text-sm text-kitsuden-text-dim">{data.length} {t("kanbanBoard.records")}</span>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-64 text-kitsuden-accent">
      <Spinner size="lg" />
    </div>
  {:else if !hasValidGroupBy}
    <EmptyState icon="alert" title={t("kanbanBoard.incompatibleKanbanView")}>
      <p class="text-sm text-kitsuden-subtle mb-2">
        {t("kanbanBoard.thisKanbanViewIsConfigured")}
        <code class="bg-kitsuden-bg px-1.5 py-0.5 rounded-sm text-kitsuden-accent"
          >'{view.groupBy}'</code
        >{t("kanbanBoard.butTheCurrentDatasetDoes")}
      </p>
      <p class="text-xs text-kitsuden-text-dim">
        {t("kanbanBoard.pleaseUpdateTheGrimoireConfig")}
      </p>
    </EmptyState>
  {:else}
    <div class="flex gap-4 overflow-x-auto pb-4" style="min-height: 400px;">
      {#each stages as stage, i}
        {@const items = grouped[stage] || []}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="shrink-0 w-72 flex flex-col rounded-xl border-2 bg-kitsuden-bg transition-colors {dragOverColumn ===
          stage
            ? 'border-kitsuden-accent/50 bg-kitsuden-accent/5'
            : getStageColor(stage, i)}"
          ondragover={(e) => handleDragOver(e, stage)}
          ondragleave={handleDragLeave}
          ondrop={() => handleDrop(stage)}
        >
          <!-- Column Header -->
          <div
            class="flex items-center justify-between px-3 py-2.5 border-b border-kitsuden-border/50"
          >
            <div class="flex items-center gap-2">
              <span
                class="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full {getStageHeaderColor(
                  stage,
                  i
                )}"
              >
                {resolveGroupDisplay(stage)}
              </span>
              <span class="text-xs text-kitsuden-subtle">{items.length}</span>
            </div>
            <Button variant="ghost" size="icon" ariaLabel={t("kanbanBoard.addItem")}>
              <Plus class="w-3.5 h-3.5" />
            </Button>
          </div>

          <!-- Cards -->
          <div class="flex-1 p-2 space-y-2 overflow-y-auto">
            {#each items as item}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="bg-kitsuden-card border border-kitsuden-border rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-kitsuden-accent/30 transition-all shadow-xs hover:shadow-md"
                draggable="true"
                ondragstart={() => handleDragStart(item)}
              >
                <!-- Card Title (first cardField or ID) -->
                <div class="flex items-center justify-between mb-2">
                  <div class="min-w-0">
                    <p class="text-sm font-medium text-kitsuden-text truncate">
                      {item[cardFields[0]] || item.title || item.name || item.id}
                    </p>
                    {#if isRelationColumn(view.groupBy)}
                      <span class="text-xs text-kitsuden-subtle">
                        {resolveGroupDisplay(item[view.groupBy])}
                      </span>
                    {/if}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="shrink-0"
                    ariaLabel={t("kanbanBoard.moreActions")}
                  >
                    <MoreHorizontal class="w-3.5 h-3.5" />
                  </Button>
                </div>

                <!-- Card Fields -->
                {#each cardFields.slice(1) as field}
                  {#if item[field] !== undefined && item[field] !== null}
                    <div class="flex items-center justify-between text-xs mb-1">
                      <span class="text-kitsuden-subtle capitalize">{field.replace(/_/g, " ")}</span
                      >
                      <span class="text-kitsuden-text-dim font-medium"
                        >{formatCardValue(item[field])}</span
                      >
                    </div>
                  {/if}
                {/each}
              </div>
            {/each}

            {#if items.length === 0}
              <div class="flex items-center justify-center h-20 text-xs text-kitsuden-subtle">
                {t("kanbanBoard.noItems")}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
