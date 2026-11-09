<!--
  Human approval: inbox, settings and audit; and
  agent code promotion.
  `?tab=inbox|reviews|discarded|settings|audit|promotion`, `?id=<proposal>` and `?version=<version>`
  open what was requested.
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import {
    Inbox,
    Settings2,
    ScrollText,
    ShieldCheck,
    GitBranch,
    Ban,
    CalendarClock,
  } from "lucide-svelte";

  import AgentDecisions from "$lib/components/approvals/AgentDecisions.svelte";
  import ApprovalAudit from "$lib/components/approvals/ApprovalAudit.svelte";
  import ApprovalSettings from "$lib/components/approvals/ApprovalSettings.svelte";
  import CodePromotion from "$lib/components/approvals/CodePromotion.svelte";
  import LedgerReviews from "$lib/components/approvals/LedgerReviews.svelte";
  import ProposalInbox from "$lib/components/approvals/ProposalInbox.svelte";
  import { approvals } from "$lib/states/approvals.svelte";
  import { Tabs, type TabItem } from "$lib/tallao";

  import { page } from "$app/stores";

  type Tab = "inbox" | "reviews" | "discarded" | "settings" | "audit" | "promotion";
  // Editors see Discarded too: the API leaves out the agents they sponsor
  // (GET /api/v1/agent-decisions).
  const TABS: Tab[] = ["inbox", "reviews", "discarded", "promotion", "settings", "audit"];
  const initial = $page.url.searchParams.get("tab") as Tab | null;
  let active = $state<Tab>(initial && TABS.includes(initial) ? initial : "inbox");
  const initialId = $page.url.searchParams.get("id");
  const initialVersion = $page.url.searchParams.get("version");

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

<div class="h-full flex flex-col">
  <div class="flex flex-wrap items-center gap-4 px-6 py-4 border-b border-zinc-800">
    <div class="flex items-center gap-3 min-w-0">
      <div class="p-2 bg-indigo-500/10 rounded-lg">
        <ShieldCheck size={20} class="text-indigo-400" />
      </div>
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-zinc-100">{t("approvals.title")}</h1>
        <p class="text-xs text-zinc-500">{t("approvals.subtitle")}</p>
      </div>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-6 pb-6 pt-4">
    <Tabs
      items={TAB_ITEMS}
      bind:value={() => active, (v) => (active = v as Tab)}
      variant="pills"
      wrap
      ariaLabel={t("approvals.title")}
    >
      {#snippet tab(item)}
        {@const Icon = ICONS[item.id as Tab]}
        <Icon size={14} />
        {item.label}
        {#if item.count !== undefined}
          <span
            class="text-[10px] px-1.5 py-0.5 rounded-full bg-kitsuden-amber/20 text-kitsuden-amber"
            >{item.count}</span
          >
        {/if}
      {/snippet}
      <div class="pt-2">
        {#if active === "inbox"}
          <ProposalInbox {initialId} />
        {:else if active === "discarded"}
          <div class="max-w-6xl"><AgentDecisions /></div>
        {:else if active === "reviews"}
          <LedgerReviews />
        {:else if active === "promotion"}
          <CodePromotion {initialVersion} />
        {:else if active === "settings"}
          <div class="max-w-5xl"><ApprovalSettings /></div>
        {:else}
          <ApprovalAudit />
        {/if}
      </div>
    </Tabs>
  </div>
</div>
