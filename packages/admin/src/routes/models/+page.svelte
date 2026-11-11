<!--
  Models (defineModel): the models the mounted kons expose (GET /api/models), on the list
  template. Each one opens its own list at /models/<kon>/<name>; the older
  `?model=<kon>/<name>` address still lands there.
-->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import { t } from "$lib/i18n";
  import { memorySource, type Row } from "$lib/list/source";
  import { listModels, modelPath, type MountedModel } from "$lib/services/models";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  let models = $state<MountedModel[]>([]);
  let total = $state<number | null>(null);

  const asRow = (m: MountedModel): Row => ({
    id: `${m.kon}/${m.descriptor.name}`,
    name: m.descriptor.tag || m.descriptor.plural,
    kon: m.kon,
    table: m.descriptor.table,
    description: m.descriptor.description,
    fields: m.descriptor.fields.length,
    read: m.descriptor.access.read,
    write: m.descriptor.access.write,
  });

  const options = (values: string[]) =>
    [...new Set(values)].sort().map((value) => ({ value, label: value }));
  const konOptions = $derived(options(models.map((m) => m.kon)));
  const accessOptions = $derived(
    options(models.flatMap((m) => [m.descriptor.access.read, m.descriptor.access.write]))
  );

  const source = $derived(
    memorySource({
      id: "models",
      label: t("shell.models"),
      singular: t("models.model"),
      titleField: "name",
      fields: [
        { key: "name", label: t("common.name"), kind: "text", sortable: true },
        { key: "kon", label: t("models.kon"), kind: "select", sortable: true, options: konOptions },
        { key: "description", label: t("common.description"), kind: "text" },
        { key: "table", label: t("models.table"), kind: "id", sortable: true },
        { key: "fields", label: t("common.fields"), kind: "number", sortable: true },
        { key: "read", label: t("models.readColumn"), kind: "select", options: accessOptions },
        { key: "write", label: t("models.writeColumn"), kind: "select", options: accessOptions },
      ],
      rows: () => models.map(asRow),
    })
  );

  let loaded = $state(false);
  let error = $state<string | null>(null);
  async function load(fresh = false) {
    error = null;
    try {
      models = await listModels({ fresh });
    } catch (e) {
      error = (e as Error)?.message || t("models.errorLoading");
    } finally {
      loaded = true;
    }
  }
  $effect(() => {
    void load();
  });

  // `?model=<kon>/<name>` was how a model was opened before each had its own address.
  $effect(() => {
    const legacy = $page.url.searchParams.get("model");
    if (!legacy || !legacy.includes("/")) return;
    const [kon, name] = legacy.split("/");
    void goto(`/models/${encodeURIComponent(kon!)}/${encodeURIComponent(name!)}`, {
      replaceState: true,
    });
  });

  const hrefFor = (row: Row) => {
    const model = models.find((m) => `${m.kon}/${m.descriptor.name}` === row.id);
    return model ? modelPath(model) : undefined;
  };
</script>

<Page title={t("shell.models")} description={t("models.subtitle")}>
  {#snippet meta()}
    {#if total !== null}{t("models.count", { n: total })}{/if}
  {/snippet}

  <ListView
    {source}
    bind:total
    {hrefFor}
    canDelete={false}
    pending={!loaded}
    loadError={error}
    onRetry={() => load(true)}
    emptyTitle={t("models.noModels")}
    emptyDescription={t("models.empty")}
  />
</Page>
