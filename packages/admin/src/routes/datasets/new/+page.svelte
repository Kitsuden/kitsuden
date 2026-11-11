<script lang="ts">
  import { Alert, Button } from "$lib/tallao";
  import { toast } from "svelte-sonner";
  import { t } from "$lib/i18n";
  import type { DatasetDefinition } from "@kitsuden/shared";
  import { ArrowLeft } from "lucide-svelte";

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

<div class="space-y-6 animate-fade-in pb-20">
  <div class="flex items-center gap-4">
    <Button
      variant="ghost"
      size="icon"
      onclick={handleCancel}
      ariaLabel={t("newPage.back")}
      title={t("newPage.back")}
    >
      <ArrowLeft class="w-5 h-5" />
    </Button>
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text">{t("common.createDataset")}</h1>
      <p class="text-sm text-kitsuden-text-dim mt-1">
        {t("newPage.defineTheSchemaAndFields")}
      </p>
    </div>
  </div>

  {#if error}
    <Alert variant="error" onDismiss={() => (error = null)}>{error}</Alert>
  {/if}

  <div class="card p-6 border-kitsuden-accent/20">
    <SchemaBuilder definition={initialDatasetData} onSave={handleSave} onCancel={handleCancel} />
  </div>
</div>
