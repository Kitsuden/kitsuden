<!-- One record of a model at its own URL: /models/<kon>/<name>/<id>, or …/new. -->
<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import RecordPage from "$lib/components/list/RecordPage.svelte";
  import { t } from "$lib/i18n";
  import { modelSource, type RecordSource } from "$lib/list/source";
  import { findModel } from "$lib/services/models";
  import { EmptyState, Skeleton } from "$lib/tallao";

  import { page } from "$app/stores";

  const kon = $derived($page.params.kon ?? "");
  const name = $derived($page.params.model ?? "");
  const id = $derived($page.params.id ?? "new");
  const base = $derived(`/models/${encodeURIComponent(kon)}/${encodeURIComponent(name)}`);

  let source = $state<RecordSource | null>(null);
  let phase = $state<"loading" | "ready" | "missing" | "error">("loading");
  let error = $state("");

  async function load(k: string, n: string) {
    phase = "loading";
    try {
      const model = await findModel(k, n);
      source = model ? modelSource(model.kon, model.base, model.descriptor) : null;
      phase = model ? "ready" : "missing";
    } catch (e) {
      error = (e as Error)?.message || t("models.errorLoading");
      phase = "error";
    }
  }

  $effect(() => {
    void load(kon, name);
  });
</script>

{#if phase === "ready" && source}
  <RecordPage
    {source}
    {id}
    listHref={base}
    hrefFor={(recordId) => `${base}/${recordId}`}
    crumbs={[{ label: source.label, href: base }]}
  />
{:else}
  <Page title={name} crumbs={[{ label: name }]}>
    {#if phase === "loading"}
      <Skeleton lines={6} />
    {:else if phase === "error"}
      <EmptyState variant="error" description={error} onRetry={() => load(kon, name)} />
    {:else}
      <EmptyState
        title={t("models.notFound", { name })}
        actionLabel={t("shell.models")}
        actionHref="/models"
      />
    {/if}
  </Page>
{/if}
