<script lang="ts">
  import { t } from "$lib/i18n";
  import { explorerEndpoint } from "$lib/explorer-endpoint";
  import { knownTables } from "$lib/explorer-tables";
  import { resolveFieldType } from "@kitsuden/shared";
  import { Loader2, Save } from "lucide-svelte";
  import { onMount } from "svelte";

  import { resolveRelatedTable } from "$lib/explorer-relations";
  import { autosaveStore } from "$lib/states/autosave.svelte";
  import { Alert, Button, Checkbox, Dialog, Input, Select, Textarea } from "$lib/tallao";
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

  /**
   * The table each relation column points to, once resolved against the tables the
   * explorer really has (see $lib/explorer-relations). Empty until then.
   */
  const relatedTables = $state<Record<string, string>>({});

  function isRelationColumn(col: SchemaColumn): boolean {
    return (
      col.type === "relation" ||
      col.name.endsWith("_id") ||
      (col.name.endsWith("Id") && col.name !== "id")
    );
  }

  const uid = $props.id();

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
      // The table is a guess from the column's name. It is matched against the tables the
      // explorer knows — also behind this table's own prefix (`directory_employees` →
      // `directory_departments`), which is how a kon names its tables — and options are
      // requested only for one that exists: a blind guess was a 404 per column, and a
      // guess without the prefix left every relation select of a kon empty.
      const relTable = resolveRelatedTable(col.name, tableName, await knownTables());
      if (!relTable) return;
      relatedTables[col.name] = relTable;
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
      const collection = `${API_URL}${explorerEndpoint(apiEndpoint, tableName)}`;
      const url = isEdit ? `${collection}/${editData!.id}` : collection;

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
  /** Cancel, Escape, the X or a click outside. */
  function close() {
    autosaveStore.stopAutosave();
    onclose?.();
  }
</script>

<!--
  A real dialog: tallao's Dialog (native <dialog> + showModal()) gives the role, the focus
  trap, Escape and focus back on the row's button. It used to be a hand-made overlay of
  divs: no role, Tab walked out of it into the page behind, Escape did nothing.
  The parent mounts this component only while the form is open, so it is always `open`.
-->
<Dialog
  open
  title={isEdit ? t("autoFormModal.editRecord") : t("autoFormModal.newRecord")}
  description={tableName}
  size="2xl"
  onClose={close}
>
  <div class="mb-3 flex justify-end">
    <AutoSaveIndicator />
  </div>

  {#if error}
    <div class="mb-4">
      <Alert variant="error">{error}</Alert>
    </div>
  {/if}

  <form
    id="{uid}-form"
    class="space-y-4"
    novalidate
    onsubmit={(e) => {
      e.preventDefault();
      void handleSubmit();
    }}
  >
    {#if editableColumns.length === 0}
      <div class="p-8 text-center">
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
    {#each editableColumns as col (col.name)}
      {@const inputType = inferInputType(col)}
      {@const id = `${uid}-${col.name}`}
      <div>
        {#if inputType === "checkbox"}
          <Checkbox
            bind:checked={() => !!formData[col.name], (v) => (formData[col.name] = v)}
            label={formatLabel(col.name)}
            {id}
          />
        {:else}
          <label class="block text-sm font-medium text-kitsuden-text mb-1.5" for={id}>
            {formatLabel(col.name)}
            {#if !col.nullable}
              <span class="text-kitsuden-danger ml-0.5" aria-hidden="true">*</span>
            {/if}
          </label>

          {#if inputType === "relation"}
            {#if relationOptions[col.name]?.length}
              <!-- The related records by their display field. -->
              <Select
                {id}
                bind:value={() => formData[col.name] ?? "", (v) => (formData[col.name] = v)}
                placeholder={t("common.select")}
                options={relationOptions[col.name].map((o) => ({
                  value: String(o.value),
                  label: o.label,
                }))}
                required={!col.nullable}
                aria-describedby="{id}-help"
              />
              <p class="text-xs text-kitsuden-subtle mt-1" id="{id}-help">
                {t("autoFormModal.relatedTo")}
                {relatedTables[col.name]}
              </p>
            {:else}
              <!--
                No list to choose from (the related table is not one the explorer serves, or
                it is empty). An empty select would hide the current value and make the
                field impossible to set: the id itself stays editable.
              -->
              <Input
                {id}
                bind:value={() => formData[col.name] ?? "", (v) => (formData[col.name] = v)}
                placeholder={t("autoFormModal.relationIdPlaceholder")}
                required={!col.nullable}
                aria-describedby="{id}-help"
              />
              <p class="text-xs text-kitsuden-subtle mt-1" id="{id}-help">
                {loadingRelations ? t("common.loading") : t("autoFormModal.relationNoOptions")}
              </p>
            {/if}
          {:else if inputType === "textarea"}
            <Textarea
              {id}
              bind:value={() => formData[col.name] ?? "", (v) => (formData[col.name] = v)}
              rows={3}
              required={!col.nullable}
            />
          {:else if inputType === "json"}
            <Textarea
              {id}
              mono
              bind:value={() => formData[col.name] ?? "", (v) => (formData[col.name] = v)}
              placeholder={'{"key": "value"}'}
              rows={3}
            />
          {:else}
            <Input
              {id}
              type={inputType}
              bind:value={() => formData[col.name] ?? "", (v) => (formData[col.name] = v)}
              required={!col.nullable}
            />
          {/if}
        {/if}
      </div>
    {/each}
  </form>

  {#if isGame}
    <GameTags bind:this={gameSelector} gameId={editData?.id ?? null} />
  {/if}

  <!-- Inline Relations (edit mode only) -->
  {#if isEdit && editData?.id}
    <InlineRelationPanel {grimoireId} parentTable={tableName} parentId={editData.id} />
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={close} disabled={saving}>{t("common.cancel")}</Button>
    <Button type="submit" form="{uid}-form" disabled={saving}>
      {#if saving}
        <Loader2 class="w-4 h-4 animate-spin" />
        {t("common.saving")}
      {:else}
        <Save class="w-4 h-4" />
        {isEdit ? t("autoFormModal.update") : t("common.create")}
      {/if}
    </Button>
  {/snippet}
</Dialog>
