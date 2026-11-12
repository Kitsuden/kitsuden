<script lang="ts">
  /**
   * DynamicForm.svelte — the entry form generated from a dataset's schema.
   *
   * It renders a control for EVERY field type the schema builder offers (the shared
   * registry: text, long text, number, boolean, date, date & time, image, file, URL, email,
   * select, multi-select, JSON, rich text, relation, KPI, repeater). A type it does not know
   * gets a visible "cannot be edited here" row: before, such a field was dropped from the
   * form without a word, and the entry was saved without it.
   *
   * The rules (which control, starting values, validation, what is submitted) live in
   * `dynamic-form.ts`; the controls are tallao's.
   */
  import {
    Save,
    Upload,
    X,
    ImageIcon,
    Paperclip,
    Plus,
    Trash2,
    Calculator,
    CircleSlash,
  } from "lucide-svelte";
  import { toast } from "$lib/tallao";

  import MediaPicker from "$lib/components/media/MediaPicker.svelte";
  import { t } from "$lib/i18n";
  import { uploadMedia } from "$lib/media/upload";
  import {
    Button,
    Checkbox,
    Input,
    NumberInput,
    Select,
    Spinner,
    Switch,
    Textarea,
  } from "$lib/tallao";

  import type { FieldDefinition } from "../../../types/datasets";

  import {
    cleanValues,
    controlFor,
    emptyRow,
    fileNameOf,
    fromDatetimeLocal,
    initialValues,
    toDateInput,
    toDatetimeLocal,
    validateFields,
    type FormField,
  } from "./dynamic-form";
  import RelationshipField from "./RelationshipField.svelte";

  // ─── Props ──────────────────────────────────────────
  interface Props {
    fields: FieldDefinition[];
    initialData?: Record<string, any>;
    submitLabel?: string;
    onSubmit?: (data: Record<string, any>) => void;
    onCancel?: () => void;
    /** The `<form>`'s id, for a SaveBar outside it (`<SaveBar form={formId}>`). */
    formId?: string;
    /** `false`: no Cancel / Save row of its own (a record page draws a SaveBar instead). */
    actions?: boolean;
    /** Told whenever the form starts or stops differing from what it was loaded with. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Errors the API reported, by field key; shown under the field like the form's own. */
    errors?: Record<string, string>;
  }

  const {
    fields,
    initialData = {},
    submitLabel = t("dynamicForm.saveEntry"),
    onSubmit,
    onCancel,
    formId,
    actions = true,
    onDirtyChange,
    errors,
  }: Props = $props();

  const uid = $props.id();

  // ─── State ──────────────────────────────────────────
  let formData = $state<Record<string, any>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let submitting = $state(false);
  const uploadingStates = $state<Record<string, boolean>>({});

  /**
   * Which field expects an image from the library: its path and its setter. Not a boolean:
   * a dataset can have several image fields (and a repeater, one per row), and with a
   * boolean the chosen one would go to the first.
   */
  let choosing = $state<{ path: string; set: (v: unknown) => void } | null>(null);

  /** The loaded values as text: what "dirty" is measured against. */
  let pristine = $state("");

  // Initialize on mount, and again when another record (or a saved one) is loaded.
  $effect(() => {
    const start = initialValues(fields as FormField[], initialData);
    formData = start;
    pristine = JSON.stringify(start);
    fieldErrors = {};
  });

  const dirty = $derived(pristine !== "" && JSON.stringify(formData) !== pristine);
  $effect(() => onDirtyChange?.(dirty));

  // What the API refused, field by field.
  $effect(() => {
    if (errors && Object.keys(errors).length > 0) fieldErrors = { ...errors };
  });

  // ─── Computed ───────────────────────────────────────
  const visibleFields = $derived(
    [...(fields as FormField[])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  );
  const errorCount = $derived(Object.keys(fieldErrors).length);

  function clearError(path: string) {
    if (fieldErrors[path]) delete fieldErrors[path];
  }

  function setJson(path: string, set: (v: unknown) => void, raw: string) {
    try {
      set(JSON.parse(raw));
    } catch {
      // Not valid yet: keep the text, validation reports it on submit.
      set(raw);
    }
    clearError(path);
  }

  /**
   * Uploads a file to a field through `uploadMedia`, the same function as the blog editor,
   * so the two paths cannot diverge. The reason the server gave is shown: "could not
   * upload" alone does not tell a 20 MB file from a full disk.
   */
  async function upload(path: string, set: (v: unknown) => void, file: File) {
    uploadingStates[path] = true;
    try {
      const { uploaded, errors } = await uploadMedia([file]);
      if (uploaded[0]) {
        set(uploaded[0].url);
        clearError(path);
      } else {
        toast.error(errors.join(" · ") || t("dynamicForm.couldNotUploadThe"));
      }
    } catch (err: any) {
      toast.error(err?.message || t("dynamicForm.couldNotUploadThe"));
    } finally {
      uploadingStates[path] = false;
    }
  }

  function pickFile(path: string, set: (v: unknown) => void, accept?: string) {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) await upload(path, set, file);
    };
    input.click();
  }

  function toggleOption(current: unknown, value: string, on: boolean): string[] {
    const list = Array.isArray(current) ? current.map(String) : [];
    return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  }

  // ─── Submit ─────────────────────────────────────────
  function handleSubmit() {
    fieldErrors = validateFields(fields as FormField[], formData);
    if (Object.keys(fieldErrors).length > 0) return;

    submitting = true;
    onSubmit?.(cleanValues(fields as FormField[], formData));
    setTimeout(() => {
      submitting = false;
    }, 500);
  }
</script>

<!--
  One field: label, control, help and error. `path` is the field's key, or
  `key.<row>.<subKey>` inside a repeater, and names its error and its upload state.
-->
{#snippet fieldRow(field: FormField, value: any, set: (v: unknown) => void, path: string)}
  {@const kind = controlFor(field.type)}
  {@const id = `${uid}-${path}`}
  {@const error = fieldErrors[path]}
  {@const describedBy = error ? `${id}-error` : field.helpText ? `${id}-help` : undefined}
  {@const update = (v: unknown) => {
    set(v);
    clearError(path);
  }}

  <div class="space-y-1.5" data-field={path} data-control={kind}>
    {#if kind === "relation" && field.relation}
      <RelationshipField
        {value}
        onChange={(val) => update(val)}
        target={field.relation.target}
        targetDatasetId={field.relation.targetDatasetId}
        relationType={field.relation.type}
        displayField={field.relation.displayField}
        label={field.label}
        helpText={field.helpText}
        required={field.isRequired}
        {error}
      />
    {:else if kind === "boolean"}
      <div class="flex items-center justify-between gap-4 py-1">
        <div class="min-w-0">
          <p class="text-sm font-medium text-kitsuden-text" id="{id}-label">
            {field.label}
            {#if field.isRequired}<span class="text-kitsuden-danger" aria-hidden="true">*</span
              >{/if}
          </p>
          {#if field.helpText}
            <p class="text-xs text-kitsuden-subtle" id="{id}-help">{field.helpText}</p>
          {/if}
        </div>
        <Switch checked={!!value} ariaLabel={field.label} onchange={(on) => update(on)} />
      </div>
    {:else}
      <label class="block text-sm font-medium text-kitsuden-text" for={id} id="{id}-label">
        {field.label}
        {#if field.isRequired}<span class="text-kitsuden-danger" aria-hidden="true">*</span>{/if}
      </label>

      {#if kind === "text" || kind === "url" || kind === "email"}
        <Input
          {id}
          type={kind === "text" ? "text" : kind}
          value={value ?? ""}
          oninput={(e: Event) => update((e.currentTarget as HTMLInputElement).value)}
          placeholder={kind === "url"
            ? "https://"
            : kind === "email"
              ? t("dynamicForm.emailExampleCom")
              : t("dynamicForm.enter", { v: field.label.toLowerCase() })}
          required={field.isRequired}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "textarea" || kind === "richtext"}
        <Textarea
          {id}
          value={value ?? ""}
          oninput={(e: Event) => update((e.currentTarget as HTMLTextAreaElement).value)}
          rows={kind === "richtext" ? 6 : 4}
          placeholder={kind === "richtext"
            ? t("dynamicForm.enterContentMarkdownSupported")
            : t("dynamicForm.enter", { v: field.label.toLowerCase() })}
          required={field.isRequired}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "number"}
        <NumberInput
          {id}
          value={value === null || value === undefined || value === "" ? null : Number(value)}
          min={field.minValue}
          max={field.maxValue}
          step={1}
          clamp={false}
          placeholder="0"
          onchange={(n) => update(n)}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "date"}
        <Input
          {id}
          type="date"
          value={toDateInput(value)}
          oninput={(e: Event) => update((e.currentTarget as HTMLInputElement).value || null)}
          required={field.isRequired}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "datetime"}
        <Input
          {id}
          type="datetime-local"
          value={toDatetimeLocal(value)}
          oninput={(e: Event) =>
            update(fromDatetimeLocal((e.currentTarget as HTMLInputElement).value))}
          required={field.isRequired}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "select"}
        <Select
          {id}
          value={value ?? ""}
          onchange={(e: Event) => update((e.currentTarget as HTMLSelectElement).value || null)}
          placeholder={t("common.select")}
          options={(field.options || []).map((o) => ({ value: o.value, label: o.label }))}
          required={field.isRequired}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "multiselect"}
        <div
          {id}
          role="group"
          aria-labelledby="{id}-label"
          aria-describedby={describedBy}
          class="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-kitsuden-input bg-kitsuden-bg px-3 py-2.5"
        >
          {#each field.options || [] as opt (opt.value)}
            <Checkbox
              checked={Array.isArray(value) && value.map(String).includes(opt.value)}
              label={opt.label}
              onchange={(e: Event) =>
                update(
                  toggleOption(value, opt.value, (e.currentTarget as HTMLInputElement).checked)
                )}
            />
          {:else}
            <p class="text-sm text-kitsuden-subtle">{t("dynamicForm.noOptions")}</p>
          {/each}
        </div>
      {:else if kind === "json"}
        <Textarea
          {id}
          mono
          value={value === null || value === undefined
            ? ""
            : typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2)}
          oninput={(e: Event) => setJson(path, set, (e.currentTarget as HTMLTextAreaElement).value)}
          rows={4}
          placeholder={'{ "key": "value" }'}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {:else if kind === "image"}
        {#if value}
          <div class="relative group">
            <div
              class="relative w-full h-40 rounded-xl border border-kitsuden-border overflow-hidden bg-kitsuden-bg"
            >
              <img src={value} alt={field.label} class="w-full h-full object-contain p-4" />
              <!-- Shown on keyboard focus too, not only on hover. -->
              <div
                class="absolute inset-x-0 bottom-0 p-3 bg-linear-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex items-center justify-between"
              >
                <span class="text-xs text-white truncate max-w-[200px]">{fileNameOf(value)}</span>
                <div class="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="icon"
                    onclick={() => pickFile(path, update, "image/*")}
                    title={t("dynamicForm.replaceImage")}
                    ariaLabel={t("dynamicForm.replaceImage")}
                  >
                    <Upload class="w-4 h-4" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    onclick={() => update(null)}
                    title={t("dynamicForm.removeImage")}
                    ariaLabel={t("dynamicForm.removeImage")}
                  >
                    <X class="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        {:else if uploadingStates[path]}
          <div
            class="w-full h-40 rounded-xl border-2 border-dashed border-kitsuden-accent/30 bg-kitsuden-accent/5 flex flex-col items-center justify-center gap-3"
          >
            <Spinner size="lg" class="text-kitsuden-accent" label={t("dynamicForm.uploading")} />
            <span class="text-sm text-kitsuden-accent" aria-hidden="true"
              >{t("dynamicForm.uploading")}</span
            >
          </div>
        {:else}
          <button
            type="button"
            {id}
            class="w-full h-40 rounded-xl border-2 border-dashed border-kitsuden-input bg-kitsuden-bg hover:border-kitsuden-accent/50 hover:bg-kitsuden-accent/5 transition-all flex flex-col items-center justify-center gap-3 group"
            onclick={() => pickFile(path, update, "image/*")}
          >
            <span
              class="w-12 h-12 rounded-full bg-kitsuden-surface group-hover:bg-kitsuden-accent/10 flex items-center justify-center transition-colors"
            >
              <ImageIcon
                class="w-6 h-6 text-kitsuden-subtle group-hover:text-kitsuden-accent transition-colors"
              />
            </span>
            <span class="text-center">
              <span class="block text-sm text-kitsuden-text font-medium">
                {t("dynamicForm.clickToUploadImage")}
              </span>
              <span class="block text-xs text-kitsuden-subtle mt-1"
                >{t("dynamicForm.pngJpgGifUpTo")}</span
              >
            </span>
          </button>
          <!-- Choose one that is ALREADY uploaded, instead of uploading the same logo again. -->
          <Button
            variant="ghost"
            size="sm"
            class="w-full"
            onclick={() => (choosing = { path, set: update })}
          >
            <ImageIcon class="h-4 w-4" />
            {t("dynamicForm.chooseFromLibrary")}
          </Button>
        {/if}
      {:else if kind === "media"}
        {#if uploadingStates[path]}
          <div
            class="flex items-center gap-3 rounded-lg border border-dashed border-kitsuden-accent/30 bg-kitsuden-accent/5 px-3 py-3 text-sm text-kitsuden-accent"
          >
            <Spinner size="sm" label={t("dynamicForm.uploading")} />
            <span aria-hidden="true">{t("dynamicForm.uploading")}</span>
          </div>
        {:else if value}
          <div
            class="flex items-center gap-3 rounded-lg border border-kitsuden-input bg-kitsuden-bg px-3 py-2"
          >
            <Paperclip class="w-4 h-4 shrink-0 text-kitsuden-subtle" />
            <a
              href={String(value)}
              target="_blank"
              rel="noopener noreferrer"
              class="min-w-0 flex-1 truncate text-sm text-kitsuden-accent hover:underline"
              >{fileNameOf(value)}</a
            >
            <Button variant="ghost" size="sm" {id} onclick={() => pickFile(path, update)}>
              <Upload class="w-3.5 h-3.5" />
              {t("dynamicForm.replaceFile")}
            </Button>
            <Button
              variant="danger-ghost"
              size="icon"
              ariaLabel={t("dynamicForm.removeFile")}
              title={t("dynamicForm.removeFile")}
              onclick={() => update(null)}
            >
              <X class="w-4 h-4" />
            </Button>
          </div>
        {:else}
          <Button variant="outline" class="w-full" {id} onclick={() => pickFile(path, update)}>
            <Upload class="w-4 h-4" />
            {t("dynamicForm.uploadFile")}
          </Button>
        {/if}
      {:else if kind === "kpi"}
        <!-- Calculated by the server from the other fields: shown, never typed. -->
        <div
          {id}
          class="flex items-center gap-2 rounded-lg border border-dashed border-kitsuden-border bg-kitsuden-card px-3 py-2 text-sm"
          role="note"
        >
          <Calculator class="w-4 h-4 shrink-0 text-kitsuden-subtle" />
          {#if value !== null && value !== undefined && value !== ""}
            <span class="font-mono text-kitsuden-text">{value}</span>
          {/if}
          <span class="text-kitsuden-subtle">{t("dynamicForm.calculated")}</span>
        </div>
      {:else if kind === "repeater"}
        {@const rows = Array.isArray(value) ? value : []}
        <div class="space-y-3" {id} role="group" aria-labelledby="{id}-label">
          {#each rows as row, i (i)}
            <fieldset class="rounded-lg border border-kitsuden-border bg-kitsuden-card p-3">
              <legend class="sr-only">{t("dynamicForm.rowN", { n: i + 1 })}</legend>
              <div class="mb-2 flex items-center justify-between">
                <span class="text-xs font-medium text-kitsuden-subtle" aria-hidden="true"
                  >{t("dynamicForm.rowN", { n: i + 1 })}</span
                >
                <Button
                  variant="danger-ghost"
                  size="icon"
                  ariaLabel={t("dynamicForm.removeRow", { n: i + 1 })}
                  title={t("dynamicForm.removeRow", { n: i + 1 })}
                  onclick={() => update(rows.filter((_: unknown, j: number) => j !== i))}
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </Button>
              </div>
              <div class="space-y-3">
                {#each field.subFields ?? [] as sub (sub.id ?? sub.key)}
                  {@render fieldRow(
                    sub,
                    row?.[sub.key],
                    (v) =>
                      set(
                        rows.map((r: Record<string, unknown>, j: number) =>
                          j === i ? { ...r, [sub.key]: v } : r
                        )
                      ),
                    `${path}.${i}.${sub.key}`
                  )}
                {/each}
              </div>
            </fieldset>
          {:else}
            <p class="text-sm text-kitsuden-subtle">{t("dynamicForm.noRows")}</p>
          {/each}
          <Button
            variant="outline"
            size="sm"
            disabled={!!field.maxLength && rows.length >= field.maxLength}
            onclick={() => update([...rows, emptyRow(field)])}
          >
            <Plus class="w-3.5 h-3.5" />
            {t("dynamicForm.addRow")}
          </Button>
        </div>
      {:else}
        <!-- A type this form does not know: say so instead of dropping the field. -->
        <div
          {id}
          class="flex items-start gap-2 rounded-lg border border-dashed border-kitsuden-amber/40 bg-kitsuden-amber/5 px-3 py-2 text-sm text-kitsuden-text-dim"
          role="note"
          data-testid="field-unsupported"
        >
          <CircleSlash class="mt-0.5 w-4 h-4 shrink-0 text-kitsuden-amber" />
          <span>{t("common.fieldTypeNotEditable", { type: field.type })}</span>
        </div>
      {/if}

      {#if error}
        <p class="text-xs text-kitsuden-danger" id="{id}-error" role="alert">{error}</p>
      {:else if field.helpText}
        <p class="text-xs text-kitsuden-subtle" id="{id}-help">{field.helpText}</p>
      {/if}
    {/if}
  </div>
{/snippet}

<form
  id={formId}
  onsubmit={(e) => {
    e.preventDefault();
    handleSubmit();
  }}
  novalidate
  class="space-y-5"
>
  {#each visibleFields as field (field.id ?? field.key)}
    {@render fieldRow(field, formData[field.key], (v) => (formData[field.key] = v), field.key)}
  {/each}

  <!-- ── Actions ── -->
  {#if !actions}
    {#if errorCount > 0}
      <p class="text-xs text-kitsuden-danger" role="status">
        {t("dynamicForm.fieldSNeedAttention", { count: errorCount })}
      </p>
    {/if}
  {:else}
    <div class="flex items-center justify-between pt-4 border-t border-kitsuden-border">
      <div>
        {#if errorCount > 0}
          <p class="text-xs text-kitsuden-danger" role="status">
            {t("dynamicForm.fieldSNeedAttention", { count: errorCount })}
          </p>
        {/if}
      </div>
      <div class="flex items-center gap-3">
        <Button variant="ghost" onclick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" loading={submitting}>
          {#if !submitting}
            <Save class="w-4 h-4" />
          {/if}
          {submitLabel}
        </Button>
      </div>
    </div>
  {/if}
</form>

<MediaPicker
  open={choosing !== null}
  title={t("dynamicForm.chooseImage")}
  onSelect={(media) => {
    choosing?.set(media.url);
    choosing = null;
  }}
  onClose={() => (choosing = null)}
/>
