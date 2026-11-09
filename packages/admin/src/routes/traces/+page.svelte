<!--
  System: the "glass box" of requests and the Postgres
  queue (B1). The AGENTS' traces remain at /agents/traces.
  `?tab=requests|queue` opens the requested tab.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Activity, ListChecks, Workflow } from "lucide-svelte";

  import QueueStatus from "$lib/components/system/QueueStatus.svelte";
  import RequestTraces from "$lib/components/system/RequestTraces.svelte";

  import { page } from "$app/stores";

  type Tab = "requests" | "queue";
  const TABS: Tab[] = ["requests", "queue"];
  const initial = $page.url.searchParams.get("tab") as Tab | null;
  let active = $state<Tab>(initial && TABS.includes(initial) ? initial : "requests");
  const ICONS = { requests: Activity, queue: ListChecks };
  const TAGS: Record<Tab, () => string> = {
    requests: () => t("systemTraces.tabRequests"),
    queue: () => t("systemTraces.tabQueue"),
  };
</script>

<div class="h-full flex flex-col">
  <div class="flex flex-wrap items-center gap-4 px-6 py-4 border-b border-zinc-800">
    <div class="flex items-center gap-3 min-w-0">
      <div class="p-2 bg-indigo-500/10 rounded-lg">
        <Workflow size={20} class="text-indigo-400" />
      </div>
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-zinc-100">{t("systemTraces.title")}</h1>
        <p class="text-xs text-zinc-500">
          {t("systemTraces.subtitle")}
          <a href="/agents/traces" class="ml-1 text-indigo-300 hover:underline"
            >{t("systemTraces.agentTracesLink")}</a
          >
        </p>
      </div>
    </div>
    <div class="flex-1"></div>
    <div class="flex items-center gap-1 bg-zinc-900 p-1 rounded-lg" role="tablist">
      {#each TABS as p}
        {@const Icon = ICONS[p]}
        <button
          role="tab"
          aria-selected={active === p}
          class="px-3 py-1.5 text-sm rounded-md transition-colors {active === p
            ? 'bg-zinc-800 text-zinc-100'
            : 'text-zinc-500 hover:text-zinc-300'}"
          onclick={() => (active = p)}
          data-testid="tab-{p}"
        >
          <Icon size={14} class="inline mr-1.5" />
          {TAGS[p]()}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex-1 overflow-y-auto p-6">
    {#if active === "requests"}
      <RequestTraces />
    {:else}
      <QueueStatus />
    {/if}
  </div>
</div>
