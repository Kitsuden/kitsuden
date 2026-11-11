<!--
  The records of one model, on the list template: columns, filters (its enum and boolean
  fields the API can filter by) and sort come from the model's descriptor; what the user
  cannot see or touch is decided by the API (permission + row security), not here.
-->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import QuickAddDialog from "$lib/components/list/QuickAddDialog.svelte";
  import { localeFormat, t } from "$lib/i18n";
  import { modelSource, type RecordSource } from "$lib/list/source";
  import { findModel, type MountedModel } from "$lib/services/models";
  import { Button, EmptyState, Skeleton } from "$lib/tallao";

  import { page } from "$app/stores";

  const kon = $derived($page.params.kon ?? "");
  const name = $derived($page.params.model ?? "");
  const base = $derived(`/models/${encodeURIComponent(kon)}/${encodeURIComponent(name)}`);

  let model = $state<MountedModel | null>(null);
  let source = $state<RecordSource | null>(null);
  let phase = $state<"loading" | "ready" | "missing" | "error">("loading");
  let error = $state("");
  let total = $state<number | null>(null);
  let quickAdd = $state(false);
  let reloadKey = $state(0);

  async function load(k: string, n: string) {
    phase = "loading";
    source = null;
    try {
      model = await findModel(k, n);
      if (!model) {
        phase = "missing";
        return;
      }
      source = modelSource(model.kon, model.base, model.descriptor);
      phase = "ready";
    } catch (e) {
      error = (e as Error)?.message || t("models.errorLoading");
      phase = "error";
    }
  }

  $effect(() => {
    void load(kon, name);
  });

  const access = (value: string) =>
    value === "public"
      ? t("models.access_public")
      : value === "owner"
        ? t("models.access_owner")
        : value === "staff"
          ? t("models.access_staff")
          : value;
</script>

<Page
  title={source?.label ?? name}
  description={model?.descriptor.description}
  crumbs={[{ label: source?.label ?? name }]}
>
  {#snippet meta()}
    {#if model}
      {#if total !== null}
        {total === 1
          ? t("list.countOne")
          : t("list.count", { n: total.toLocaleString(localeFormat()) })} ·
      {/if}
      {t("models.readAccess", { value: access(model.descriptor.access.read) })} ·
      {t("models.writeAccess", { value: access(model.descriptor.access.write) })} ·
      {t("models.scopes", {
        read: model.descriptor.scopes.read,
        write: model.descriptor.scopes.write,
      })}
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if source}
      <Button variant="secondary" onclick={() => (quickAdd = true)}>{t("list.quickAdd")}</Button>
      <Button href={`${base}/new`}>{t("list.newOne", { name: source.singular })}</Button>
    {/if}
  {/snippet}

  {#if phase === "loading"}
    <Skeleton lines={6} />
  {:else if phase === "error"}
    <EmptyState variant="error" description={error} onRetry={() => load(kon, name)} />
  {:else if phase === "missing" || !source}
    <EmptyState
      title={t("models.notFound", { name })}
      actionLabel={t("shell.models")}
      actionHref="/models"
    />
  {:else}
    {#key source.id}
      <ListView
        {source}
        bind:total
        {reloadKey}
        hrefFor={(row) => `${base}/${source!.rowId(row)}`}
        newHref={`${base}/new`}
      />
    {/key}
    <QuickAddDialog bind:open={quickAdd} {source} onCreated={() => (reloadKey += 1)} />
  {/if}
</Page>
