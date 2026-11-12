<!--
  tallao — SchemaForm
  A form built from a JSON Schema (the subset used by forms): for what the server
  defines, or for reviewing the arguments an agent proposes before approving a
  tool.
    string → Input (email, url), DatePicker (format "date"), Textarea ("x-widget": "textarea")
    enum   → Select, or RadioGroup with "x-widget": "radio"; names with oneOf [{ const, title }]
    number / integer → numeric Input with minimum / maximum (the value is a number)
    boolean → Switch (or Checkbox with "x-widget": "checkbox")
    array with items.enum → multiple Combobox
    object → <fieldset> with its <legend>
  Validates required, minLength / maxLength, pattern, minimum / maximum and the format on
  submit (and each field on leaving it, once touched). With `name`, the fields are sent
  in the form's native submission as `name.field.subfield`: in SvelteKit, SchemaForm
  itself is the <form> (method="POST" and {@attach fromAction(enhance)}); an invalid
  submission never reaches the action.
-->
<script lang="ts" module>
  export interface JsonSchema {
    type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
    title?: string;
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    enum?: (string | number)[];
    oneOf?: { const: string | number; title?: string }[];
    items?: JsonSchema;
    format?: "date" | "email" | "uri" | string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    default?: unknown;
    "x-widget"?: "textarea" | "radio" | "checkbox";
  }

  type FormValue = Record<string, unknown>;

  /** The starting value: the schema's `default`s, or empty. */
  export function defaultsOf(schema: JsonSchema): unknown {
    if (schema.default !== undefined) return structuredClone(schema.default);
    if (schema.type === "object") {
      const o: FormValue = {};
      for (const [k, s] of Object.entries(schema.properties ?? {})) o[k] = defaultsOf(s);
      return o;
    }
    if (schema.type === "array") return [];
    if (schema.type === "boolean") return false;
    if (schema.type === "number" || schema.type === "integer") return null;
    return "";
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";

  import { useLabels } from "../i18n";
  import { cn } from "../utils";

  import Button from "./button.svelte";
  import Checkbox from "./checkbox.svelte";
  import Combobox from "./combobox.svelte";
  import DatePicker from "./date-picker.svelte";
  import Field from "./field.svelte";
  import Input from "./input.svelte";
  import RadioGroup from "./radio-group.svelte";
  import Select from "./select.svelte";
  import Switch from "./switch.svelte";
  import Textarea from "./textarea.svelte";

  const L = useLabels();
  let {
    schema,
    value = $bindable({}),
    name,
    submitLabel = L.submit,
    showSubmit = true,
    descriptions = true,
    disabled = false,
    class: className = "",
    onsubmit,
    children,
    ...rest
  }: {
    schema: JsonSchema;
    value?: FormValue;
    /** Prefix of the names in a native <form>; without it, the form is data-only. */
    name?: string;
    submitLabel?: string;
    showSubmit?: boolean;
    /** Shows each field's `description` below it. */
    descriptions?: boolean;
    disabled?: boolean;
    class?: string;
    /** With the value already validated. */
    onsubmit?: (value: FormValue) => void;
    /** More fields after the schema's and before the button (a CodeEditor, a FileUpload…). */
    children?: import("svelte").Snippet;
    /** method, action, enctype and attachments ({@attach fromAction(enhance)}) go to the <form>. */
    [key: string]: unknown;
  } = $props();

  const id = $props.id();
  // Whatever is missing from the incoming value is filled in with the schema's `default`s.
  untrack(() => {
    const base = defaultsOf(schema) as FormValue;
    value = { ...base, ...value };
  });

  let errors = $state<Record<string, string>>({});
  let touched = $state<Record<string, boolean>>({});
  let formEl: HTMLFormElement | undefined = $state();

  const read = (path: string[]) =>
    path.reduce<unknown>((o, k) => (o as FormValue | undefined)?.[k], value);
  function write(path: string[], v: unknown) {
    let o = value as FormValue;
    for (const k of path.slice(0, -1)) o = (o[k] ??= {}) as FormValue;
    o[path.at(-1)!] = v;
    if (touched[path.join(".")]) validateField(path);
  }

  const optionsOf = (s: JsonSchema) =>
    (s.oneOf?.map((o) => ({ value: String(o.const), label: o.title ?? String(o.const) })) ??
      s.enum?.map((e) => ({ value: String(e), label: String(e) })) ??
      []) as { value: string; label: string }[];

  /** The first problem with a value, or null. */
  function problemOf(s: JsonSchema, v: unknown, isRequired: boolean): string | null {
    const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) return isRequired ? L.required : null;
    if (s.type === "string" && typeof v === "string") {
      if (s.minLength != null && v.length < s.minLength) return `${L.invalid} (≥ ${s.minLength})`;
      if (s.maxLength != null && v.length > s.maxLength) return `${L.invalid} (≤ ${s.maxLength})`;
      if (s.pattern && !new RegExp(`^(?:${s.pattern})$`).test(v)) return L.invalid;
      if (s.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return L.invalid;
      if (s.format === "uri" && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v)) return L.invalid;
      if (s.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return L.invalid;
      if ((s.enum || s.oneOf) && !optionsOf(s).some((o) => o.value === v)) return L.invalid;
    }
    if ((s.type === "number" || s.type === "integer") && typeof v === "number") {
      if (s.type === "integer" && !Number.isInteger(v)) return L.invalid;
      if (s.minimum != null && v < s.minimum) return `${L.invalid} (≥ ${s.minimum})`;
      if (s.maximum != null && v > s.maximum) return `${L.invalid} (≤ ${s.maximum})`;
    }
    return null;
  }

  function schemaAt(path: string[]): { s: JsonSchema; isRequired: boolean } {
    let s = schema;
    let isRequired = false;
    for (const k of path) {
      isRequired = !!s.required?.includes(k);
      s = s.properties?.[k] ?? {};
    }
    return { s, isRequired };
  }

  function validateField(path: string[]) {
    const { s, isRequired } = schemaAt(path);
    const p = problemOf(s, read(path), isRequired);
    const key = path.join(".");
    if (p) errors[key] = p;
    else delete errors[key];
  }

  function leaves(s: JsonSchema, path: string[] = []): string[][] {
    if (s.type !== "object") return [path];
    return Object.entries(s.properties ?? {}).flatMap(([k, child]) => leaves(child, [...path, k]));
  }

  /** Validates everything; returns whether it is valid and focuses the first field with an error. */
  export function validate(): boolean {
    for (const path of leaves(schema)) {
      touched[path.join(".")] = true;
      validateField(path);
    }
    // The first in form order, not in the order the errors appeared.
    const first = leaves(schema)
      .map((r) => r.join("."))
      .find((k) => errors[k]);
    if (first) {
      const box = [...(formEl?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].find(
        (e) => e.dataset.field === first
      );
      box
        ?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button")
        ?.focus();
    }
    return !first;
  }

  // In the capture phase, before any other listener on the <form>: SvelteKit's `enhance`
  // does not check defaultPrevented, so an invalid submission has to be stopped here.
  function handleSubmit(e: SubmitEvent) {
    if (!validate()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (onsubmit) {
      e.preventDefault();
      e.stopImmediatePropagation();
      onsubmit($state.snapshot(value) as FormValue);
    }
  }

  const nameOf = (path: string[]) => (name ? [name, ...path].join(".") : undefined);
  const leave = (path: string[], e?: FocusEvent) => {
    // If focus goes to the submit button, the submission validates. Validating here would render the error,
    // the button would move down between mousedown and mouseup and the click would be lost.
    const next = e?.relatedTarget;
    if (next instanceof HTMLElement && next.matches("[type=submit]") && formEl?.contains(next))
      return;
    touched[path.join(".")] = true;
    validateField(path);
  };
</script>

{#snippet field(s: JsonSchema, path: string[], isRequired: boolean)}
  {@const key = path.join(".")}
  {@const cid = `${id}-${key}`}
  {@const fieldLabel = s.title ?? path.at(-1) ?? ""}
  {@const helpId = descriptions && s.description ? `${cid}-help` : undefined}
  {@const error = touched[key] ? errors[key] : undefined}
  {#if s.type === "object"}
    <fieldset class="ta-schema-group">
      <legend>{fieldLabel}</legend>
      {#if helpId}<p class="ta-schema-help" id={helpId}>{s.description}</p>{/if}
      {#each Object.entries(s.properties ?? {}) as [k, child] (k)}
        {@render field(child, [...path, k], !!s.required?.includes(k))}
      {/each}
    </fieldset>
  {:else if s.type === "boolean"}
    <div class="ta-schema-field" data-field={key}>
      {#if s["x-widget"] === "checkbox"}
        <Checkbox
          id={cid}
          label={fieldLabel}
          {disabled}
          name={nameOf(path)}
          checked={!!read(path)}
          aria-describedby={helpId}
          onchange={(e: Event) => write(path, (e.currentTarget as HTMLInputElement).checked)}
        />
      {:else}
        <Switch
          label={fieldLabel}
          {disabled}
          name={nameOf(path)}
          value="true"
          checked={!!read(path)}
          onchange={(v) => write(path, v)}
        />
      {/if}
      {#if helpId}<p class="ta-schema-help" id={helpId}>{s.description}</p>{/if}
    </div>
  {:else if (s.enum || s.oneOf) && s["x-widget"] === "radio"}
    <div class="ta-schema-field" data-field={key}>
      <RadioGroup
        legend={fieldLabel}
        options={optionsOf(s)}
        value={String(read(path) ?? "")}
        name={nameOf(path)}
        required={isRequired}
        onchange={(v) => {
          write(path, v);
          leave(path);
        }}
      />
      {#if error}<span class="ta-schema-error" role="alert">{error}</span>{/if}
    </div>
  {:else}
    <div class="ta-schema-field" data-field={key}>
      <Field label={fieldLabel} required={isRequired} {error}>
        {#if s.type === "array" && s.items && (s.items.enum || s.items.oneOf)}
          <Combobox
            multiple
            name={nameOf(path)}
            options={optionsOf(s.items)}
            values={(read(path) as string[]) ?? []}
            {disabled}
            onValuesChange={(v) => write(path, v)}
          />
        {:else if s.enum || s.oneOf}
          <Select
            id={cid}
            name={nameOf(path)}
            options={optionsOf(s)}
            placeholder={isRequired ? undefined : "—"}
            value={String(read(path) ?? "")}
            {disabled}
            aria-describedby={helpId}
            aria-invalid={error ? "true" : undefined}
            onchange={(e: Event) => {
              write(path, (e.currentTarget as HTMLSelectElement).value);
              leave(path);
            }}
          />
        {:else if s.type === "number" || s.type === "integer"}
          <Input
            id={cid}
            type="number"
            name={nameOf(path)}
            min={s.minimum}
            max={s.maximum}
            step={s.type === "integer" ? 1 : "any"}
            value={read(path) == null ? "" : String(read(path))}
            {disabled}
            aria-describedby={helpId}
            aria-invalid={error ? "true" : undefined}
            oninput={(e: Event) => {
              const t = (e.currentTarget as HTMLInputElement).value;
              write(path, t === "" ? null : Number(t));
            }}
            onblur={(e: FocusEvent) => leave(path, e)}
          />
        {:else if s.format === "date"}
          <DatePicker
            name={nameOf(path)}
            value={(read(path) as string) || null}
            {disabled}
            onchange={(v) => {
              write(path, v ?? "");
              leave(path);
            }}
          />
        {:else if s["x-widget"] === "textarea"}
          <Textarea
            id={cid}
            name={nameOf(path)}
            value={String(read(path) ?? "")}
            maxlength={s.maxLength}
            {disabled}
            aria-describedby={helpId}
            aria-invalid={error ? "true" : undefined}
            oninput={(e: Event) => write(path, (e.currentTarget as HTMLTextAreaElement).value)}
            onblur={(e: FocusEvent) => leave(path, e)}
          />
        {:else}
          <Input
            id={cid}
            type={s.format === "email" ? "email" : s.format === "uri" ? "url" : "text"}
            name={nameOf(path)}
            value={String(read(path) ?? "")}
            maxlength={s.maxLength}
            {disabled}
            aria-describedby={helpId}
            aria-invalid={error ? "true" : undefined}
            oninput={(e: Event) => write(path, (e.currentTarget as HTMLInputElement).value)}
            onblur={(e: FocusEvent) => leave(path, e)}
          />
        {/if}
      </Field>
      {#if helpId}<p class="ta-schema-help" id={helpId}>{s.description}</p>{/if}
    </div>
  {/if}
{/snippet}

<form
  {...rest}
  class={cn("ta-schema", className)}
  novalidate
  onsubmitcapture={handleSubmit}
  bind:this={formEl}
>
  {#if schema.type === "object"}
    {#each Object.entries(schema.properties ?? {}) as [k, s] (k)}
      {@render field(s, [k], !!schema.required?.includes(k))}
    {/each}
  {/if}
  {@render children?.()}
  {#if showSubmit}
    <div class="ta-schema-actions"><Button type="submit" {disabled}>{submitLabel}</Button></div>
  {/if}
</form>

<style>
  .ta-schema {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .ta-schema-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .ta-schema-group {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin: 0;
    padding: 0.75rem 1rem 1rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
  .ta-schema-group legend {
    padding: 0 0.25rem;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .ta-schema-help {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .ta-schema-error {
    font-size: 0.75rem;
    color: rgb(var(--ta-danger));
  }
  .ta-schema-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
