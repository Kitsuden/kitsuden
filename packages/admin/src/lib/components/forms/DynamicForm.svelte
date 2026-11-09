<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * DynamicForm.svelte — Runtime form generator from Dataset schema
   * Reads FieldDefinition[], generates validation, renders form
   */
  import { Save, Loader2, Upload, X, ImageIcon } from "lucide-svelte";

  import MediaPicker from "$lib/components/media/MediaPicker.svelte";
  import { uploadMedia } from "$lib/media/upload";

  import type { FieldDefinition } from "../../../types/datasets";

  import RelationshipField from "./RelationshipField.svelte";

  // ─── Props ──────────────────────────────────────────
  interface Props {
    fields: FieldDefinition[];
    initialData?: Record<string, any>;
    submitLabel?: string;
    onSubmit?: (data: Record<string, any>) => void;
    onCancel?: () => void;
  }

  const {
    fields,
    initialData = {},
    submitLabel = t("dynamicForm.saveEntry"),
    onSubmit,
    onCancel,
  }: Props = $props();

  // ─── State ──────────────────────────────────────────
  let formData = $state<Record<string, any>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let submitting = $state(false);
  const uploadingStates = $state<Record<string, boolean>>({});

  /**
   * Which field expects an image. The KEY and not a boolean: a dataset can have
   * several image fields, and with a boolean the chosen one would go to the first.
   */
  let fieldChoosing = $state<string | null>(null);

  // Initialize form data with defaults
  function initFormData() {
    const data: Record<string, any> = {};
    for (const field of fields) {
      if (initialData[field.key] !== undefined) {
        data[field.key] = initialData[field.key];
      } else if (field.defaultValue !== undefined && field.defaultValue !== "") {
        if (field.type === "number") data[field.key] = Number(field.defaultValue) || 0;
        else if (field.type === "boolean") data[field.key] = field.defaultValue === "true";
        else data[field.key] = field.defaultValue;
      } else if (field.type === "boolean") {
        data[field.key] = false;
      } else if (field.type === "relation" && field.relation?.type !== "one-to-one") {
        data[field.key] = [];
      } else {
        data[field.key] = null;
      }
    }
    formData = data;
  }

  // Initialize on mount
  $effect(() => {
    initFormData();
  });

  // ─── Computed ───────────────────────────────────────
  const visibleFields = $derived([...fields].sort((a, b) => a.order - b.order));

  // ─── Field setters ──────────────────────────────────
  function setField(key: string, value: any) {
    formData[key] = value;
    if (fieldErrors[key]) delete fieldErrors[key];
  }

  function setJsonField(key: string, raw: string) {
    try {
      formData[key] = JSON.parse(raw);
      if (fieldErrors[key]) delete fieldErrors[key];
    } catch {
      formData[key] = raw;
    }
  }

  // ─── Image Upload Handler ───────────────────────────
  /**
   * Uploads an image to a form field.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THIS WAS BROKEN IN TWO WAYS AT ONCE, AND NOBODY SAW IT
   *
   *   · It sent the file as `file`, and the endpoint reads `files` (plural).
   *     The upload died before starting with «No files provided».
   *   · It read `data.url`, which NEVER existed in that response. Even if the upload
   *     had worked, the field would have been saved with `undefined`.
   *
   * Now it uses `uploadMedia`, the same function as the blog editor, so
   * the two paths cannot diverge again.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async function handleImageUpload(fieldKey: string, file: File) {
    uploadingStates[fieldKey] = true;

    try {
      const { uploaded, errors: errorsValue } = await uploadMedia([file]);
      if (uploaded[0]) {
        setField(fieldKey, uploaded[0].url);
      } else {
        // The specific reason the server returned is stated: «Failed to
        // upload» on its own does not distinguish a 20 MB file from a full disk.
        alert(errorsValue.join(" · ") || t("dynamicForm.couldNotUploadThe"));
      }
    } catch (err: any) {
      alert(err?.message || t("dynamicForm.couldNotUploadThe"));
    } finally {
      uploadingStates[fieldKey] = false;
    }
  }

  // ─── Validation Engine ──────────────────────────────
  function validate(): boolean {
    const errors: Record<string, string> = {};

    for (const field of fields) {
      const val = formData[field.key];

      // Required check
      if (field.isRequired) {
        if (val === null || val === undefined || val === "") {
          errors[field.key] = `${field.label} is required`;
          continue;
        }
        if (Array.isArray(val) && val.length === 0) {
          errors[field.key] = `${field.label} requires at least one selection`;
          continue;
        }
      }

      if (val === null || val === undefined || val === "") continue;

      // Type-specific validation
      switch (field.type) {
        case "number": {
          const num = Number(val);
          if (isNaN(num)) {
            errors[field.key] = t("dynamicForm.mustBeAValidNumber");
          } else {
            if (field.minValue !== undefined && num < field.minValue) {
              errors[field.key] = t("dynamicForm.minimumValueIs", { minValue: field.minValue });
            }
            if (field.maxValue !== undefined && num > field.maxValue) {
              errors[field.key] = t("dynamicForm.maximumValueIs", { maxValue: field.maxValue });
            }
          }
          break;
        }

        case "text":
        case "richtext": {
          const str = String(val);
          if (field.minLength && str.length < field.minLength) {
            errors[field.key] = t("dynamicForm.minimumCharacters", { minLength: field.minLength });
          }
          if (field.maxLength && str.length > field.maxLength) {
            errors[field.key] = t("dynamicForm.maximumCharacters", { maxLength: field.maxLength });
          }
          if (field.validationRegex) {
            try {
              if (!new RegExp(field.validationRegex).test(str)) {
                errors[field.key] = t("dynamicForm.doesNotMatchPattern", {
                  validationRegex: field.validationRegex,
                });
              }
            } catch {}
          }
          break;
        }

        case "email": {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val))) {
            errors[field.key] = t("dynamicForm.invalidEmailAddress");
          }
          break;
        }

        case "url": {
          try {
            new URL(String(val));
          } catch {
            errors[field.key] = t("dynamicForm.invalidUrl");
          }
          break;
        }

        case "json": {
          if (typeof val === "string") {
            try {
              JSON.parse(val);
            } catch {
              errors[field.key] = t("dynamicForm.invalidJson");
            }
          }
          break;
        }

        case "select": {
          const validValues = (field.options || []).map((o) => o.value);
          if (!validValues.includes(String(val))) {
            errors[field.key] = t("dynamicForm.invalidSelection");
          }
          break;
        }
      }
    }

    fieldErrors = errors;
    return Object.keys(errors).length === 0;
  }

  // ─── Submit ─────────────────────────────────────────
  function handleSubmit() {
    if (!validate()) return;

    submitting = true;

    const cleanData: Record<string, any> = {};
    for (const field of fields) {
      let val = formData[field.key];
      if (field.type === "number" && val !== null && val !== undefined) {
        val = Number(val);
      }
      if (field.type === "json" && typeof val === "string") {
        try {
          val = JSON.parse(val);
        } catch {}
      }
      cleanData[field.key] = val;
    }

    onSubmit?.(cleanData);

    setTimeout(() => {
      submitting = false;
    }, 500);
  }
</script>

<form
  onsubmit={(e) => {
    e.preventDefault();
    handleSubmit();
  }}
  class="space-y-5"
>
  {#each visibleFields as field}
    <div class="space-y-1.5">
      <!-- ── Text ── -->
      {#if field.type === "text"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <input
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, e.currentTarget.value)}
          type="text"
          placeholder={field.helpText || t("dynamicForm.enter", { v: field.label.toLowerCase() })}
          class="input {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        />
      {/if}

      <!-- ── Number ── -->
      {#if field.type === "number"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <input
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, Number(e.currentTarget.value) || null)}
          type="number"
          min={field.minValue}
          max={field.maxValue}
          placeholder={field.helpText || "0"}
          class="input {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        />
      {/if}

      <!-- ── Boolean ── -->
      {#if field.type === "boolean"}
        <div class="flex items-center justify-between py-1">
          <div>
            <label class="text-sm font-medium text-kitsuden-text">
              {field.label}
              {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
            </label>
            {#if field.helpText}
              <p class="text-[10px] text-kitsuden-subtle">{field.helpText}</p>
            {/if}
          </div>
          <button
            type="button"
            onclick={() => setField(field.key, !formData[field.key])}
            class="relative w-10 h-6 rounded-full transition-colors {formData[field.key]
              ? 'bg-kitsuden-accent'
              : 'bg-kitsuden-border'}"
          >
            <span
              class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-xs transition-transform {formData[
                field.key
              ]
                ? 'translate-x-[18px]'
                : 'translate-x-[2px]'}"
            ></span>
          </button>
        </div>
      {/if}

      <!-- ── Date ── -->
      {#if field.type === "date"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <input
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, e.currentTarget.value)}
          type="date"
          class="input {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        />
      {/if}

      <!-- ── URL ── -->
      {#if field.type === "url"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <input
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, e.currentTarget.value)}
          type="url"
          placeholder="https://"
          class="input {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        />
      {/if}

      <!-- ── Email ── -->
      {#if field.type === "email"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <input
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, e.currentTarget.value)}
          type="email"
          placeholder={field.helpText || t("dynamicForm.emailExampleCom")}
          class="input {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        />
      {/if}

      <!-- ── Image / Media Picker ── -->
      {#if field.type === "image"}
        {@const uploadingKey = field.key + "_uploading"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>

        {#if formData[field.key]}
          <!-- Preview Mode -->
          <div class="relative group">
            <div
              class="relative w-full h-40 rounded-xl border border-kitsuden-border overflow-hidden bg-kitsuden-bg"
            >
              <!-- Checkerboard background for transparency -->
              <div
                class="absolute inset-0 opacity-[0.03]"
                style="background-image: linear-gradient(45deg, #fff 25%, transparent 25%), linear-gradient(-45deg, #fff 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #fff 75%), linear-gradient(-45deg, transparent 75%, #fff 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0px;"
              ></div>

              <img
                src={formData[field.key]}
                alt={field.label}
                class="w-full h-full object-contain p-4"
              />

              <!-- Overlay actions -->
              <div
                class="absolute inset-x-0 bottom-0 p-3 bg-linear-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-between"
              >
                <span class="text-xs text-kitsuden-text truncate max-w-[200px]"
                  >{formData[field.key].split("/").pop()}</span
                >
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-kitsuden-text transition-colors"
                    onclick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = "image/*";
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (!file) return;
                        await handleImageUpload(field.key, file);
                      };
                      input.click();
                    }}
                    title={t("dynamicForm.replaceImage")}
                  >
                    <Upload class="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    class="p-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                    onclick={() => setField(field.key, null)}
                    title={t("dynamicForm.removeImage")}
                  >
                    <X class="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        {:else if uploadingStates[field.key]}
          <!-- Uploading State -->
          <div
            class="w-full h-40 rounded-xl border-2 border-dashed border-kitsuden-accent/30 bg-kitsuden-accent/5 flex flex-col items-center justify-center gap-3"
          >
            <Loader2 class="w-8 h-8 text-kitsuden-accent animate-spin" />
            <span class="text-sm text-kitsuden-accent">{t("dynamicForm.uploading")}</span>
          </div>
        {:else}
          <!-- Upload Zone -->
          <button
            type="button"
            class="w-full h-40 rounded-xl border-2 border-dashed border-kitsuden-border bg-kitsuden-bg hover:border-kitsuden-accent/50 hover:bg-kitsuden-accent/5 transition-all flex flex-col items-center justify-center gap-3 group"
            onclick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = async (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (!file) return;
                await handleImageUpload(field.key, file);
              };
              input.click();
            }}
          >
            <div
              class="w-12 h-12 rounded-full bg-kitsuden-surface group-hover:bg-kitsuden-accent/10 flex items-center justify-center transition-colors"
            >
              <ImageIcon
                class="w-6 h-6 text-kitsuden-subtle group-hover:text-kitsuden-accent transition-colors"
              />
            </div>
            <div class="text-center">
              <p class="text-sm text-kitsuden-text font-medium">
                {t("dynamicForm.clickToUploadImage")}
              </p>
              <p class="text-xs text-kitsuden-subtle mt-1">{t("dynamicForm.pngJpgGifUpTo")}</p>
            </div>
          </button>

          <!--
            Choose one that is ALREADY uploaded.

            Without this, the only way out was uploading the same image again every
            time it was used in another entry — and the library filled up with
            copies of the same logo with different names.
          -->
          <button
            type="button"
            class="btn-ghost btn-sm mt-2 w-full gap-1.5"
            onclick={() => (fieldChoosing = field.key)}
          >
            <ImageIcon class="h-4 w-4" />
            {t("dynamicForm.chooseFromLibrary")}
          </button>
        {/if}

        <!-- Hidden URL input for form validation -->
        <input type="hidden" value={formData[field.key] || ""} />
      {/if}

      <!-- ── Select ── -->
      {#if field.type === "select"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <select
          value={formData[field.key] || ""}
          onchange={(e) => setField(field.key, e.currentTarget.value)}
          class="select {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"
        >
          <option value="">{t("common.select")}</option>
          {#each field.options || [] as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      {/if}

      <!-- ── JSON ── -->
      {#if field.type === "json"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <textarea
          value={typeof formData[field.key] === "string"
            ? formData[field.key]
            : JSON.stringify(formData[field.key], null, 2)}
          oninput={(e) => setJsonField(field.key, e.currentTarget.value)}
          rows="4"
          placeholder={'{ "key": "value" }'}
          class="textarea font-mono text-xs {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"></textarea>
      {/if}

      <!-- ── Rich Text ── -->
      {#if field.type === "richtext"}
        <label class="label block">
          {field.label}
          {#if field.isRequired}<span class="text-kitsuden-accent-2">*</span>{/if}
        </label>
        <textarea
          value={formData[field.key] || ""}
          oninput={(e) => setField(field.key, e.currentTarget.value)}
          rows="5"
          placeholder={field.helpText || t("dynamicForm.enterContentMarkdownSupported")}
          class="textarea {fieldErrors[field.key]
            ? 'border-kitsuden-accent-2-50 focus:ring-kitsuden-accent-2-30'
            : ''}"></textarea>
      {/if}

      <!-- ── Relation ── -->
      {#if field.type === "relation" && field.relation}
        <RelationshipField
          value={formData[field.key]}
          onChange={(val) => setField(field.key, val)}
          target={field.relation.target}
          targetDatasetId={field.relation.targetDatasetId}
          relationType={field.relation.type}
          displayField={field.relation.displayField}
          label={field.label}
          helpText={field.helpText}
          required={field.isRequired}
          error={fieldErrors[field.key]}
        />
      {/if}

      <!-- Error display (non-relation fields) -->
      {#if field.type !== "relation" && field.type !== "boolean"}
        {#if field.helpText && !fieldErrors[field.key]}
          <p class="text-[10px] text-kitsuden-subtle">{field.helpText}</p>
        {/if}
        {#if fieldErrors[field.key]}
          <p class="text-[10px] text-kitsuden-accent-2">{fieldErrors[field.key]}</p>
        {/if}
      {/if}
    </div>
  {/each}

  <!-- ── Actions ── -->
  <div class="flex items-center justify-between pt-4 border-t border-kitsuden-border">
    <div>
      {#if Object.keys(fieldErrors).length > 0}
        <p class="text-xs text-kitsuden-accent-2">
          {t("dynamicForm.fieldSNeedAttention", { count: Object.keys(fieldErrors).length })}
        </p>
      {/if}
    </div>
    <div class="flex items-center gap-3">
      <button type="button" onclick={onCancel} class="btn-ghost">{t("common.cancel")}</button>
      <button type="submit" disabled={submitting} class="btn-primary">
        {#if submitting}
          <Loader2 class="w-4 h-4 animate-spin" />
        {:else}
          <Save class="w-4 h-4" />
        {/if}
        {submitLabel}
      </button>
    </div>
  </div>
</form>

<MediaPicker
  open={fieldChoosing !== null}
  title={t("dynamicForm.chooseImage")}
  onSelect={(media) => {
    if (fieldChoosing) setField(fieldChoosing, media.url);
    fieldChoosing = null;
  }}
  onClose={() => (fieldChoosing = null)}
/>

<style>
  .border-kitsuden-accent-2-50 {
    border-color: rgb(255 45 111 / 0.5);
  }
</style>
