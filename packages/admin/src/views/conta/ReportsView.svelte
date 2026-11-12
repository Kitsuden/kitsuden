<script lang="ts">
  import { t } from "$lib/i18n";
  import { onMount } from "svelte";
  import {
    toast,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Spinner,
    Tabs,
    type TabItem,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";

  import { api } from "$lib/api";

  type Tab = "trial" | "balance" | "pl";
  let activeTab = $state<Tab>("trial");
  const tabItems: TabItem[] = [
    { id: "trial", label: t("reportsView.trialBalance") },
    { id: "balance", label: t("reportsView.balanceSheet") },
    { id: "pl", label: t("reportsView.profitLoss") },
  ];
  let loading = $state(false);
  let dateFrom = $state("");
  let dateTo = $state("");
  let asOf = $state("");

  let trialData = $state<any[]>([]);
  let balanceData = $state<any>(null);
  let plData = $state<any>(null);

  async function loadTrial() {
    loading = true;
    try {
      const res = await api.getContaTrialBalance({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      trialData = res.data || [];
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      loading = false;
    }
  }

  async function loadBalance() {
    loading = true;
    try {
      const res = await api.getContaBalanceSheet(asOf || undefined);
      balanceData = res.data;
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      loading = false;
    }
  }

  async function loadPL() {
    loading = true;
    try {
      const res = await api.getContaProfitLoss({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      plData = res.data;
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      loading = false;
    }
  }

  function loadActive() {
    if (activeTab === "trial") loadTrial();
    if (activeTab === "balance") loadBalance();
    if (activeTab === "pl") loadPL();
  }

  onMount(loadTrial);
</script>

<div class="space-y-4 min-w-0">
  <Tabs
    items={tabItems}
    value={activeTab}
    panels={false}
    ariaLabel={t("reportsView.reports")}
    onchange={(id) => {
      activeTab = id as Tab;
      loadActive();
    }}
  />

  <div class="flex flex-wrap items-center gap-3">
    {#if activeTab === "balance"}
      <div class="w-48 max-w-full">
        <Input type="date" bind:value={asOf} aria-label={t("reportsView.asOf")} />
      </div>
    {:else}
      <div class="w-48 max-w-full">
        <Input type="date" bind:value={dateFrom} aria-label={t("reportsView.from")} />
      </div>
      <div class="w-48 max-w-full">
        <Input type="date" bind:value={dateTo} aria-label={t("reportsView.to")} />
      </div>
    {/if}
    <Button onclick={loadActive}>{t("reportsView.runReport")}</Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-48"><Spinner size="lg" /></div>
  {:else if activeTab === "trial"}
    <div>
      <Table>
        <TableHeader>
          <TableRow
            ><TableHead>{t("reportsView.code")}</TableHead><TableHead
              >{t("reportsView.account")}</TableHead
            ><TableHead class="text-right">{t("reportsView.debit")}</TableHead><TableHead
              class="text-right">{t("reportsView.credit")}</TableHead
            ><TableHead class="text-right">{t("reportsView.balance")}</TableHead></TableRow
          >
        </TableHeader>
        <TableBody>
          {#each trialData as row}
            <TableRow>
              <TableCell class="font-mono">{row.account.code}</TableCell>
              <TableCell>{row.account.name}</TableCell>
              <TableCell class="text-right font-mono">{Number(row.totalDebit).toFixed(2)}</TableCell
              >
              <TableCell class="text-right font-mono"
                >{Number(row.totalCredit).toFixed(2)}</TableCell
              >
              <TableCell class="text-right font-mono">{Number(row.balance).toFixed(2)}</TableCell>
            </TableRow>
          {:else}
            <TableRow
              ><TableCell colspan={5} class="2 text-center text-kitsuden-subtle"
                >{t("reportsView.noData")}</TableCell
              ></TableRow
            >
          {/each}
        </TableBody>
      </Table>
    </div>
  {:else if activeTab === "balance" && balanceData}
    <div class="grid gap-4 md:grid-cols-3">
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.assets")}</CardTitle></CardHeader
        ><CardContent>
          <div class="text-2xl font-bold">{Number(balanceData.totalAssets).toFixed(2)}</div>
        </CardContent></Card
      >
      <Card
        ><CardHeader
          ><CardTitle class="text-sm">{t("reportsView.liabilities")}</CardTitle></CardHeader
        ><CardContent>
          <div class="text-2xl font-bold">{Number(balanceData.totalLiabilities).toFixed(2)}</div>
        </CardContent></Card
      >
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.equity")}</CardTitle></CardHeader
        ><CardContent>
          <div class="text-2xl font-bold">{Number(balanceData.totalEquity).toFixed(2)}</div>
        </CardContent></Card
      >
    </div>
    <div>
      <Table>
        <TableHeader
          ><TableRow
            ><TableHead>{t("reportsView.account")}</TableHead><TableHead class="text-right"
              >{t("reportsView.balance")}</TableHead
            ></TableRow
          ></TableHeader
        >
        <TableBody>
          {#each balanceData.assets as a}<TableRow
              ><TableCell>{a.account.name}</TableCell><TableCell class="text-right font-mono"
                >{Number(a.balance).toFixed(2)}</TableCell
              ></TableRow
            >{/each}
          {#each balanceData.liabilities as a}<TableRow
              ><TableCell>{a.account.name}</TableCell><TableCell class="text-right font-mono"
                >{Number(a.balance).toFixed(2)}</TableCell
              ></TableRow
            >{/each}
          {#each balanceData.equity as a}<TableRow
              ><TableCell>{a.account.name}</TableCell><TableCell class="text-right font-mono"
                >{Number(a.balance).toFixed(2)}</TableCell
              ></TableRow
            >{/each}
        </TableBody>
      </Table>
    </div>
  {:else if activeTab === "pl" && plData}
    <div class="grid gap-4 md:grid-cols-3">
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.revenue")}</CardTitle></CardHeader
        ><CardContent
          ><div class="text-2xl font-bold text-kitsuden-green">
            {Number(plData.totalRevenue).toFixed(2)}
          </div></CardContent
        ></Card
      >
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.expenses")}</CardTitle></CardHeader
        ><CardContent
          ><div class="text-2xl font-bold text-kitsuden-danger">
            {Number(plData.totalExpenses).toFixed(2)}
          </div></CardContent
        ></Card
      >
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.netIncome")}</CardTitle></CardHeader
        ><CardContent
          ><div class="text-2xl font-bold">{Number(plData.netIncome).toFixed(2)}</div></CardContent
        ></Card
      >
    </div>
    <div>
      <Table>
        <TableHeader
          ><TableRow
            ><TableHead>{t("reportsView.account")}</TableHead><TableHead class="text-right"
              >{t("reportsView.balance")}</TableHead
            ></TableRow
          ></TableHeader
        >
        <TableBody>
          {#each plData.revenue as a}<TableRow
              ><TableCell>{a.account.name}</TableCell><TableCell class="text-right font-mono"
                >{Number(a.balance).toFixed(2)}</TableCell
              ></TableRow
            >{/each}
          {#each plData.expenses as a}<TableRow
              ><TableCell>{a.account.name}</TableCell><TableCell class="text-right font-mono"
                >{Number(a.balance).toFixed(2)}</TableCell
              ></TableRow
            >{/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
