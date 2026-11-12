<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import { t } from "$lib/i18n";
  import type { DatasetDefinition } from "@kitsuden/shared";
  import { Alert, Button, EmptyState, Skeleton } from "$lib/tallao";
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

<Page
  title={dataset
    ? t("editEditPage.editDataset", { name: dataset.name })
    : t("editEditPage.editDataset2")}
  description={t("editEditPage.modifyTheSchemaFieldsAnd")}
  crumbs={dataset
    ? [
        { label: dataset.name, href: `/datasets/${datasetId}/entries` },
        { label: t("titles.editDataset") },
      ]
    : [{ label: t("titles.editDataset") }]}
>
  {#snippet actions()}
    {#if dataset}
      <Button variant="secondary" href={`/datasets/${datasetId}/entries`}>
        {t("entriesPage.entries")}
      </Button>
    {/if}
  {/snippet}

  <div class="space-y-6 pb-20">
    {#if error}
      <Alert variant="error">{error}</Alert>
    {/if}

    {#if loading}
      <div role="status" aria-busy="true">
        <span class="sr-only">{t("editEditPage.loadingDataset")}</span>
        <Skeleton lines={6} />
      </div>
    {:else if !dataset}
      <EmptyState
        title={t("editEditPage.datasetNotFound")}
        actionLabel={t("editEditPage.backToDatasets")}
        onAction={goBack}
      />
    {:else}
      <SchemaBuilder
        definition={dataset}
        {allDatasets}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    {/if}
  </div>
</Page>
