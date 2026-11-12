<script lang="ts">
  import ViewPage from "$lib/components/admin/ViewPage.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Users,
    Building2,
    Briefcase,
    TrendingUp,
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
    Kanban,
  } from "lucide-svelte";
  import { onMount, untrack } from "svelte";
  import {
    toast,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
    Button,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    EmptyState,
    SearchInput,
    Select,
    Sheet,
    Skeleton,
    Tabs,
    type TabItem,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  import DealForm from "./DealForm.svelte";
  import { crmHref } from "./links";
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

  type BadgeVariant = "success" | "warning" | "error" | "accent" | "secondary";
  const dealTone: Record<string, BadgeVariant> = {
    open: "accent",
    won: "success",
    lost: "error",
    paused: "warning",
  };
  const contactTone: Record<string, BadgeVariant> = {
    lead: "accent",
    prospect: "warning",
    customer: "success",
    churned: "error",
    archived: "secondary",
  };
  const tabItems: TabItem[] = [
    { id: "overview", label: tr("crmDashboard.overview") },
    { id: "deals", label: tr("crmDashboard.deals") },
    { id: "contacts", label: tr("crmDashboard.contacts") },
    { id: "companies", label: tr("crmDashboard.companies") },
    { id: "pipelines", label: tr("crmDashboard.pipelines") },
  ];

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
  // ── A deal is created and edited in a sheet over the dashboard: kon-crm's deals view is
  // a board, with no record page to send "Edit" to. `undefined`: closed; `null`: a new one.
  let dealSheet = $state<string | null | undefined>(undefined);
  function dealSaved() {
    dealSheet = undefined;
    void Promise.all([loadDeals(), loadOverview(), loadStats()]);
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

  // Loads the tab when it changes. `untrack`: each loader reads its own paging and filters
  // and then writes them back; tracked, that write re-ran this effect, which loaded again,
  // forever — the Deals tab never left its skeleton rows.
  $effect(() => {
    const tab = activeTab;
    untrack(() => {
      if (tab === "overview") loadOverview();
      else if (tab === "deals") loadDeals();
      else if (tab === "contacts") loadContacts();
      else if (tab === "companies") loadCompanies();
      else if (tab === "pipelines") loadPipelines();
    });
  });
  onMount(() => {
    loadStats();
    loadOverview();
    loadPipelines();
  });
</script>

{#snippet statusBadge(status: string, map: Record<string, BadgeVariant>, fallback: BadgeVariant)}
  <Badge variant={map[status] ?? fallback}>{status}</Badge>
{/snippet}

{#snippet selectAllBox(rows: { id: string }[], sel: Set<string>, onToggle: () => void)}
  <Checkbox
    checked={rows.length > 0 && rows.every((r) => sel.has(r.id))}
    ariaLabel={tr("crmDashboard.selectAll")}
    onchange={onToggle}
  />
{/snippet}

{#snippet selectRowBox(checked: boolean, name: string, onToggle: () => void)}
  <Checkbox {checked} ariaLabel={tr("crmDashboard.selectRow", { name })} onchange={onToggle} />
{/snippet}

{#snippet loadingRows()}
  {#each [1, 2, 3, 4] as _}
    <TableRow><TableCell colspan={9}><Skeleton /></TableCell></TableRow>
  {/each}
{/snippet}

{#snippet emptyRow(text: string)}
  <TableRow>
    <TableCell colspan={9}><EmptyState size="sm" level={null} title={text} /></TableCell>
  </TableRow>
{/snippet}

{#snippet rowActions(onEdit: () => void, onDelete: () => void)}
  <div class="flex justify-end gap-1">
    <Button
      variant="ghost"
      size="icon"
      ariaLabel={tr("common.edit")}
      title={tr("common.edit")}
      onclick={onEdit}><Edit2 class="w-4 h-4" aria-hidden="true" /></Button
    >
    <Button
      variant="danger-ghost"
      size="icon"
      ariaLabel={tr("common.delete")}
      title={tr("common.delete")}
      onclick={onDelete}><Trash2 class="w-4 h-4" aria-hidden="true" /></Button
    >
  </div>
{/snippet}

{#snippet pager(
  kind: "deals" | "contacts" | "companies",
  p: { offset: number; limit: number; total: number },
  totalLabel: string
)}
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-xs text-kitsuden-subtle">{p.total} {totalLabel}</p>
    <div class="flex items-center gap-2">
      <Button
        variant="secondary"
        size="icon"
        ariaLabel={tr("crmDashboard.previousPage")}
        disabled={p.offset === 0}
        onclick={() => pg(kind, -1)}><ChevronLeft class="w-4 h-4" aria-hidden="true" /></Button
      >
      <span class="text-xs text-kitsuden-subtle">{pageLabel(p)}</span>
      <Button
        variant="secondary"
        size="icon"
        ariaLabel={tr("crmDashboard.nextPage")}
        disabled={p.offset + p.limit >= p.total}
        onclick={() => pg(kind, 1)}><ChevronRight class="w-4 h-4" aria-hidden="true" /></Button
      >
    </div>
  </div>
{/snippet}

{#snippet sortHead(field: "value" | "expectedCloseDate", label: string)}
  <TableHead
    aria-sort={dealsSortField === field
      ? dealsSortDir === "asc"
        ? "ascending"
        : "descending"
      : "none"}
  >
    <Button variant="ghost" size="sm" onclick={() => setDealSort(field)}>
      {label}
      {#if dealsSortField === field}
        {#if dealsSortDir === "asc"}
          <ArrowUp class="w-3 h-3" aria-hidden="true" />
        {:else}
          <ArrowDown class="w-3 h-3" aria-hidden="true" />
        {/if}
      {:else}
        <ArrowUpDown class="w-3 h-3" aria-hidden="true" />
      {/if}
    </Button>
  </TableHead>
{/snippet}

<ViewPage
  title={tr("crmDashboard.crmDashboard")}
  description={tr("crmDashboard.manageDealsContactsCompaniesAnd")}
>
  {#snippet actions()}
    <Button onclick={() => (dealSheet = null)}
      ><Plus class="w-4 h-4" /> {tr("crmDashboard.addDeal")}</Button
    >
  {/snippet}

  <div class="space-y-6 min-w-0">
    <!-- Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#if statsLoading}
        {#each [1, 2, 3, 4] as _}
          <Card class="p-5">
            <div class="flex items-center gap-3">
              <Skeleton width="2.5rem" height="2.5rem" />
              <div class="flex-1 space-y-2">
                <Skeleton width="5rem" height="0.75rem" />
                <Skeleton width="6rem" height="1.5rem" />
              </div>
            </div>
          </Card>
        {/each}
      {:else if stats}
        {@const cards = [
          {
            label: tr("crmDashboard.contacts"),
            value: stats.contacts.toLocaleString(localeFormat()),
            icon: Users,
            bg: "bg-kitsuden-accent/10",
            fg: "text-kitsuden-accent",
          },
          {
            label: tr("crmDashboard.companies"),
            value: stats.companies.toLocaleString(localeFormat()),
            icon: Building2,
            bg: "bg-kitsuden-green/10",
            fg: "text-kitsuden-green",
          },
          {
            label: tr("crmDashboard.openDeals"),
            value: fmtCur(stats.deals.values.open),
            icon: Briefcase,
            bg: "bg-kitsuden-amber/10",
            fg: "text-kitsuden-amber",
          },
          {
            label: tr("crmDashboard.pipelineValue"),
            value: fmtCur(stats.deals.values.total),
            icon: TrendingUp,
            bg: "bg-kitsuden-accent/10",
            fg: "text-kitsuden-accent",
          },
        ]}
        {#each cards as c}
          <Card class="p-5 min-w-0">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 shrink-0 rounded-lg {c.bg} flex items-center justify-center">
                <c.icon class="w-5 h-5 {c.fg}" />
              </div>
              <div class="min-w-0">
                <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">{c.label}</p>
                <p class="text-xl font-bold text-kitsuden-text truncate">{c.value}</p>
              </div>
            </div>
          </Card>
        {/each}
      {/if}
    </div>

    <Tabs
      items={tabItems}
      value={activeTab}
      panels={false}
      ariaLabel={tr("crmDashboard.sections")}
      onchange={(id) => (activeTab = id as Tab)}
    />

    <!-- OVERVIEW -->
    {#if activeTab === "overview"}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 animate-fade-in">
        <Card class="min-w-0">
          <CardHeader>
            <CardTitle>{tr("crmDashboard.recentDeals")}</CardTitle>
            <Button variant="ghost" size="sm" onclick={() => (activeTab = "deals")}
              >{tr("crmDashboard.viewAll")}</Button
            >
          </CardHeader>
          <div class="divide-y divide-kitsuden-border">
            {#if overviewLoading}
              {#each [1, 2, 3] as _}
                <div class="p-3 flex justify-between gap-3">
                  <Skeleton width="8rem" />
                  <Skeleton width="4rem" />
                </div>
              {/each}
            {:else if !recentDeals.length}
              <EmptyState size="sm" title={tr("crmDashboard.noDealsYet")} />
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
                    <p class="text-sm font-semibold text-kitsuden-text mb-1">
                      {fmtCur(d.value, d.currency)}
                    </p>
                    {@render statusBadge(d.status, dealTone, "accent")}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </Card>

        <Card class="min-w-0">
          <CardHeader>
            <CardTitle>{tr("crmDashboard.recentContacts")}</CardTitle>
            <Button variant="ghost" size="sm" onclick={() => (activeTab = "contacts")}
              >{tr("crmDashboard.viewAll")}</Button
            >
          </CardHeader>
          <div class="divide-y divide-kitsuden-border">
            {#if overviewLoading}
              {#each [1, 2, 3] as _}
                <div class="p-3 flex justify-between gap-3">
                  <Skeleton width="8rem" />
                  <Skeleton width="4rem" />
                </div>
              {/each}
            {:else if !recentContacts.length}
              <EmptyState size="sm" title={tr("crmDashboard.noContactsYet")} />
            {:else}
              {#each recentContacts as c}
                <div class="p-3 flex justify-between hover:bg-kitsuden-bg/40 transition-colors">
                  <div class="min-w-0">
                    <p class="text-sm text-kitsuden-text truncate font-medium">
                      {c.firstName}
                      {c.lastName}
                    </p>
                    <p class="text-xs text-kitsuden-subtle truncate">{c.email}</p>
                  </div>
                  <div class="text-right shrink-0 ml-3">
                    {@render statusBadge(c.status, contactTone, "accent")}
                    {#if c.score}
                      <p class="text-xs text-kitsuden-subtle mt-0.5">
                        {tr("crmDashboard.score", { score: c.score })}
                      </p>
                    {/if}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        </Card>

        <Card class="lg:col-span-2 min-w-0">
          <CardHeader><CardTitle>{tr("crmDashboard.quickActions")}</CardTitle></CardHeader>
          <CardContent>
            <div class="flex flex-wrap gap-2">
              <Button onclick={() => (dealSheet = null)}
                ><Plus class="w-4 h-4" /> {tr("crmDashboard.addDeal")}</Button
              >
              <Button variant="secondary" onclick={() => goto(crmHref("contacts", "new"))}
                ><Plus class="w-4 h-4" /> {tr("crmDashboard.addContact")}</Button
              >
              <Button variant="secondary" onclick={() => goto(crmHref("companies", "new"))}
                ><Plus class="w-4 h-4" /> {tr("crmDashboard.addCompany")}</Button
              >
            </div>
          </CardContent>
        </Card>
      </div>
    {/if}

    <!-- DEALS -->
    {#if activeTab === "deals"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1 min-w-0">
            <SearchInput
              class="min-w-0 flex-1 basis-56 sm:max-w-sm"
              bind:value={dealsSearch}
              placeholder={tr("crmDashboard.searchDeals")}
              oninput={() => {
                dealsPag.offset = 0;
                loadDeals();
              }}
            />
            <Select
              width="auto"
              bind:value={dealsStatus}
              aria-label={tr("common.status")}
              onchange={() => {
                dealsPag.offset = 0;
                loadDeals();
              }}
            >
              <option value="">{tr("crmDashboard.allStatuses")}</option>
              <option value="open">{tr("crmDashboard.open")}</option>
              <option value="won">{tr("crmDashboard.won")}</option>
              <option value="lost">{tr("crmDashboard.lost")}</option>
              <option value="paused">{tr("crmDashboard.paused")}</option>
            </Select>
            <Select
              width="auto"
              bind:value={dealsPipelineId}
              aria-label={tr("crmDashboard.pipelines")}
              onchange={() => {
                dealsPag.offset = 0;
                loadDeals();
              }}
            >
              <option value="">{tr("crmDashboard.allPipelines")}</option>
              {#each pipelines as p}<option value={p.id}>{p.name}</option>{/each}
            </Select>
          </div>
          {#if selDeals.size}
            <Button variant="danger-ghost" onclick={bulkDelDeals}
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selDeals.size })}</Button
            >
          {/if}
        </div>

        <Table aria-label={tr("crmDashboard.deals")}>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10">
                {@render selectAllBox(
                  deals,
                  selDeals,
                  () => (selDeals = toggleAll(deals, selDeals))
                )}
              </TableHead>
              <TableHead>{tr("common.title")}</TableHead>
              {@render sortHead("value", tr("crmDashboard.value"))}
              <TableHead>{tr("common.status")}</TableHead>
              <TableHead>{tr("crmDashboard.probability")}</TableHead>
              {@render sortHead("expectedCloseDate", tr("crmDashboard.expectedClose"))}
              <TableHead>{tr("common.source")}</TableHead>
              <TableHead>{tr("common.tags")}</TableHead>
              <TableHead class="text-right">{tr("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#if dealsLoading}
              {@render loadingRows()}
            {:else if !deals.length}
              {@render emptyRow(tr("crmDashboard.noDealsFound"))}
            {:else}
              {#each deals as d}
                <TableRow>
                  <TableCell>
                    {@render selectRowBox(
                      selDeals.has(d.id),
                      d.title,
                      () => (selDeals = toggleOne(selDeals, d.id))
                    )}
                  </TableCell>
                  <TableCell class="text-kitsuden-text font-medium">{d.title}</TableCell>
                  <TableCell>{fmtCur(d.value, d.currency)}</TableCell>
                  <TableCell>{@render statusBadge(d.status, dealTone, "accent")}</TableCell>
                  <TableCell>{d.probability ?? 0}%</TableCell>
                  <TableCell class="text-kitsuden-subtle">{fmtDate(d.expectedCloseDate)}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{d.source || "—"}</TableCell>
                  <TableCell>
                    <div class="flex flex-wrap gap-1">
                      {#each (d.tags ?? []).slice(0, 3) as tag}
                        <Badge variant="secondary">{tag}</Badge>
                      {/each}
                      {#if (d.tags ?? []).length > 3}
                        <Badge variant="secondary">+{(d.tags ?? []).length - 3}</Badge>
                      {/if}
                    </div>
                  </TableCell>
                  <TableCell>
                    {@render rowActions(
                      () => (dealSheet = d.id),
                      () => ofTheDeal(d.id)
                    )}
                  </TableCell>
                </TableRow>
              {/each}
            {/if}
          </TableBody>
        </Table>
        {@render pager("deals", dealsPag, tr("crmDashboard.dealsTotal"))}
      </div>
    {/if}

    <!-- CONTACTS -->
    {#if activeTab === "contacts"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1 min-w-0">
            <SearchInput
              class="min-w-0 flex-1 basis-56 sm:max-w-sm"
              bind:value={contactsSearch}
              placeholder={tr("crmDashboard.searchContacts")}
              oninput={() => {
                contactsPag.offset = 0;
                loadContacts();
              }}
            />
            <Select
              width="auto"
              bind:value={contactsStatus}
              aria-label={tr("common.status")}
              onchange={() => {
                contactsPag.offset = 0;
                loadContacts();
              }}
            >
              <option value="">{tr("crmDashboard.allStatuses")}</option>
              <option value="lead">{tr("crmDashboard.lead")}</option>
              <option value="prospect">{tr("crmDashboard.prospect")}</option>
              <option value="customer">{tr("crmDashboard.customer")}</option>
              <option value="churned">{tr("crmDashboard.churned")}</option>
              <option value="archived">{tr("common.archived")}</option>
            </Select>
          </div>
          {#if selContacts.size}
            <Button variant="danger-ghost" onclick={bulkDelContacts}
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selContacts.size })}</Button
            >
          {/if}
        </div>

        <Table aria-label={tr("crmDashboard.contacts")}>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10">
                {@render selectAllBox(
                  contacts,
                  selContacts,
                  () => (selContacts = toggleAll(contacts, selContacts))
                )}
              </TableHead>
              <TableHead>{tr("common.name")}</TableHead>
              <TableHead>{tr("common.email")}</TableHead>
              <TableHead>{tr("common.status")}</TableHead>
              <TableHead>{tr("crmDashboard.company")}</TableHead>
              <TableHead>{tr("crmDashboard.jobTitle")}</TableHead>
              <TableHead>{tr("common.score")}</TableHead>
              <TableHead>{tr("crmDashboard.lastContacted")}</TableHead>
              <TableHead class="text-right">{tr("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#if contactsLoading}
              {@render loadingRows()}
            {:else if !contacts.length}
              {@render emptyRow(tr("crmDashboard.noContactsFound"))}
            {:else}
              {#each contacts as c}
                <TableRow>
                  <TableCell>
                    {@render selectRowBox(
                      selContacts.has(c.id),
                      `${c.firstName} ${c.lastName}`,
                      () => (selContacts = toggleOne(selContacts, c.id))
                    )}
                  </TableCell>
                  <TableCell class="text-kitsuden-text font-medium"
                    >{c.firstName} {c.lastName}</TableCell
                  >
                  <TableCell class="text-kitsuden-subtle">{c.email}</TableCell>
                  <TableCell>{@render statusBadge(c.status, contactTone, "accent")}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.company?.name || "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.jobTitle || "—"}</TableCell>
                  <TableCell>{c.score ?? "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{ago(c.lastContactedAt)}</TableCell>
                  <TableCell>
                    {@render rowActions(
                      () => goto(crmHref("contacts", c.id)),
                      () => ofTheContact(c.id)
                    )}
                  </TableCell>
                </TableRow>
              {/each}
            {/if}
          </TableBody>
        </Table>
        {@render pager("contacts", contactsPag, tr("crmDashboard.contactsTotal"))}
      </div>
    {/if}

    <!-- COMPANIES -->
    {#if activeTab === "companies"}
      <div class="space-y-4 animate-fade-in">
        <div class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div class="flex flex-col sm:flex-row gap-2 flex-1 min-w-0">
            <SearchInput
              class="min-w-0 flex-1 basis-56 sm:max-w-sm"
              bind:value={companiesSearch}
              placeholder={tr("crmDashboard.searchCompanies")}
              oninput={() => {
                companiesPag.offset = 0;
                loadCompanies();
              }}
            />
            <Select
              width="auto"
              bind:value={companiesIndustry}
              aria-label={tr("crmDashboard.industry")}
              onchange={() => {
                companiesPag.offset = 0;
                loadCompanies();
              }}
            >
              <option value="">{tr("crmDashboard.allIndustries")}</option>
              {#each [...new Set(companies.map((c) => c.industry).filter(Boolean))] as i}
                <option value={i}>{i}</option>
              {/each}
            </Select>
          </div>
          {#if selCompanies.size}
            <Button variant="danger-ghost" onclick={bulkDelCompanies}
              ><Trash2 class="w-4 h-4" />
              {tr("crmDashboard.delete", { size: selCompanies.size })}</Button
            >
          {/if}
        </div>

        <Table aria-label={tr("crmDashboard.companies")}>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10">
                {@render selectAllBox(
                  companies,
                  selCompanies,
                  () => (selCompanies = toggleAll(companies, selCompanies))
                )}
              </TableHead>
              <TableHead>{tr("common.name")}</TableHead>
              <TableHead>{tr("crmDashboard.industry")}</TableHead>
              <TableHead>{tr("crmDashboard.domain")}</TableHead>
              <TableHead>{tr("crmDashboard.size")}</TableHead>
              <TableHead>{tr("crmDashboard.city")}</TableHead>
              <TableHead>{tr("crmDashboard.country")}</TableHead>
              <TableHead>{tr("crmDashboard.deals")}</TableHead>
              <TableHead class="text-right">{tr("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#if companiesLoading}
              {@render loadingRows()}
            {:else if !companies.length}
              {@render emptyRow(tr("crmDashboard.noCompaniesFound"))}
            {:else}
              {#each companies as c}
                <TableRow>
                  <TableCell>
                    {@render selectRowBox(
                      selCompanies.has(c.id),
                      c.name,
                      () => (selCompanies = toggleOne(selCompanies, c.id))
                    )}
                  </TableCell>
                  <TableCell class="text-kitsuden-text font-medium">{c.name}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.industry || "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.domain || "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.size || "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.city || "—"}</TableCell>
                  <TableCell class="text-kitsuden-subtle">{c.country || "—"}</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>
                    {@render rowActions(
                      () => goto(crmHref("companies", c.id)),
                      () => ofTheCompany(c.id)
                    )}
                  </TableCell>
                </TableRow>
              {/each}
            {/if}
          </TableBody>
        </Table>
        {@render pager("companies", companiesPag, tr("crmDashboard.companiesTotal"))}
      </div>
    {/if}

    <!-- PIPELINES -->
    {#if activeTab === "pipelines"}
      <div class="space-y-4 animate-fade-in">
        {#if pipelinesLoading}
          <div class="space-y-3">
            {#each [1, 2, 3] as _}<Card class="p-4"><Skeleton width="12rem" /></Card>{/each}
          </div>
        {:else if !pipelines.length}
          <EmptyState title={tr("crmDashboard.noPipelinesFound")} />
        {:else}
          <div class="space-y-3">
            {#each pipelines as pl}
              {@const stages = pipelineStages[pl.id] ?? []}
              <Card class="overflow-hidden">
                <!-- The whole row opens the pipeline: one large native button, no kit equivalent. -->
                <button
                  type="button"
                  onclick={() => togglePipeline(pl.id)}
                  aria-expanded={expandedPipelineId === pl.id}
                  class="w-full min-h-11 px-5 py-4 flex items-center justify-between gap-3 hover:bg-kitsuden-bg/30 transition-colors text-left cursor-pointer"
                >
                  <div class="flex items-center gap-3 min-w-0">
                    <div
                      class="w-9 h-9 shrink-0 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center"
                    >
                      <Kanban class="w-4 h-4 text-kitsuden-accent" />
                    </div>
                    <div class="min-w-0">
                      <p class="text-sm font-semibold text-kitsuden-text truncate">{pl.name}</p>
                      <p class="text-xs text-kitsuden-subtle">
                        {stages.length || "?"}
                        {tr("crmDashboard.stages", { currency: pl.currency })}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    {#if pl.isDefault}
                      <Badge variant="success">{tr("crmDashboard.default")}</Badge>
                    {/if}
                    {#if expandedPipelineId === pl.id}
                      <ChevronUp class="w-4 h-4 text-kitsuden-subtle" />
                    {:else}
                      <ChevronDown class="w-4 h-4 text-kitsuden-subtle" />
                    {/if}
                  </div>
                </button>
                {#if expandedPipelineId === pl.id}
                  <div class="border-t border-kitsuden-border px-5 py-4">
                    {#if !stages.length}
                      <p class="text-sm text-kitsuden-subtle">
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
                              ></span>
                              <span class="text-sm font-medium text-kitsuden-text">{s.name}</span>
                            </div>
                            <div
                              class="flex items-center justify-between text-xs text-kitsuden-subtle"
                            >
                              <span>{tr("crmDashboard.probability")}</span>
                              <span class="text-kitsuden-text font-medium">{s.probability}%</span>
                            </div>
                            {#if s.wipLimit}
                              <div
                                class="flex items-center justify-between text-xs text-kitsuden-subtle mt-1"
                              >
                                <span>{tr("crmDashboard.wipLimit")}</span>
                                <span class="text-kitsuden-text font-medium">{s.wipLimit}</span>
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </Card>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <Sheet
    open={dealSheet !== undefined}
    onClose={() => (dealSheet = undefined)}
    title={dealSheet ? tr("crmDashboard.editDeal") : tr("crmDashboard.addDeal")}
    size="lg"
  >
    {#if dealSheet !== undefined}
      {#key dealSheet}
        <DealForm
          dealId={dealSheet}
          embedded
          onBack={() => (dealSheet = undefined)}
          onSave={dealSaved}
        />
      {/key}
    {/if}
  </Sheet>
</ViewPage>
