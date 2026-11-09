<!--
  Models (defineModel): the list of models of the mounted
  kons (GET /api/models) and, for the chosen one, its generated view.
  `?model=<kon>/<name>` opens one.
-->
<script lang="ts">
  import type { ModelDescriptor } from "@kitsuden/shared";
  import { Database } from "lucide-svelte";

  import ModelView from "$lib/components/models/ModelView.svelte";
  import { api } from "$lib/api";
  import { t } from "$lib/i18n";

  import { page } from "$app/stores";

  interface MountedModel {
    kon: string;
    mountPath: string;
    base: string;
    descriptor: ModelDescriptor;
  }

  let models = $state<MountedModel[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let chosenItem = $state<string | null>($page.url.searchParams.get("model"));

  const key = (m: MountedModel) => `${m.kon}/${m.descriptor.name}`;
  const active = $derived(models.find((m) => key(m) === chosenItem) ?? models[0] ?? null);

  $effect(() => {
    void (async () => {
      try {
        const r = await api.get<{ data: MountedModel[] }>("/api/models");
        models = r.data;
      } catch (e) {
        error = (e as Error).message || t("models.errorLoading");
      } finally {
        loading = false;
      }
    })();
  });
</script>

<div class="h-full flex flex-col">
  <div class="flex items-center gap-3 px-6 py-4 border-b border-zinc-800">
    <div class="p-2 bg-indigo-500/10 rounded-lg">
      <Database size={20} class="text-indigo-400" />
    </div>
    <div class="min-w-0">
      <h1 class="text-lg font-semibold text-zinc-100">{t("models.title")}</h1>
      <p class="text-xs text-zinc-500">{t("models.subtitle")}</p>
    </div>
  </div>

  <div class="flex-1 overflow-auto p-6">
    {#if loading}
      <p class="text-sm text-zinc-500">{t("models.loading")}</p>
    {:else if error}
      <div
        class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        role="alert"
      >
        {t("models.errorLoading")}: {error}
      </div>
    {:else if models.length === 0}
      <div class="card p-12 text-center text-sm text-zinc-500">{t("models.empty")}</div>
    {:else}
      <div class="flex flex-col gap-6 md:flex-row">
        <nav class="md:w-56 shrink-0 space-y-1" aria-label={t("models.pick")}>
          {#each models as m (key(m))}
            <button
              class="w-full rounded-lg px-3 py-2 text-left text-sm {active && key(active) === key(m)
                ? 'bg-indigo-500/10 text-indigo-300'
                : 'text-zinc-300 hover:bg-zinc-800/60'}"
              onclick={() => (chosenItem = key(m))}
            >
              <span class="block font-medium">{m.descriptor.tag}</span>
              <span class="block text-[11px] text-zinc-500">{m.kon}</span>
            </button>
          {/each}
        </nav>
        <div class="min-w-0 flex-1">
          {#if active}
            {#key key(active)}
              <ModelView descriptor={active.descriptor} base={active.base} />
            {/key}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
