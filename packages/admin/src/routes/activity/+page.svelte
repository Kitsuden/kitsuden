<!--
  Activity: what the API and the agents did. Requests (the "glass box" of every request),
  agent traces, the approvals audit and the Postgres queue, as tabs. `?tab=` opens one, so
  back/forward and a copied link keep it. /traces and /agents/traces land here.
-->
<script lang="ts">
  import ApprovalAudit from "$lib/components/approvals/ApprovalAudit.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import AgentTraces from "$lib/components/system/AgentTraces.svelte";
  import QueueStatus from "$lib/components/system/QueueStatus.svelte";
  import RequestTraces from "$lib/components/system/RequestTraces.svelte";
  import { t } from "$lib/i18n";
  import { queryChoice, setQuery } from "$lib/page";
  import { Tabs, type TabItem } from "$lib/tallao";

  import { page } from "$app/stores";

  const TABS = ["requests", "agents", "audit", "queue"] as const;
  const LABELS: Record<(typeof TABS)[number], () => string> = {
    requests: () => t("activity.tabRequests"),
    agents: () => t("activity.tabAgents"),
    audit: () => t("activity.tabAudit"),
    queue: () => t("activity.tabQueue"),
  };
  const active = $derived(queryChoice($page.url, "tab", TABS, "requests"));
  const items = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: LABELS[id](),
      controls: "activity-panel",
      tabId: `activity-tab-${id}`,
    }))
  );
  const select = (tab: string) =>
    void setQuery($page.url, { tab: tab === "requests" ? null : tab });
</script>

<Page title={t("shell.activity")} description={t("activity.description")}>
  {#snippet tabs()}
    <Tabs
      {items}
      bind:value={() => active, select}
      panels={false}
      ariaLabel={t("shell.activity")}
    />
  {/snippet}

  <div id="activity-panel" role="tabpanel" aria-labelledby="activity-tab-{active}">
    {#if active === "requests"}
      <RequestTraces />
    {:else if active === "agents"}
      <AgentTraces />
    {:else if active === "audit"}
      <ApprovalAudit />
    {:else}
      <QueueStatus />
    {/if}
  </div>
</Page>
