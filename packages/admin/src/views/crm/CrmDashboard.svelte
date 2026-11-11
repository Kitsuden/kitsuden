<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Users,
    Building2,
    Briefcase,
    TrendingUp,
    Search,
    ChevronLeft,
    ChevronRight,
    Plus,
    Trash2,
    Edit2,
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
    ChevronDown,
    ChevronUp,
    Inbox,
    Kanban,
    CheckSquare,
    Square,
  } from "lucide-svelte";
  import { onMount } from "svelte";
  import {
    toast,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Button,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  import type {
    CRMStats,
    CrmDeal,
    CrmContact,
    CrmCompany,
    CrmPipeline,
    CrmPipelineStage,
  } from "./types";

  import { goto } from "$app/navigation";

  type Tab = "overview" | "deals" | "contacts" | "companies" | "pipelines";
  let activeTab = $state<Tab>("overview");

  let stats = $state<CRMStats | null>(null);
  let statsLoading = $state(true);
  let pipelines = $state<CrmPipeline[]>([]);
  let pipelinesLoading = $state(false);

  let deals = $state<CrmDeal[]>([]),
    dealsPag = $state({ total: 0, limit: 10, offset: 0 }),
    dealsLoading = $state(false),
    dealsSearch = $state(""),
    dealsStatus = $state(""),
    dealsPipelineId = $state(""),
    dealsSortField = $state<"value" | "expectedCloseDate" | "">(""),
    dealsSortDir = $state<"asc" | "desc">("desc"),
    selDeals = $state<Set<string>>(new Set());
  let contacts = $state<CrmContact[]>([]),
    contactsPag = $state({ total: 0, limit: 10, offset: 0 }),
    contactsLoading = $state(false),
    contactsSearch = $state(""),
    contactsStatus = $state(""),
    selContacts = $state<Set<string>>(new Set());
  let companies = $state<CrmCompany[]>([]),
    companiesPag = $state({ total: 0, limit: 10, offset: 0 }),
    companiesLoading = $state(false),
    companiesSearch = $state(""),
    companiesIndustry = $state(""),
    selCompanies = $state<Set<string>>(new Set());

  let recentDeals = $state<CrmDeal[]>([]),
    recentContacts = $state<CrmContact[]>([]),
    overviewLoading = $state(false);
  let expandedPipelineId = $state<string | null>(null),
    pipelineStages = $state<Record<string, CrmPipelineStage[]>>({});

  function fmtCur(cents = 0, cur = "USD") {
    return new Intl.NumberFormat(localeFormat(), {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  }
  function fmtDate(d?: string) {
    return d
      ? new Date(d).toLocaleDateString(localeFormat(), {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "—";
  }
  function ago(d?: string) {
    if (!d) return "—";
    const diff = Date.now() - new Date(d).getTime(),
      m = Math.floor(diff / 60000),
      h = Math.floor(diff / 3600000),
      D = Math.floor(diff / 86400000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${D}d ago`;
  }

  const dCols: Record<string, string> = {
    open: "bg-kitsuden-accent/10 text-kitsuden-accent border-kitsuden-accent/20",
    won: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
    lost: "bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border-kitsuden-accent-2/20",
    paused: "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20",
  };
  const cCols: Record<string, string> = {
    lead: "bg-kitsuden-accent/10 text-kitsuden-accent border-kitsuden-accent/20",
    prospect: "bg-kitsuden-amber/10 text-kitsuden-amber border-kitsuden-amber/20",
    customer: "bg-kitsuden-green/10 text-kitsuden-green border-kitsuden-green/20",
    churned: "bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border-kitsuden-accent-2/20",
    archived: "bg-kitsuden-subtle/10 text-kitsuden-subtle border-kitsuden-subtle/20",
  };

  async function loadStats() {
    statsLoading = true;
    try {
      stats = (await api.getCrmStats()).data as CRMStats;
    } catch (e: any) {
      toast.error(tr("crmDashboard.statsError") + e.message);
    } finally {
      statsLoading = false;
    }
  }
  async function loadPipelines() {
    pipelinesLoading = true;
    try {
      pipelines = (await api.getCrmPipelines()).data as CrmPipeline[];
    } catch (e: any) {
      toast.error(tr("crmDashboard.pipelinesError") + e.message);
    } finally {
      pipelinesLoading = false;
    }
  }
  async function loadDeals() {
    dealsLoading = true;
    try {
      const res = await api.getCrmDeals({
        limit: dealsPag.limit,
        offset: dealsPag.offset,
        search: dealsSearch || undefined,
        status: dealsStatus || undefined,
        pipelineId: dealsPipelineId || undefined,
      });
      let data = (res.data as CrmDeal[]) ?? [];
      if (dealsSortField)
        data = [...data].sort((a, b) => {
          let av: any, bv: any;
          if (dealsSortField === "value") {
            av = a.value ?? 0;
            bv = b.value ?? 0;
          } else {
            av = a.expectedCloseDate || "";
            bv = b.expectedCloseDate || "";
          }
          return dealsSortDir === "asc" ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
        });
      deals = data;
      dealsPag = { ...(res.pagination ?? dealsPag), total: res.pagination?.total ?? data.length };
    } catch (e: any) {
      toast.error(tr("crmDashboard.dealsError") + e.message);
    } finally {
      dealsLoading = false;
    }
  }
  async function loadContacts() {
    contactsLoading = true;
    try {
      const res = await api.getCrmContacts({
        limit: contactsPag.limit,
        offset: contactsPag.offset,
        search: contactsSearch || undefined,
        status: contactsStatus || undefined,
      });
      contacts = (res.data as CrmContact[]) ?? [];
      contactsPag = {
        ...(res.pagination ?? contactsPag),
        total: res.pagination?.total ?? contacts.length,
      };
    } catch (e: any) {
      toast.error(tr("crmDashboard.contactsError") + e.message);
    } finally {
      contactsLoading = false;
    }
  }
  async function loadCompanies() {
    companiesLoading = true;
    try {
      const res = await api.getCrmCompanies({
        limit: companiesPag.limit,
        offset: companiesPag.offset,
        search: companiesSearch || undefined,
        industry: companiesIndustry || undefined,
      });
      companies = (res.data as CrmCompany[]) ?? [];
      companiesPag = {
        ...(res.pagination ?? companiesPag),
        total: res.pagination?.total ?? companies.length,
      };
    } catch (e: any) {
      toast.error(tr("crmDashboard.companiesError") + e.message);
    } finally {
      companiesLoading = false;
    }
  }
  async function loadOverview() {
    overviewLoading = true;
    try {
      const [d, c] = await Promise.all([
        api.getCrmDeals({ limit: 5, offset: 0 }),
        api.getCrmContacts({ limit: 5, offset: 0 }),
      ]);
      recentDeals = (d.data as CrmDeal[]) ?? [];
      recentContacts = (c.data as CrmContact[]) ?? [];
    } catch (e: any) {
      toast.error(tr("crmDashboard.overviewError") + e.message);
    } finally {
      overviewLoading = false;
    }
  }
  async function togglePipeline(id: string) {
    if (expandedPipelineId === id) {
      expandedPipelineId = null;
      return;
    }
    expandedPipelineId = id;
    if (!pipelineStages[id]) {
      try {
        const d = (await api.getCrmPipeline(id)).data as CrmPipeline & {
          stages: CrmPipelineStage[];
        };
        pipelineStages = { ...pipelineStages, [id]: d.stages ?? [] };
      } catch (e: any) {
        toast.error(tr("crmDashboard.stagesError") + e.message);
      }
    }
  }

  async function ofTheDeal(id: string) {
    if (!(await confirmDialog(tr("crmDashboard.deleteThisDeal")))) return;
    try {
      await api.deleteCrmDeal(id);
      toast.success(tr("crmDashboard.dealDeleted"));
      await loadDeals();
      await loadStats();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function bulkDelDeals() {
    if (
      !selDeals.size ||
      !(await confirmDialog(tr("crmDashboard.deleteDeals", { size: selDeals.size })))
    )
      return;
    await Promise.all([...selDeals].map((id) => api.deleteCrmDeal(id)));
    toast.success(tr("crmDashboard.dealsDeleted", { size: selDeals.size }));
    selDeals = new Set();
    await loadDeals();
    await loadStats();
  }
  async function ofTheContact(id: string) {
    if (!(await confirmDialog(tr("crmDashboard.deleteThisContact")))) return;
    try {
      await api.deleteCrmContact(id);
      toast.success(tr("crmDashboard.contactDeleted"));
      await loadContacts();
      await loadStats();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function bulkDelContacts() {
    if (
      !selContacts.size ||
      !(await confirmDialog(tr("crmDashboard.deleteContacts", { size: selContacts.size })))
    )
      return;
    await Promise.all([...selContacts].map((id) => api.deleteCrmContact(id)));
    toast.success(tr("crmDashboard.contactsDeleted", { size: selContacts.size }));
    selContacts = new Set();
    await loadContacts();
    await loadStats();
  }
  async function ofTheCompany(id: string) {
    if (!(await confirmDialog(tr("crmDashboard.deleteThisCompany")))) return;
    try {
      await api.deleteCrmCompany(id);
      toast.success(tr("crmDashboard.companyDeleted"));
      await loadCompanies();
      await loadStats();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function bulkDelCompanies() {
    if (
      !selCompanies.size ||
      !(await confirmDialog(tr("crmDashboard.deleteCompanies", { size: selCompanies.size })))
    )
      return;
    await Promise.all([...selCompanies].map((id) => api.deleteCrmCompany(id)));
    toast.success(tr("crmDashboard.companiesDeleted", { size: selCompanies.size }));
    selCompanies = new Set();
    await loadCompanies();
    await loadStats();
  }

  function setDealSort(f: "value" | "expectedCloseDate") {
    if (dealsSortField === f) dealsSortDir = dealsSortDir === "asc" ? "desc" : "asc";
    else {
      dealsSortField = f;
      dealsSortDir = "desc";
    }
    loadDeals();
  }
  function pg(t: "deals" | "contacts" | "companies", dir: -1 | 1) {
    if (t === "deals") {
      const n = dealsPag.offset + dir * dealsPag.limit;
      if (n < 0 || n >= dealsPag.total) return;
      dealsPag = { ...dealsPag, offset: n };
      loadDeals();
    } else if (t === "contacts") {
      const n = contactsPag.offset + dir * contactsPag.limit;
      if (n < 0 || n >= contactsPag.total) return;
      contactsPag = { ...contactsPag, offset: n };
      loadContacts();
    } else {
      const n = companiesPag.offset + dir * companiesPag.limit;
      if (n < 0 || n >= companiesPag.total) return;
      companiesPag = { ...companiesPag, offset: n };
      loadCompanies();
    }
  }
  function pageLabel(p: { offset: number; limit: number; total: number }) {
    return tr("crmDashboard.pageOf", {
      v: Math.floor(p.offset / p.limit) + 1,
      v2: Math.max(1, Math.ceil(p.total / p.limit)),
    });
  }

  function toggleAll(rows: any[], sel: Set<string>) {
    const all = rows.length && rows.every((r) => sel.has(r.id));
    const next = new Set(sel);
    rows.forEach((r) => (all ? next.delete(r.id) : next.add(r.id)));
    return next;
  }
  function toggleOne(sel: Set<string>, id: string) {
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }

  $effect(() => {
    const tab = activeTab;
    if (tab === "overview") loadOverview();
    else if (tab === "deals") loadDeals();
    else if (tab === "contacts") loadContacts();
    else if (tab === "companies") loadCompanies();
    else if (tab === "pipelines") loadPipelines();
  });
  onMount(() => {
    loadStats();
    loadOverview();
    loadPipelines();
  });
</script>

<ViewPage
  title={tr("crmDashboard.crmDashboard")}
  description={tr("crmDashboard.manageDealsContactsCompaniesAnd")}
>
  {#snippet actions()}
    <Button onclick={() => goto("/g/kon-crm/deals")} size="sm"
      ><Plus class="w-4 h-4" /> {tr("crmDashboard.addDeal")}</Button
    >
  {/snippet}

  <div class="space-y-6">
    <!-- Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#if statsLoading}
        {#each [1, 2, 3, 4] as _}
          <div class="card p-5 animate-pulse">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-kitsuden-bg"></div>
              <div class="space-y-2">
                <div class="h-3 w-20 bg-kitsuden-bg rounded-sm"></div>
                <div class="h-6 w-24 bg-kitsuden-bg rounded-sm"></div>
              </div>
            </div>
          </div>
        {/each}
      {:else if stats}
        {@const cards = [
          {
            label: tr("crmDashboard.contacts"),
            value: stats.contacts.toLocaleString(localeFormat()),
            icon: Users,
            cls: "bg-kitsuden-accent/10 text-kitsuden-accent",
          },
          {
            label: tr("crmDashboard.companies"),
            value: stats.companies.toLocaleString(localeFormat()),
            icon: Building2,
            cls: "bg-kitsuden-green/10 text-kitsuden-green",
          },
          {
            label: tr("crmDashboard.openDeals"),
            value: fmtCur(stats.deals.values.open),
            icon: Briefcase,
            cls: "bg-kitsuden-amber/10 text-kitsuden-amber",
          },
          {
            label: tr("crmDashboard.pipelineValue"),
            value: fmtCur(stats.deals.values.total),
            icon: TrendingUp,
            cls: "bg-kitsuden-accent/10 text-kitsuden-accent",
          },
        ]}
        {#each cards as c}
          <div class="card p-5">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-lg {c.cls.split(' ')[0]} flex items-center justify-center"
              >
                <c.icon class="w-5 h-5 {c.cls.split(' ')[1]}" />
              </div>
              <div>
                <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">{c.label}</p>
                <p class="text-xl font-bold text-kitsuden-text">{c.value}</p>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Tabs -->
    <div class="border-b border-kitsuden-border">
      <nav class="flex gap-1 -mb-px">
        {#each [{ id: "overview", l: "Overview" }, { id: "deals", l: "Deals" }, { id: "contacts", l: "Contacts" }, { id: "companies", l: "Companies" }, { id: "pipelines", l: "Pipelines" }] as { id, l }}
          <button
            onclick={() => {
              activeTab = id as Tab;
            }}
            class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer {activeTab ===
            id
              ? 'border-kitsuden-accent text-kitsuden-accent'
              : 'border-transparent text-kitsuden-subtle hover:text-kitsuden-text'}">{l}</button
          >
        {/each}
      </nav>
    </div>

    <!-- OVERVIEW -->
    {#if activeTab === "overview"}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-fade-in">
        <section class="card">
          <div class="p-4 border-b border-kitsuden-border flex items-center justify-between">
            <h3 class="font-semibold text-kitsuden-text text-sm">
              {tr("crmDashboard.recentDeals")}
            </h3>
            <button
              onclick={() => (activeTab = "deals")}
              class="text-xs text-kitsuden-accent hover:underline"
              >{tr("crmDashboard.viewAll")}</button
            >
          </div>
          <div class="divide-y divide-kitsuden-border">
            {#if overviewLoading}
              {#each [1, 2, 3] as _}
                <div class="p-3 animate-pulse flex justify-between">
                  <div class="h-4 w-32 bg-kitsuden-bg rounded-sm"></div>
                  <div class="h-4 w-16 bg-kitsuden-bg rounded-sm"></div>
                </div>
              {/each}
            {:else if !recentDeals.length}
              <div class="p-8 text-center text-kitsuden-subtle text-sm">
                {tr("crmDashboard.noDealsYet")}
              </div>
            {:else}
              {#each recentDeals as d}
                <div class="p-3 flex justify-between hover:bg-kitsuden-bg/40 transition-colors">
                  <div class="min-w-0">
                    <p class="text-sm text-kitsuden-text truncate font-medium">{d.title}</p>
                    <p class="text-xs text-kitsuden-subtle">
                      {d.source || tr("crmDashboard.noSource")}
                    </p>
                  </div>
                  <div class="text-right shrink-0 ml-3">
                    <p class="text-sm font-semibold text-kitsuden-text">
                      {fmtCur(d.value, d.currency)}
                    </p>
                    <span
                      class="inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded-full border {dCols[
                        d.status
                      ] || dCols.open}">{d.status}</span
                    >
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </section>

        <section class="card">
          <div class="p-4 border-b border-kitsuden-border flex items-center justify-between">
            <h3 class="font-semibold text-kitsuden-text text-sm">
              {tr("crmDashboard.recentContacts")}
            </h3>
            <button
              onclick={() => (activeTab = "contacts")}
              class="text-xs text-kitsuden-accent hover:underline"
              >{tr("crmDashboard.viewAll")}</button
            >
          </div>
          <div class="divide-y divide-kitsuden-border">
            {#if overviewLoading}
              {#each [1, 2, 3] as _}
                <div class="p-3 animate-pulse flex justify-between">
                  <div class="h-4 w-32 bg-kitsuden-bg rounded-sm"></div>
                  <div class="h-4 w-16 bg-kitsuden-bg rounded-sm"></div>
                </div>
              {/each}
            {:else if !recentContacts.length}
              <div class="p-8 text-center text-kitsuden-subtle text-sm">
                {tr("crmDashboard.noContactsYet")}
              </div>
            {:else}
              {#each recentContacts as c}
                <div class="p-3 flex justify-between hover:bg-kitsuden-bg/40 transition-colors">
                  <div class="min-w-0">
                    <p class="text-sm text-kitsuden-text truncate font-medium">
                      {c.firstName}
                      {c.lastName}
                    </p>
                    <p class="text-xs text-kitsuden-subtle">{c.email}</p>
                  </div>
                  <div class="text-right shrink-0 ml-3">
                    <span
                      class="inline-block px-2 py-0.5 text-xs font-medium rounded-full border {cCols[
                        c.status
                      ] || cCols.lead}">{c.status}</span
                    >
                    {#if c.score}<p class="text-xs text-kitsuden-subtle mt-0.5">
                        {tr("crmDashboard.score", { score: c.score })}
                      </p>{/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </section>

        <section class="card p-4 lg:col-span-2">
          <h3 class="font-semibold text-kitsuden-text text-sm mb-3">
            {tr("crmDashboard.quickActions")}
          </h3>
          <div class="flex flex-wrap gap-2">
            <button
              onclick={() => goto("/g/kon-crm/deals")}
              class="btn-primary inline-flex items-center gap-2 text-sm"
              ><Plus class="w-4 h-4" /> {tr("crmDashboard.addDeal")}</button
            >
            <button
              onclick={() => goto("/g/kon-crm/contacts")}
              class="btn-secondary inline-flex items-center gap-2 text-sm"
              ><Plus class="w-4 h-4" /> {tr("crmDashboard.addContact")}</button
            >
            <button
              onclick={() => goto("/g/kon-crm/companies")}
              class="btn-secondary inline-flex items-center gap-2 text-sm"
              ><Plus class="w-4 h-4" /> {tr("crmDashboard.addCompany")}</button
            >
          </div>
        </section>
      </div>
    {/if}

    <!-- DEALS -->
    {#if activeTab === "deals"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1">
            <div class="relative flex-1 max-w-sm">
              <Search
                class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle"
              /><input
                bind:value={dealsSearch}
                oninput={() => {
                  dealsPag.offset = 0;
                  loadDeals();
                }}
                placeholder={tr("crmDashboard.searchDeals")}
                class="w-full pl-9 pr-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent"
              />
            </div>
            <select
              bind:value={dealsStatus}
              onchange={() => {
                dealsPag.offset = 0;
                loadDeals();
              }}
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
              ><option value="">{tr("crmDashboard.allStatuses")}</option><option value="open"
                >{tr("crmDashboard.open")}</option
              ><option value="won">{tr("crmDashboard.won")}</option><option value="lost"
                >{tr("crmDashboard.lost")}</option
              ><option value="paused">{tr("crmDashboard.paused")}</option></select
            >
            <select
              bind:value={dealsPipelineId}
              onchange={() => {
                dealsPag.offset = 0;
                loadDeals();
              }}
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
              ><option value="">{tr("crmDashboard.allPipelines")}</option
              >{#each pipelines as p}<option value={p.id}>{p.name}</option>{/each}</select
            >
          </div>
          {#if selDeals.size}<button
              onclick={bulkDelDeals}
              class="btn-danger inline-flex items-center gap-2 text-sm"
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selDeals.size })}</button
            >{/if}
        </div>

        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-sm">
              <TableHeader
                ><TableRow class="border-b border-kitsuden-border bg-kitsuden-bg/50">
                  <TableHead class="px-4 py-3 text-left w-10"
                    ><button
                      onclick={() => (selDeals = toggleAll(deals, selDeals))}
                      class="text-kitsuden-subtle hover:text-kitsuden-text"
                      >{#if deals.length && deals.every((r) => selDeals.has(r.id))}<CheckSquare
                          class="w-4 h-4"
                        />{:else}<Square class="w-4 h-4" />{/if}</button
                    ></TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.title")}</TableHead
                  >
                  <TableHead
                    class="px-4 py-3 text-left font-medium text-kitsuden-subtle cursor-pointer select-none"
                    onclick={() => setDealSort("value")}
                    ><span class="flex items-center gap-1"
                      >{tr("crmDashboard.value")}
                      {#if dealsSortField === "value"}{#if dealsSortDir === "asc"}<ArrowUp
                            class="w-3 h-3"
                          />{:else}<ArrowDown class="w-3 h-3" />{/if}{:else}<ArrowUpDown
                          class="w-3 h-3"
                        />{/if}</span
                    ></TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.status")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.probability")}</TableHead
                  >
                  <TableHead
                    class="px-4 py-3 text-left font-medium text-kitsuden-subtle cursor-pointer select-none"
                    onclick={() => setDealSort("expectedCloseDate")}
                    ><span class="flex items-center gap-1"
                      >{tr("crmDashboard.expectedClose")}
                      {#if dealsSortField === "expectedCloseDate"}{#if dealsSortDir === "asc"}<ArrowUp
                            class="w-3 h-3"
                          />{:else}<ArrowDown class="w-3 h-3" />{/if}{:else}<ArrowUpDown
                          class="w-3 h-3"
                        />{/if}</span
                    ></TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.source")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.tags")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-right font-medium text-kitsuden-subtle"
                    >{tr("common.actions")}</TableHead
                  >
                </TableRow></TableHeader
              >
              <TableBody class="divide-y divide-kitsuden-border">
                {#if dealsLoading}{#each [1, 2, 3, 4] as _}<TableRow class="animate-pulse"
                      ><TableCell colspan={9} class="px-4 py-3"
                        ><div class="h-4 bg-kitsuden-bg rounded-sm w-full"></div></TableCell
                      ></TableRow
                    >{/each}
                {:else if !deals.length}<TableRow
                    ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                      ><Inbox class="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p class="text-sm">{tr("crmDashboard.noDealsFound")}</p></TableCell
                    ></TableRow
                  >
                {:else}{#each deals as d}<TableRow
                      class="hover:bg-kitsuden-bg/30 transition-colors"
                    >
                      <TableCell class="px-4 py-3"
                        ><button
                          onclick={() => (selDeals = toggleOne(selDeals, d.id))}
                          class="text-kitsuden-subtle hover:text-kitsuden-text"
                          >{#if selDeals.has(d.id)}<CheckSquare class="w-4 h-4" />{:else}<Square
                              class="w-4 h-4"
                            />{/if}</button
                        ></TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text font-medium"
                        >{d.title}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text"
                        >{fmtCur(d.value, d.currency)}</TableCell
                      >
                      <TableCell class="px-4 py-3"
                        ><span
                          class="inline-block px-2 py-0.5 text-xs font-medium rounded-full border {dCols[
                            d.status
                          ] || dCols.open}">{d.status}</span
                        ></TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text"
                        >{d.probability ?? 0}%</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{fmtDate(d.expectedCloseDate)}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle">{d.source || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3"
                        ><div class="flex flex-wrap gap-1">
                          {#each (d.tags ?? []).slice(0, 3) as t}<span
                              class="px-1.5 py-0.5 text-xs rounded-sm bg-kitsuden-bg border border-kitsuden-border text-kitsuden-subtle"
                              >{t}</span
                            >{/each}{#if (d.tags ?? []).length > 3}<span
                              class="px-1.5 py-0.5 text-xs rounded-sm bg-kitsuden-bg border border-kitsuden-border text-kitsuden-subtle"
                              >+{(d.tags ?? []).length - 3}</span
                            >{/if}
                        </div></TableCell
                      >
                      <TableCell class="px-4 py-3 text-right"
                        ><div class="flex justify-end gap-1">
                          <button
                            onclick={() => goto(`/crm/deals/${d.id}`)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent transition-colors"
                            title={tr("common.edit")}><Edit2 class="w-3.5 h-3.5" /></button
                          ><button
                            onclick={() => ofTheDeal(d.id)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent-2 transition-colors"
                            title={tr("common.delete")}><Trash2 class="w-3.5 h-3.5" /></button
                          >
                        </div></TableCell
                      >
                    </TableRow>{/each}{/if}
              </TableBody>
            </Table>
          </div>
          <div class="px-4 py-3 border-t border-kitsuden-border flex items-center justify-between">
            <p class="text-xs text-kitsuden-subtle">
              {dealsPag.total}
              {tr("crmDashboard.dealsTotal")}
            </p>
            <div class="flex items-center gap-2">
              <button
                onclick={() => pg("deals", -1)}
                disabled={dealsPag.offset === 0}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronLeft class="w-4 h-4" /></button
              >
              <span class="text-xs text-kitsuden-subtle">{pageLabel(dealsPag)}</span>
              <button
                onclick={() => pg("deals", 1)}
                disabled={dealsPag.offset + dealsPag.limit >= dealsPag.total}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronRight class="w-4 h-4" /></button
              >
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- CONTACTS -->
    {#if activeTab === "contacts"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1">
            <div class="relative flex-1 max-w-sm">
              <Search
                class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle"
              /><input
                bind:value={contactsSearch}
                oninput={() => {
                  contactsPag.offset = 0;
                  loadContacts();
                }}
                placeholder={tr("crmDashboard.searchContacts")}
                class="w-full pl-9 pr-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent"
              />
            </div>
            <select
              bind:value={contactsStatus}
              onchange={() => {
                contactsPag.offset = 0;
                loadContacts();
              }}
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
              ><option value="">{tr("crmDashboard.allStatuses")}</option><option value="lead"
                >{tr("crmDashboard.lead")}</option
              ><option value="prospect">{tr("crmDashboard.prospect")}</option><option
                value="customer">{tr("crmDashboard.customer")}</option
              ><option value="churned">{tr("crmDashboard.churned")}</option><option value="archived"
                >{tr("common.archived")}</option
              ></select
            >
          </div>
          {#if selContacts.size}<button
              onclick={bulkDelContacts}
              class="btn-danger inline-flex items-center gap-2 text-sm"
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selContacts.size })}</button
            >{/if}
        </div>
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-sm">
              <TableHeader
                ><TableRow class="border-b border-kitsuden-border bg-kitsuden-bg/50">
                  <TableHead class="px-4 py-3 text-left w-10"
                    ><button
                      onclick={() => (selContacts = toggleAll(contacts, selContacts))}
                      class="text-kitsuden-subtle hover:text-kitsuden-text"
                      >{#if contacts.length && contacts.every( (r) => selContacts.has(r.id) )}<CheckSquare
                          class="w-4 h-4"
                        />{:else}<Square class="w-4 h-4" />{/if}</button
                    ></TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.name")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.email")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.status")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.company")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.jobTitle")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.score")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.lastContacted")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-right font-medium text-kitsuden-subtle"
                    >{tr("common.actions")}</TableHead
                  >
                </TableRow></TableHeader
              >
              <TableBody class="divide-y divide-kitsuden-border">
                {#if contactsLoading}{#each [1, 2, 3, 4] as _}<TableRow class="animate-pulse"
                      ><TableCell colspan={9} class="px-4 py-3"
                        ><div class="h-4 bg-kitsuden-bg rounded-sm w-full"></div></TableCell
                      ></TableRow
                    >{/each}
                {:else if !contacts.length}<TableRow
                    ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                      ><Inbox class="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p class="text-sm">{tr("crmDashboard.noContactsFound")}</p></TableCell
                    ></TableRow
                  >
                {:else}{#each contacts as c}<TableRow
                      class="hover:bg-kitsuden-bg/30 transition-colors"
                    >
                      <TableCell class="px-4 py-3"
                        ><button
                          onclick={() => (selContacts = toggleOne(selContacts, c.id))}
                          class="text-kitsuden-subtle hover:text-kitsuden-text"
                          >{#if selContacts.has(c.id)}<CheckSquare class="w-4 h-4" />{:else}<Square
                              class="w-4 h-4"
                            />{/if}</button
                        ></TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text font-medium"
                        >{c.firstName} {c.lastName}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle">{c.email}</TableCell>
                      <TableCell class="px-4 py-3"
                        ><span
                          class="inline-block px-2 py-0.5 text-xs font-medium rounded-full border {cCols[
                            c.status
                          ] || cCols.lead}">{c.status}</span
                        ></TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{c.company?.name || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{c.jobTitle || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text">{c.score ?? "—"}</TableCell>
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{ago(c.lastContactedAt)}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-right"
                        ><div class="flex justify-end gap-1">
                          <button
                            onclick={() => goto(`/crm/contacts/${c.id}`)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent transition-colors"
                            title={tr("common.edit")}><Edit2 class="w-3.5 h-3.5" /></button
                          ><button
                            onclick={() => ofTheContact(c.id)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent-2 transition-colors"
                            title={tr("common.delete")}><Trash2 class="w-3.5 h-3.5" /></button
                          >
                        </div></TableCell
                      >
                    </TableRow>{/each}{/if}
              </TableBody>
            </Table>
          </div>
          <div class="px-4 py-3 border-t border-kitsuden-border flex items-center justify-between">
            <p class="text-xs text-kitsuden-subtle">
              {contactsPag.total}
              {tr("crmDashboard.contactsTotal")}
            </p>
            <div class="flex items-center gap-2">
              <button
                onclick={() => pg("contacts", -1)}
                disabled={contactsPag.offset === 0}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronLeft class="w-4 h-4" /></button
              >
              <span class="text-xs text-kitsuden-subtle">{pageLabel(contactsPag)}</span>
              <button
                onclick={() => pg("contacts", 1)}
                disabled={contactsPag.offset + contactsPag.limit >= contactsPag.total}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronRight class="w-4 h-4" /></button
              >
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- COMPANIES -->
    {#if activeTab === "companies"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1">
            <div class="relative flex-1 max-w-sm">
              <Search
                class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle"
              /><input
                bind:value={companiesSearch}
                oninput={() => {
                  companiesPag.offset = 0;
                  loadCompanies();
                }}
                placeholder={tr("crmDashboard.searchCompanies")}
                class="w-full pl-9 pr-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent"
              />
            </div>
            <select
              bind:value={companiesIndustry}
              onchange={() => {
                companiesPag.offset = 0;
                loadCompanies();
              }}
              class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
              ><option value="">{tr("crmDashboard.allIndustries")}</option
              >{#each [...new Set(companies.map((c) => c.industry).filter(Boolean))] as i}<option
                  value={i}>{i}</option
                >{/each}</select
            >
          </div>
          {#if selCompanies.size}<button
              onclick={bulkDelCompanies}
              class="btn-danger inline-flex items-center gap-2 text-sm"
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selCompanies.size })}</button
            >{/if}
        </div>
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <Table class="w-full text-sm">
              <TableHeader
                ><TableRow class="border-b border-kitsuden-border bg-kitsuden-bg/50">
                  <TableHead class="px-4 py-3 text-left w-10"
                    ><button
                      onclick={() => (selCompanies = toggleAll(companies, selCompanies))}
                      class="text-kitsuden-subtle hover:text-kitsuden-text"
                      >{#if companies.length && companies.every( (r) => selCompanies.has(r.id) )}<CheckSquare
                          class="w-4 h-4"
                        />{:else}<Square class="w-4 h-4" />{/if}</button
                    ></TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("common.name")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.industry")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.domain")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.size")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.city")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.country")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-left font-medium text-kitsuden-subtle"
                    >{tr("crmDashboard.deals")}</TableHead
                  >
                  <TableHead class="px-4 py-3 text-right font-medium text-kitsuden-subtle"
                    >{tr("common.actions")}</TableHead
                  >
                </TableRow></TableHeader
              >
              <TableBody class="divide-y divide-kitsuden-border">
                {#if companiesLoading}{#each [1, 2, 3, 4] as _}<TableRow class="animate-pulse"
                      ><TableCell colspan={9} class="px-4 py-3"
                        ><div class="h-4 bg-kitsuden-bg rounded-sm w-full"></div></TableCell
                      ></TableRow
                    >{/each}
                {:else if !companies.length}<TableRow
                    ><TableCell colspan={9} class="px-4 py-12 text-center text-kitsuden-subtle"
                      ><Inbox class="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p class="text-sm">{tr("crmDashboard.noCompaniesFound")}</p></TableCell
                    ></TableRow
                  >
                {:else}{#each companies as c}<TableRow
                      class="hover:bg-kitsuden-bg/30 transition-colors"
                    >
                      <TableCell class="px-4 py-3"
                        ><button
                          onclick={() => (selCompanies = toggleOne(selCompanies, c.id))}
                          class="text-kitsuden-subtle hover:text-kitsuden-text"
                          >{#if selCompanies.has(c.id)}<CheckSquare class="w-4 h-4" />{:else}<Square
                              class="w-4 h-4"
                            />{/if}</button
                        ></TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text font-medium"
                        >{c.name}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{c.industry || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle">{c.domain || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-subtle">{c.size || "—"}</TableCell>
                      <TableCell class="px-4 py-3 text-kitsuden-subtle">{c.city || "—"}</TableCell>
                      <TableCell class="px-4 py-3 text-kitsuden-subtle"
                        >{c.country || "—"}</TableCell
                      >
                      <TableCell class="px-4 py-3 text-kitsuden-text">—</TableCell>
                      <TableCell class="px-4 py-3 text-right"
                        ><div class="flex justify-end gap-1">
                          <button
                            onclick={() => goto(`/crm/companies/${c.id}`)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent transition-colors"
                            title={tr("common.edit")}><Edit2 class="w-3.5 h-3.5" /></button
                          ><button
                            onclick={() => ofTheCompany(c.id)}
                            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle hover:text-kitsuden-accent-2 transition-colors"
                            title={tr("common.delete")}><Trash2 class="w-3.5 h-3.5" /></button
                          >
                        </div></TableCell
                      >
                    </TableRow>{/each}{/if}
              </TableBody>
            </Table>
          </div>
          <div class="px-4 py-3 border-t border-kitsuden-border flex items-center justify-between">
            <p class="text-xs text-kitsuden-subtle">
              {companiesPag.total}
              {tr("crmDashboard.companiesTotal")}
            </p>
            <div class="flex items-center gap-2">
              <button
                onclick={() => pg("companies", -1)}
                disabled={companiesPag.offset === 0}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronLeft class="w-4 h-4" /></button
              >
              <span class="text-xs text-kitsuden-subtle">{pageLabel(companiesPag)}</span>
              <button
                onclick={() => pg("companies", 1)}
                disabled={companiesPag.offset + companiesPag.limit >= companiesPag.total}
                class="p-1.5 rounded-lg border border-kitsuden-border text-kitsuden-subtle hover:text-kitsuden-text disabled:opacity-30 disabled:cursor-not-allowed"
                ><ChevronRight class="w-4 h-4" /></button
              >
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- PIPELINES -->
    {#if activeTab === "pipelines"}
      <div class="space-y-4 animate-fade-in">
        {#if pipelinesLoading}
          <div class="space-y-3">
            {#each [1, 2, 3] as _}<div class="card p-4 animate-pulse">
                <div class="h-4 w-48 bg-kitsuden-bg rounded-sm"></div>
              </div>{/each}
          </div>
        {:else if !pipelines.length}
          <div class="card p-12 text-center text-kitsuden-subtle">
            <Inbox class="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p class="text-sm">{tr("crmDashboard.noPipelinesFound")}</p>
          </div>
        {:else}
          <div class="space-y-3">
            {#each pipelines as pl}
              {@const stages = pipelineStages[pl.id] ?? []}
              <div class="card overflow-hidden">
                <button
                  onclick={() => togglePipeline(pl.id)}
                  class="w-full px-5 py-4 flex items-center justify-between hover:bg-kitsuden-bg/30 transition-colors text-left"
                >
                  <div class="flex items-center gap-3">
                    <div
                      class="w-9 h-9 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center"
                    >
                      <Kanban class="w-4 h-4 text-kitsuden-accent" />
                    </div>
                    <div>
                      <p class="text-sm font-semibold text-kitsuden-text">{pl.name}</p>
                      <p class="text-xs text-kitsuden-subtle">
                        {stages.length || "?"}
                        {tr("crmDashboard.stages", { currency: pl.currency })}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    {#if pl.isDefault}<span
                        class="px-2 py-0.5 text-xs font-medium rounded-full bg-kitsuden-green/10 text-kitsuden-green border border-kitsuden-green/20"
                        >{tr("crmDashboard.default")}</span
                      >{/if}
                    {#if expandedPipelineId === pl.id}<ChevronUp
                        class="w-4 h-4 text-kitsuden-subtle"
                      />{:else}<ChevronDown class="w-4 h-4 text-kitsuden-subtle" />{/if}
                  </div>
                </button>
                {#if expandedPipelineId === pl.id}
                  <div class="border-t border-kitsuden-border px-5 py-4">
                    {#if !stages.length}<p class="text-sm text-kitsuden-subtle">
                        {tr("crmDashboard.noStagesLoaded")}
                      </p>
                    {:else}
                      <div
                        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
                      >
                        {#each stages as s}
                          <div
                            class="p-3 rounded-lg border border-kitsuden-border bg-kitsuden-bg/30"
                          >
                            <div class="flex items-center gap-2 mb-2">
                              <span class="w-3 h-3 rounded-full" style="background-color: {s.color}"
                              ></span><span class="text-sm font-medium text-kitsuden-text"
                                >{s.name}</span
                              >
                            </div>
                            <div
                              class="flex items-center justify-between text-xs text-kitsuden-subtle"
                            >
                              <span>{tr("crmDashboard.probability")}</span><span
                                class="text-kitsuden-text font-medium">{s.probability}%</span
                              >
                            </div>
                            {#if s.wipLimit}<div
                                class="flex items-center justify-between text-xs text-kitsuden-subtle mt-1"
                              >
                                <span>{tr("crmDashboard.wipLimit")}</span><span
                                  class="text-kitsuden-text font-medium">{s.wipLimit}</span
                                >
                              </div>{/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</ViewPage>

<style>
  @reference "../../style.css";

  .btn-danger {
    @apply inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-medium bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border border-kitsuden-accent-2/20 hover:bg-kitsuden-accent-2/20 transition-colors;
  }
</style>
