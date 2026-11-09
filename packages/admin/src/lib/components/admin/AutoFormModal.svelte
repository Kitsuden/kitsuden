<script lang="ts">
  import { t } from "$lib/i18n";
  import { knownTables } from "$lib/explorer-tables";
  import { resolveFieldType } from "@kitsuden/shared";
  import { X, Loader2, Save } from "lucide-svelte";
  import { onMount } from "svelte";

  import { autosaveStore } from "$lib/states/autosave.svelte";
  import type { SchemaColumn } from "$lib/types/admin";

  import AutoSaveIndicator from "./AutoSaveIndicator.svelte";
  import GameTags from "./GameTags.svelte";
  import InlineRelationPanel from "./InlineRelationPanel.svelte";

  interface Props {
    /** Table/collection name for API calls */
    tableName: string;
    /** Columns from schema introspection */
    columns: SchemaColumn[];
    /** Existing record data (null = create mode) */
    editData?: Record<string, any> | null;
    /** Custom API endpoint base (e.g., /api/directory). If not provided, uses /api/explorer */
    apiEndpoint?: string;
    /** Grimoire ID for inline relation auto-detection */
    grimoireId?: string;
    /** Called on successful save */
    onsave?: () => void;
    /** Called when modal is closed */
    onclose?: () => void;
  }

  const {
    tableName,
    columns,
    editData = null,
    apiEndpoint,
    grimoireId,
    onsave,
    onclose,
  }: Props = $props();

  const API_URL = import.meta.env.VITE_API_URL ?? "";
  const isEdit = $derived(!!editData);

  // Form state — initialize from editData or empty
  let formData = $state<Record<string, any>>({});
  let saving = $state(false);
  let error = $state<string | null>(null);
  const relationOptions = $state<Record<string, { value: string; label: string }[]>>({});
  let loadingRelations = $state(false);

  /**
   * A kon-games game also carries tags and platforms (bridge tables
   * that this generic form does not see): `GameTags` lets you pick them and they are
   * saved as soon as the game has an id.
   */
  const isGame = $derived(tableName === "games");
  let gameSelector = $state<GameTags | null>(null);

  // Autosave key for this form
  const autosaveKey = $derived(`${tableName}_${editData?.id || "new"}`);

  // Start autosave when form is ready
  onMount(() => {
    // Wait a tick so the $effect initializer runs first
    const timer = setTimeout(() => {
      if (Object.keys(formData).length > 0) {
        autosaveStore.startAutosave(autosaveKey, formData);
      }
    }, 0);

    return () => {
      clearTimeout(timer);
      autosaveStore.stopAutosave();
    };
  });

  // Track form changes for autosave
  $effect(() => {
    autosaveStore.updateData(formData);
  });

  // Apply restored version data to the form
  $effect(() => {
    if (autosaveStore.restoredData) {
      for (const key of Object.keys(autosaveStore.restoredData)) {
        if (editableColumns.some((c) => c.name === key)) {
          formData[key] = autosaveStore.restoredData[key];
        }
      }
      autosaveStore.restoredData = null;
    }
  });

  // Readonly fields excluded from the form
  const READONLY_FIELDS = new Set(["id", "created_at", "updated_at", "createdAt", "updatedAt"]);

  // Editable columns = all except readonly
  const editableColumns = $derived(
    columns.filter((c) => !READONLY_FIELDS.has(c.name) && !c.isPrimary)
  );

  // FK column name → related table name mapping
  const FK_TABLE_MAP: Record<string, string> = {
    platform_id: "platforms",
    platformId: "platforms",
    tag_id: "tags",
    tagId: "tags",
    streamer_id: "streamers",
    streamerId: "streamers",
    collection_id: "collections",
    collectionId: "collections",
    user_id: "auth_users",
    userId: "auth_users",
    author_id: "auth_users",
    authorId: "auth_users",
    assigned_to_id: "auth_users",
    assignedToId: "auth_users",
    contact_id: "contacts",
    contactId: "contacts",
    dataset_id: "datasets",
    datasetId: "datasets",
  };

  function isRelationColumn(col: SchemaColumn): boolean {
    return (
      col.type === "relation" ||
      col.name.endsWith("_id") ||
      (col.name.endsWith("Id") && col.name !== "id")
    );
  }

  function getRelatedTable(colName: string): string | undefined {
    if (FK_TABLE_MAP[colName]) return FK_TABLE_MAP[colName];
    const base = colName.replace(/_id$/, "").replace(/Id$/, "");
    const plural = base.endsWith("s") ? base : base + "s";
    return plural;
  }

  /**
   * Canonical registry type → HTML `input` type.
   *
   * This half does belong to the UI and stays here. The other half —recognizing that
   * `integer`, `float` and `numeric` are the same— is done by `resolveFieldType`
   * against the shared registry, so a new alias there is understood
   * here without touching this file. It was the fourth type list in the repo.
   */
  const INPUT_BY_FIELD_TYPE: Record<string, string> = {
    boolean: "checkbox",
    number: "number",
    kpi: "number",
    date: "date",
    datetime: "datetime-local",
    json: "json",
    email: "email",
    url: "url",
    textarea: "textarea",
    richtext: "textarea",
  };

  function inferInputType(col: SchemaColumn): string {
    if (isRelationColumn(col)) return "relation";
    const canonical = resolveFieldType(col.type?.toLowerCase() || "text");
    const mappedValue = INPUT_BY_FIELD_TYPE[canonical];
    if (mappedValue) return mappedValue;
    if (
      col.name.includes("description") ||
      col.name.includes("content") ||
      col.name.includes("body") ||
      col.name.includes("notes") ||
      col.name.includes("bio")
    )
      return "textarea";
    return "text";
  }

  function formatLabel(name: string): string {
    return name
      .replace(/_id$/, "")
      .replace(/Id$/, "")
      .replace(/([A-Z])/g, " $1")
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase())
      .trim();
  }

  // Initialize form data
  $effect(() => {
    const initial: Record<string, any> = {};
    for (const col of editableColumns) {
      if (editData && editData[col.name] !== undefined) {
        initial[col.name] = editData[col.name];
      } else {
        const inputType = inferInputType(col);
        initial[col.name] = inputType === "checkbox" ? false : inputType === "number" ? null : "";
      }
    }
    formData = initial;
  });

  // Load FK options
  $effect(() => {
    const relationCols = editableColumns.filter(isRelationColumn);
    if (relationCols.length === 0) return;

    loadingRelations = true;
    const promises = relationCols.map(async (col) => {
      const relTable = getRelatedTable(col.name);
      if (!relTable) return;
      // The table is GUESSED from the column name (`room_id` → `rooms`) and almost
      // never exists: every create in Bookings fired ten 404s. Options are only requested
      // for tables the explorer knows.
      if (!(await knownTables()).has(relTable)) return;
      try {
        const res = await fetch(`${API_URL}/api/explorer/${relTable}/options`, {
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          relationOptions[col.name] = data.options || [];
        }
      } catch {
        // Table might not be in registry — skip
      }
    });

    Promise.all(promises).then(() => {
      loadingRelations = false;
    });
  });

  async function handleSubmit() {
    saving = true;
    error = null;

    // Build payload with proper type handling
    const payload: Record<string, any> = {};
    for (const col of editableColumns) {
      const key = col.name;
      const value = formData[key];
      const inputType = inferInputType(col);

      // Skip undefined values unless it's a required field
      if ((value === "" || value === undefined || value === null) && col.nullable) {
        payload[key] = null;
        continue;
      }

      // Handle different types
      if (inputType === "number") {
        // Convert to number or null
        const num = value === "" || value === null ? null : Number(value);
        payload[key] = num;
      } else if (inputType === "json") {
        // Parse JSON or send as-is if already object
        if (typeof value === "string" && value.trim() !== "") {
          try {
            payload[key] = JSON.parse(value);
          } catch {
            error = t("autoFormModal.invalidJsonInField", { key: formatLabel(key) });
            saving = false;
            return;
          }
        } else if (typeof value === "object") {
          payload[key] = value;
        } else {
          payload[key] = null;
        }
      } else if (inputType === "checkbox") {
        // Ensure boolean
        payload[key] = Boolean(value);
      } else if (inputType === "relation") {
        // Handle empty relation
        payload[key] = value === "" ? null : value;
      } else {
        // Text and other types
        payload[key] = value === "" ? null : value;
      }
    }

    try {
      // Use custom apiEndpoint if provided, otherwise fall back to /api/explorer
      // apiEndpoint is the base path (e.g., /api/directory), tableName gets appended
      const baseUrl = apiEndpoint ? `${API_URL}${apiEndpoint}` : `${API_URL}/api/explorer`;
      const url = isEdit ? `${baseUrl}/${tableName}/${editData!.id}` : `${baseUrl}/${tableName}`;

      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        if (isGame && gameSelector) {
          const saved = isEdit ? editData : await res.json().catch(() => null);
          const id = saved?.id ?? editData?.id;
          const failure = id ? await gameSelector.save(String(id)) : null;
          if (failure) {
            // The game was saved: a warning is shown and the form stays open to retry
            error = t("autoFormModal.gameSavedBut", {
              v: failure.charAt(0).toLowerCase(),
              v2: failure.slice(1),
            });
            onsave?.();
            return;
          }
        }
        autosaveStore.clearCurrentAutosave();
        onsave?.();
        onclose?.();
      } else {
        const err = await res.json().catch(() => ({}));
        error =
          err.error ||
          err.message ||
          t("autoFormModal.failedToRecord", { v: isEdit ? "update" : "create" });
      }
    } catch (e: any) {
      error = e.message || t("autoFormModal.networkError");
    } finally {
      saving = false;
    }
  }
</script>

<!-- Backdrop -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
  onclick={(e) => {
    if (e.target === e.currentTarget) {
      autosaveStore.stopAutosave();
      onclose?.();
    }
  }}
>
  <div
    class="bg-kitsuden-card border border-kitsuden-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between px-6 py-4 border-b border-kitsuden-border shrink-0"
    >
      <div>
        <h2 class="text-lg font-semibold text-kitsuden-text">
          {isEdit ? t("common.edit") : t("common.create")}
          {t("autoFormModal.record")}
        </h2>
        <p class="text-xs text-kitsuden-subtle mt-0.5">{tableName}</p>
      </div>
      <div class="flex items-center gap-3">
        <AutoSaveIndicator />
        <button
          onclick={() => {
            autosaveStore.stopAutosave();
            onclose?.();
          }}
          class="p-2 rounded-lg hover:bg-kitsuden-border/30 text-kitsuden-text-dim hover:text-kitsuden-text transition-colors"
        >
          <X class="w-5 h-5" />
        </button>
      </div>
    </div>

    <!-- Form Body -->
    <div class="flex-1 overflow-y-auto px-6 py-5">
      {#if error}
        <div
          class="mb-4 p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/20 text-sm text-kitsuden-accent-2"
        >
          {error}
        </div>
      {/if}

      <div class="space-y-4">
        {#if editableColumns.length === 0}
          <div class="p-8 text-center">
            <div
              class="w-12 h-12 rounded-full bg-kitsuden-accent/10 flex items-center justify-center mx-auto mb-3"
            >
              <span class="text-2xl">⚠️</span>
            </div>
            <h3 class="text-kitsuden-text font-medium mb-1">
              {t("autoFormModal.noFieldsAvailable")}
            </h3>
            <p class="text-sm text-kitsuden-subtle">
              {t("autoFormModal.couldNotLoadSchemaFor", { tableName })}
            </p>
            <p class="text-xs text-kitsuden-subtle mt-2">
              {t("autoFormModal.totalColumnsReceived")}
              {columns.length}<br />
              {t("autoFormModal.editableColumns", { editableColumnsCount: editableColumns.length })}
            </p>
          </div>
        {/if}
        {#each editableColumns as col}
          {@const inputType = inferInputType(col)}
          <div>
            <label class="block text-sm font-medium text-kitsuden-text mb-1.5">
              {formatLabel(col.name)}
              {#if !col.nullable}
                <span class="text-kitsuden-accent-2 ml-0.5">*</span>
              {/if}
            </label>

            {#if inputType === "relation"}
              <!-- FK Dropdown -->
              <select class="input w-full" bind:value={formData[col.name]}>
                <option value="">{t("common.select")}</option>
                {#if relationOptions[col.name]}
                  {#each relationOptions[col.name] as opt}
                    <option value={opt.value}>{opt.label}</option>
                  {/each}
                {/if}
              </select>
              <p class="text-[10px] text-kitsuden-subtle mt-1">
                {t("autoFormModal.relatedTo")}
                {getRelatedTable(col.name) || "unknown"}
              </p>
            {:else if inputType === "checkbox"}
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  bind:checked={formData[col.name]}
                  class="w-4 h-4 rounded border-kitsuden-border accent-kitsuden-accent"
                />
                <span class="text-sm text-kitsuden-text-dim">{t("autoFormModal.enabled")}</span>
              </label>
            {:else if inputType === "textarea"}
              <textarea
                class="input w-full min-h-[80px] resize-y"
                bind:value={formData[col.name]}
                placeholder={formatLabel(col.name)}
                rows="3"
              ></textarea>
            {:else if inputType === "json"}
              <textarea
                class="input w-full font-mono text-xs min-h-[80px] resize-y"
                bind:value={formData[col.name]}
                placeholder={'{"key": "value"}'}
                rows="3"
              ></textarea>
            {:else if inputType === "number"}
              <input
                type="number"
                class="input w-full"
                bind:value={formData[col.name]}
                placeholder={formatLabel(col.name)}
              />
            {:else if inputType === "date" || inputType === "datetime-local"}
              <input type={inputType} class="input w-full" bind:value={formData[col.name]} />
            {:else}
              <input
                type={inputType}
                class="input w-full"
                bind:value={formData[col.name]}
                placeholder={formatLabel(col.name)}
              />
            {/if}
          </div>
        {/each}
      </div>

      {#if isGame}
        <GameTags bind:this={gameSelector} gameId={editData?.id ?? null} />
      {/if}

      <!-- Inline Relations (edit mode only) -->
      {#if isEdit && editData?.id}
        <InlineRelationPanel {grimoireId} parentTable={tableName} parentId={editData.id} />
      {/if}
    </div>

    <!-- Footer -->
    <div
      class="flex items-center justify-end gap-3 px-6 py-4 border-t border-kitsuden-border shrink-0"
    >
      <button class="btn-secondary-sm" onclick={() => onclose?.()} disabled={saving}>
        {t("common.cancel")}
      </button>
      <button class="btn-primary flex items-center gap-2" onclick={handleSubmit} disabled={saving}>
        {#if saving}
          <Loader2 class="w-4 h-4 animate-spin" />
          {t("common.saving")}
        {:else}
          <Save class="w-4 h-4" />
          {isEdit ? t("autoFormModal.update") : t("common.create")}
        {/if}
      </button>
    </div>
  </div>
</div>
