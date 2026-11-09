<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * DataSets.svelte
   *
   * Datasets management view - CONNECTED TO THE REAL API
   * Svelte 5 compatible (no @tanstack/svelte-table)
   */
  import { Zap, Plus, Pencil, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";

  import { datasetStore } from "$lib/states/datasets.svelte";
  import {
    Alert,
    Button,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";

  // ─── Local State ───
  const showBuilder = $state(false);

  // ─── Load datasets on mount ───
  onMount(() => {
    datasetStore.fetchDatasets();
  });

  // ─── Handlers ───
  function handleNewDataset() {
    // Navigate to the schema builder
    window.location.href = "/datasets/new";
  }

  function handleEditDataset(id: string) {
    window.location.href = `/datasets/${id}/edit`;
  }

  function handleViewEntries(id: string) {
    window.location.href = `/datasets/${id}/entries`;
  }

  async function handleDeleteDataset(id: string, name: string) {
    if (!confirm(t("dataSets.areYouSureYouWant", { name }))) return;
    await datasetStore.deleteDataset(id);
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
          <Zap class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("dataSets.dataSets")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">{t("dataSets.manageYourDataCollectionsAnd")}</p>
    </div>
    <Button href="/datasets/new">
      <Plus class="w-4 h-4" />
      {t("dataSets.newDataSet")}
    </Button>
  </div>

  <!-- Error Message -->
  {#if datasetStore.error}
    <div transition:slide>
      <Alert variant="error" onDismiss={() => datasetStore.clearError()}>
        {datasetStore.error}
      </Alert>
    </div>
  {/if}

  <!-- Loading State -->
  {#if datasetStore.isLoading && datasetStore.datasets.length === 0}
    <div class="card p-12 text-center">
      <Spinner size="lg" class="text-kitsuden-accent mb-4" label={t("dataSets.loadingDatasets")} />
      <p class="text-kitsuden-subtle">{t("dataSets.loadingDatasets")}</p>
    </div>
    <!-- Empty State -->
  {:else if datasetStore.datasets.length === 0}
    <div class="card p-12 text-center">
      <div
        class="w-16 h-16 mx-auto mb-4 rounded-full bg-kitsuden-accent/10 flex items-center justify-center"
      >
        <Zap class="w-8 h-8 text-kitsuden-accent/50" />
      </div>
      <h3 class="text-lg font-medium text-kitsuden-text mb-2">{t("dataSets.noDataSetsYet")}</h3>
      <p class="text-sm text-kitsuden-subtle max-w-md mx-auto mb-6">
        {t("dataSets.createYourFirstDatasetTo")}
      </p>
      <Button href="/datasets/new">
        <Plus class="w-4 h-4" />
        {t("dataSets.createFirstDataSet")}
      </Button>
    </div>
    <!-- Data Table -->
  {:else}
    <Table aria-label={t("dataSets.dataSets")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("common.name")}</TableHead>
          <TableHead>{t("common.slug")}</TableHead>
          <TableHead>{t("common.fields")}</TableHead>
          <TableHead>{t("common.description")}</TableHead>
          <TableHead class="text-right!">{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each datasetStore.datasets as dataset}
          <TableRow class="cursor-pointer group" onclick={() => handleViewEntries(dataset.id)}>
            <TableCell>
              <span
                class="font-medium text-kitsuden-text group-hover:text-kitsuden-accent transition-colors"
              >
                {dataset.icon || "📦"}
                {dataset.name}
              </span>
            </TableCell>
            <TableCell>
              <code class="text-xs text-kitsuden-subtle bg-kitsuden-surface px-2 py-0.5 rounded-sm"
                >{dataset.slug}</code
              >
            </TableCell>
            <TableCell class="text-kitsuden-text-dim!">
              {t("dataSets.field", { v: dataset.fields?.length || 0 })}{(dataset.fields?.length ||
                0) !== 1
                ? "s"
                : ""}
            </TableCell>
            <TableCell class="text-kitsuden-text-dim! truncate max-w-[200px]">
              {dataset.description || "—"}
            </TableCell>
            <TableCell class="text-right">
              <div
                class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("dataSets.editSchema")}
                  ariaLabel={t("dataSets.editSchema")}
                  onclick={(e) => {
                    e.stopPropagation();
                    handleEditDataset(dataset.id);
                  }}
                >
                  <Pencil class="w-4 h-4" />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="icon"
                  title={t("common.delete")}
                  ariaLabel={t("common.delete")}
                  onclick={(e) => {
                    e.stopPropagation();
                    handleDeleteDataset(dataset.id, dataset.name);
                  }}
                >
                  <Trash2 class="w-4 h-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
</div>
