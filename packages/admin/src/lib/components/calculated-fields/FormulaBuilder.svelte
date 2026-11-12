<script lang="ts">
  import { t as tr } from "$lib/i18n";
  /**
   * FormulaBuilder - Visual formula/KPI builder
   *
   * "Drag and drop"-style interface for creating calculated fields.
   * Supports: fields, operators, functions, constant values.
   */
  import {
    Trash2,
    GripVertical,
    Calculator,
    Sigma,
    Hash,
    Type,
    Calendar,
    ChevronDown,
    AlertCircle,
    Check,
  } from "lucide-svelte";

  import { Button, Card, Textarea } from "$lib/tallao";

  import { evaluateFormula } from "./evaluate";
  import { FORMULA_FUNCTIONS, FORMULA_OPERATORS } from "./index";

  // Props
  interface Props {
    availableFields: Array<{ name: string; label: string; type: string }>;
    value?: string;
    onChange?: (formula: string) => void;
  }

  const { availableFields, value = "", onChange }: Props = $props();

  // State
  let formulaTokens = $state<
    Array<{
      type: "field" | "operator" | "function" | "value" | "group";
      value: string;
      id: string;
    }>
  >([]);
  let showFunctionMenu = $state(false);
  let showFieldMenu = $state(false);
  let expression = $state(value);
  let error = $state("");
  let previewValue = $state<any>(null);

  // Parse initial formula if it exists
  $effect(() => {
    if (value && formulaTokens.length === 0) {
      parseExpression(value);
    }
  });

  function parseExpression(expr: string) {
    // Simple parser to convert an expression into tokens
    // For now it only recognizes fields between {}
    const tokens: typeof formulaTokens = [];
    let current = "";
    let i = 0;

    while (i < expr.length) {
      if (expr[i] === "{") {
        if (current) tokens.push({ type: "value", value: current, id: crypto.randomUUID() });
        const end = expr.indexOf("}", i);
        if (end > i) {
          tokens.push({ type: "field", value: expr.slice(i + 1, end), id: crypto.randomUUID() });
          i = end + 1;
          current = "";
          continue;
        }
      } else if (["+", "-", "*", "/", "%", "^", "&", "=", "!", ">", "<"].includes(expr[i])) {
        if (current) tokens.push({ type: "value", value: current, id: crypto.randomUUID() });
        tokens.push({ type: "operator", value: expr[i], id: crypto.randomUUID() });
        i++;
        current = "";
        continue;
      }
      current += expr[i];
      i++;
    }
    if (current) tokens.push({ type: "value", value: current, id: crypto.randomUUID() });
    formulaTokens = tokens;
  }

  function addToken(type: "field" | "operator" | "function" | "value", value: string) {
    formulaTokens = [...formulaTokens, { type, value, id: crypto.randomUUID() }];
    updateExpression();
  }

  function removeToken(index: number) {
    formulaTokens = formulaTokens.filter((_, i) => i !== index);
    updateExpression();
  }

  function moveToken(from: number, to: number) {
    const tokens = [...formulaTokens];
    const [moved] = tokens.splice(from, 1);
    tokens.splice(to, 0, moved);
    formulaTokens = tokens;
    updateExpression();
  }

  function updateExpression() {
    expression = formulaTokens
      .map((t) => {
        if (t.type === "field") return `{${t.value}}`;
        return t.value;
      })
      .join(" ");

    onChange?.(expression);
    validateExpression();
    calculatePreview();
  }

  function validateExpression() {
    error = "";

    // Check existing fields
    const fieldMatches = expression.match(/\{([^}]+)\}/g) || [];
    for (const match of fieldMatches) {
      const fieldName = match.slice(1, -1);
      if (!availableFields.find((f) => f.name === fieldName)) {
        error = tr("formulaBuilder.fieldNotFound", { fieldName });
        return;
      }
    }

    // Check basic syntax
    const openBraces = (expression.match(/\{/g) || []).length;
    const closeBraces = (expression.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      error = tr("formulaBuilder.unmatchedBraces");
      return;
    }
  }

  function calculatePreview() {
    // Preview with sample values
    try {
      let result = expression;

      // Replace fields with sample values
      availableFields.forEach((field) => {
        const exampleValue = getExampleValue(field);
        result = result.replace(new RegExp(`\\{${field.name}\\}`, "g"), String(exampleValue));
      });

      // Evaluate safe expression
      previewValue = safeEvaluate(result);
    } catch (e) {
      previewValue = null;
    }
  }

  function getExampleValue(field: { type: string }) {
    switch (field.type) {
      case "number":
        return 100;
      case "text":
        return "'Sample'";
      case "date":
        return "'2026-03-18'";
      case "boolean":
        return true;
      default:
        return 0;
    }
  }

  function safeEvaluate(expr: string): any {
    // A parser, not the Function constructor: the panel's CSP has no 'unsafe-eval' (./evaluate.ts)
    try {
      return evaluateFormula(expr);
    } catch {
      return null;
    }
  }

  function getFieldColor(fieldName: string): string {
    const field = availableFields.find((f) => f.name === fieldName);
    if (!field) return "bg-kitsuden-subtle/20 text-kitsuden-text-dim";

    switch (field.type) {
      case "number":
        return "bg-kitsuden-info/20 text-kitsuden-info border-kitsuden-info/30";
      case "text":
        return "bg-kitsuden-purple/20 text-kitsuden-purple border-kitsuden-purple/30";
      case "date":
        return "bg-kitsuden-green/20 text-kitsuden-green border-kitsuden-green/30";
      case "boolean":
        return "bg-kitsuden-amber/20 text-kitsuden-amber border-kitsuden-amber/30";
      default:
        return "bg-kitsuden-subtle/20 text-kitsuden-text-dim border-kitsuden-subtle/30";
    }
  }

  function getFieldIcon(fieldType: string) {
    switch (fieldType) {
      case "number":
        return Hash;
      case "text":
        return Type;
      case "date":
        return Calendar;
      default:
        return Hash;
    }
  }
</script>

<div class="space-y-4">
  <!-- Builder Visual -->
  <div class="bg-kitsuden-surface/50 border border-kitsuden-border rounded-xl p-4">
    <label class="text-sm font-medium text-kitsuden-text mb-3 block flex items-center gap-2">
      <Calculator class="w-4 h-4 text-kitsuden-accent" />
      {tr("formulaBuilder.formulaBuilder")}
    </label>

    <!-- Tokens -->
    <div
      class="min-h-[80px] bg-kitsuden-bg border border-kitsuden-border rounded-lg p-3 flex flex-wrap gap-2 items-center"
    >
      {#if formulaTokens.length === 0}
        <span class="text-kitsuden-subtle text-sm italic"
          >{tr("formulaBuilder.clickButtonsBelowToBuild")}</span
        >
      {:else}
        {#each formulaTokens as token, index}
          <div class="group relative flex items-center">
            {#if token.type === "field"}
              <span
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium text-sm {getFieldColor(
                  token.value
                )}"
              >
                <GripVertical class="w-3 h-3 opacity-50 cursor-move" />
                {availableFields.find((f) => f.name === token.value)?.label || token.value}
              </span>
            {:else if token.type === "operator"}
              <span
                class="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-kitsuden-surface text-kitsuden-text font-bold text-lg"
              >
                {FORMULA_OPERATORS.find((o) => o.id === token.value)?.label || token.value}
              </span>
            {:else if token.type === "function"}
              <span
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-kitsuden-amber/20 text-kitsuden-amber border border-kitsuden-amber/30 font-mono text-sm"
              >
                <Sigma class="w-3.5 h-3.5" />
                {token.value}()
              </span>
            {:else}
              <span
                class="inline-flex items-center px-3 py-1.5 rounded-lg bg-kitsuden-surface text-kitsuden-text text-sm"
              >
                {token.value}
              </span>
            {/if}

            <Button
              variant="danger-ghost"
              size="icon"
              ariaLabel={tr("common.remove")}
              title={tr("common.remove")}
              onclick={() => removeToken(index)}
            >
              <Trash2 class="w-3.5 h-3.5" />
            </Button>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Error -->
    {#if error}
      <div class="mt-2 flex items-center gap-2 text-kitsuden-accent-2 text-sm">
        <AlertCircle class="w-4 h-4" />
        {error}
      </div>
    {/if}

    <!-- Preview -->
    {#if previewValue !== null && !error}
      <div class="mt-3 flex items-center gap-2 text-sm">
        <span class="text-kitsuden-subtle">{tr("formulaBuilder.preview")}</span>
        <span class="font-mono text-kitsuden-accent bg-kitsuden-accent/10 px-2 py-0.5 rounded-sm">
          {previewValue}
        </span>
        <Check class="w-4 h-4 text-kitsuden-green" />
      </div>
    {/if}
  </div>

  <!-- Toolbox -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- Fields -->
    <Card class="p-3">
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-between"
        aria-expanded={showFieldMenu}
        onclick={() => (showFieldMenu = !showFieldMenu)}
      >
        <span class="flex items-center gap-2">
          <Hash class="w-4 h-4" />
          {tr("common.fields")}
        </span>
        <ChevronDown class="w-4 h-4 transition-transform {showFieldMenu ? 'rotate-180' : ''}" />
      </Button>

      {#if showFieldMenu}
        <div class="space-y-1 mt-2 max-h-40 overflow-y-auto">
          {#each availableFields as field}
            {@const FieldIcon = getFieldIcon(field.type)}
            <Button
              variant="ghost"
              size="sm"
              class="w-full justify-start"
              onclick={() => addToken("field", field.name)}
            >
              <FieldIcon class="w-3.5 h-3.5 shrink-0 text-kitsuden-subtle" />
              <span class="min-w-0 truncate text-kitsuden-text">{field.label}</span>
              <span class="text-kitsuden-subtle text-xs ml-auto">{field.type}</span>
            </Button>
          {/each}
        </div>
      {/if}
    </Card>

    <!-- Operators -->
    <Card class="p-3">
      <h4 class="text-sm font-medium text-kitsuden-text mb-3 flex items-center gap-2">
        <Calculator class="w-4 h-4" />
        {tr("formulaBuilder.operators")}
      </h4>
      <div class="grid grid-cols-4 gap-1">
        {#each FORMULA_OPERATORS.slice(0, 8) as op}
          <Button
            variant="secondary"
            size="sm"
            class="font-bold"
            onclick={() => addToken("operator", op.id)}
            title={op.description}
          >
            {op.label}
          </Button>
        {/each}
      </div>
    </Card>

    <!-- Functions -->
    <Card class="p-3">
      <Button
        variant="ghost"
        size="sm"
        class="w-full justify-between"
        aria-expanded={showFunctionMenu}
        onclick={() => (showFunctionMenu = !showFunctionMenu)}
      >
        <span class="flex items-center gap-2">
          <Sigma class="w-4 h-4" />
          {tr("formulaBuilder.functions")}
        </span>
        <ChevronDown class="w-4 h-4 transition-transform {showFunctionMenu ? 'rotate-180' : ''}" />
      </Button>

      {#if showFunctionMenu}
        <div class="space-y-1 mt-2 max-h-40 overflow-y-auto">
          {#each FORMULA_FUNCTIONS.slice(0, 8) as fn}
            <Button
              variant="ghost"
              size="sm"
              class="w-full justify-start"
              onclick={() => addToken("function", fn.id)}
              title={fn.description}
            >
              <span class="font-mono text-kitsuden-accent">{fn.id}()</span>
              <span class="min-w-0 truncate text-kitsuden-subtle text-xs ml-auto"
                >{fn.description}</span
              >
            </Button>
          {/each}
        </div>
      {/if}
    </Card>
  </div>

  <!-- Expression Raw (editable) -->
  <div class="space-y-2">
    <label for="expression" class="text-sm text-kitsuden-subtle"
      >{tr("formulaBuilder.rawExpression")}</label
    >
    <Textarea
      id="expression"
      mono
      bind:value={expression}
      rows={2}
      oninput={(e: Event) => {
        expression = (e.currentTarget as HTMLTextAreaElement).value;
        parseExpression(expression);
        onChange?.(expression);
        validateExpression();
        calculatePreview();
      }}
    />
    <p class="text-xs text-kitsuden-subtle">
      {tr("formulaBuilder.useToReferenceFieldsExample", { v: "{fieldName}" })}
      <code class="text-kitsuden-accent">{"{price} * {quantity}"}</code>
    </p>
  </div>
</div>
