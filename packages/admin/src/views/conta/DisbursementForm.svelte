<script lang="ts">
  import { t } from "$lib/i18n";
  import { ArrowLeft, Save, FileText, DollarSign } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { api } from "$lib/api";
  import Badge from "$lib/components/ui/Badge.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Input from "$lib/components/ui/Input.svelte";
  import Label from "$lib/components/ui/Label.svelte";
  import Textarea from "$lib/components/ui/Textarea.svelte";

  interface Props {
    disbursementId?: string | null;
    onBack: () => void;
    onSave: () => void;
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
      onSave();
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

<div class="space-y-6">
  <Button variant="ghost" onclick={onBack}
    ><ArrowLeft class="w-4 h-4 mr-2" /> {t("common.back")}</Button
  >

  {#if loading}
    <div class="flex items-center justify-center h-48">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-kitsuden-accent"></div>
    </div>
  {:else}
    {#if disbursement}
      {@const sb = statusBadge(disbursement.status)}
      <div class="flex items-center gap-3">
        <Badge variant={sb.variant}>{sb.label}</Badge>
        <span class="text-sm text-kitsuden-text-dim"
          >{disbursement.matterNumber ||
            matters.find((m) => m.id === disbursement.matterId)?.matterNumber ||
            disbursement.matterId}</span
        >
      </div>
    {/if}

    <div class="grid gap-4 md:grid-cols-2">
      <div>
        <Label>{t("disbursementForm.matter")}</Label>
        <select
          bind:value={matterId}
          disabled={!!disbursement}
          class="w-full bg-kitsuden-card border border-kitsuden-input rounded-lg px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="">{t("common.select")}</option>
          {#each matters as m}
            <option value={m.id}>{m.matterNumber} - {m.name}</option>
          {/each}
        </select>
      </div>
      <div>
        <Label>{t("disbursementForm.paidFromAccount")}</Label>
        <select
          bind:value={paidFromAccountId}
          disabled={!!disbursement}
          class="w-full bg-kitsuden-card border border-kitsuden-input rounded-lg px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="">{t("common.select")}</option>
          {#each accounts as a}
            <option value={a.id}>{a.code} - {a.name}</option>
          {/each}
        </select>
      </div>
      <div>
        <Label>{t("disbursementForm.amount")}</Label>
        <Input
          type="number"
          step="0.01"
          bind:value={amount}
          disabled={!!disbursement}
          placeholder="0.00"
        />
      </div>
      <div class="md:col-span-2">
        <Label>{t("common.description")}</Label>
        <Textarea
          bind:value={description}
          disabled={!!disbursement}
          rows={2}
          placeholder={t("disbursementForm.whatWasPaidFor")}
        />
      </div>
    </div>

    <div class="flex items-center justify-between pt-4 border-t border-kitsuden-border">
      <Button variant="outline" onclick={onBack} disabled={saving}>{t("common.back")}</Button>
      {#if disbursement}
        <div class="flex items-center gap-2">
          {#if disbursement.status === "pending"}
            <Button variant="outline" onclick={bill}
              ><FileText class="w-4 h-4 mr-2" /> {t("disbursementForm.bill")}</Button
            >
          {/if}
          {#if disbursement.status === "billed"}
            <Button onclick={pay}
              ><DollarSign class="w-4 h-4 mr-2" /> {t("disbursementForm.pay")}</Button
            >
          {/if}
        </div>
      {:else}
        <Button onclick={save} loading={saving}
          ><Save class="w-4 h-4 mr-2" /> {t("common.create")}</Button
        >
      {/if}
    </div>
  {/if}
</div>
