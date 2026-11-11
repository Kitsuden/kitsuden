<!-- One entry of a dataset at its own URL (`…/entries/<id>`, or `…/entries/new`). -->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import RecordPage from "$lib/components/list/RecordPage.svelte";
  import { t } from "$lib/i18n";
  import { loadDataset } from "$lib/list/dataset-loader";
  import { datasetSource, type RecordSource } from "$lib/list/source";
  import { EmptyState, Skeleton } from "$lib/tallao";

  import { page } from "$app/stores";

  const datasetId = $derived($page.params.id ?? "");
  const entryId = $derived($page.params.entryId ?? "new");

  let source = $state<RecordSource | null>(null);
  let error = $state<string | null>(null);

  async function load(id: string) {
    error = null;
    try {
      const dataset = await loadDataset(id);
      source = datasetSource(dataset, { status: t("common.status"), entry: t("list.entry") });
    } catch (e) {
      source = null;
      error = (e as Error)?.message ?? String(e);
    }
  }

  $effect(() => {
    void load(datasetId);
  });

  const base = $derived(`/datasets/${datasetId}/entries`);
</script>

{#if source}
  <RecordPage
    {source}
    id={entryId}
    listHref={base}
    hrefFor={(id) => `${base}/${id}`}
    crumbs={[{ label: source.label, href: base }]}
  />
{:else}
  <Page title={t("titles.entries")} crumbs={[{ label: "…" }]}>
    {#if error}
      <EmptyState variant="error" description={error} onRetry={() => load(datasetId)} />
    {:else}
      <Skeleton lines={6} />
    {/if}
  </Page>
{/if}
