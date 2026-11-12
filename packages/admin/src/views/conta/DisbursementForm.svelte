<script lang="ts">
  import { t } from "$lib/i18n";
  import { ArrowLeft, Save, FileText, DollarSign } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast, Badge, Button, Field, Input, Select, Spinner, Textarea } from "$lib/tallao";

  import { api } from "$lib/api";

  interface Props {
    disbursementId?: string | null;
    /**
     * Back and Cancel. A kon mounts the form as a tab of its page and passes nothing: then
     * there is nowhere to go back to and the buttons are not drawn (they called an undefined
     * function).
     */
    onBack?: () => void;
    /** After a save; by default the form starts over, ready for the next one. */
    onSave?: () => void;
  }
  const { disbursementId = null, onBack, onSave }: Props = $props();

  let matters = $state<any[]>([]);
  let accounts = $state<any[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  let matterId = $state("");
  let description = $state("");
  let amount = $state("");
  let paidFromAccountId = $state("");
  let disbursement = $state<any>(null);

  async function load() {
    try {
      const [mRes, aRes] = await Promise.all([
        api.getContaMatters(),
        api.getContaAccounts({ type: "asset", limit: 500 }),
      ]);
      matters = mRes.data || [];
      accounts = aRes.data || [];

      if (disbursementId) {
        const dRes = await api.getContaDisbursement(disbursementId);
        disbursement = dRes.data;
        matterId = disbursement.matterId;
        description = disbursement.description;
        amount = disbursement.amount;
        paidFromAccountId = disbursement.paidFromAccountId || "";
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!matterId || !description || !amount || !paidFromAccountId) {
      toast.error(t("disbursementForm.allFieldsAreRequired"));
      return;
    }
    saving = true;
    try {
      await api.createContaDisbursement({
        matterId,
        description,
        amount: String(amount),
        paidFromAccountId,
      });
      toast.success(t("disbursementForm.disbursementCreated"));
      if (onSave) onSave();
      else {
        matterId = "";
        description = "";
        amount = "";
        paidFromAccountId = "";
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      saving = false;
    }
  }

  async function bill() {
    if (!disbursementId) return;
    try {
      await api.billContaDisbursement(disbursementId);
      toast.success(t("disbursementForm.disbursementBilled"));
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function pay() {
    if (!disbursementId) return;
    try {
      await api.payContaDisbursement(disbursementId);
      toast.success(t("disbursementForm.disbursementPaid"));
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  function statusBadge(status: string) {
    switch (status) {
      case "paid":
        return { variant: "success" as const, label: t("disbursementForm.paid") };
      case "billed":
        return { variant: "info" as const, label: t("disbursementForm.billed") };
      default:
        return { variant: "warning" as const, label: t("disbursementForm.pending") };
    }
  }

  onMount(load);
</script>

<div class="space-y-6 min-w-0">
  {#if onBack}
    <Button variant="ghost" onclick={onBack}
      ><ArrowLeft class="w-4 h-4" /> {t("common.back")}</Button
    >
  {/if}

  {#if loading}
    <div class="flex items-center justify-center h-48"><Spinner size="lg" /></div>
  {:else}
    {#if disbursement}
      {@const sb = statusBadge(disbursement.status)}
      <div class="flex flex-wrap items-center gap-3">
        <Badge variant={sb.variant}>{sb.label}</Badge>
        <span class="text-sm text-kitsuden-text-dim"
          >{disbursement.matterNumber ||
            matters.find((m) => m.id === disbursement.matterId)?.matterNumber ||
            disbursement.matterId}</span
        >
      </div>
    {/if}

    <div class="grid gap-4 md:grid-cols-2">
      <Field label={t("disbursementForm.matter")}>
        <Select bind:value={matterId} disabled={!!disbursement}>
          <option value="">{t("common.select")}</option>
          {#each matters as m}
            <option value={m.id}>{m.matterNumber} - {m.name}</option>
          {/each}
        </Select>
      </Field>
      <Field label={t("disbursementForm.paidFromAccount")}>
        <Select bind:value={paidFromAccountId} disabled={!!disbursement}>
          <option value="">{t("common.select")}</option>
          {#each accounts as a}
            <option value={a.id}>{a.code} - {a.name}</option>
          {/each}
        </Select>
      </Field>
      <Field label={t("disbursementForm.amount")}>
        <Input
          type="number"
          step="0.01"
          bind:value={amount}
          disabled={!!disbursement}
          placeholder="0.00"
        />
      </Field>
      <Field label={t("common.description")} class="md:col-span-2">
        <Textarea
          bind:value={description}
          disabled={!!disbursement}
          rows={2}
          placeholder={t("disbursementForm.whatWasPaidFor")}
        />
      </Field>
    </div>

    <div
      class="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-kitsuden-border"
    >
      {#if onBack}
        <Button variant="secondary" onclick={onBack} disabled={saving}>{t("common.back")}</Button>
      {/if}
      {#if disbursement}
        <div class="flex items-center gap-2">
          {#if disbursement.status === "pending"}
            <Button variant="secondary" onclick={bill}
              ><FileText class="w-4 h-4" /> {t("disbursementForm.bill")}</Button
            >
          {/if}
          {#if disbursement.status === "billed"}
            <Button onclick={pay}><DollarSign class="w-4 h-4" /> {t("disbursementForm.pay")}</Button
            >
          {/if}
        </div>
      {:else}
        <Button onclick={save} loading={saving}
          ><Save class="w-4 h-4" /> {t("common.create")}</Button
        >
      {/if}
    </div>
  {/if}
</div>
