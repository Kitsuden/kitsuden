<script lang="ts">
  import { t as tr } from "$lib/i18n";
  /**
   * DatasetCreator - Dataset creator with support for computed fields
   *
   * View to create and configure datasets with:
   * - Native fields
   * - Computed fields/KPIs
   * - Relations
   * - DataExplorer views
   */
  import type { CreateDatasetPayload, FieldDefinition } from "@kitsuden/shared";
  import {
    Plus,
    Settings,
    Table2,
    Calculator,
    ChevronRight,
    Save,
    X,
    Loader2,
  } from "lucide-svelte";

  import {
    KpiCreator,
    FormulaBuilder,
    type CalculatedField,
  } from "$lib/components/calculated-fields";
  import { datasetStore } from "$lib/states/datasets.svelte";

  import { goto } from "$app/navigation";

  // Native field types
  const nativeFieldTypes = [
    {
      id: "text",
      label: tr("datasetCreator.text"),
      description: tr("datasetCreator.shortTextInput"),
    },
    {
      id: "textarea",
      label: tr("datasetCreator.longText"),
      description: tr("datasetCreator.multiLineText"),
    },
    {
      id: "number",
      label: tr("datasetCreator.number"),
      description: tr("datasetCreator.numericValue"),
    },
    {
      id: "boolean",
      label: tr("datasetCreator.boolean"),
      description: tr("datasetCreator.yesNoToggle"),
    },
    { id: "date", label: tr("common.date"), description: tr("datasetCreator.datePicker") },
    {
      id: "datetime",
      label: tr("datasetCreator.dateTime"),
      description: tr("datasetCreator.timestamp"),
    },
    {
      id: "select",
      label: tr("datasetCreator.select"),
      description: tr("datasetCreator.dropdownOptions"),
    },
    {
      id: "multiselect",
      label: tr("datasetCreator.multiSelect"),
      description: tr("datasetCreator.multipleChoices"),
    },
    {
      id: "relation",
      label: tr("datasetCreator.relation"),
      description: tr("datasetCreator.linkToAnotherTable"),
    },
    { id: "media", label: tr("common.media"), description: tr("datasetCreator.imagesOrFiles") },
    { id: "kpi", label: "KPI", description: tr("datasetCreator.calculatedMetric") },
  ];

  // State
  let step = $state(1);
  let datasetName = $state("");
  let datasetLabel = $state("");
  let description = $state("");

  // Fields
  let fields = $state<
    Array<{ id: string; name: string; label: string; type: string; config?: any }>
  >([]);
  let calculatedFields = $state<CalculatedField[]>([]);

  // UI state
  let showAddField = $state(false);
  let showAddCalculated = $state(false);
  let editingField = $state<any>(null);

  // Preview field for the formula builder
  let previewFormula = $state("");

  const steps = [
    { id: 1, label: tr("datasetCreator.basicInfo"), icon: Settings },
    { id: 2, label: tr("common.fields"), icon: Table2 },
    { id: 3, label: tr("datasetCreator.calculatedFields"), icon: Calculator },
    { id: 4, label: tr("datasetCreator.review"), icon: Save },
  ];

  function addField(type: string) {
    const id = crypto.randomUUID();
    fields = [
      ...fields,
      {
        id,
        name: ``,
        label: tr("datasetCreator.new", { type }),
        type,
        config: {},
      },
    ];
    editingField = fields[fields.length - 1];
    showAddField = false;
  }

  function removeField(index: number) {
    const field = fields[index];
    fields = fields.filter((_, i) => i !== index);

    // Remove computed fields that depend on this field
    calculatedFields = calculatedFields.filter((cf) => !cf.dependsOn?.includes(field.name));
  }

  function addCalculatedField(field: CalculatedField) {
    calculatedFields = [...calculatedFields, field];
    showAddCalculated = false;
  }

  function removeCalculatedField(index: number) {
    calculatedFields = calculatedFields.filter((_, i) => i !== index);
  }

  async function saveDataset() {
    // Transform fields to the FieldDefinition format
    const transformedFields: FieldDefinition[] = fields.map((f, index) => ({
      id: f.id,
      key: f.name,
      label: f.label,
      type: f.type as any, // Map native types to FieldType
      order: index,
      isRequired: false,
      isUnique: false,
      hidden: false,
      ...f.config,
    }));

    // Add computed fields as KPI-type fields
    const calculatedFieldsAsKpi: FieldDefinition[] = calculatedFields.map((cf, index) => ({
      id: cf.id,
      key: cf.name,
      label: cf.label,
      type: "kpi",
      order: fields.length + index,
      isRequired: false,
      isUnique: false,
      hidden: false,
      helpText: cf.config?.expression || `${cf.type} calculation`,
    }));

    const payload: CreateDatasetPayload = {
      name: datasetLabel,
      slug: datasetName,
      description: description || undefined,
      fields: [...transformedFields, ...calculatedFieldsAsKpi],
      policyJson: null,
      workflowJson: null,
    };

    const result = await datasetStore.createDataset(payload);

    if (result) {
      goto("/datasets");
    } else {
      alert(tr("datasetCreator.failedToCreateDataset", { error: datasetStore.error }));
    }
  }

  // Generate name from label
  $effect(() => {
    if (datasetLabel && !datasetName) {
      datasetName = datasetLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    }
  });

  // Fields available for formulas
  const availableFormulaFields = $derived(
    [
      ...fields.map((f) => ({ name: f.name, label: f.label, type: f.type })),
      ...calculatedFields.map((f) => ({ name: f.name, label: f.label, type: "number" })),
    ].filter((f) => f.name)
  );
</script>

<div class="max-w-5xl mx-auto space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <Plus class="w-6 h-6 text-kitsuden-accent" />
        {tr("common.createDataset")}
      </h1>
      <p class="text-kitsuden-subtle mt-1">{tr("datasetCreator.defineYourDataStructureWith")}</p>
    </div>
    <div class="flex items-center gap-2">
      {#if step > 1}
        <button class="btn-secondary" onclick={() => step--}> {tr("common.back")} </button>
      {/if}
      {#if step < 4}
        <button class="btn-primary flex items-center gap-2" onclick={() => step++}>
          {tr("common.next")}
          <ChevronRight class="w-4 h-4" />
        </button>
      {:else}
        <button
          class="btn-primary flex items-center gap-2"
          onclick={saveDataset}
          disabled={datasetStore.isLoading}
        >
          {#if datasetStore.isLoading}
            <Loader2 class="w-4 h-4 animate-spin" />
            {tr("common.creating")}
          {:else}
            <Save class="w-4 h-4" />
            {tr("common.createDataset")}
          {/if}
        </button>
      {/if}
    </div>
  </div>

  <!-- Steps -->
  <div class="flex items-center gap-2">
    {#each steps as s, index}
      <button
        class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all {step ===
        s.id
          ? 'bg-kitsuden-accent text-black'
          : step > s.id
            ? 'bg-kitsuden-accent/20 text-kitsuden-accent'
            : 'bg-kitsuden-surface text-kitsuden-subtle'}"
        onclick={() => (step = s.id)}
      >
        <svelte:component this={s.icon} class="w-4 h-4" />
        {s.label}
      </button>
      {#if index < steps.length - 1}
        <ChevronRight class="w-4 h-4 text-kitsuden-subtle" />
      {/if}
    {/each}
  </div>

  <!-- Error Message -->
  {#if datasetStore.error}
    <div
      class="bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/30 text-kitsuden-accent-2 px-4 py-3 rounded-lg mb-4"
    >
      <p class="font-medium">{tr("common.error")}</p>
      <p class="text-sm">{datasetStore.error}</p>
    </div>
  {/if}

  <!-- Content -->
  <div class="bg-kitsuden-card border border-kitsuden-border rounded-xl p-6">
    {#if step === 1}
      <!-- Step 1: Basic Info -->
      <div class="space-y-6 max-w-xl">
        <div>
          <label for="datasetlabel" class="block text-sm font-medium text-kitsuden-text mb-2">
            {tr("datasetCreator.datasetLabel")} <span class="text-kitsuden-accent-2">*</span>
          </label>
          <input
            id="datasetlabel"
            type="text"
            bind:value={datasetLabel}
            placeholder={tr("datasetCreator.eGSalesOrders")}
            class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
          />
        </div>

        <div>
          <label for="datasetname" class="block text-sm font-medium text-kitsuden-text mb-2">
            {tr("datasetCreator.datasetName")} <span class="text-kitsuden-accent-2">*</span>
          </label>
          <input
            id="datasetname"
            type="text"
            bind:value={datasetName}
            placeholder={tr("datasetCreator.eGSalesOrders2")}
            class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text font-mono focus:outline-none focus:border-kitsuden-accent"
          />
          <p class="mt-1 text-xs text-kitsuden-subtle">
            {tr("datasetCreator.usedInApiEndpointsAuto")}
          </p>
        </div>

        <div>
          <label for="description" class="block text-sm font-medium text-kitsuden-text mb-2">
            {tr("common.description")}
          </label>
          <textarea
            id="description"
            bind:value={description}
            placeholder={tr("datasetCreator.whatDataDoesThisDataset")}
            rows="3"
            class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text focus:outline-none focus:border-kitsuden-accent"
          ></textarea>
        </div>
      </div>
    {:else if step === 2}
      <!-- Step 2: Fields -->
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <h3 class="font-medium text-kitsuden-text">
            {tr("datasetCreator.nativeFields", { fieldsCount: fields.length })}
          </h3>
          <button
            class="btn-secondary flex items-center gap-2"
            onclick={() => (showAddField = true)}
          >
            <Plus class="w-4 h-4" />
            {tr("datasetCreator.addField")}
          </button>
        </div>

        {#if fields.length === 0}
          <div class="text-center py-12 border-2 border-dashed border-kitsuden-border rounded-xl">
            <Table2 class="w-12 h-12 text-kitsuden-subtle mx-auto mb-3" />
            <p class="text-kitsuden-text-dim">{tr("datasetCreator.noFieldsYet")}</p>
            <button
              class="text-kitsuden-accent hover:underline mt-2"
              onclick={() => (showAddField = true)}
            >
              {tr("datasetCreator.addYourFirstField")}
            </button>
          </div>
        {:else}
          <div class="space-y-3">
            {#each fields as field, index}
              <div
                class="flex items-center gap-4 p-4 bg-kitsuden-surface/50 rounded-lg border border-kitsuden-border"
              >
                <div class="flex-1">
                  {#if editingField?.id === field.id}
                    <div class="flex items-center gap-3">
                      <input
                        type="text"
                        bind:value={field.label}
                        placeholder={tr("datasetCreator.fieldLabel")}
                        class="flex-1 px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-border rounded text-sm"
                        onblur={() => {
                          if (!field.name) {
                            field.name = field.label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
                          }
                        }}
                      />
                      <input
                        type="text"
                        bind:value={field.name}
                        placeholder="name"
                        class="w-32 px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-border rounded text-sm font-mono"
                      />
                      <select
                        bind:value={field.type}
                        class="px-3 py-1.5 bg-kitsuden-bg border border-kitsuden-border rounded text-sm"
                      >
                        {#each nativeFieldTypes as type}
                          <option value={type.id}>{type.label}</option>
                        {/each}
                      </select>
                      <button
                        class="p-1.5 text-kitsuden-green hover:bg-kitsuden-green/10 rounded"
                        onclick={() => (editingField = null)}
                      >
                        <Save class="w-4 h-4" />
                      </button>
                    </div>
                  {:else}
                    <div class="flex items-center gap-3">
                      <span class="font-medium text-kitsuden-text">{field.label}</span>
                      <code class="text-xs text-kitsuden-subtle bg-kitsuden-bg px-2 py-0.5 rounded"
                        >{field.name}</code
                      >
                      <span
                        class="text-xs text-kitsuden-subtle px-2 py-0.5 bg-kitsuden-accent/10 text-kitsuden-accent rounded"
                      >
                        {nativeFieldTypes.find((t) => t.id === field.type)?.label}
                      </span>
                    </div>
                  {/if}
                </div>
                <div class="flex items-center gap-1">
                  <button
                    class="p-1.5 text-kitsuden-subtle hover:text-kitsuden-text"
                    onclick={() => (editingField = field)}
                  >
                    <Settings class="w-4 h-4" />
                  </button>
                  <button
                    class="p-1.5 text-kitsuden-subtle hover:text-kitsuden-accent-2"
                    onclick={() => removeField(index)}
                  >
                    <X class="w-4 h-4" />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if step === 3}
      <!-- Step 3: Calculated Fields -->
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-medium text-kitsuden-text">
              {tr("datasetCreator.calculatedFieldsKpis", {
                calculatedFieldsCount: calculatedFields.length,
              })}
            </h3>
            <p class="text-sm text-kitsuden-subtle">
              {tr("datasetCreator.createMetricsAndFormulasBased")}
            </p>
          </div>
          <button
            class="btn-primary flex items-center gap-2"
            onclick={() => (showAddCalculated = true)}
          >
            <Calculator class="w-4 h-4" />
            {tr("datasetCreator.addCalculatedField")}
          </button>
        </div>

        {#if calculatedFields.length === 0}
          <div class="text-center py-12 border-2 border-dashed border-kitsuden-border rounded-xl">
            <Calculator class="w-12 h-12 text-kitsuden-subtle mx-auto mb-3" />
            <p class="text-kitsuden-text-dim">{tr("datasetCreator.noCalculatedFieldsYet")}</p>
            <p class="text-sm text-kitsuden-subtle mt-1">
              {tr("datasetCreator.createKpisLikeTotalsAverages")}
            </p>
          </div>
        {:else}
          <div class="space-y-3">
            {#each calculatedFields as cf, index}
              <div
                class="flex items-center gap-4 p-4 bg-kitsuden-surface/50 rounded-lg border border-kitsuden-border"
              >
                <div
                  class="w-10 h-10 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center"
                >
                  <Calculator class="w-5 h-5 text-kitsuden-accent" />
                </div>
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-medium text-kitsuden-text">{cf.label}</span>
                    {#if cf.isKpi}
                      <span class="text-xs px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded"
                        >{tr("datasetCreator.kpi")}</span
                      >
                    {/if}
                  </div>
                  <code class="text-xs text-kitsuden-subtle">{cf.name}</code>
                  {#if cf.config?.expression}
                    <p class="text-xs text-kitsuden-subtle mt-1 font-mono">
                      {cf.config.expression}
                    </p>
                  {/if}
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-xs text-kitsuden-subtle px-2 py-1 bg-kitsuden-bg rounded">
                    {cf.format?.type}
                  </span>
                  <button
                    class="p-1.5 text-kitsuden-subtle hover:text-kitsuden-accent-2"
                    onclick={() => removeCalculatedField(index)}
                  >
                    <X class="w-4 h-4" />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Quick Formula Builder -->
        {#if fields.length > 0}
          <div class="mt-8 p-4 bg-kitsuden-surface/30 rounded-xl border border-kitsuden-border">
            <h4 class="font-medium text-kitsuden-text mb-4 flex items-center gap-2">
              <Calculator class="w-4 h-4 text-kitsuden-accent" />
              {tr("datasetCreator.quickFormulaPreview")}
            </h4>
            <FormulaBuilder
              availableFields={availableFormulaFields}
              value={previewFormula}
              onChange={(v) => (previewFormula = v)}
            />
          </div>
        {/if}
      </div>
    {:else if step === 4}
      <!-- Step 4: Review -->
      <div class="space-y-6">
        <h3 class="font-medium text-kitsuden-text">
          {tr("datasetCreator.reviewDatasetConfiguration")}
        </h3>

        <div class="space-y-4">
          <div class="p-4 bg-kitsuden-surface/50 rounded-lg">
            <h4 class="text-sm font-medium text-kitsuden-text mb-2">
              {tr("datasetCreator.basicInfo")}
            </h4>
            <div class="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span class="text-kitsuden-subtle">{tr("datasetCreator.label")}</span>
                <span class="text-kitsuden-text ml-2">{datasetLabel}</span>
              </div>
              <div>
                <span class="text-kitsuden-subtle">{tr("datasetCreator.name")}</span>
                <code class="text-kitsuden-accent ml-2">{datasetName}</code>
              </div>
            </div>
          </div>

          <div class="p-4 bg-kitsuden-surface/50 rounded-lg">
            <h4 class="text-sm font-medium text-kitsuden-text mb-2">
              {tr("datasetCreator.nativeFields", { fieldsCount: fields.length })}
            </h4>
            <div class="flex flex-wrap gap-2">
              {#each fields as field}
                <span class="px-3 py-1 bg-kitsuden-bg rounded-lg text-sm text-kitsuden-text">
                  {field.label}
                  <span class="text-kitsuden-subtle text-xs">({field.type})</span>
                </span>
              {/each}
            </div>
          </div>

          <div class="p-4 bg-kitsuden-surface/50 rounded-lg">
            <h4 class="text-sm font-medium text-kitsuden-text mb-2">
              {tr("datasetCreator.calculatedFields2", {
                calculatedFieldsCount: calculatedFields.length,
              })}
            </h4>
            <div class="flex flex-wrap gap-2">
              {#each calculatedFields as cf}
                <span
                  class="px-3 py-1 bg-kitsuden-accent/10 border border-kitsuden-accent/20 rounded-lg text-sm text-kitsuden-accent"
                >
                  {cf.label}
                  {#if cf.isKpi}
                    <span class="text-amber-400 ml-1">★</span>
                  {/if}
                </span>
              {/each}
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Modal: Add Field -->
{#if showAddField}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-kitsuden-card border border-kitsuden-border rounded-xl w-full max-w-lg p-6">
      <h3 class="text-lg font-bold text-kitsuden-text mb-4">{tr("datasetCreator.addField")}</h3>
      <div class="grid grid-cols-2 gap-3">
        {#each nativeFieldTypes as type}
          <button
            class="p-4 rounded-lg border border-kitsuden-border hover:border-kitsuden-accent/50 text-left transition-colors"
            onclick={() => addField(type.id)}
          >
            <p class="font-medium text-kitsuden-text">{type.label}</p>
            <p class="text-xs text-kitsuden-subtle">{type.description}</p>
          </button>
        {/each}
      </div>
      <button class="mt-4 w-full py-2 btn-secondary" onclick={() => (showAddField = false)}>
        {tr("common.cancel")}
      </button>
    </div>
  </div>
{/if}

<!-- Modal: Add Calculated Field -->
{#if showAddCalculated}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <KpiCreator
      availableFields={availableFormulaFields}
      onSave={addCalculatedField}
      onCancel={() => (showAddCalculated = false)}
    />
  </div>
{/if}

<style>
  .btn-primary {
    @apply px-4 py-2 bg-kitsuden-accent text-black font-medium rounded-lg hover:brightness-110 transition-all;
  }
  .btn-secondary {
    @apply px-4 py-2 bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text rounded-lg hover:border-kitsuden-accent/50 transition-all;
  }
</style>
