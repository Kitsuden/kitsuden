<!--
  The entries of a dataset, on the list template: filters from the dataset's select and
  yes/no fields, search, bulk actions, and each entry at its own page.
-->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import QuickAddDialog from "$lib/components/list/QuickAddDialog.svelte";
  import { localeFormat, t } from "$lib/i18n";
  import { loadDataset } from "$lib/list/dataset-loader";
  import { datasetSource, type RecordSource } from "$lib/list/source";
  import { Button, EmptyState, Skeleton } from "$lib/tallao";

  import { page } from "$app/stores";

  const datasetId = $derived($page.params.id ?? "");

  let source = $state<RecordSource | null>(null);
  let error = $state<string | null>(null);
  let total = $state<number | null>(null);
  let quickAdd = $state(false);
  let reloadKey = $state(0);

  async function load(id: string) {
    source = null;
    error = null;
    try {
      const dataset = await loadDataset(id);
      source = datasetSource(dataset, { status: t("common.status"), entry: t("list.entry") });
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
  }

  $effect(() => {
    void load(datasetId);
  });

  const base = $derived(`/datasets/${datasetId}/entries`);
</script>

<Page title={source?.label ?? t("titles.entries")} crumbs={[{ label: source?.label ?? "…" }]}>
  {#snippet meta()}
    {#if total !== null}
      {total === 1
        ? t("list.countOne")
        : t("list.count", { n: total.toLocaleString(localeFormat()) })}
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="secondary" href={`/datasets/${datasetId}/edit`}>
      {t("entriesPage.editSchema")}
    </Button>
    {#if source && source.formFields.length > 0}
      <Button variant="secondary" onclick={() => (quickAdd = true)}>{t("list.quickAdd")}</Button>
      <Button href={`${base}/new`}>{t("list.newOne", { name: source.singular })}</Button>
    {/if}
  {/snippet}

  {#if error}
    <EmptyState variant="error" description={error} onRetry={() => load(datasetId)} />
  {:else if !source}
    <Skeleton lines={6} />
  {:else}
    <ListView
      {source}
      bind:total
      {reloadKey}
      hrefFor={(row) => `${base}/${source!.rowId(row)}`}
      newHref={source.formFields.length > 0 ? `${base}/new` : undefined}
      emptyDescription={source.formFields.length > 0
        ? t("entriesPage.emptyHint")
        : t("entriesPage.noFieldsHint")}
    />
    <QuickAddDialog bind:open={quickAdd} {source} onCreated={() => (reloadKey += 1)} />
  {/if}
</Page>
