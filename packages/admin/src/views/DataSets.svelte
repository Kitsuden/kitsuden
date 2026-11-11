<script lang="ts">
  import { goto } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t } from "$lib/i18n";
  /**
   * DataSets.svelte
   *
   * Datasets management view - CONNECTED TO THE REAL API
   * Svelte 5 compatible (no @tanstack/svelte-table)
   */
  import { Table2, Plus, Pencil, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { slide } from "svelte/transition";

  import StateMessage from "$lib/components/feedback/StateMessage.svelte";
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

  // ─── Load datasets on mount ───
  onMount(() => {
    datasetStore.fetchDatasets();
  });

  // ─── Handlers ───
  function handleEditDataset(id: string) {
    void goto(`/datasets/${id}/edit`);
  }

  function handleViewEntries(id: string) {
    void goto(`/datasets/${id}/entries`);
  }

  async function handleDeleteDataset(id: string, name: string) {
    const ok = await confirmDialog({
      title: t("dataSets.deleteTitle", { name }),
      description: t("dataSets.areYouSureYouWant", { name }),
      confirmLabel: t("common.delete"),
    });
    if (!ok) return;
    const deleted = await datasetStore.deleteDataset(id);
    if (deleted) toast.success(t("dataSets.deleted", { name }));
  }

  /** The list failed to load and there is nothing to show: an error, not "no datasets". */
  const loadFailed = $derived(!!datasetStore.error && datasetStore.datasets.length === 0);
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
        >
          <Table2 class="w-5 h-5 text-kitsuden-accent" />
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

  <!-- Error Message (an action that failed while the list is on screen) -->
  {#if datasetStore.error && !loadFailed}
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
  {:else if loadFailed}
    <!-- The error replaces the empty state: never both. -->
    <StateMessage
      kind="error"
      title={t("dataSets.loadFailed")}
      description={datasetStore.error}
      onRetry={() => {
        datasetStore.clearError();
        void datasetStore.fetchDatasets();
      }}
      retrying={datasetStore.isLoading}
    />
    <!-- Empty State -->
  {:else if datasetStore.datasets.length === 0}
    <div class="card p-12 text-center">
      <div
        class="w-16 h-16 mx-auto mb-4 rounded-full bg-kitsuden-accent/10 flex items-center justify-center"
      >
        <Table2 class="w-8 h-8 text-kitsuden-accent/50" />
      </div>
      <h2 class="text-lg font-medium text-kitsuden-text mb-2">{t("dataSets.noDataSetsYet")}</h2>
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
              <!-- A real link: the row's click is a mouse shortcut, this is the keyboard's way in. -->
              <a
                href="/datasets/{dataset.id}/entries"
                onclick={(e) => e.stopPropagation()}
                class="font-medium text-kitsuden-text group-hover:text-kitsuden-accent hover:underline transition-colors rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kitsuden-accent"
              >
                <span aria-hidden="true">{dataset.icon || "📦"}</span>
                {dataset.name}
              </a>
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
              <!-- Always drawn: an action that only appears on hover does not exist for a keyboard. -->
              <div class="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("dataSets.editSchema")}
                  ariaLabel={`${t("dataSets.editSchema")}: ${dataset.name}`}
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
                  ariaLabel={`${t("common.delete")}: ${dataset.name}`}
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
