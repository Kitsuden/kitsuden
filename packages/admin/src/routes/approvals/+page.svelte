<!--
  Human approval: inbox, settings and audit; and
  agent code promotion.
  `?tab=inbox|reviews|discarded|settings|audit|promotion`, `?id=<proposal>` and `?version=<version>`
  open what was requested.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { Inbox, Settings2, ScrollText, GitBranch, Ban, CalendarClock } from "lucide-svelte";

  import AgentDecisions from "$lib/components/approvals/AgentDecisions.svelte";
  import ApprovalAudit from "$lib/components/approvals/ApprovalAudit.svelte";
  import ApprovalSettings from "$lib/components/approvals/ApprovalSettings.svelte";
  import CodePromotion from "$lib/components/approvals/CodePromotion.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import LedgerReviews from "$lib/components/approvals/LedgerReviews.svelte";
  import ProposalInbox from "$lib/components/approvals/ProposalInbox.svelte";
  import { approvals } from "$lib/states/approvals.svelte";
  import { queryChoice, setQuery } from "$lib/page";
  import { Badge, Tabs, type TabItem } from "$lib/tallao";

  import { page } from "$app/stores";

  type Tab = "inbox" | "reviews" | "discarded" | "settings" | "audit" | "promotion";
  // Editors see Discarded too: the API leaves out the agents they sponsor
  // (GET /api/v1/agent-decisions).
  const TABS: Tab[] = ["inbox", "reviews", "discarded", "promotion", "settings", "audit"];
  /**
   * The tab and the open proposal ARE the address (`?tab=`, `?id=`): choosing one
   * navigates (a history entry), so back/forward walk them and a copied link opens the
   * same thing. They used to be read once and never written back.
   */
  const active = $derived(queryChoice($page.url, "tab", TABS, "inbox"));
  const selectedId = $derived($page.url.searchParams.get("id"));
  const initialVersion = $page.url.searchParams.get("version");

  function selectTab(tab: string) {
    // Another tab is another subject: the open proposal does not follow.
    void setQuery($page.url, { tab: tab === "inbox" ? null : tab, id: null, version: null });
  }
  function selectProposal(id: string | null) {
    void setQuery($page.url, { id });
  }

  const ICONS = {
    inbox: Inbox,
    reviews: CalendarClock,
    discarded: Ban,
    settings: Settings2,
    audit: ScrollText,
    promotion: GitBranch,
  };
  const TAB_ITEMS = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: TAGS[id](),
      count: id === "inbox" && approvals.pendingItems > 0 ? approvals.pendingItems : undefined,
      controls: "approvals-panel",
      tabId: `approvals-tab-${id}`,
    }))
  );
  const TAGS: Record<Tab, () => string> = {
    inbox: () => t("approvals.tabInbox"),
    reviews: () => t("approvals.tabReviews"),
    discarded: () => t("approvals.tabDiscarded"),
    settings: () => t("approvals.tabSettings"),
    audit: () => t("approvals.tabAudit"),
    promotion: () => t("approvals.tabPromotion"),
  };
</script>

<Page title={t("shell.approvals")} description={t("approvals.subtitle")}>
  {#snippet meta()}
    {#if approvals.pendingItems > 0}
      {t("sidebarLayout.approvalsPending", { n: approvals.pendingItems })}
    {/if}
  {/snippet}
  {#snippet tabs()}
    <Tabs
      items={TAB_ITEMS}
      bind:value={() => active, selectTab}
      panels={false}
      ariaLabel={t("approvals.title")}
    >
      {#snippet tab(item)}
        {@const Icon = ICONS[item.id as Tab]}
        <Icon size={14} aria-hidden="true" />
        {item.label}
        {#if item.count !== undefined}
          <Badge variant="warning" size="sm">{item.count}</Badge>
        {/if}
      {/snippet}
    </Tabs>
  {/snippet}

  <div id="approvals-panel" role="tabpanel" aria-labelledby="approvals-tab-{active}">
    {#if active === "inbox"}
      <ProposalInbox {selectedId} onSelect={selectProposal} />
    {:else if active === "discarded"}
      <AgentDecisions />
    {:else if active === "reviews"}
      <LedgerReviews />
    {:else if active === "promotion"}
      <CodePromotion {initialVersion} />
    {:else if active === "settings"}
      <ApprovalSettings />
    {:else}
      <ApprovalAudit />
    {/if}
  </div>
</Page>
