<script lang="ts">
  import { t } from "$lib/i18n";
  import type { DatasetDefinition } from "@kitsuden/shared";
  import { ArrowLeft, Loader2, AlertCircle } from "lucide-svelte";
  import { onMount } from "svelte";

  import SchemaBuilder from "$lib/components/datasets/SchemaBuilder.svelte";
  import { datasetStore } from "$lib/states/datasets.svelte";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  const datasetId = $derived($page.params.id);

  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let dataset = $state<DatasetDefinition | null>(null);
  let allDatasets = $state<DatasetDefinition[]>([]);

  onMount(async () => {
    await loadDataset();
    // Load all datasets for relation dropdowns
    await datasetStore.fetchDatasets();
    allDatasets = datasetStore.datasets;
  });

  async function loadDataset() {
    loading = true;
    error = null;

    try {
      const data = await datasetStore.fetchDatasetById(datasetId);
      if (data) {
        dataset = data;
      } else {
        error = t("editPage.datasetNotFound");
      }
    } catch (err: any) {
      error = err.message || t("editPage.failedToLoadDataset");
    } finally {
      loading = false;
    }
  }

  async function handleSave(datasetSchema: DatasetDefinition) {
    saving = true;
    error = null;

    try {
      const updated = await datasetStore.updateDataset(datasetId, {
        name: datasetSchema.name,
        slug: datasetSchema.slug,
        description: datasetSchema.description,
        icon: datasetSchema.icon,
        schema: (datasetSchema as any).schema,
        displayConfig: (datasetSchema as any).displayConfig,
        policyJson: datasetSchema.policyJson,
        workflowJson: datasetSchema.workflowJson,
      } as any);

      if (updated) {
        goto("/datasets");
      } else {
        error = datasetStore.error || t("editPage.failedToUpdateDataset");
      }
    } catch (err: any) {
      error = err.message || t("editPage.failedToUpdateDataset");
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    goto("/datasets");
  }

  function goBack() {
    goto("/datasets");
  }
</script>

<div class="space-y-6 animate-fade-in pb-20">
  <!-- Header -->
  <div class="flex items-center gap-4">
    <button
      class="btn-icon p-2 hover:bg-kitsuden-surface rounded-lg transition-colors text-kitsuden-subtle"
      onclick={goBack}
    >
      <ArrowLeft class="w-5 h-5" />
    </button>
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text">
        {#if loading}
          {t("common.loading")}
        {:else if dataset}
          {t("editEditPage.editDataset", { name: dataset.name })}
        {:else}
          {t("editEditPage.editDataset2")}
        {/if}
      </h1>
      <p class="text-sm text-kitsuden-text-dim mt-1">
        {t("editEditPage.modifyTheSchemaFieldsAnd")}
      </p>
    </div>
  </div>

  <!-- Error Message -->
  {#if error}
    <div
      class="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3"
    >
      <AlertCircle class="w-5 h-5" />
      {error}
    </div>
  {/if}

  <!-- Loading State -->
  {#if loading}
    <div class="card p-12 text-center">
      <Loader2 class="w-8 h-8 text-kitsuden-accent animate-spin mx-auto mb-4" />
      <p class="text-kitsuden-subtle">{t("editEditPage.loadingDataset")}</p>
    </div>
  {:else if !dataset}
    <div class="card p-12 text-center">
      <div class="text-4xl mb-3">😕</div>
      <p class="text-kitsuden-text-dim">{t("editEditPage.datasetNotFound")}</p>
      <button onclick={goBack} class="btn-primary mt-4">
        {t("editEditPage.backToDatasets")}
      </button>
    </div>
  {:else}
    <div class="card p-6 border-kitsuden-accent/20">
      <SchemaBuilder
        definition={dataset}
        {allDatasets}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  {/if}
</div>

<style>
  .btn-primary {
    @apply px-4 py-2 bg-kitsuden-accent text-black rounded-lg font-medium 
           hover:bg-kitsuden-accent-hover transition-colors;
  }

  .btn-icon {
    @apply p-2 rounded-lg transition-colors;
  }

  .card {
    @apply bg-kitsuden-card border border-kitsuden-border rounded-xl;
  }
</style>
