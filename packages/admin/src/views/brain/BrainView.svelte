<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import {
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    SearchInput,
    Select,
    Spinner,
    Stat,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
  } from "$lib/tallao";
  import { t as tr, localeFormat } from "$lib/i18n";
  import { RefreshCw, ExternalLink, BookOpen } from "lucide-svelte";
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

<Page title={tr("shell.brain")} description={tr("brainView.knowledgeGraphAndSemanticNotes")}>
  {#snippet actions()}
    <Button variant="ghost" href="/api/brain/llms.txt" target="_blank" rel="noopener noreferrer">
      <ExternalLink size={14} aria-hidden="true" />
      {tr("brainView.llmsTxt")}
    </Button>
    <Button variant="ghost" href="/api/brain/wiki" target="_blank" rel="noopener noreferrer">
      <BookOpen size={14} aria-hidden="true" />
      {tr("brainView.wiki")}
    </Button>
    <Button onclick={handleScan} loading={scanning} disabled={scanning}>
      {#if !scanning}<RefreshCw size={16} aria-hidden="true" />{/if}
      {tr("brainView.scanNow")}
    </Button>
  {/snippet}
  <div class="space-y-6 min-w-0">
    <!-- Error -->
    {#if error}
      <Alert
        variant="error"
        title={tr("brainView.somethingWentWrong")}
        onDismiss={() => (error = null)}
        dismissLabel={tr("brainView.dismiss")}
      >
        {error}
      </Alert>
    {/if}

    <!-- Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <Stat
        label={tr("brainView.totalNotes")}
        value={statusLoading ? "—" : (status?.totalNotes ?? 0)}
      />
      <Stat
        label={tr("brainView.connections")}
        value={statusLoading ? "—" : (status?.totalConnections ?? 0)}
      />
      <Stat
        label={tr("brainView.lastScan")}
        value={statusLoading ? "—" : formatDate(status?.lastScanAt)}
      />
    </div>

    <!-- Tabs -->
    <Tabs
      items={[
        { id: "Graph", label: tr("brainView.tabGraph") },
        { id: "Notes", label: tr("brainView.tabNotes") },
      ]}
      value={activeTab}
      onchange={(id) => (activeTab = id as Tab)}
      panels={false}
      ariaLabel={tr("brainView.sections")}
    />

    <!-- Tab content -->
    {#if activeTab === "Graph"}
      {#if graphLoading}
        <Card class="flex items-center justify-center h-[600px]">
          <div class="flex flex-col items-center gap-3 text-kitsuden-text-dim">
            <Spinner size="lg" label={tr("brainView.loadingKnowledgeGraph")} />
            <p class="text-sm" aria-hidden="true">{tr("brainView.loadingKnowledgeGraph")}</p>
          </div>
        </Card>
      {:else if graph}
        <div class="flex flex-col lg:flex-row gap-4 h-auto lg:h-[600px]">
          <div class="flex-1 min-w-0 h-[500px] lg:h-full">
            <KnowledgeGraph
              {graph}
              selectedNodeId={selectedNode?.id ?? null}
              onNodeSelect={(node) => (selectedNode = node)}
            />
          </div>
          <div class="h-[500px] lg:h-full min-w-0">
            <NoteDetailPanel note={selectedNode} onExpand={mergeNeighborhood} />
          </div>
        </div>
      {/if}
    {:else if activeTab === "Notes"}
      <div class="space-y-4">
        <div class="flex flex-col sm:flex-row gap-3">
          <SearchInput
            class="flex-1 min-w-0"
            bind:value={searchQuery}
            placeholder={tr("brainView.searchByTitleContentOr")}
          />
          <Select
            bind:value={categoryFilter}
            class="sm:w-56"
            aria-label={tr("common.category")}
            placeholder={tr("brainView.allCategories")}
            options={categories.map((category) => ({ value: category, label: category }))}
          />
        </div>

        {#if notesLoading}
          <Card class="flex items-center justify-center h-64">
            <Spinner size="lg" />
          </Card>
        {:else if filteredNotes.length === 0}
          <EmptyState
            variant={searchQuery || categoryFilter ? "no-results" : "empty"}
            title={tr("brainView.noNotesFound")}
            description={searchQuery || categoryFilter
              ? tr("brainView.tryAdjustingYourFilters")
              : undefined}
          />
        {:else}
          <Table density="compact">
            <TableHeader>
              <TableRow>
                <TableHead>{tr("common.title")}</TableHead>
                <TableHead>{tr("common.category")}</TableHead>
                <TableHead>{tr("common.source")}</TableHead>
                <TableHead>{tr("common.tags")}</TableHead>
                <TableHead>{tr("brainView.importance")}</TableHead>
                <TableHead>{tr("brainView.updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each filteredNotes as note}
                <TableRow>
                  <TableCell>
                    <p class="font-medium text-kitsuden-text truncate max-w-[240px]">
                      {note.title}
                    </p>
                    <p class="text-xs text-kitsuden-subtle truncate max-w-[240px]">
                      {note.sourcePath || note.source}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="accent">{note.category}</Badge>
                  </TableCell>
                  <TableCell class="truncate max-w-[160px]">{note.source}</TableCell>
                  <TableCell>
                    <div class="flex flex-wrap gap-1 max-w-[160px]">
                      {#each note.tags.slice(0, 3) as tag}
                        <Badge variant="secondary">{tag}</Badge>
                      {/each}
                      {#if note.tags.length > 3}
                        <span class="text-xs text-kitsuden-subtle">+{note.tags.length - 3}</span>
                      {/if}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span class="text-xs text-kitsuden-text"
                      >{Math.round((note.importance ?? 0) * 100)}%</span
                    >
                  </TableCell>
                  <TableCell class="whitespace-nowrap">
                    {formatDate(note.updatedAt)}
                  </TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </div>
    {/if}
  </div>
</Page>
