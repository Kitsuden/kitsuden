<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import { Alert, toast } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import type { DatasetDefinition } from "@kitsuden/shared";

  import SchemaBuilder from "$lib/components/datasets/SchemaBuilder.svelte";
  import { datasetStore } from "$lib/states/datasets.svelte";

  import { goto } from "$app/navigation";

  let saving = $state(false);
  let error = $state<string | null>(null);

  const initialDatasetData = {
    id: "",
    name: "",
    slug: "",
    icon: "📦",
    description: "",
    fields: [],
    customEndpoints: [],
  } as DatasetDefinition;

  async function handleSave(datasetSchema: DatasetDefinition) {
    saving = true;
    error = null;
    try {
      // The store does not throw: it returns null and leaves the reason in `error`. The page
      // used to go back to the list either way, so a refused dataset looked created.
      const created = await datasetStore.createDataset(datasetSchema);
      if (!created) {
        error = datasetStore.error || t("newPage.failedToCreateDataset");
        return;
      }
      toast.success(t("newPage.created", { name: created.name }));
      // Straight to where the next step happens: the new dataset's entries.
      await goto(`/datasets/${created.id}/entries`);
    } catch (err: any) {
      error = err.message || t("newPage.failedToCreateDataset");
      console.error(err);
    } finally {
      saving = false;
    }
  }

  function handleCancel() {
    goto("/datasets");
  }
</script>

<Page
  title={t("common.createDataset")}
  description={t("newPage.defineTheSchemaAndFields")}
  crumbs={[{ label: t("common.createDataset") }]}
>
  <div class="space-y-6 pb-20">
    {#if error}
      <Alert variant="error" onDismiss={() => (error = null)}>{error}</Alert>
    {/if}

    <SchemaBuilder definition={initialDatasetData} onSave={handleSave} onCancel={handleCancel} />
  </div>
</Page>
