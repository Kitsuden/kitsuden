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

  import {
    Button,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
    Checkbox,
    Field,
    Input,
    NumberInput,
    Progress,
    Select,
    ToggleGroup,
  } from "$lib/tallao";

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

  /** The text of a native control's event (tallao's Input and Select pass events through). */
  const textOf = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;

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

<Card class="w-full max-w-2xl overflow-hidden">
  <CardHeader>
    <div class="min-w-0">
      <CardTitle level={2}>
        <span class="flex items-center gap-2">
          <Calculator class="w-5 h-5 text-kitsuden-accent" />
          {value?.id ? t("common.edit") : t("common.create")}
          {t("kpiCreator.calculatedField")}
        </span>
      </CardTitle>
    </div>
    <Button variant="ghost" size="icon" ariaLabel={t("common.close")} onclick={onCancel}>
      <X class="w-5 h-5" />
    </Button>
  </CardHeader>

  <CardContent>
    <Progress value={step} max={3} label={t("kpiCreator.stepOf3", { step })} class="mb-6" />

    {#if step === 1}
      <!-- Step 1: Basic Info -->
      <div class="space-y-6">
        <Field label={t("kpiCreator.fieldLabel")} required error={errors.label}>
          <Input bind:value={field.label} placeholder={t("kpiCreator.eGTotalRevenue")} />
        </Field>

        <div>
          <Field label={t("kpiCreator.fieldName")} required error={errors.name}>
            <Input
              bind:value={field.name}
              placeholder={t("kpiCreator.eGTotalRevenue2")}
              class="font-mono"
            />
          </Field>
          <p class="mt-1 text-xs text-kitsuden-subtle">
            {t("kpiCreator.usedInApiAndFormulas")}
          </p>
        </div>

        <div role="group" aria-labelledby="kpi-type-label">
          <p id="kpi-type-label" class="block text-sm font-medium text-kitsuden-text mb-3">
            {t("kpiCreator.calculationType")}
            <span class="text-kitsuden-danger" aria-hidden="true">*</span>
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {#each fieldTypes as type}
              {@const Icon = type.icon}
              <!-- A whole card as one choice: the kit has no card-shaped radio. -->
              <button
                type="button"
                aria-pressed={field.type === type.id}
                class="flex items-start gap-3 p-3 rounded-lg border text-left transition-all {field.type ===
                type.id
                  ? 'border-kitsuden-accent bg-kitsuden-accent/10'
                  : 'border-kitsuden-border hover:border-kitsuden-accent/50'}"
                onclick={() => (field.type = type.id)}
              >
                <span
                  class="w-10 h-10 rounded-lg bg-kitsuden-surface flex items-center justify-center shrink-0"
                >
                  <Icon class="w-5 h-5 text-kitsuden-accent" />
                </span>
                <span class="min-w-0">
                  <span class="block font-medium text-kitsuden-text">{type.label}</span>
                  <span class="block text-xs text-kitsuden-subtle">{type.description}</span>
                </span>
              </button>
            {/each}
          </div>
          {#if errors.type}
            <p class="mt-2 text-sm text-kitsuden-danger" role="alert">{errors.type}</p>
          {/if}
        </div>

        <Checkbox bind:checked={field.isKpi}>
          <span>
            <span class="block font-medium text-kitsuden-text">{t("kpiCreator.markAsKpi")}</span>
            <span class="block text-xs text-kitsuden-subtle"
              >{t("kpiCreator.showInDashboardsAndEnable")}</span
            >
          </span>
        </Checkbox>
      </div>
    {:else if step === 2}
      <!-- Step 2: Configuration -->
      <div class="space-y-6">
        {#if field.type === "formula"}
          <div>
            <p class="block text-sm font-medium text-kitsuden-text mb-3">
              {t("kpiCreator.formula")}
            </p>
            <FormulaBuilder
              {availableFields}
              value={field.config?.expression}
              onChange={(expr) => (field.config = { ...field.config, expression: expr })}
            />
            {#if errors.expression}
              <p class="mt-2 text-sm text-kitsuden-danger" role="alert">{errors.expression}</p>
            {/if}
          </div>
        {:else if field.type === "count" || field.type === "sum" || field.type === "average"}
          <div class="space-y-4">
            <Field label={t("kpiCreator.sourceTable")} error={errors.sourceTable}>
              <Select
                value={field.config.sourceTable ?? ""}
                onchange={(e: Event) => (field.config.sourceTable = textOf(e))}
                placeholder={t("kpiCreator.selectTable")}
                options={availableTables.map((table) => ({
                  value: table.name,
                  label: table.label,
                }))}
              />
            </Field>

            {#if field.type !== "count"}
              <Field
                label={t("kpiCreator.fieldTo", { type: field.type })}
                error={errors.sourceField}
              >
                <Select
                  value={field.config.sourceField ?? ""}
                  onchange={(e: Event) => (field.config.sourceField = textOf(e))}
                  placeholder={t("kpiCreator.selectField")}
                  options={availableFields
                    .filter((f) => f.type === "number")
                    .map((f) => ({ value: f.name, label: f.label }))}
                />
              </Field>
            {/if}
          </div>
        {:else if field.type === "concat"}
          <div>
            <p class="block text-sm font-medium text-kitsuden-text mb-2">
              {t("kpiCreator.fieldsToConcatenate")}
            </p>
            <div class="space-y-2">
              {#each field.config?.fields || [] as selectedField, index}
                <div class="flex items-center gap-2">
                  <Select
                    class="min-w-0 flex-1"
                    value={selectedField ?? ""}
                    aria-label={t("kpiCreator.selectField")}
                    onchange={(e: Event) => {
                      const fields = [...(field.config?.fields || [])];
                      fields[index] = textOf(e);
                      field.config = { ...field.config, fields };
                    }}
                    placeholder={t("kpiCreator.selectField")}
                    options={availableFields
                      .filter((f) => f.type === "text")
                      .map((f) => ({ value: f.name, label: f.label }))}
                  />
                  <Button
                    variant="danger-ghost"
                    size="icon"
                    ariaLabel={t("common.remove")}
                    onclick={() => {
                      const fields = (field.config?.fields || []).filter(
                        (_f: any, i: number) => i !== index
                      );
                      field.config = { ...field.config, fields };
                    }}
                  >
                    <X class="w-4 h-4" />
                  </Button>
                </div>
              {/each}
              <Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  field.config = {
                    ...field.config,
                    fields: [...(field.config?.fields || []), ""],
                  };
                }}
              >
                <Plus class="w-4 h-4" />
                {t("kpiCreator.addField")}
              </Button>
            </div>

            <Field label={t("kpiCreator.separator")} class="mt-4">
              <Input
                value={field.config.separator ?? ""}
                oninput={(e: Event) => (field.config.separator = textOf(e))}
                placeholder={t("kpiCreator.eGOr")}
              />
            </Field>
          </div>
        {:else if field.type === "date_diff"}
          <div class="space-y-4">
            <Field label={t("kpiCreator.startDateField")}>
              <Select
                value={field.config.startField ?? ""}
                onchange={(e: Event) => (field.config.startField = textOf(e))}
                placeholder={t("kpiCreator.selectField")}
                options={availableFields
                  .filter((f) => f.type === "date")
                  .map((f) => ({ value: f.name, label: f.label }))}
              />
            </Field>

            <Field label={t("kpiCreator.endDateField")}>
              <Select
                value={field.config.endField ?? ""}
                onchange={(e: Event) => (field.config.endField = textOf(e))}
                placeholder={t("kpiCreator.nowCurrentTime")}
                options={availableFields
                  .filter((f) => f.type === "date")
                  .map((f) => ({ value: f.name, label: f.label }))}
              />
            </Field>

            <Field label={t("kpiCreator.outputUnit")}>
              <Select
                value={field.config.unit ?? "days"}
                onchange={(e: Event) => (field.config.unit = textOf(e))}
                options={[
                  { value: "days", label: t("kpiCreator.days") },
                  { value: "hours", label: t("kpiCreator.hours") },
                  { value: "minutes", label: t("kpiCreator.minutes") },
                  { value: "seconds", label: t("kpiCreator.seconds") },
                ]}
              />
            </Field>
          </div>
        {:else if field.type === "conditional"}
          <div class="space-y-4">
            <p class="text-sm text-kitsuden-subtle">{t("kpiCreator.ifConditionThenValueElse")}</p>

            <div
              class="p-4 rounded-lg bg-kitsuden-surface/50 border border-kitsuden-border space-y-4"
            >
              <p class="text-kitsuden-accent font-medium">{t("kpiCreator.if")}</p>

              <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Select
                  value={field.config.condition.field ?? ""}
                  aria-label={t("kpiCreator.selectField")}
                  onchange={(e: Event) => (field.config.condition.field = textOf(e))}
                  placeholder={t("kpiCreator.selectField")}
                  options={availableFields.map((f) => ({ value: f.name, label: f.label }))}
                />

                <Select
                  value={field.config.condition.operator ?? "eq"}
                  aria-label={t("kpiCreator.equals")}
                  onchange={(e: Event) => (field.config.condition.operator = textOf(e))}
                  options={[
                    { value: "eq", label: t("kpiCreator.equals") },
                    { value: "neq", label: t("kpiCreator.notEquals") },
                    { value: "gt", label: t("kpiCreator.greaterThan") },
                    { value: "gte", label: t("kpiCreator.greaterOrEqual") },
                    { value: "lt", label: t("kpiCreator.lessThan") },
                    { value: "lte", label: t("kpiCreator.lessOrEqual") },
                    { value: "contains", label: t("kpiCreator.contains") },
                    { value: "empty", label: t("kpiCreator.isEmpty") },
                  ]}
                />

                {#if field.config.condition.operator !== "empty"}
                  <Input
                    value={field.config.condition.value ?? ""}
                    aria-label={t("kpiCreator.value")}
                    oninput={(e: Event) => (field.config.condition.value = textOf(e))}
                    placeholder={t("kpiCreator.value")}
                  />
                {/if}
              </div>

              <Field label={t("kpiCreator.then")}>
                <Input
                  value={field.config.trueValue ?? ""}
                  oninput={(e: Event) => (field.config.trueValue = textOf(e))}
                  placeholder={t("kpiCreator.valueIfTrue")}
                />
              </Field>

              <Field label={t("kpiCreator.else")}>
                <Input
                  value={field.config.falseValue ?? ""}
                  oninput={(e: Event) => (field.config.falseValue = textOf(e))}
                  placeholder={t("kpiCreator.valueIfFalse")}
                />
              </Field>
            </div>
          </div>
        {/if}
      </div>
    {:else if step === 3}
      <!-- Step 3: Format & KPI Settings -->
      <div class="space-y-6">
        <div>
          <p class="block text-sm font-medium text-kitsuden-text mb-3">
            {t("kpiCreator.outputFormat")}
          </p>
          <ToggleGroup
            ariaLabel={t("kpiCreator.outputFormat")}
            required
            options={formatTypes.map((fmt) => ({ value: fmt.id, label: fmt.label }))}
            value={field.format?.type ?? ""}
            onchange={(v) => (field.format = { ...field.format, type: v as any })}
          />
        </div>

        {#if field.format?.type === "currency"}
          <Field label={t("common.currency")}>
            <Select
              value={field.format.currency ?? "USD"}
              onchange={(e: Event) => (field.format.currency = textOf(e))}
              options={[
                { value: "USD", label: t("kpiCreator.usd") },
                { value: "EUR", label: t("kpiCreator.eur") },
                { value: "GBP", label: t("kpiCreator.gbp") },
                { value: "MXN", label: t("kpiCreator.mxn") },
              ]}
            />
          </Field>
        {/if}

        {#if field.format?.type === "number" || field.format?.type === "currency" || field.format?.type === "percentage"}
          <Field label={t("kpiCreator.decimalPlaces")}>
            <NumberInput
              value={field.format.decimals ?? null}
              onchange={(n) => (field.format.decimals = n)}
              min={0}
              max={10}
            />
          </Field>
        {/if}

        <div class="grid grid-cols-2 gap-4">
          <Field label={t("kpiCreator.prefix")}>
            <Input
              value={field.format.prefix ?? ""}
              oninput={(e: Event) => (field.format.prefix = textOf(e))}
              placeholder="e.g., $"
            />
          </Field>
          <Field label={t("kpiCreator.suffix")}>
            <Input
              value={field.format.suffix ?? ""}
              oninput={(e: Event) => (field.format.suffix = textOf(e))}
              placeholder="e.g., %"
            />
          </Field>
        </div>

        {#if field.isKpi}
          <div
            class="p-4 rounded-lg bg-kitsuden-surface/50 border border-kitsuden-border space-y-4"
          >
            <h4 class="font-medium text-kitsuden-text flex items-center gap-2">
              <Target class="w-4 h-4 text-kitsuden-accent" />
              {t("kpiCreator.kpiTargets")}
            </h4>

            <Field label={t("kpiCreator.targetValue")}>
              <NumberInput
                value={field.target ?? null}
                onchange={(n) => (field.target = n)}
                placeholder="e.g., 1000"
              />
            </Field>

            <div>
              <Field label={t("kpiCreator.warningThreshold")}>
                <NumberInput
                  value={field.warningThreshold ?? null}
                  onchange={(n) => (field.warningThreshold = n)}
                  placeholder="e.g., 500"
                />
              </Field>
              <p class="mt-1 text-xs text-kitsuden-subtle flex items-center gap-1.5">
                <AlertTriangle class="w-3.5 h-3.5 text-kitsuden-amber shrink-0" />
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
  </CardContent>

  <CardFooter class="flex-wrap justify-between">
    <Button variant="ghost" onclick={onCancel}>{t("common.cancel")}</Button>

    <div class="flex items-center gap-2">
      {#if step > 1}
        <Button variant="secondary" onclick={prevStep}>{t("common.back")}</Button>
      {/if}

      {#if step < 3}
        <Button onclick={nextStep}>
          {t("common.next")}
          <ChevronRight class="w-4 h-4" />
        </Button>
      {:else}
        <Button onclick={handleSave}>
          <Check class="w-4 h-4" />
          {t("kpiCreator.saveField")}
        </Button>
      {/if}
    </div>
  </CardFooter>
</Card>
