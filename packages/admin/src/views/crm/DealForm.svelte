<script lang="ts">
  import { t as tr } from "$lib/i18n";
  import { ArrowLeft } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast, Button, Input, Label, NumberInput, Select, Textarea } from "$lib/tallao";

  import { api } from "$lib/api";

  import type { CrmDeal, CrmPipeline, CrmPipelineStage, CrmCompany, CrmContact } from "./types";

  interface Props {
    dealId?: string | null;
    /** Inside a sheet or dialog that already names it: no "← Deals / New deal" row. */
    embedded?: boolean;
    /** Back and Cancel; the previous page when the form is a page of its own. */
    onBack?: () => void;
    onSave?: () => void;
  }

  const {
    dealId = null,
    embedded = false,
    onBack = () => history.back(),
    onSave = () => history.back(),
  }: Props = $props();

  let loading = $state(false);
  let pipelines = $state<CrmPipeline[]>([]);
  let stages = $state<CrmPipelineStage[]>([]);
  let companies = $state<CrmCompany[]>([]);
  let contacts = $state<CrmContact[]>([]);
  let tagsInput = $state("");

  let formData = $state<Partial<CrmDeal>>({
    title: "",
    description: "",
    value: 0,
    currency: "USD",
    status: "open",
    pipelineId: "",
    stageId: "",
    probability: 50,
    contactId: "",
    companyId: "",
    assignedTo: "",
    expectedCloseDate: "",
    source: "",
    campaign: "",
  });

  const statuses = [
    { value: "open", label: tr("dealForm.open") },
    { value: "won", label: tr("dealForm.won") },
    { value: "lost", label: tr("dealForm.lost") },
    { value: "paused", label: tr("dealForm.paused") },
  ];

  onMount(async () => {
    try {
      const [pipelinesRes, companiesRes, contactsRes] = await Promise.all([
        api.getCrmPipelines(),
        api.getCrmCompanies(),
        api.getCrmContacts(),
      ]);
      pipelines = pipelinesRes.data || [];
      companies = companiesRes.data || [];
      contacts = contactsRes.data || [];

      if (dealId) {
        const res = await api.getCrmDeal(dealId);
        // `{ data: deal }`; anything else (an empty answer) is said, not read as a deal.
        const deal = res?.data as CrmDeal | undefined;
        if (!deal || typeof deal !== "object") throw new Error(tr("dealForm.failedToLoadData"));
        formData = {
          ...deal,
          expectedCloseDate: deal.expectedCloseDate
            ? new Date(deal.expectedCloseDate).toISOString().split("T")[0]
            : "",
        };
        tagsInput = (deal.tags || []).join(", ");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("dealForm.failedToLoadData"));
    }
  });

  async function loadStages(pipelineId: string) {
    if (!pipelineId) {
      stages = [];
      return;
    }
    try {
      const res = await api.getCrmPipeline(pipelineId);
      stages = res.data.stages || [];
      if (!stages.find((s) => s.id === formData.stageId)) {
        formData.stageId = stages[0]?.id || "";
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("dealForm.failedToLoadStages"));
    }
  }

  $effect(() => {
    const pid = formData.pipelineId;
    if (pid) {
      loadStages(pid);
    } else {
      stages = [];
    }
  });

  async function handleSubmit() {
    if (!formData.title?.trim()) {
      toast.error(tr("dealForm.dealTitleIsRequired"));
      return;
    }
    if (!formData.stageId) {
      toast.error(tr("dealForm.stageIsRequired"));
      return;
    }

    try {
      loading = true;
      const payload = {
        ...formData,
        value: Number(formData.value) || 0,
        probability: Number(formData.probability) || 0,
        expectedCloseDate: formData.expectedCloseDate || undefined,
        tags: tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };

      if (dealId) {
        await api.updateCrmDeal(dealId, payload);
        toast.success(tr("dealForm.dealUpdated"));
      } else {
        await api.createCrmDeal(payload);
        toast.success(tr("dealForm.dealCreated"));
      }
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("dealForm.failedToSaveDeal"));
    } finally {
      loading = false;
    }
  }
</script>

<div class="space-y-6">
  {#if !embedded}
    <div class="flex items-center gap-2 text-sm text-kitsuden-text-dim">
      <Button variant="ghost" size="sm" onclick={onBack} class="gap-1">
        <ArrowLeft class="w-4 h-4" />
        {tr("dealForm.deals")}
      </Button>
      <span>/</span>
      <span class="text-kitsuden-text"
        >{dealId ? tr("common.edit") : tr("dealForm.new")} {tr("dealForm.deal")}</span
      >
    </div>
  {/if}

  <div class="space-y-8">
    <section>
      <h3
        class="text-sm font-semibold text-kitsuden-text uppercase tracking-wider mb-3 border-b border-kitsuden-border pb-2"
      >
        {tr("dealForm.dealInformation")}
      </h3>
      <div class="grid gap-4 md:grid-cols-2">
        <!-- Title -->
        <div class="space-y-2 md:col-span-2">
          <Label for="title" required>{tr("dealForm.dealTitle")}</Label>
          <Input
            id="title"
            bind:value={formData.title}
            placeholder={tr("dealForm.enterpriseSoftwareLicense")}
          />
        </div>

        <!-- Description -->
        <div class="space-y-2 md:col-span-2">
          <Label for="description">{tr("common.description")}</Label>
          <Textarea
            id="description"
            bind:value={formData.description}
            placeholder={tr("dealForm.dealDetailsAndNotes")}
            rows={3}
          />
        </div>

        <!-- Value -->
        <div class="space-y-2">
          <Label for="value">{tr("dealForm.valueCents")}</Label>
          <NumberInput
            id="value"
            value={formData.value ?? null}
            onchange={(v) => (formData.value = v ?? undefined)}
            placeholder="10000"
          />
        </div>

        <!-- Currency -->
        <div class="space-y-2">
          <Label for="currency">{tr("common.currency")}</Label>
          <Input id="currency" bind:value={formData.currency} placeholder="USD" />
        </div>

        <!-- Status -->
        <div class="space-y-2">
          <Label for="status">{tr("common.status")}</Label>
          <Select
            id="status"
            options={statuses}
            value={formData.status ?? "open"}
            onchange={(e: Event) =>
              (formData.status = (e.currentTarget as HTMLSelectElement).value as CrmDeal["status"])}
          />
        </div>

        <!-- Probability -->
        <div class="space-y-2">
          <Label for="probability">{tr("dealForm.probability")}</Label>
          <NumberInput
            id="probability"
            min={0}
            max={100}
            clamp={false}
            value={formData.probability ?? null}
            onchange={(v) => (formData.probability = v ?? undefined)}
            placeholder="50"
          />
        </div>

        <!-- Pipeline -->
        <div class="space-y-2">
          <Label for="pipelineId" required>{tr("dealForm.pipeline")}</Label>
          <Select id="pipelineId" bind:value={formData.pipelineId}>
            <option value="">{tr("dealForm.selectPipeline")}</option>
            {#each pipelines as pipeline}
              <option value={pipeline.id}>{pipeline.name}</option>
            {/each}
          </Select>
        </div>

        <!-- Stage -->
        <div class="space-y-2">
          <Label for="stageId" required>{tr("dealForm.stage")}</Label>
          <Select id="stageId" bind:value={formData.stageId}>
            <option value="">{tr("dealForm.selectStage")}</option>
            {#each stages as stage}
              <option value={stage.id}>{stage.name}</option>
            {/each}
          </Select>
        </div>

        <!-- Expected Close Date -->
        <div class="space-y-2">
          <Label for="expectedCloseDate">{tr("dealForm.expectedCloseDate")}</Label>
          <Input id="expectedCloseDate" type="date" bind:value={formData.expectedCloseDate} />
        </div>

        <!-- Source -->
        <div class="space-y-2">
          <Label for="source">{tr("common.source")}</Label>
          <Input
            id="source"
            bind:value={formData.source}
            placeholder={tr("dealForm.websiteCampaignEtc")}
          />
        </div>

        <!-- Campaign -->
        <div class="space-y-2">
          <Label for="campaign">{tr("dealForm.campaign")}</Label>
          <Input
            id="campaign"
            bind:value={formData.campaign}
            placeholder={tr("dealForm.summer2024")}
          />
        </div>

        <!-- Tags -->
        <div class="space-y-2 md:col-span-2">
          <Label for="tags">{tr("common.tags")}</Label>
          <Input
            id="tags"
            bind:value={tagsInput}
            placeholder={tr("dealForm.enterpriseQualifiedUrgentCommaSeparated")}
          />
        </div>
      </div>
    </section>

    <section>
      <h3
        class="text-sm font-semibold text-kitsuden-text uppercase tracking-wider mb-3 border-b border-kitsuden-border pb-2"
      >
        {tr("dealForm.relatedEntities")}
      </h3>
      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <Label for="contactId">{tr("dealForm.relatedContact")}</Label>
          <Select id="contactId" bind:value={formData.contactId}>
            <option value="">{tr("dealForm.none")}</option>
            {#each contacts as c}
              <option value={c.id}>{c.firstName} {c.lastName}</option>
            {/each}
          </Select>
        </div>
        <div class="space-y-2">
          <Label for="companyId">{tr("dealForm.relatedCompany")}</Label>
          <Select id="companyId" bind:value={formData.companyId}>
            <option value="">{tr("dealForm.none")}</option>
            {#each companies as c}
              <option value={c.id}>{c.name}</option>
            {/each}
          </Select>
        </div>
        <div class="space-y-2">
          <Label for="assignedTo">{tr("dealForm.assignedTo")}</Label>
          <Input
            id="assignedTo"
            bind:value={formData.assignedTo}
            placeholder={tr("common.userId")}
          />
        </div>
      </div>
    </section>

    <div class="border-t border-kitsuden-border pt-4 flex flex-wrap gap-2">
      <Button onclick={handleSubmit} {loading}>
        {loading
          ? tr("common.saving")
          : dealId
            ? tr("dealForm.saveChanges")
            : tr("dealForm.createDeal")}
      </Button>
      <Button variant="secondary" onclick={onBack} disabled={loading}>{tr("common.cancel")}</Button>
    </div>
  </div>
</div>
