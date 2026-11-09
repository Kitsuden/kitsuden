<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * KpiCreator - Full KPI / Calculated Fields creator
   *
   * Interface for creating calculated fields with:
   * - Calculation type (formula, aggregation, conditional, etc.)
   * - Visual configuration
   * - Output format
   * - Targets and alerts
   */
  import {
    X,
    Calculator,
    TrendingUp,
    Hash,
    Text,
    Calendar,
    Filter,
    Target,
    AlertTriangle,
    Check,
    ChevronRight,
    Plus,
  } from "lucide-svelte";

  import FormulaBuilder from "./FormulaBuilder.svelte";

  import type { CalculatedField, CalculatedFieldType } from "./index";

  interface Props {
    availableFields: Array<{ name: string; label: string; type: string }>;
    availableTables?: Array<{ name: string; label: string }>;
    value?: Partial<CalculatedField>;
    onSave?: (field: CalculatedField) => void;
    onCancel?: () => void;
  }

  const { availableFields, availableTables = [], value, onSave, onCancel }: Props = $props();

  // Form state
  let step = $state(1);
  const field = $state<any>({
    id: value?.id || crypto.randomUUID(),
    name: value?.name || "",
    label: value?.label || "",
    type: value?.type || "formula",
    config: value?.config || {},
    format: value?.format || { type: "number" },
    dependsOn: value?.dependsOn || [],
    isKpi: value?.isKpi ?? false,
    target: value?.target,
    warningThreshold: value?.warningThreshold,
    ...value,
  });

  let errors = $state<Record<string, string>>({});

  const fieldTypes: Array<{
    id: CalculatedFieldType;
    label: string;
    description: string;
    icon: any;
  }> = [
    {
      id: "formula",
      label: t("kpiCreator.formula"),
      description: t("kpiCreator.mathematicalExpressionUsingFields"),
      icon: Calculator,
    },
    {
      id: "count",
      label: t("kpiCreator.count"),
      description: t("kpiCreator.countRelatedRecords"),
      icon: Hash,
    },
    {
      id: "sum",
      label: t("kpiCreator.sum"),
      description: t("kpiCreator.sumValuesFromRelatedRecords"),
      icon: TrendingUp,
    },
    {
      id: "average",
      label: t("kpiCreator.average"),
      description: t("kpiCreator.calculateAverage"),
      icon: TrendingUp,
    },
    {
      id: "concat",
      label: t("kpiCreator.concatenate"),
      description: t("kpiCreator.joinTextFields"),
      icon: Text,
    },
    {
      id: "date_diff",
      label: t("kpiCreator.dateDifference"),
      description: t("kpiCreator.daysHoursBetweenDates"),
      icon: Calendar,
    },
    {
      id: "conditional",
      label: t("kpiCreator.conditional"),
      description: t("kpiCreator.ifThenElseLogic"),
      icon: Filter,
    },
  ];

  const formatTypes = [
    { id: "text", label: t("kpiCreator.text") },
    { id: "number", label: t("kpiCreator.number") },
    { id: "currency", label: t("common.currency") },
    { id: "percentage", label: t("kpiCreator.percentage") },
    { id: "duration", label: t("kpiCreator.duration") },
    { id: "badge", label: t("kpiCreator.statusBadge") },
  ];

  function validateStep(): boolean {
    errors = {};

    if (step === 1) {
      if (!field.label?.trim()) errors.label = t("kpiCreator.labelIsRequired");
      if (!field.name?.trim()) errors.name = t("kpiCreator.nameIsRequired");
      if (!field.type) errors.type = t("kpiCreator.typeIsRequired");
    }

    if (step === 2) {
      switch (field.type) {
        case "formula":
          if (!field.config?.expression) errors.expression = t("kpiCreator.formulaIsRequired");
          break;
        case "count":
        case "sum":
        case "average":
          if (!field.config?.sourceTable)
            errors.sourceTable = t("kpiCreator.sourceTableIsRequired");
          if (field.type !== "count" && !field.config?.sourceField) {
            errors.sourceField = t("kpiCreator.fieldToAggregateIsRequired");
          }
          break;
        case "concat":
          if (!field.config?.fields?.length) errors.fields = t("kpiCreator.atLeastOneFieldIs");
          break;
        case "date_diff":
          if (!field.config?.startField)
            errors.startField = t("kpiCreator.startDateFieldIsRequired");
          if (!field.config?.endField) errors.endField = t("kpiCreator.endDateFieldIsRequired");
          break;
        case "conditional":
          if (!field.config?.condition?.field)
            errors.condition = t("kpiCreator.conditionIsRequired");
          break;
      }
    }

    return Object.keys(errors).length === 0;
  }

  function nextStep() {
    if (validateStep()) step++;
  }

  function prevStep() {
    step--;
  }

  function handleSave() {
    if (!validateStep()) return;

    onSave?.(field as CalculatedField);
  }

  function generateNameFromLabel(label: string) {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // Auto-generate name from label
  $effect(() => {
    if (field.label && !field.name) {
      field.name = generateNameFromLabel(field.label);
    }
  });

  // Update dependencies according to type
  $effect(() => {
    const deps: string[] = [];

    if (field.type === "formula" && field.config?.expression) {
      const matches = field.config.expression.match(/\{([^}]+)\}/g) || [];
      deps.push(...matches.map((m: string) => m.slice(1, -1)));
    }

    if (field.type === "concat" && field.config?.fields) {
      deps.push(...field.config.fields);
    }

    if (field.type === "date_diff") {
      if (field.config?.startField) deps.push(field.config.startField);
      if (field.config?.endField) deps.push(field.config.endField);
    }

    if (field.type === "conditional" && field.config?.condition?.field) {
      deps.push(field.config.condition.field);
    }

    field.dependsOn = [...new Set(deps)];
  });
</script>

<div
  class="w-full max-w-2xl bg-kitsuden-card border border-kitsuden-border rounded-xl overflow-hidden"
>
  <!-- Header -->
  <div
    class="flex items-center justify-between px-6 py-4 border-b border-kitsuden-border bg-kitsuden-surface/50"
  >
    <div>
      <h2 class="text-lg font-bold text-kitsuden-text flex items-center gap-2">
        <Calculator class="w-5 h-5 text-kitsuden-accent" />
        {value?.id ? t("common.edit") : t("common.create")}
        {t("kpiCreator.calculatedField")}
      </h2>
      <p class="text-sm text-kitsuden-subtle">{t("kpiCreator.stepOf3", { step })}</p>
    </div>
    <button
      class="p-2 rounded-lg hover:bg-kitsuden-surface text-kitsuden-subtle"
      onclick={onCancel}
    >
      <X class="w-5 h-5" />
    </button>
  </div>

  <!-- Progress -->
  <div class="flex h-1 bg-kitsuden-border">
    <div class="h-full bg-kitsuden-accent transition-all" style="width: {(step / 3) * 100}%"></div>
  </div>

  <!-- Content -->
  <div class="p-6">
    {#if step === 1}
      <!-- Step 1: Basic Info -->
      <div class="space-y-6">
        <div>
          <label for="label" class="block text-sm font-medium text-kitsuden-text mb-2">
            {t("kpiCreator.fieldLabel")} <span class="text-kitsuden-accent-2">*</span>
          </label>
          <input
            id="label"
            type="text"
            bind:value={field.label}
            placeholder={t("kpiCreator.eGTotalRevenue")}
            class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent"
          />
          {#if errors.label}
            <p class="mt-1 text-sm text-kitsuden-accent-2">{errors.label}</p>
          {/if}
        </div>

        <div>
          <label for="name" class="block text-sm font-medium text-kitsuden-text mb-2">
            {t("kpiCreator.fieldName")} <span class="text-kitsuden-accent-2">*</span>
          </label>
          <input
            id="name"
            type="text"
            bind:value={field.name}
            placeholder={t("kpiCreator.eGTotalRevenue2")}
            class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text placeholder:text-kitsuden-subtle focus:outline-hidden focus:border-kitsuden-accent font-mono"
          />
          <p class="mt-1 text-xs text-kitsuden-subtle">
            {t("kpiCreator.usedInApiAndFormulas")}
          </p>
          {#if errors.name}
            <p class="mt-1 text-sm text-kitsuden-accent-2">{errors.name}</p>
          {/if}
        </div>

        <div>
          <label class="block text-sm font-medium text-kitsuden-text mb-3">
            {t("kpiCreator.calculationType")} <span class="text-kitsuden-accent-2">*</span>
          </label>
          <div class="grid grid-cols-2 gap-3">
            {#each fieldTypes as type}
              <button
                class="flex items-start gap-3 p-3 rounded-lg border text-left transition-all {field.type ===
                type.id
                  ? 'border-kitsuden-accent bg-kitsuden-accent/10'
                  : 'border-kitsuden-border hover:border-kitsuden-accent/50'}"
                onclick={() => (field.type = type.id)}
              >
                <div
                  class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center shrink-0"
                >
                  <svelte:component this={type.icon} class="w-5 h-5 text-kitsuden-accent" />
                </div>
                <div>
                  <p class="font-medium text-kitsuden-text">{type.label}</p>
                  <p class="text-xs text-kitsuden-subtle">{type.description}</p>
                </div>
              </button>
            {/each}
          </div>
          {#if errors.type}
            <p class="mt-2 text-sm text-kitsuden-accent-2">{errors.type}</p>
          {/if}
        </div>

        <label class="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            bind:checked={field.isKpi}
            class="w-5 h-5 rounded-sm border-kitsuden-border bg-kitsuden-bg text-kitsuden-accent"
          />
          <div>
            <p class="font-medium text-kitsuden-text">{t("kpiCreator.markAsKpi")}</p>
            <p class="text-xs text-kitsuden-subtle">{t("kpiCreator.showInDashboardsAndEnable")}</p>
          </div>
        </label>
      </div>
    {:else if step === 2}
      <!-- Step 2: Configuration -->
      <div class="space-y-6">
        {#if field.type === "formula"}
          <div>
            <label class="block text-sm font-medium text-kitsuden-text mb-3">
              {t("kpiCreator.formula")}
            </label>
            <FormulaBuilder
              {availableFields}
              value={field.config?.expression}
              onChange={(expr) => (field.config = { ...field.config, expression: expr })}
            />
            {#if errors.expression}
              <p class="mt-2 text-sm text-kitsuden-accent-2">{errors.expression}</p>
            {/if}
          </div>
        {:else if field.type === "count" || field.type === "sum" || field.type === "average"}
          <div class="space-y-4">
            <div>
              <label for="sourcetable" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.sourceTable")}
              </label>
              <select
                id="sourcetable"
                bind:value={field.config.sourceTable}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
              >
                <option value="">{t("kpiCreator.selectTable")}</option>
                {#each availableTables as table}
                  <option value={table.name}>{table.label}</option>
                {/each}
              </select>
              {#if errors.sourceTable}
                <p class="mt-1 text-sm text-kitsuden-accent-2">{errors.sourceTable}</p>
              {/if}
            </div>

            {#if field.type !== "count"}
              <div>
                <label for="sourcefield" class="block text-sm font-medium text-kitsuden-text mb-2">
                  {t("kpiCreator.fieldTo", { type: field.type })}
                </label>
                <select
                  id="sourcefield"
                  bind:value={field.config.sourceField}
                  class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text focus:outline-hidden focus:border-kitsuden-accent"
                >
                  <option value="">{t("kpiCreator.selectField")}</option>
                  {#each availableFields.filter((f) => f.type === "number") as field}
                    <option value={field.name}>{field.label}</option>
                  {/each}
                </select>
                {#if errors.sourceField}
                  <p class="mt-1 text-sm text-kitsuden-accent-2">{errors.sourceField}</p>
                {/if}
              </div>
            {/if}
          </div>
        {:else if field.type === "concat"}
          <div>
            <label class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("kpiCreator.fieldsToConcatenate")}
            </label>
            <div class="space-y-2">
              {#each field.config?.fields || [] as selectedField, index}
                <div class="flex items-center gap-2">
                  <select
                    value={selectedField}
                    onchange={(e) => {
                      const fields = [...(field.config?.fields || [])];
                      fields[index] = e.currentTarget.value;
                      field.config = { ...field.config, fields };
                    }}
                    class="flex-1 px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
                  >
                    <option value="">{t("kpiCreator.selectField")}</option>
                    {#each availableFields.filter((f) => f.type === "text") as f}
                      <option value={f.name}>{f.label}</option>
                    {/each}
                  </select>
                  <button
                    class="p-2 rounded-lg hover:bg-kitsuden-accent-2/20 text-kitsuden-subtle hover:text-kitsuden-accent-2"
                    onclick={() => {
                      const fields = (field.config?.fields || []).filter(
                        (_f: any, i: number) => i !== index
                      );
                      field.config = { ...field.config, fields };
                    }}
                  >
                    <X class="w-4 h-4" />
                  </button>
                </div>
              {/each}
              <button
                class="flex items-center gap-2 px-3 py-2 text-sm text-kitsuden-accent hover:bg-kitsuden-accent/10 rounded-lg transition-colors"
                onclick={() => {
                  field.config = {
                    ...field.config,
                    fields: [...(field.config?.fields || []), ""],
                  };
                }}
              >
                <Plus class="w-4 h-4" />
                {t("kpiCreator.addField")}
              </button>
            </div>

            <div class="mt-4">
              <label for="separator" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.separator")}
              </label>
              <input
                id="separator"
                type="text"
                bind:value={field.config.separator}
                placeholder={t("kpiCreator.eGOr")}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              />
            </div>
          </div>
        {:else if field.type === "date_diff"}
          <div class="space-y-4">
            <div>
              <label for="startfield" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.startDateField")}
              </label>
              <select
                id="startfield"
                bind:value={field.config.startField}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              >
                <option value="">{t("kpiCreator.selectField")}</option>
                {#each availableFields.filter((f) => f.type === "date") as f}
                  <option value={f.name}>{f.label}</option>
                {/each}
              </select>
            </div>

            <div>
              <label for="endfield" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.endDateField")}
              </label>
              <select
                id="endfield"
                bind:value={field.config.endField}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              >
                <option value="">{t("kpiCreator.nowCurrentTime")}</option>
                {#each availableFields.filter((f) => f.type === "date") as f}
                  <option value={f.name}>{f.label}</option>
                {/each}
              </select>
            </div>

            <div>
              <label for="unit" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.outputUnit")}
              </label>
              <select
                id="unit"
                bind:value={field.config.unit}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              >
                <option value="days">{t("kpiCreator.days")}</option>
                <option value="hours">{t("kpiCreator.hours")}</option>
                <option value="minutes">{t("kpiCreator.minutes")}</option>
                <option value="seconds">{t("kpiCreator.seconds")}</option>
              </select>
            </div>
          </div>
        {:else if field.type === "conditional"}
          <div class="space-y-4">
            <p class="text-sm text-kitsuden-subtle">{t("kpiCreator.ifConditionThenValueElse")}</p>

            <div
              class="p-4 rounded-lg bg-kitsuden-surface/50 border border-kitsuden-border space-y-4"
            >
              <div class="flex items-center gap-2 text-kitsuden-accent font-medium">
                <span>{t("kpiCreator.if")}</span>
              </div>

              <div class="grid grid-cols-3 gap-2">
                <select
                  bind:value={field.config.condition.field}
                  class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
                >
                  <option value="">{t("kpiCreator.selectField")}</option>
                  {#each availableFields as f}
                    <option value={f.name}>{f.label}</option>
                  {/each}
                </select>

                <select
                  bind:value={field.config.condition.operator}
                  class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
                >
                  <option value="eq">{t("kpiCreator.equals")}</option>
                  <option value="neq">{t("kpiCreator.notEquals")}</option>
                  <option value="gt">{t("kpiCreator.greaterThan")}</option>
                  <option value="gte">{t("kpiCreator.greaterOrEqual")}</option>
                  <option value="lt">{t("kpiCreator.lessThan")}</option>
                  <option value="lte">{t("kpiCreator.lessOrEqual")}</option>
                  <option value="contains">{t("kpiCreator.contains")}</option>
                  <option value="empty">{t("kpiCreator.isEmpty")}</option>
                </select>

                {#if field.config.condition.operator !== "empty"}
                  <input
                    type="text"
                    bind:value={field.config.condition.value}
                    placeholder={t("kpiCreator.value")}
                    class="px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
                  />
                {/if}
              </div>

              <div class="flex items-center gap-2 text-kitsuden-green font-medium">
                <span>{t("kpiCreator.then")}</span>
              </div>

              <input
                type="text"
                bind:value={field.config.trueValue}
                placeholder={t("kpiCreator.valueIfTrue")}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              />

              <div class="flex items-center gap-2 text-kitsuden-accent-2 font-medium">
                <span>{t("kpiCreator.else")}</span>
              </div>

              <input
                type="text"
                bind:value={field.config.falseValue}
                placeholder={t("kpiCreator.valueIfFalse")}
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              />
            </div>
          </div>
        {/if}
      </div>
    {:else if step === 3}
      <!-- Step 3: Format & KPI Settings -->
      <div class="space-y-6">
        <div>
          <label class="block text-sm font-medium text-kitsuden-text mb-3">
            {t("kpiCreator.outputFormat")}
          </label>
          <div class="grid grid-cols-3 gap-2">
            {#each formatTypes as fmt}
              <button
                class="p-3 rounded-lg border text-sm font-medium transition-all {field.format
                  ?.type === fmt.id
                  ? 'border-kitsuden-accent bg-kitsuden-accent/10 text-kitsuden-accent'
                  : 'border-kitsuden-border text-kitsuden-text hover:border-kitsuden-accent/50'}"
                onclick={() => (field.format = { ...field.format, type: fmt.id as any })}
              >
                {fmt.label}
              </button>
            {/each}
          </div>
        </div>

        {#if field.format?.type === "currency"}
          <div>
            <label for="currency" class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("common.currency")}
            </label>
            <select
              id="currency"
              bind:value={field.format.currency}
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
            >
              <option value="USD">{t("kpiCreator.usd")}</option>
              <option value="EUR">{t("kpiCreator.eur")}</option>
              <option value="GBP">{t("kpiCreator.gbp")}</option>
              <option value="MXN">{t("kpiCreator.mxn")}</option>
            </select>
          </div>
        {/if}

        {#if field.format?.type === "number" || field.format?.type === "currency" || field.format?.type === "percentage"}
          <div>
            <label for="decimals" class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("kpiCreator.decimalPlaces")}
            </label>
            <input
              id="decimals"
              type="number"
              bind:value={field.format.decimals}
              min="0"
              max="10"
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
            />
          </div>
        {/if}

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="prefix" class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("kpiCreator.prefix")}
            </label>
            <input
              id="prefix"
              type="text"
              bind:value={field.format.prefix}
              placeholder="e.g., $"
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
            />
          </div>
          <div>
            <label for="suffix" class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("kpiCreator.suffix")}
            </label>
            <input
              id="suffix"
              type="text"
              bind:value={field.format.suffix}
              placeholder="e.g., %"
              class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
            />
          </div>
        </div>

        {#if field.isKpi}
          <div
            class="p-4 rounded-lg bg-kitsuden-surface/50 border border-kitsuden-border space-y-4"
          >
            <h4 class="font-medium text-kitsuden-text flex items-center gap-2">
              <Target class="w-4 h-4 text-kitsuden-accent" />
              {t("kpiCreator.kpiTargets")}
            </h4>

            <div>
              <label for="target" class="block text-sm font-medium text-kitsuden-text mb-2">
                {t("kpiCreator.targetValue")}
              </label>
              <input
                id="target"
                type="number"
                bind:value={field.target}
                placeholder="e.g., 1000"
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              />
            </div>

            <div>
              <label
                for="warningthreshold"
                class="block text-sm font-medium text-kitsuden-text mb-2 flex items-center gap-2"
              >
                <AlertTriangle class="w-4 h-4 text-amber-400" />
                {t("kpiCreator.warningThreshold")}
              </label>
              <input
                id="warningthreshold"
                type="number"
                bind:value={field.warningThreshold}
                placeholder="e.g., 500"
                class="w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-border rounded-lg text-kitsuden-text"
              />
              <p class="mt-1 text-xs text-kitsuden-subtle">
                {t("kpiCreator.valueAtWhichToShow")}
              </p>
            </div>
          </div>
        {/if}

        <!-- Summary -->
        <div class="p-4 rounded-lg bg-kitsuden-accent/5 border border-kitsuden-accent/20">
          <h4 class="font-medium text-kitsuden-text mb-2">{t("kpiCreator.summary")}</h4>
          <div class="space-y-1 text-sm">
            <p class="text-kitsuden-subtle">
              <span class="text-kitsuden-text">{t("kpiCreator.name")}</span>
              {field.name}
            </p>
            <p class="text-kitsuden-subtle">
              <span class="text-kitsuden-text">{t("kpiCreator.type")}</span>
              {field.type}
            </p>
            <p class="text-kitsuden-subtle">
              <span class="text-kitsuden-text">{t("kpiCreator.format")}</span>
              {field.format?.type}
            </p>
            {#if field.dependsOn?.length}
              <p class="text-kitsuden-subtle">
                <span class="text-kitsuden-text">{t("kpiCreator.dependsOn")}</span>
                {field.dependsOn.join(", ")}
              </p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="flex items-center justify-between pt-6 border-t border-kitsuden-border">
    <button
      class="px-4 py-2 text-kitsuden-subtle hover:text-kitsuden-text transition-colors"
      onclick={onCancel}
    >
      {t("common.cancel")}
    </button>

    <div class="flex items-center gap-2">
      {#if step > 1}
        <button class="px-4 py-2 btn-secondary" onclick={prevStep}> {t("common.back")} </button>
      {/if}

      {#if step < 3}
        <button class="px-4 py-2 btn-primary flex items-center gap-2" onclick={nextStep}>
          {t("common.next")}
          <ChevronRight class="w-4 h-4" />
        </button>
      {:else}
        <button class="px-4 py-2 btn-primary flex items-center gap-2" onclick={handleSave}>
          <Check class="w-4 h-4" />
          {t("kpiCreator.saveField")}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  @reference "../../../style.css";

  .btn-primary {
    @apply bg-kitsuden-accent text-black font-medium rounded-lg hover:brightness-110 transition-all;
  }
  .btn-secondary {
    @apply bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text rounded-lg hover:border-kitsuden-accent/50 transition-all;
  }
</style>
