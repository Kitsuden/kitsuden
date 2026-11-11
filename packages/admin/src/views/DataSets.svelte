<!--
  Datasets, on the list template: each one opens its entries; the row menu edits its schema
  or deletes it (with its schema and all its entries, after a confirmation).
-->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import { t } from "$lib/i18n";
  import { memorySource, type Row } from "$lib/list/source";
  import { datasetStore } from "$lib/states/datasets.svelte";
  import { Button, MenuItem } from "$lib/tallao";

  import { goto } from "$app/navigation";

  let loaded = $state(false);
  let total = $state<number | null>(null);
  let reloadKey = $state(0);

  async function load() {
    await datasetStore.fetchDatasets();
    loaded = true;
    reloadKey += 1;
  }
  $effect(() => {
    void load();
  });

  const source = $derived(
    memorySource({
      id: "datasets",
      label: t("shell.datasets"),
      singular: t("datasets.dataset"),
      titleField: "name",
      fields: [
        { key: "name", label: t("common.name"), kind: "text", sortable: true },
        { key: "slug", label: t("common.slug"), kind: "id", sortable: true },
        { key: "fieldCount", label: t("common.fields"), kind: "number", sortable: true },
        { key: "description", label: t("common.description"), kind: "text" },
        { key: "updatedAt", label: t("datasets.updated"), kind: "datetime", sortable: true },
      ],
      rows: () =>
        datasetStore.datasets.map((d) => {
          const withSchema = d as typeof d & { schema?: unknown[] };
          return {
            id: d.id,
            name: d.name,
            slug: d.slug,
            description: d.description ?? "",
            fieldCount: (withSchema.schema ?? d.fields ?? []).length,
            updatedAt: d.updatedAt ?? null,
          };
        }),
      remove: async (id) => {
        const ok = await datasetStore.deleteDataset(id);
        if (!ok) throw new Error(datasetStore.error ?? t("dataSets.loadFailed"));
      },
    })
  );

  const failed = $derived(
    loaded && !!datasetStore.error && datasetStore.datasets.length === 0 ? datasetStore.error : null
  );
</script>

<Page title={t("shell.datasets")} description={t("dataSets.manageYourDataCollectionsAnd")}>
  {#snippet meta()}
    {#if total !== null}{t("datasets.count", { n: total })}{/if}
  {/snippet}
  {#snippet actions()}
    <Button href="/datasets/new">{t("dataSets.newDataSet")}</Button>
  {/snippet}

  <ListView
    {source}
    bind:total
    {reloadKey}
    pending={!loaded}
    loadError={failed}
    onRetry={load}
    hrefFor={(row: Row) => `/datasets/${String(row.id)}/entries`}
    newHref="/datasets/new"
    emptyTitle={t("dataSets.noDataSetsYet")}
    emptyDescription={t("dataSets.createYourFirstDatasetTo")}
  >
    {#snippet rowMenu(row)}
      <MenuItem onSelect={() => goto(`/datasets/${String(row.id)}/edit`)}>
        {t("dataSets.editSchema")}
      </MenuItem>
    {/snippet}
  </ListView>
</Page>
