<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save, Plus, X, CheckCircle, ArrowLeft } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { api } from "$lib/api";
  import Badge from "$lib/components/ui/Badge.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Input from "$lib/components/ui/Input.svelte";
  import Label from "$lib/components/ui/Label.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";

  interface Props {
    journalId?: string | null;
    onBack: () => void;
    onSave: () => void;
  }
  let { journalId = null, onBack, onSave }: Props = $props();

  let journal = $state<any>({
    date: new Date().toISOString().slice(0, 10),
    description: "",
    reference: "",
    journalType: "standard",
    status: "draft",
    lines: [],
  });
  let accounts = $state<any[]>([]);
  let counterparties = $state<any[]>([]);
  let currencies = $state<any[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const totalDebit = $derived(
    journal.lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0)
  );
  const totalCredit = $derived(
    journal.lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0)
  );
  const isBalanced = $derived(
    Math.abs(totalDebit - totalCredit) < 0.001 && journal.lines.length >= 2
  );

  async function load() {
    loading = true;
    try {
      const [accRes, cpRes, currRes] = await Promise.all([
        api.getContaAccounts({ limit: 500 }),
        api.getContaCounterparties(),
        api.getContaCurrencies(),
      ]);
      accounts = accRes.data || [];
      counterparties = cpRes.data || [];
      currencies = currRes.data || [];

      if (journalId) {
        const jRes = await api.getContaJournal(journalId);
        journal = jRes.data;
        if (!journal.lines) journal.lines = [];
      } else {
        addLine();
        addLine();
      }
    } catch (e: any) {
      error = e.message;
      toast.error(t("journalForm.failedToLoad") + e.message);
    } finally {
      loading = false;
    }
  }

  function addLine() {
    journal.lines = [
      ...journal.lines,
      { accountId: "", debit: "", credit: "", description: "", currency: "USD", exchangeRate: "1" },
    ];
  }
  function removeLine(idx: number) {
    journal.lines = journal.lines.filter((_: any, i: number) => i !== idx);
  }

  function normalizeLines(lines: any[]) {
    return lines.map((l) => ({
      ...l,
      debit: String(l.debit || ""),
      credit: String(l.credit || ""),
      exchangeRate: String(l.exchangeRate || "1"),
    }));
  }

  async function saveDraft() {
    saving = true;
    try {
      const payload = { ...journal, status: "draft", lines: normalizeLines(journal.lines) };
      if (journalId) {
        await api.updateContaJournal(journalId, payload);
      } else {
        const res = await api.createContaJournal(payload);
        journalId = res.data.id;
      }
      toast.success(t("journalForm.journalSaved"));
      onSave();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      saving = false;
    }
  }

  async function post() {
    if (!isBalanced) {
      toast.error(t("journalForm.journalIsNotBalanced"));
      return;
    }
    saving = true;
    try {
      const payload = { ...journal, lines: normalizeLines(journal.lines) };
      if (!journalId) {
        const res = await api.createContaJournal({ ...payload, status: "posted" });
        journalId = res.data.id;
      } else {
        await api.updateContaJournal(journalId, payload);
        await api.postContaJournal(journalId);
      }
      toast.success(t("journalForm.journalPosted"));
      onSave();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <Button variant="ghost" onclick={onBack}
      ><ArrowLeft class="w-4 h-4 mr-2" /> {t("common.back")}</Button
    >
    <div class="flex items-center gap-2">
      {#if isBalanced}
        <Badge variant="success">{t("journalForm.balanced")}</Badge>
      {:else}
        <Badge variant="error">{t("journalForm.unbalanced")}</Badge>
      {/if}
      <span class="text-sm text-zinc-400"
        >{t("journalForm.debitCredit", { v: totalDebit.toFixed(2) })} {totalCredit.toFixed(2)}</span
      >
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-48">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-3">
      <div><Label>{t("common.date")}</Label><Input type="date" bind:value={journal.date} /></div>
      <div>
        <Label>{t("journalForm.reference")}</Label><Input
          bind:value={journal.reference}
          placeholder={t("journalForm.inv001Case123")}
        />
      </div>
      <div>
        <Label>{t("common.type")}</Label>
        <select
          bind:value={journal.journalType}
          class="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
        >
          <option value="standard">{t("journalForm.standard")}</option>
          <option value="trust_deposit">{t("journalForm.trustDeposit")}</option>
          <option value="trust_withdrawal">{t("journalForm.trustWithdrawal")}</option>
          <option value="disbursement">{t("journalForm.disbursement")}</option>
        </select>
      </div>
    </div>

    <div>
      <Label>{t("common.description")}</Label><Textarea bind:value={journal.description} rows={2} />
    </div>

    <div>
      <Label>{t("journalForm.counterparty")}</Label>
      <select
        bind:value={journal.counterpartyId}
        class="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm"
      >
        <option value="">{t("journalForm.none")}</option>
        {#each counterparties as cp}
          <option value={cp.id}>{cp.name} ({cp.type})</option>
        {/each}
      </select>
    </div>

    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <Label>{t("journalForm.ledgerLines")}</Label>
        <Button variant="outline" size="sm" onclick={addLine}
          ><Plus class="w-4 h-4 mr-1" /> {t("journalForm.addLine")}</Button
        >
      </div>

      <div class="border border-zinc-800 rounded-lg overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-zinc-900/80 text-zinc-400 text-left">
            <tr>
              <th class="px-3 py-2 font-medium">{t("journalForm.account")}</th>
              <th class="px-3 py-2 font-medium">{t("common.description")}</th>
              <th class="px-3 py-2 font-medium text-right">{t("journalForm.debit")}</th>
              <th class="px-3 py-2 font-medium text-right">{t("journalForm.credit")}</th>
              <th class="px-3 py-2 font-medium">{t("common.currency")}</th>
              <th class="px-3 py-2 font-medium w-10"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-zinc-800">
            {#each journal.lines as line, idx}
              <tr class="hover:bg-zinc-800/20">
                <td class="px-3 py-2">
                  <select
                    bind:value={line.accountId}
                    class="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    <option value="">{t("common.select")}</option>
                    {#each accounts as a}
                      <option value={a.id}>{a.code} - {a.name}</option>
                    {/each}
                  </select>
                </td>
                <td class="px-3 py-2"
                  ><Input bind:value={line.description} class="text-sm py-1" /></td
                >
                <td class="px-3 py-2"
                  ><Input
                    type="number"
                    step="0.01"
                    bind:value={line.debit}
                    class="text-sm py-1 text-right"
                  /></td
                >
                <td class="px-3 py-2"
                  ><Input
                    type="number"
                    step="0.01"
                    bind:value={line.credit}
                    class="text-sm py-1 text-right"
                  /></td
                >
                <td class="px-3 py-2">
                  <select
                    bind:value={line.currency}
                    class="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    {#each currencies as c}<option value={c.code}>{c.code}</option>{/each}
                  </select>
                </td>
                <td class="px-3 py-2">
                  <Button variant="ghost" size="sm" onclick={() => removeLine(idx)}
                    ><X class="w-4 h-4 text-red-400" /></Button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div class="flex items-center justify-between pt-4 border-t border-zinc-800">
      <Button variant="outline" onclick={onBack} disabled={saving}>{t("common.cancel")}</Button>
      <div class="flex items-center gap-2">
        <Button variant="secondary" onclick={saveDraft} loading={saving}
          ><Save class="w-4 h-4 mr-2" /> {t("journalForm.saveDraft")}</Button
        >
        <Button onclick={post} loading={saving} disabled={!isBalanced}
          ><CheckCircle class="w-4 h-4 mr-2" /> {t("journalForm.post")}</Button
        >
      </div>
    </div>
  {/if}
</div>
