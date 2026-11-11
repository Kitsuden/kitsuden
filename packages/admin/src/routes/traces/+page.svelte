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

  import { queryChoice, setQuery } from "$lib/page";
  import { Tabs, type TabItem } from "$lib/tallao";

  import { page } from "$app/stores";

  type Tab = "requests" | "queue";
  const TABS: Tab[] = ["requests", "queue"];
  // The tab is the `?tab=` of the address, so back/forward and a copied link keep it.
  const active = $derived(queryChoice($page.url, "tab", TABS, "requests"));
  function selectTab(tab: string) {
    void setQuery($page.url, { tab: tab === "requests" ? null : tab });
  }
  const TAB_ITEMS = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: TAGS[id](),
      controls: "traces-panel",
      tabId: `traces-tab-${id}`,
    }))
  );
  const ICONS = { requests: Activity, queue: ListChecks };
  const TAGS: Record<Tab, () => string> = {
    requests: () => t("systemTraces.tabRequests"),
    queue: () => t("systemTraces.tabQueue"),
  };
</script>

<div class="h-full flex flex-col">
  <div class="flex flex-wrap items-center gap-4 px-6 py-4 border-b border-kitsuden-border">
    <div class="flex items-center gap-3 min-w-0">
      <div class="p-2 bg-kitsuden-accent/10 rounded-lg">
        <Workflow size={20} class="text-kitsuden-accent" />
      </div>
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-kitsuden-text">{t("systemTraces.title")}</h1>
        <p class="text-xs text-kitsuden-subtle">
          {t("systemTraces.subtitle")}
          <a href="/agents/traces" class="ml-1 text-kitsuden-accent hover:underline"
            >{t("systemTraces.agentTracesLink")}</a
          >
        </p>
      </div>
    </div>
    <div class="flex-1"></div>
    <!-- tallao Tabs: tab roles, arrow keys, roving tabindex (they were bare buttons). -->
    <Tabs
      items={TAB_ITEMS}
      bind:value={() => active, selectTab}
      variant="pills"
      panels={false}
      ariaLabel={t("systemTraces.title")}
    >
      {#snippet tab(item)}
        {@const Icon = ICONS[item.id as Tab]}
        <span class="inline-flex items-center gap-1.5" data-testid="tab-{item.id}">
          <Icon size={14} />
          {item.label}
        </span>
      {/snippet}
    </Tabs>
  </div>

  <div
    class="flex-1 overflow-y-auto p-6"
    id="traces-panel"
    role="tabpanel"
    aria-labelledby="traces-tab-{active}"
  >
    {#if active === "requests"}
      <RequestTraces />
    {:else}
      <QueueStatus />
    {/if}
  </div>
</div>
