<script lang="ts">
  import { t } from "$lib/i18n";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { api } from "$lib/api";
  import Button from "$lib/components/ui/Button.svelte";
  import Card from "$lib/components/ui/Card.svelte";
  import CardContent from "$lib/components/ui/CardContent.svelte";
  import CardHeader from "$lib/components/ui/CardHeader.svelte";
  import CardTitle from "$lib/components/ui/CardTitle.svelte";
  import Input from "$lib/components/ui/Input.svelte";

  let activeTab = $state<"trial" | "balance" | "pl">("trial");
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

<div class="space-y-4">
  <div class="flex items-center gap-4">
    <button
      class="px-4 py-2 text-sm font-medium rounded-lg transition-colors {activeTab === 'trial'
        ? 'bg-indigo-600 text-white'
        : 'text-zinc-400 hover:bg-zinc-800'}"
      onclick={() => {
        activeTab = "trial";
        loadTrial();
      }}>{t("reportsView.trialBalance")}</button
    >
    <button
      class="px-4 py-2 text-sm font-medium rounded-lg transition-colors {activeTab === 'balance'
        ? 'bg-indigo-600 text-white'
        : 'text-zinc-400 hover:bg-zinc-800'}"
      onclick={() => {
        activeTab = "balance";
        loadBalance();
      }}>{t("reportsView.balanceSheet")}</button
    >
    <button
      class="px-4 py-2 text-sm font-medium rounded-lg transition-colors {activeTab === 'pl'
        ? 'bg-indigo-600 text-white'
        : 'text-zinc-400 hover:bg-zinc-800'}"
      onclick={() => {
        activeTab = "pl";
        loadPL();
      }}>{t("reportsView.profitLoss")}</button
    >
  </div>

  <div class="flex items-center gap-3">
    {#if activeTab === "balance"}
      <Input type="date" bind:value={asOf} class="w-48" />
    {:else}
      <Input type="date" bind:value={dateFrom} class="w-48" placeholder={t("reportsView.from")} />
      <Input type="date" bind:value={dateTo} class="w-48" placeholder={t("reportsView.to")} />
    {/if}
    <Button onclick={loadActive}>{t("reportsView.runReport")}</Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-48">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
    </div>
  {:else if activeTab === "trial"}
    <div class="border border-zinc-800 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900/80 text-zinc-400 text-left">
          <tr
            ><th class="px-4 py-3 font-medium">{t("reportsView.code")}</th><th
              class="px-4 py-3 font-medium">{t("reportsView.account")}</th
            ><th class="px-4 py-3 font-medium text-right">{t("reportsView.debit")}</th><th
              class="px-4 py-3 font-medium text-right">{t("reportsView.credit")}</th
            ><th class="px-4 py-3 font-medium text-right">{t("reportsView.balance")}</th></tr
          >
        </thead>
        <tbody class="divide-y divide-zinc-800">
          {#each trialData as row}
            <tr class="hover:bg-zinc-800/30">
              <td class="px-4 py-2 font-mono">{row.account.code}</td>
              <td class="px-4 py-2">{row.account.name}</td>
              <td class="px-4 py-2 text-right font-mono">{Number(row.totalDebit).toFixed(2)}</td>
              <td class="px-4 py-2 text-right font-mono">{Number(row.totalCredit).toFixed(2)}</td>
              <td class="px-4 py-2 text-right font-mono">{Number(row.balance).toFixed(2)}</td>
            </tr>
          {:else}
            <tr
              ><td colspan="5" class="px-4 py-12 text-center text-zinc-500"
                >{t("reportsView.noData")}</td
              ></tr
            >
          {/each}
        </tbody>
      </table>
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
    <div class="border border-zinc-800 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900/80 text-zinc-400 text-left"
          ><tr
            ><th class="px-4 py-3">{t("reportsView.account")}</th><th class="px-4 py-3 text-right"
              >{t("reportsView.balance")}</th
            ></tr
          ></thead
        >
        <tbody class="divide-y divide-zinc-800">
          {#each balanceData.assets as a}<tr
              ><td class="px-4 py-2">{a.account.name}</td><td class="px-4 py-2 text-right font-mono"
                >{Number(a.balance).toFixed(2)}</td
              ></tr
            >{/each}
          {#each balanceData.liabilities as a}<tr
              ><td class="px-4 py-2">{a.account.name}</td><td class="px-4 py-2 text-right font-mono"
                >{Number(a.balance).toFixed(2)}</td
              ></tr
            >{/each}
          {#each balanceData.equity as a}<tr
              ><td class="px-4 py-2">{a.account.name}</td><td class="px-4 py-2 text-right font-mono"
                >{Number(a.balance).toFixed(2)}</td
              ></tr
            >{/each}
        </tbody>
      </table>
    </div>
  {:else if activeTab === "pl" && plData}
    <div class="grid gap-4 md:grid-cols-3">
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.revenue")}</CardTitle></CardHeader
        ><CardContent
          ><div class="text-2xl font-bold text-emerald-400">
            {Number(plData.totalRevenue).toFixed(2)}
          </div></CardContent
        ></Card
      >
      <Card
        ><CardHeader><CardTitle class="text-sm">{t("reportsView.expenses")}</CardTitle></CardHeader
        ><CardContent
          ><div class="text-2xl font-bold text-red-400">
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
    <div class="border border-zinc-800 rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-zinc-900/80 text-zinc-400 text-left"
          ><tr
            ><th class="px-4 py-3">{t("reportsView.account")}</th><th class="px-4 py-3 text-right"
              >{t("reportsView.balance")}</th
            ></tr
          ></thead
        >
        <tbody class="divide-y divide-zinc-800">
          {#each plData.revenue as a}<tr
              ><td class="px-4 py-2">{a.account.name}</td><td class="px-4 py-2 text-right font-mono"
                >{Number(a.balance).toFixed(2)}</td
              ></tr
            >{/each}
          {#each plData.expenses as a}<tr
              ><td class="px-4 py-2">{a.account.name}</td><td class="px-4 py-2 text-right font-mono"
                >{Number(a.balance).toFixed(2)}</td
              ></tr
            >{/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
