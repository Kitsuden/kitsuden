<script lang="ts">
  import { t } from "$lib/i18n";
  import { Save, Plus, X, CheckCircle, ArrowLeft } from "lucide-svelte";
  import { onMount } from "svelte";
  import {
    toast,
    Badge,
    Button,
    Input,
    Field,
    Select,
    Spinner,
    Textarea,
    Table,
    TableHeader,
    TableBody,
    TableRow,
    TableHead,
    TableCell,
  } from "$lib/tallao";

  import { api } from "$lib/api";

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

<div class="space-y-6 min-w-0">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Button variant="ghost" onclick={onBack}
      ><ArrowLeft class="w-4 h-4" /> {t("common.back")}</Button
    >
    <div class="flex items-center gap-2">
      {#if isBalanced}
        <Badge variant="success">{t("journalForm.balanced")}</Badge>
      {:else}
        <Badge variant="error">{t("journalForm.unbalanced")}</Badge>
      {/if}
      <span class="text-sm text-kitsuden-text-dim"
        >{t("journalForm.debitCredit", { v: totalDebit.toFixed(2) })} {totalCredit.toFixed(2)}</span
      >
    </div>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-48"><Spinner size="lg" /></div>
  {:else}
    <div class="grid gap-4 md:grid-cols-3">
      <Field label={t("common.date")}><Input type="date" bind:value={journal.date} /></Field>
      <Field label={t("journalForm.reference")}>
        <Input bind:value={journal.reference} placeholder={t("journalForm.inv001Case123")} />
      </Field>
      <Field label={t("common.type")}>
        <Select bind:value={journal.journalType}>
          <option value="standard">{t("journalForm.standard")}</option>
          <option value="trust_deposit">{t("journalForm.trustDeposit")}</option>
          <option value="trust_withdrawal">{t("journalForm.trustWithdrawal")}</option>
          <option value="disbursement">{t("journalForm.disbursement")}</option>
        </Select>
      </Field>
    </div>

    <Field label={t("common.description")}>
      <Textarea bind:value={journal.description} rows={2} />
    </Field>

    <Field label={t("journalForm.counterparty")}>
      <Select bind:value={journal.counterpartyId}>
        <option value="">{t("journalForm.none")}</option>
        {#each counterparties as cp}
          <option value={cp.id}>{cp.name} ({cp.type})</option>
        {/each}
      </Select>
    </Field>

    <div class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-medium text-kitsuden-text">{t("journalForm.ledgerLines")}</h3>
        <Button variant="secondary" size="sm" onclick={addLine}
          ><Plus class="w-4 h-4" /> {t("journalForm.addLine")}</Button
        >
      </div>

      <div>
        <Table density="compact" aria-label={t("journalForm.ledgerLines")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("journalForm.account")}</TableHead>
              <TableHead>{t("common.description")}</TableHead>
              <TableHead class="text-right">{t("journalForm.debit")}</TableHead>
              <TableHead class="text-right">{t("journalForm.credit")}</TableHead>
              <TableHead>{t("common.currency")}</TableHead>
              <TableHead class="w-10"><span class="sr-only">{t("common.actions")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each journal.lines as line, idx}
              <TableRow>
                <TableCell>
                  <Select
                    size="sm"
                    bind:value={line.accountId}
                    aria-label={t("journalForm.account")}
                  >
                    <option value="">{t("common.select")}</option>
                    {#each accounts as a}
                      <option value={a.id}>{a.code} - {a.name}</option>
                    {/each}
                  </Select>
                </TableCell>
                <TableCell
                  ><Input
                    bind:value={line.description}
                    aria-label={t("common.description")}
                  /></TableCell
                >
                <TableCell
                  ><Input
                    type="number"
                    step="0.01"
                    bind:value={line.debit}
                    aria-label={t("journalForm.debit")}
                    class="text-right"
                  /></TableCell
                >
                <TableCell
                  ><Input
                    type="number"
                    step="0.01"
                    bind:value={line.credit}
                    aria-label={t("journalForm.credit")}
                    class="text-right"
                  /></TableCell
                >
                <TableCell>
                  <Select size="sm" bind:value={line.currency} aria-label={t("common.currency")}>
                    {#each currencies as c}<option value={c.code}>{c.code}</option>{/each}
                  </Select>
                </TableCell>
                <TableCell>
                  <Button
                    variant="danger-ghost"
                    size="icon"
                    ariaLabel={t("journalForm.removeLine")}
                    title={t("journalForm.removeLine")}
                    onclick={() => removeLine(idx)}><X class="w-4 h-4" aria-hidden="true" /></Button
                  >
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    </div>

    <div
      class="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-kitsuden-border"
    >
      <Button variant="secondary" onclick={onBack} disabled={saving}>{t("common.cancel")}</Button>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onclick={saveDraft} loading={saving}
          ><Save class="w-4 h-4" /> {t("journalForm.saveDraft")}</Button
        >
        <Button onclick={post} loading={saving} disabled={!isBalanced}
          ><CheckCircle class="w-4 h-4" /> {t("journalForm.post")}</Button
        >
      </div>
    </div>
  {/if}
</div>
