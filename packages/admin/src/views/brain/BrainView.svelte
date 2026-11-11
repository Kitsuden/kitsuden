<script lang="ts">
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Brain,
    Loader2,
    RefreshCw,
    Search,
    ExternalLink,
    BookOpen,
    AlertCircle,
    Fingerprint,
    GitBranch,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  import KnowledgeGraph from "$lib/components/brain/KnowledgeGraph.svelte";
  import NoteDetailPanel from "$lib/components/brain/NoteDetailPanel.svelte";
  import {
    getBrainGraph,
    getBrainNotes,
    getBrainStatus,
    triggerBrainScan,
  } from "$lib/services/brain";
  import type {
    BrainNeighborhood,
    BrainNote,
    KnowledgeGraph as BrainKnowledgeGraph,
    KnowledgeGraphNode,
  } from "$lib/types/brain";

  type Tab = "Graph" | "Notes";

  let activeTab = $state<Tab>("Graph");
  let statusLoading = $state(true);
  let graphLoading = $state(true);
  let notesLoading = $state(true);
  let scanning = $state(false);
  let error = $state<string | null>(null);

  let status = $state<{
    totalNotes: number;
    totalConnections: number;
    collections?: string[];
    lastScanAt?: string;
  } | null>(null);
  let graph = $state<BrainKnowledgeGraph | null>(null);
  let notes = $state<BrainNote[]>([]);
  let selectedNode = $state<KnowledgeGraphNode | null>(null);

  let searchQuery = $state("");
  let categoryFilter = $state("");

  const categories = $derived([...new Set(notes.map((n) => n.category).filter(Boolean))].sort());

  const filteredNotes = $derived(
    notes.filter((note) => {
      const matchesSearch =
        searchQuery.trim() === "" ||
        note.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.content?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.tags?.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesCategory = categoryFilter === "" || note.category === categoryFilter;
      return matchesSearch && matchesCategory;
    })
  );

  async function loadStatus() {
    try {
      statusLoading = true;
      status = await getBrainStatus();
    } catch (e) {
      error = e instanceof Error ? e.message : tr("brainView.failedToLoadBrainStatus");
    } finally {
      statusLoading = false;
    }
  }

  async function loadGraph() {
    try {
      graphLoading = true;
      graph = await getBrainGraph();
    } catch (e) {
      error = e instanceof Error ? e.message : tr("brainView.failedToLoadKnowledgeGraph");
    } finally {
      graphLoading = false;
    }
  }

  async function loadNotes() {
    try {
      notesLoading = true;
      notes = await getBrainNotes();
    } catch (e) {
      error = e instanceof Error ? e.message : tr("brainView.failedToLoadNotes");
    } finally {
      notesLoading = false;
    }
  }

  async function handleScan() {
    scanning = true;
    error = null;
    try {
      await triggerBrainScan();
      // Allow the backend a moment to start/finish the scan before refreshing.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await Promise.all([loadStatus(), loadGraph(), loadNotes()]);
    } catch (e) {
      error = e instanceof Error ? e.message : tr("brainView.failedToTriggerScan");
    } finally {
      scanning = false;
    }
  }

  function mergeNeighborhood(neighborhood: BrainNeighborhood) {
    if (!graph) return;
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const n of neighborhood.nodes) {
      nodeMap.set(n.id, n);
    }
    const edgeKey = (e: { source: string; target: string; relation: string }) =>
      `${e.source}->${e.target}:${e.relation}`;
    const edgeMap = new Map(graph.edges.map((e) => [edgeKey(e), e]));
    for (const e of neighborhood.edges) {
      edgeMap.set(edgeKey(e), e);
    }
    graph = {
      ...graph,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
    selectedNode = neighborhood.nodes.find((n) => n.id === neighborhood.centerId) ?? selectedNode;
  }

  function formatDate(value?: string): string {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(localeFormat());
  }

  onMount(() => {
    Promise.all([loadStatus(), loadGraph(), loadNotes()]);
  });
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
    <div class="flex items-center gap-3">
      <div
        class="w-11 h-11 rounded-xl bg-kitsuden-accent/10 border border-kitsuden-accent/20 flex items-center justify-center"
      >
        <Brain class="w-5 h-5 text-kitsuden-accent" />
      </div>
      <div>
        <h1 class="text-2xl font-bold text-kitsuden-text">{tr("brainView.kitsudenBrain")}</h1>
        <p class="text-sm text-kitsuden-text-dim">
          {tr("brainView.knowledgeGraphAndSemanticNotes")}
        </p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <a
        href="/api/brain/llms.txt"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-card border border-kitsuden-border transition-colors"
      >
        <ExternalLink class="w-3.5 h-3.5" />
        <span>{tr("brainView.llmsTxt")}</span>
      </a>
      <a
        href="/api/brain/wiki"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-card border border-kitsuden-border transition-colors"
      >
        <BookOpen class="w-3.5 h-3.5" />
        <span>{tr("brainView.wiki")}</span>
      </a>
      <button onclick={handleScan} disabled={scanning} class="kitsuden-btn-primary">
        {#if scanning}
          <Loader2 class="w-4 h-4 animate-spin" />
        {:else}
          <RefreshCw class="w-4 h-4" />
        {/if}
        <span>{tr("brainView.scanNow")}</span>
      </button>
    </div>
  </div>

  <!-- Error -->
  {#if error}
    <div
      class="flex items-start gap-3 rounded-xl bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/20 p-4"
    >
      <AlertCircle class="w-5 h-5 text-kitsuden-accent-2 shrink-0 mt-0.5" />
      <div class="flex-1">
        <p class="text-sm font-medium text-kitsuden-accent-2">
          {tr("brainView.somethingWentWrong")}
        </p>
        <p class="text-xs text-kitsuden-text-dim mt-1">{error}</p>
      </div>
      <button
        onclick={() => (error = null)}
        class="text-xs text-kitsuden-text-dim hover:text-kitsuden-text underline"
      >
        {tr("brainView.dismiss")}
      </button>
    </div>
  {/if}

  <!-- Stats -->
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
    <div class="kitsuden-card p-4">
      <p class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle">
        {tr("brainView.totalNotes")}
      </p>
      <div class="flex items-end gap-2 mt-1">
        <Fingerprint class="w-5 h-5 text-kitsuden-accent" />
        <span class="text-2xl font-bold text-kitsuden-text">
          {statusLoading ? "—" : (status?.totalNotes ?? 0)}
        </span>
      </div>
    </div>
    <div class="kitsuden-card p-4">
      <p class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle">
        {tr("brainView.connections")}
      </p>
      <div class="flex items-end gap-2 mt-1">
        <GitBranch class="w-5 h-5 text-kitsuden-purple" />
        <span class="text-2xl font-bold text-kitsuden-text">
          {statusLoading ? "—" : (status?.totalConnections ?? 0)}
        </span>
      </div>
    </div>
    <div class="kitsuden-card p-4">
      <p class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle">
        {tr("brainView.lastScan")}
      </p>
      <div class="flex items-end gap-2 mt-1">
        <RefreshCw class="w-5 h-5 text-kitsuden-green" />
        <span class="text-lg font-semibold text-kitsuden-text">
          {statusLoading ? "—" : formatDate(status?.lastScanAt)}
        </span>
      </div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="border-b border-kitsuden-border">
    <div class="flex items-center gap-1">
      {#each ["Graph", "Notes"] as tab}
        <button
          class="px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px"
          class:text-kitsuden-text={activeTab === tab}
          class:text-kitsuden-text-dim={activeTab !== tab}
          class:border-kitsuden-accent={activeTab === tab}
          class:border-transparent={activeTab !== tab}
          class:hover:text-kitsuden-text={activeTab !== tab}
          onclick={() => (activeTab = tab as Tab)}
        >
          {tab}
        </button>
      {/each}
    </div>
  </div>

  <!-- Tab content -->
  {#if activeTab === "Graph"}
    {#if graphLoading}
      <div class="flex items-center justify-center h-[600px] kitsuden-card">
        <div class="flex flex-col items-center gap-3 text-kitsuden-text-dim">
          <Loader2 class="w-8 h-8 animate-spin" />
          <p class="text-sm">{tr("brainView.loadingKnowledgeGraph")}</p>
        </div>
      </div>
    {:else if graph}
      <div class="flex flex-col lg:flex-row gap-4 h-auto lg:h-[600px]">
        <div class="flex-1 min-w-0 h-[500px] lg:h-full">
          <KnowledgeGraph
            {graph}
            selectedNodeId={selectedNode?.id ?? null}
            onNodeSelect={(node) => (selectedNode = node)}
          />
        </div>
        <div class="h-[500px] lg:h-full">
          <NoteDetailPanel note={selectedNode} onExpand={mergeNeighborhood} />
        </div>
      </div>
    {/if}
  {:else if activeTab === "Notes"}
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row gap-3">
        <div class="relative flex-1">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle" />
          <input
            type="text"
            bind:value={searchQuery}
            placeholder={tr("brainView.searchByTitleContentOr")}
            class="kitsuden-input w-full pl-9"
          />
        </div>
        <select bind:value={categoryFilter} class="kitsuden-input sm:w-56">
          <option value="">{tr("brainView.allCategories")}</option>
          {#each categories as category}
            <option value={category}>{category}</option>
          {/each}
        </select>
      </div>

      {#if notesLoading}
        <div class="flex items-center justify-center h-64 kitsuden-card">
          <Loader2 class="w-8 h-8 animate-spin text-kitsuden-text-dim" />
        </div>
      {:else if filteredNotes.length === 0}
        <div class="kitsuden-card p-12 text-center text-kitsuden-text-dim">
          <Fingerprint class="w-10 h-10 mx-auto mb-3 text-kitsuden-subtle" />
          <p class="text-sm">{tr("brainView.noNotesFound")}</p>
          {#if searchQuery || categoryFilter}
            <p class="text-xs text-kitsuden-subtle mt-1">
              {tr("brainView.tryAdjustingYourFilters")}
            </p>
          {/if}
        </div>
      {:else}
        <div class="kitsuden-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="bg-kitsuden-bg border-b border-kitsuden-border">
                <tr>
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim">{tr("common.title")}</th>
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim"
                    >{tr("common.category")}</th
                  >
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim">{tr("common.source")}</th
                  >
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim">{tr("common.tags")}</th>
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim"
                    >{tr("brainView.importance")}</th
                  >
                  <th class="px-4 py-3 font-medium text-kitsuden-text-dim"
                    >{tr("brainView.updated")}</th
                  >
                </tr>
              </thead>
              <tbody class="divide-y divide-kitsuden-border">
                {#each filteredNotes as note}
                  <tr class="hover:bg-kitsuden-bg/50 transition-colors">
                    <td class="px-4 py-3">
                      <p class="font-medium text-kitsuden-text truncate max-w-[240px]">
                        {note.title}
                      </p>
                      <p class="text-xs text-kitsuden-subtle truncate max-w-[240px]">
                        {note.sourcePath || note.source}
                      </p>
                    </td>
                    <td class="px-4 py-3">
                      <span
                        class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/20"
                      >
                        {note.category}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-kitsuden-text-dim truncate max-w-[160px]"
                      >{note.source}</td
                    >
                    <td class="px-4 py-3">
                      <div class="flex flex-wrap gap-1 max-w-[160px]">
                        {#each note.tags.slice(0, 3) as tag}
                          <span
                            class="text-xs px-1.5 py-0.5 rounded-sm bg-kitsuden-bg border border-kitsuden-border text-kitsuden-text-dim"
                          >
                            {tag}
                          </span>
                        {/each}
                        {#if note.tags.length > 3}
                          <span class="text-xs text-kitsuden-subtle">+{note.tags.length - 3}</span>
                        {/if}
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <span class="text-xs text-kitsuden-text"
                        >{Math.round((note.importance ?? 0) * 100)}%</span
                      >
                    </td>
                    <td class="px-4 py-3 text-xs text-kitsuden-text-dim whitespace-nowrap">
                      {formatDate(note.updatedAt)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
