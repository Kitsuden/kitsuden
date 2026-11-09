<script lang="ts">
  import { t as tr } from "$lib/i18n";
  /**
   * SchemaBuilder.svelte — Drag-and-drop field designer
   * Three-panel layout: Field Palette | Field List | Field Settings
   * Enterprise tabs: Fields | Security | Workflow
   */
  import {
    Type,
    Hash,
    ToggleLeft,
    Calendar,
    ImageIcon,
    Link2,
    Mail,
    List,
    Braces,
    FileText,
    GitBranch,
    GripVertical,
    X,
    Plus,
    Save,
    Layers,
    Shield,
    ShieldOff,
    Lock,
    Globe,
    Users,
    UserCheck,
    GitPullRequest,
    Zap,
    CheckCircle,
    Clock,
    Paperclip,
    ListChecks,
    Pilcrow,
    Calculator,
    Rows3,
    Trash2,
    Eye,
  } from "lucide-svelte";
  import { slide } from "svelte/transition";

  import {
    FIELD_TYPE_OPTIONS,
    generateSlug,
    generateFieldKey,
    createEmptyField,
    type FieldDefinition,
    type FieldType,
    type DatasetDefinition,
    type RelationType,
  } from "../../../types/datasets";

  // ─── Props ──────────────────────────────────────────
  interface Props {
    definition: DatasetDefinition;
    allDatasets?: DatasetDefinition[];
    onSave?: (def: DatasetDefinition) => void;
    onCancel?: () => void;
  }

  const { definition, allDatasets = [], onSave, onCancel }: Props = $props();

  // ─── Tab system ─────────────────────────────────────
  type TabId = "fields" | "security" | "workflow";
  let activeTab = $state<TabId>("fields");

  const tabs = [
    { id: "fields" as const, label: tr("common.fields"), icon: Layers },
    { id: "security" as const, label: tr("schemaBuilder.security"), icon: Shield },
    { id: "workflow" as const, label: tr("schemaBuilder.workflow"), icon: GitPullRequest },
  ];

  // ─── Access option cards ────────────────────────────
  const readAccessOptions = [
    {
      value: "admin" as const,
      label: tr("schemaBuilder.admin"),
      desc: tr("schemaBuilder.onlyAdmins"),
      icon: Lock,
    },
    {
      value: "authenticated" as const,
      label: tr("schemaBuilder.users"),
      desc: tr("schemaBuilder.loggedInUsers"),
      icon: Users,
    },
    { value: "public" as const, label: tr("schemaBuilder.public"), desc: "Everyone", icon: Globe },
  ];

  const writeAccessOptions = [
    {
      value: "admin" as const,
      label: tr("schemaBuilder.adminOnly"),
      desc: tr("schemaBuilder.onlyAdminsCanCreateEdit"),
      icon: Lock,
    },
    {
      value: "authenticated" as const,
      label: tr("schemaBuilder.authenticated"),
      desc: tr("schemaBuilder.anyLoggedInUser"),
      icon: UserCheck,
    },
  ];

  // ─── Icon map ───────────────────────────────────────
  /**
   * Registry icon name → component.
   *
   * It must cover ALL the icons the shared registry declares: a
   * name with no entry here does not fail, it falls back to the default icon, and the palette
   * shows half a dozen fields with the same drawing with nothing to warn you.
   * `Image` and `Link` are mapped to the import aliases (`ImageIcon`, `Link2`)
   * because `Image` and `Link` collide with DOM globals.
   */
  const iconMap: Record<string, typeof Type> = {
    Type,
    Hash,
    ToggleLeft,
    Calendar,
    Clock,
    ImageIcon,
    Image: ImageIcon,
    Paperclip,
    Link2,
    Link: Link2,
    Mail,
    List,
    ListChecks,
    Braces,
    FileText,
    Pilcrow,
    GitBranch,
    Calculator,
    Rows3,
  };

  const iconOptions = [
    "📦",
    "⚔️",
    "🛡️",
    "🧪",
    "👤",
    "🗺️",
    "📊",
    "🏆",
    "📜",
    "🎮",
    "🎯",
    "🔮",
    "💎",
    "🏠",
    "🔧",
  ];

  // ─── Local State ────────────────────────────────────
  let localDef = $state<DatasetDefinition>(JSON.parse(JSON.stringify(definition)));
  let selectedFieldId = $state<string | null>(null);
  let dragOverIndex = $state(-1);
  let dragFieldType: FieldType | null = null;
  let dragFieldIndex: number | null = null;

  // Watch for prop changes
  $effect(() => {
    localDef = JSON.parse(JSON.stringify(definition));
  });

  // ─── Computed ───────────────────────────────────────
  const selectedField = $derived(localDef.fields.find((f) => f.id === selectedFieldId) || null);
  const otherDatasets = $derived(allDatasets.filter((d) => d.id !== localDef.id));

  const validationErrors = $derived.by(() => {
    const errs: string[] = [];
    if (!localDef.name.trim()) errs.push(tr("schemaBuilder.datasetNameIsRequired"));
    if (localDef.fields.length === 0) errs.push(tr("schemaBuilder.addAtLeastOneField"));
    for (const f of localDef.fields) {
      if (!f.label.trim()) errs.push(tr("schemaBuilder.fieldAtPositionNeedsA", { v: f.order + 1 }));
      if (!f.key.trim()) errs.push(tr("schemaBuilder.fieldNeedsAKey", { label: f.label }));
    }
    const keys = localDef.fields.map((f) => f.key).filter(Boolean);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (dups.length) errs.push(tr("schemaBuilder.duplicateFieldKey", { v: dups[0] }));
    return errs;
  });

  const canSave = $derived(validationErrors.length === 0);

  // ─── Enterprise: Enable / Disable ───────────────────
  function enablePolicy() {
    localDef.policyJson = {
      readAccess: "admin",
      writeAccess: "admin",
      enableRLS: false,
      rlsRules: [],
    };
  }

  function enableWorkflow() {
    localDef.workflowJson = {
      requireApproval: true,
      approverUserIds: [],
    };
  }

  function addRLSRule() {
    if (!localDef.policyJson) return;
    if (!localDef.policyJson.rlsRules) localDef.policyJson.rlsRules = [];
    localDef.policyJson.rlsRules.push({ field: "", operator: "eq", value: "" });
  }

  function addApprover() {
    if (!localDef.workflowJson) return;
    if (!localDef.workflowJson.approverUserIds) localDef.workflowJson.approverUserIds = [];
    localDef.workflowJson.approverUserIds.push("");
  }

  // ─── Relation field helpers ─────────────────────────
  function setRelationType(t: RelationType) {
    if (!selectedField) return;
    if (!selectedField.relation) {
      selectedField.relation = { target: "games", type: t, displayField: "title" };
    } else {
      selectedField.relation.type = t;
    }
  }

  // ─── Field CRUD ─────────────────────────────────────
  function addField(type: FieldType) {
    const order = localDef.fields.length;
    const field = createEmptyField(type, order);
    if (type === "select") field.options = [{ label: "", value: "" }];
    if (type === "relation")
      field.relation = { target: "games", type: "one-to-many", displayField: "title" };
    localDef.fields.push(field);
    selectedFieldId = field.id;
  }

  function removeField(idx: number) {
    const f = localDef.fields[idx];
    if (selectedFieldId === f.id) selectedFieldId = null;
    localDef.fields.splice(idx, 1);
    reorder();
  }

  function selectField(id: string) {
    selectedFieldId = selectedFieldId === id ? null : id;
  }

  function collapseAll() {
    selectedFieldId = null;
  }

  // ─── Drag & Drop ────────────────────────────────────
  function onDragStartPalette(e: DragEvent, type: FieldType) {
    dragFieldType = type;
    dragFieldIndex = null;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
  }

  function onDragStartField(e: DragEvent, idx: number) {
    dragFieldType = null;
    dragFieldIndex = idx;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDropZone() {
    if (dragFieldType) {
      addField(dragFieldType);
    }
    dragFieldType = null;
    dragFieldIndex = null;
    dragOverIndex = -1;
  }

  function onDropReorder(targetIdx: number) {
    if (dragFieldType) {
      const order = targetIdx;
      const field = createEmptyField(dragFieldType, order);
      if (dragFieldType === "select") field.options = [{ label: "", value: "" }];
      if (dragFieldType === "relation")
        field.relation = { target: "games", type: "one-to-many", displayField: "title" };
      localDef.fields.splice(targetIdx, 0, field);
      selectedFieldId = field.id;
      reorder();
    } else if (dragFieldIndex !== null && dragFieldIndex !== targetIdx) {
      const [moved] = localDef.fields.splice(dragFieldIndex, 1);
      localDef.fields.splice(targetIdx, 0, moved);
      reorder();
    }
    dragFieldType = null;
    dragFieldIndex = null;
    dragOverIndex = -1;
  }

  function reorder() {
    localDef.fields.forEach((f, i) => (f.order = i));
  }

  // ─── Auto-generate helpers ──────────────────────────
  function autoSlug() {
    localDef.slug = generateSlug(localDef.name);
  }

  function autoFieldKey(field: FieldDefinition) {
    if (!field.key || field.key === generateFieldKey(field.label.slice(0, -1))) {
      field.key = generateFieldKey(field.label);
    }
  }

  function addSelectOption() {
    if (!selectedField) return;
    if (!selectedField.options) selectedField.options = [];
    selectedField.options.push({ label: "", value: "" });
  }

  // ─── Repeater ───────────────────────────────────────
  /**
   * Types allowed as a subfield. `repeater` is NOT in it: nesting is cut off
   * at one level (see shared/schemas.ts), and offering it here would create a
   * definition that the validator silently flattens.
   */
  const SUBFIELD_TYPES = FIELD_TYPE_OPTIONS.filter((o) => o.type !== "repeater");

  function addSubField() {
    if (!selectedField) return;
    if (!selectedField.subFields) selectedField.subFields = [];
    selectedField.subFields.push({
      ...createEmptyField("text", selectedField.subFields.length),
      // `createEmptyField` seeds a repeater with a subfield; for a
      // subfield that does not apply and it is removed so as not to carry junk.
      subFields: undefined,
    } as never);
  }

  function removeSubField(index: number) {
    selectedField?.subFields?.splice(index, 1);
  }

  function moveSubField(index: number, delta: number) {
    const subs = selectedField?.subFields;
    if (!subs) return;
    const target = index + delta;
    if (target < 0 || target >= subs.length) return;
    [subs[index], subs[target]] = [subs[target], subs[index]];
    subs.forEach((s, i) => (s.order = i));
  }

  function autoSubKey(sub: { key: string; label: string }) {
    if (!sub.key || sub.key === generateFieldKey(sub.label.slice(0, -1))) {
      sub.key = generateFieldKey(sub.label);
    }
  }

  // ─── Conditional logic ─────────────────────────────
  /**
   * A field can only depend on ANOTHER field, never on itself: a
   * self-referencing condition cannot be evaluated (the value would be needed to
   * decide whether the value counts) and the dropdown must not allow building one.
   */
  function conditionSources(current: FieldDefinition) {
    return localDef.fields.filter((f) => f.key && f.key !== current.key);
  }

  function toggleCondition() {
    if (!selectedField) return;
    if (selectedField.showIf) {
      selectedField.showIf = undefined;
      return;
    }
    const first = conditionSources(selectedField)[0];
    selectedField.showIf = { field: first?.key ?? "", operator: "eq", value: "" };
  }

  // ─── Utility ────────────────────────────────────────
  function getFieldColor(type: FieldType): string {
    return FIELD_TYPE_OPTIONS.find((f) => f.type === type)?.color || "#888";
  }

  function getFieldIcon(type: FieldType): typeof Type {
    const opt = FIELD_TYPE_OPTIONS.find((f) => f.type === type);
    return iconMap[opt?.icon || "Type"] || Type;
  }

  function getFieldTypeLabel(type: FieldType): string {
    return FIELD_TYPE_OPTIONS.find((f) => f.type === type)?.label || type;
  }

  function save() {
    if (canSave && onSave) onSave(localDef);
  }
</script>

<div class="flex h-[calc(100vh-9rem)] gap-4 animate-fade-in">
  <!-- ═══ LEFT: Field Type Palette ═══ -->
  {#if activeTab === "fields"}
    <div class="w-56 shrink-0 card overflow-y-auto">
      <div class="p-3 border-b border-kitsuden-border sticky top-0 bg-kitsuden-card z-10">
        <p class="label">{tr("schemaBuilder.fieldTypes")}</p>
        <p class="text-[10px] text-kitsuden-subtle mt-0.5">
          {tr("schemaBuilder.dragOrClickToAdd")}
        </p>
      </div>
      <div class="p-2 space-y-1">
        {#each FIELD_TYPE_OPTIONS as ft}
          <button
            onclick={() => addField(ft.type)}
            draggable="true"
            ondragstart={(e) => onDragStartPalette(e, ft.type)}
            class="flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-left text-sm hover:bg-kitsuden-border/30 transition-all cursor-grab active:cursor-grabbing group"
          >
            <div
              class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
              style="background: {ft.color}12; border: 1px solid {ft.color}25"
            >
              {#if iconMap[ft.icon]}
                {@const IconComponent = iconMap[ft.icon]}
                <IconComponent class="w-4 h-4" style="color: {ft.color}" />
              {/if}
            </div>
            <div class="min-w-0">
              <p
                class="font-medium text-kitsuden-text group-hover:text-kitsuden-text transition-colors"
              >
                {ft.label}
              </p>
              <p class="text-[10px] text-kitsuden-subtle truncate">{ft.description}</p>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- ═══ CENTER: Tabbed Content ═══ -->
  <div class="flex-1 flex flex-col min-w-0">
    <!-- Dataset header -->
    <div class="card p-4 mb-4">
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label for="name" class="label mb-1.5 block">{tr("schemaBuilder.datasetName")}</label>
          <input
            id="name"
            bind:value={localDef.name}
            oninput={autoSlug}
            type="text"
            placeholder={tr("schemaBuilder.eGProducts")}
            class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>
        <div>
          <label class="label mb-1.5 block">{tr("common.slug")}</label>
          <div class="flex items-center gap-2">
            <input
              bind:value={localDef.slug}
              type="text"
              placeholder="products"
              class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-xs"
            />
            <select
              bind:value={localDef.icon}
              class="w-20 px-2 py-2 bg-slate-800 border border-slate-700 text-gray-100 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 text-center text-lg appearance-none"
            >
              {#each iconOptions as ic}
                <option value={ic}>{ic}</option>
              {/each}
            </select>
          </div>
        </div>
      </div>
      <div class="mt-3">
        <label for="description" class="label mb-1.5 block">{tr("common.description")}</label>
        <input
          id="description"
          bind:value={localDef.description}
          type="text"
          placeholder={tr("schemaBuilder.optionalDescriptionForThisData")}
          class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      </div>
    </div>

    <!-- ═══ Tab Navigation ═══ -->
    <div class="flex items-center gap-1 mb-3">
      {#each tabs as tab}
        <button
          onclick={() => (activeTab = tab.id)}
          class="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all border {activeTab ===
          tab.id
            ? 'bg-kitsuden-accent-10 text-kitsuden-accent border-kitsuden-accent-20'
            : 'text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-border/20 border-transparent'}"
        >
          <tab.icon class="w-3.5 h-3.5" />
          {tab.label}
          {#if tab.id === "security" && localDef.policyJson}
            <span class="w-1.5 h-1.5 rounded-full bg-kitsuden-amber"></span>
          {/if}
          {#if tab.id === "workflow" && localDef.workflowJson?.requireApproval}
            <span class="w-1.5 h-1.5 rounded-full bg-kitsuden-purple"></span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Fields -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "fields"}
      <div class="flex-1 flex flex-col min-h-0">
        <!-- Field list / drop zone -->
        <div
          class="flex-1 card overflow-y-auto"
          ondragover={(e) => {
            e.preventDefault();
            dragOverIndex = -1;
          }}
          ondrop={(e) => {
            e.preventDefault();
            onDropZone();
          }}
        >
          <div
            class="p-3 border-b border-kitsuden-border sticky top-0 bg-kitsuden-card z-10 flex items-center justify-between"
          >
            <div class="flex items-center gap-2">
              <p class="label">{tr("schemaBuilder.schemaFields")}</p>
              <span class="badge-cyan text-[9px]">{localDef.fields.length}</span>
            </div>
            {#if localDef.fields.length > 0}
              <button onclick={collapseAll} class="btn-ghost btn-sm text-[10px]"
                >{tr("schemaBuilder.collapseAll")}</button
              >
            {/if}
          </div>

          {#if localDef.fields.length === 0}
            <div class="flex flex-col items-center justify-center py-12 text-kitsuden-subtle">
              <Layers class="w-10 h-10 mb-3 text-kitsuden-muted" />
              <p class="text-sm font-medium">{tr("schemaBuilder.noFieldsYet")}</p>
              <p class="text-xs mt-1">{tr("schemaBuilder.clickOrDragFieldTypes")}</p>
            </div>
          {:else}
            <div class="divide-y divide-kitsuden-border/50">
              {#each localDef.fields as field, idx}
                <div
                  draggable="true"
                  ondragstart={(e) => onDragStartField(e, idx)}
                  ondragover={(e) => {
                    e.preventDefault();
                    dragOverIndex = idx;
                  }}
                  ondrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDropReorder(idx);
                  }}
                  class="group transition-all {dragOverIndex === idx
                    ? 'ring-2 ring-kitsuden-accent-30 ring-inset'
                    : ''} {selectedFieldId === field.id
                    ? 'bg-kitsuden-accent/[0.04]'
                    : 'hover:bg-kitsuden-border/20'}"
                >
                  <!-- Field row -->
                  <div
                    role="button"
                    tabindex="0"
                    class="flex items-center gap-3 px-4 py-3 w-full text-left"
                    onclick={() => selectField(field.id)}
                    onkeydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") selectField(field.id);
                    }}
                  >
                    <!-- Drag handle -->
                    <GripVertical
                      class="w-4 h-4 text-kitsuden-muted shrink-0 opacity-0 group-hover:opacity-60 cursor-grab transition-opacity"
                    />

                    <!-- Type icon -->
                    <div
                      class="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                      style="background: {getFieldColor(
                        field.type
                      )}15; border: 1px solid {getFieldColor(field.type)}20"
                    >
                      {#if getFieldIcon(field.type)}
                        {@const FieldIcon = getFieldIcon(field.type)}
                        <FieldIcon class="w-3.5 h-3.5" style="color: {getFieldColor(field.type)}" />
                      {/if}
                    </div>

                    <!-- Label + Key -->
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-medium text-kitsuden-text truncate">
                        {field.label || tr("schemaBuilder.untitledField")}
                        {#if field.isRequired}<span class="text-kitsuden-accent-2 ml-1">*</span
                          >{/if}
                      </p>
                      <p class="text-[10px] font-mono text-kitsuden-subtle">
                        {field.key || tr("schemaBuilder.noKey")} · {field.type}
                      </p>
                    </div>

                    <!-- Badges -->
                    <div class="flex items-center gap-1.5 shrink-0">
                      {#if field.isUnique}<span class="badge-amber text-[8px] py-0"
                          >{tr("schemaBuilder.unq")}</span
                        >{/if}
                      {#if field.relation}
                        <span class="badge-pink text-[8px] py-0">
                          {field.relation.type === "many-to-many"
                            ? "M:N"
                            : field.relation.type === "one-to-many"
                              ? "1:N"
                              : "1:1"}
                        </span>
                      {/if}
                    </div>

                    <!-- Delete -->
                    <button
                      type="button"
                      onclick={(e) => {
                        e.stopPropagation();
                        removeField(idx);
                      }}
                      class="btn-icon p-1.5 opacity-0 group-hover:opacity-100 hover:!text-kitsuden-accent-2 transition-all"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Security -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "security"}
      <div class="flex-1 card overflow-y-auto">
        <div class="p-3 border-b border-kitsuden-border sticky top-0 bg-kitsuden-card z-10">
          <div class="flex items-center gap-2">
            <Shield class="w-4 h-4 text-kitsuden-amber" />
            <p class="label">{tr("schemaBuilder.accessControl")}</p>
          </div>
          <p class="text-[10px] text-kitsuden-subtle mt-0.5">
            {tr("schemaBuilder.configureWhoCanReadAnd")}
          </p>
        </div>

        {#if !localDef.policyJson}
          <div class="flex flex-col items-center justify-center py-8 px-4 text-kitsuden-subtle">
            <div class="flex items-start gap-4 w-full max-w-lg">
              <ShieldOff class="w-10 h-10 text-kitsuden-muted shrink-0 mt-1" />
              <div class="flex-1">
                <p class="text-sm font-medium text-kitsuden-text">
                  {tr("schemaBuilder.defaultAdminOnly")}
                </p>
                <p class="text-xs mt-1 text-kitsuden-subtle">
                  {tr("schemaBuilder.onlyAdminsCanReadAnd")}
                </p>
                <button onclick={enablePolicy} class="btn-primary mt-4">
                  <Shield class="w-4 h-4" />
                  {tr("schemaBuilder.enableCustomSecurity")}
                </button>
              </div>
            </div>
          </div>
        {:else}
          <div class="p-5 space-y-6">
            <!-- Read Access -->
            <div>
              <label class="label mb-2 block">{tr("schemaBuilder.whoCanRead")}</label>
              <div class="grid grid-cols-3 gap-2">
                {#each readAccessOptions as opt}
                  <button
                    onclick={() => (localDef.policyJson!.readAccess = opt.value)}
                    class="card-glow p-3 text-center transition-all {localDef.policyJson!
                      .readAccess === opt.value
                      ? 'border-kitsuden-accent-40 bg-kitsuden-accent-5 text-kitsuden-accent'
                      : 'text-kitsuden-text-dim hover:text-kitsuden-text'}"
                  >
                    <opt.icon class="w-5 h-5 mx-auto mb-1.5" />
                    <p class="text-xs font-semibold">{opt.label}</p>
                    <p class="text-[9px] text-kitsuden-subtle mt-0.5">{opt.desc}</p>
                  </button>
                {/each}
              </div>
            </div>

            <!-- Write Access -->
            <div>
              <label class="label mb-2 block">{tr("schemaBuilder.whoCanWrite")}</label>
              <div class="grid grid-cols-2 gap-2">
                {#each writeAccessOptions as opt}
                  <button
                    onclick={() => (localDef.policyJson!.writeAccess = opt.value)}
                    class="card-glow p-3 text-center transition-all {localDef.policyJson!
                      .writeAccess === opt.value
                      ? 'border-kitsuden-accent-2-40 bg-kitsuden-accent-2-5 text-kitsuden-accent-2'
                      : 'text-kitsuden-text-dim hover:text-kitsuden-text'}"
                  >
                    <opt.icon class="w-5 h-5 mx-auto mb-1.5" />
                    <p class="text-xs font-semibold">{opt.label}</p>
                    <p class="text-[9px] text-kitsuden-subtle mt-0.5">{opt.desc}</p>
                  </button>
                {/each}
              </div>
            </div>

            <!-- RLS Toggle -->
            <div class="pt-4 border-t border-kitsuden-border">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium text-kitsuden-text flex items-center gap-2">
                    <Lock class="w-3.5 h-3.5 text-kitsuden-amber" />
                    {tr("schemaBuilder.rowLevelSecurity")}
                  </p>
                  <p class="text-[10px] text-kitsuden-subtle mt-0.5">
                    {tr("schemaBuilder.filterRowsBasedOnUser")}
                  </p>
                </div>
                <button
                  onclick={() => (localDef.policyJson!.enableRLS = !localDef.policyJson!.enableRLS)}
                  class="relative w-10 h-6 rounded-full transition-colors {localDef.policyJson!
                    .enableRLS
                    ? 'bg-kitsuden-amber'
                    : 'bg-kitsuden-border'}"
                >
                  <span
                    class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {localDef
                      .policyJson!.enableRLS
                      ? 'translate-x-4.5'
                      : 'translate-x-0.5'}"
                  ></span>
                </button>
              </div>

              <!-- RLS Rules -->
              {#if localDef.policyJson!.enableRLS}
                <div class="mt-4 space-y-3">
                  {#each localDef.policyJson!.rlsRules || [] as rule, ri}
                    <div class="flex items-center gap-2">
                      <input
                        bind:value={rule.field}
                        type="text"
                        placeholder="field_key"
                        class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 flex-1 font-mono text-xs"
                      />
                      <select
                        bind:value={rule.operator}
                        class="px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 appearance-none w-24 text-xs"
                      >
                        <option value="eq">{tr("schemaBuilder.equals")}</option>
                        <option value="neq">{tr("schemaBuilder.notEqual")}</option>
                        <option value="contains">{tr("schemaBuilder.contains")}</option>
                        <option value="gt">{tr("schemaBuilder.greater")}</option>
                        <option value="lt">{tr("schemaBuilder.less")}</option>
                      </select>
                      <input
                        bind:value={rule.value}
                        type="text"
                        placeholder={tr("schemaBuilder.valueOrUserId")}
                        class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 flex-1 text-xs"
                      />
                      <button
                        onclick={() => localDef.policyJson!.rlsRules!.splice(ri, 1)}
                        class="btn-icon p-1.5 hover:!text-kitsuden-accent-2"
                      >
                        <X class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  {/each}
                  <button onclick={addRLSRule} class="btn-ghost btn-sm w-full justify-center">
                    <Plus class="w-3.5 h-3.5" />
                    {tr("schemaBuilder.addRule")}
                  </button>
                </div>
              {/if}
            </div>

            <!-- Remove policy -->
            <div class="pt-4 border-t border-kitsuden-border">
              <button
                onclick={() => (localDef.policyJson = null)}
                class="btn-ghost btn-sm text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/5"
              >
                <X class="w-3.5 h-3.5" />
                {tr("schemaBuilder.removeCustomSecurity")}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Workflow -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "workflow"}
      <div class="flex-1 card overflow-y-auto">
        <div class="p-3 border-b border-kitsuden-border sticky top-0 bg-kitsuden-card z-10">
          <div class="flex items-center gap-2">
            <GitPullRequest class="w-4 h-4 text-kitsuden-purple" />
            <p class="label">{tr("schemaBuilder.workflowApprovals")}</p>
          </div>
          <p class="text-[10px] text-kitsuden-subtle mt-0.5">
            {tr("schemaBuilder.requireReviewBeforeEntriesGo")}
          </p>
        </div>

        {#if !localDef.workflowJson || !localDef.workflowJson.requireApproval}
          <div class="flex flex-col items-center justify-center py-8 px-4 text-kitsuden-subtle">
            <div class="flex items-start gap-4 w-full max-w-lg">
              <Zap class="w-10 h-10 text-kitsuden-muted shrink-0 mt-1" />
              <div class="flex-1">
                <p class="text-sm font-medium text-kitsuden-text">
                  {tr("schemaBuilder.defaultInstantPublish")}
                </p>
                <p class="text-xs mt-1 text-kitsuden-subtle">
                  {tr("schemaBuilder.newEntriesArePublishedImmediately")}
                </p>
                <button onclick={enableWorkflow} class="btn-primary mt-4">
                  <GitPullRequest class="w-4 h-4" />
                  {tr("schemaBuilder.enableApprovalWorkflow")}
                </button>
              </div>
            </div>
          </div>
        {:else}
          <div class="p-5 space-y-6">
            <!-- Require Approval Toggle -->
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-kitsuden-text flex items-center gap-2">
                  <CheckCircle class="w-3.5 h-3.5 text-kitsuden-purple" />
                  {tr("schemaBuilder.requireApproval")}
                </p>
                <p class="text-[10px] text-kitsuden-subtle mt-0.5">
                  {tr("schemaBuilder.newEntriesStartAsDrafts")}
                </p>
              </div>
              <button
                onclick={() =>
                  (localDef.workflowJson!.requireApproval =
                    !localDef.workflowJson!.requireApproval)}
                class="relative w-10 h-6 rounded-full transition-colors {localDef.workflowJson!
                  .requireApproval
                  ? 'bg-kitsuden-purple'
                  : 'bg-kitsuden-border'}"
              >
                <span
                  class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {localDef
                    .workflowJson!.requireApproval
                    ? 'translate-x-4.5'
                    : 'translate-x-0.5'}"
                ></span>
              </button>
            </div>

            <!-- Approver IDs -->
            <div>
              <label class="label mb-2 block">{tr("schemaBuilder.approverUserIds")}</label>
              <p class="text-[10px] text-kitsuden-subtle mb-3">
                {tr("schemaBuilder.usersWhoCanReviewAnd")}
              </p>
              <div class="space-y-2">
                {#each localDef.workflowJson!.approverUserIds || [] as _, ai}
                  <div class="flex items-center gap-2">
                    <input
                      bind:value={localDef.workflowJson!.approverUserIds![ai]}
                      type="text"
                      placeholder={tr("common.userId")}
                      class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 flex-1 font-mono text-xs"
                    />
                    <button
                      onclick={() => localDef.workflowJson!.approverUserIds!.splice(ai, 1)}
                      class="btn-icon p-1.5 hover:!text-kitsuden-accent-2"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                {/each}
              </div>
              <button onclick={addApprover} class="btn-ghost btn-sm mt-2 w-full justify-center">
                <Plus class="w-3.5 h-3.5" />
                {tr("schemaBuilder.addApprover")}
              </button>
            </div>

            <!-- Remove workflow -->
            <div class="pt-4 border-t border-kitsuden-border">
              <button
                onclick={() => (localDef.workflowJson = null)}
                class="btn-ghost btn-sm text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/5"
              >
                <X class="w-3.5 h-3.5" />
                {tr("schemaBuilder.removeWorkflow")}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Bottom action bar -->
    <div class="mt-4 flex items-center justify-between">
      {#if validationErrors.length > 0}
        <p class="text-xs text-kitsuden-accent-2">{validationErrors[0]}</p>
      {:else}
        <div></div>
      {/if}
      <div class="flex items-center gap-3">
        <button onclick={onCancel} class="btn-ghost">{tr("common.cancel")}</button>
        <button onclick={save} disabled={!canSave} class="btn-primary">
          <Save class="w-4 h-4" />
          {localDef.id ? tr("schemaBuilder.updateSchema") : tr("common.createDataset")}
        </button>
      </div>
    </div>
  </div>

  <!-- ═══ RIGHT: Field Settings Panel ═══ -->
  {#if selectedField && activeTab === "fields"}
    <div transition:slide={{ duration: 200, axis: "x" }} class="w-80 shrink-0 card overflow-y-auto">
      <div class="p-4 border-b border-kitsuden-border sticky top-0 bg-kitsuden-card z-10">
        <div class="flex items-center justify-between">
          <p class="label">{tr("schemaBuilder.fieldSettings")}</p>
          <button onclick={() => (selectedFieldId = null)} class="btn-icon p-1">
            <X class="w-4 h-4" />
          </button>
        </div>
        <div class="flex items-center gap-2 mt-2">
          <div
            class="w-6 h-6 rounded flex items-center justify-center"
            style="background: {getFieldColor(selectedField.type)}15"
          >
            {#if getFieldIcon(selectedField.type)}
              {@const SFI = getFieldIcon(selectedField.type)}
              <SFI class="w-3 h-3" style="color: {getFieldColor(selectedField.type)}" />
            {/if}
          </div>
          <span class="text-xs font-medium text-kitsuden-text"
            >{getFieldTypeLabel(selectedField.type)}</span
          >
        </div>
      </div>

      <div class="p-4 space-y-5">
        <!-- Label -->
        <div>
          <label for="label" class="label mb-1.5 block">{tr("schemaBuilder.label")}</label>
          <input
            id="label"
            bind:value={selectedField.label}
            oninput={() => autoFieldKey(selectedField)}
            type="text"
            placeholder={tr("schemaBuilder.eGWeaponName")}
            class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>

        <!-- Key -->
        <div>
          <label for="key" class="label mb-1.5 block">{tr("schemaBuilder.machineKey")}</label>
          <input
            id="key"
            bind:value={selectedField.key}
            type="text"
            placeholder={tr("schemaBuilder.eGWeaponName2")}
            class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-xs"
          />
        </div>

        <!-- Help text -->
        <div>
          <label for="helptext" class="label mb-1.5 block">{tr("schemaBuilder.helpText")}</label>
          <input
            id="helptext"
            bind:value={selectedField.helpText}
            type="text"
            placeholder={tr("schemaBuilder.shownBelowTheField")}
            class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>

        <!-- ── Validation Rules ── -->
        <div class="pt-3 border-t border-kitsuden-border">
          <p class="label mb-3">{tr("schemaBuilder.validationRules")}</p>

          <!-- Required -->
          <div class="flex items-center justify-between py-2">
            <div>
              <p class="text-sm text-kitsuden-text">{tr("schemaBuilder.required")}</p>
              <p class="text-[10px] text-kitsuden-subtle">{tr("schemaBuilder.mustHaveAValue")}</p>
            </div>
            <button
              onclick={() => (selectedField.isRequired = !selectedField.isRequired)}
              class="relative w-10 h-6 rounded-full transition-colors {selectedField.isRequired
                ? 'bg-kitsuden-accent'
                : 'bg-kitsuden-border'}"
            >
              <span
                class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {selectedField.isRequired
                  ? 'translate-x-4.5'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>

          <!-- Unique -->
          <div class="flex items-center justify-between py-2">
            <div>
              <p class="text-sm text-kitsuden-text">{tr("schemaBuilder.unique")}</p>
              <p class="text-[10px] text-kitsuden-subtle">
                {tr("schemaBuilder.noDuplicateValues")}
              </p>
            </div>
            <button
              onclick={() => (selectedField.isUnique = !selectedField.isUnique)}
              class="relative w-10 h-6 rounded-full transition-colors {selectedField.isUnique
                ? 'bg-kitsuden-amber'
                : 'bg-kitsuden-border'}"
            >
              <span
                class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {selectedField.isUnique
                  ? 'translate-x-4.5'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>

          <!-- Default value -->
          <div class="pt-2">
            <label for="defaultvalue" class="label mb-1.5 block"
              >{tr("schemaBuilder.defaultValue")}</label
            >
            <input
              id="defaultvalue"
              bind:value={selectedField.defaultValue}
              type="text"
              placeholder={tr("schemaBuilder.eGUnknown")}
              class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          <!-- Regex (text, email, url) -->
          {#if ["text", "email", "url"].includes(selectedField.type)}
            <div class="pt-2">
              <label for="validationregex" class="label mb-1.5 block"
                >{tr("schemaBuilder.validationRegex")}</label
              >
              <input
                id="validationregex"
                bind:value={selectedField.validationRegex}
                type="text"
                placeholder={tr("schemaBuilder.eGAZaZ0")}
                class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 font-mono text-xs"
              />
            </div>
          {/if}

          <!-- Min/Max (number) -->
          {#if selectedField.type === "number"}
            <div class="pt-2 grid grid-cols-2 gap-3">
              <div>
                <label for="minvalue" class="label mb-1.5 block">{tr("schemaBuilder.min")}</label>
                <input
                  id="minvalue"
                  bind:value={selectedField.minValue}
                  type="number"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label for="maxvalue" class="label mb-1.5 block">{tr("schemaBuilder.max")}</label>
                <input
                  id="maxvalue"
                  bind:value={selectedField.maxValue}
                  type="number"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="100"
                />
              </div>
            </div>
          {/if}

          <!-- Min/Max length (text) -->
          {#if selectedField.type === "text"}
            <div class="pt-2 grid grid-cols-2 gap-3">
              <div>
                <label for="minlength" class="label mb-1.5 block"
                  >{tr("schemaBuilder.minLength")}</label
                >
                <input
                  id="minlength"
                  bind:value={selectedField.minLength}
                  type="number"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label for="maxlength" class="label mb-1.5 block"
                  >{tr("schemaBuilder.maxLength")}</label
                >
                <input
                  id="maxlength"
                  bind:value={selectedField.maxLength}
                  type="number"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="255"
                />
              </div>
            </div>
          {/if}
        </div>

        <!-- ── Select Options ── -->
        {#if selectedField.type === "select"}
          <div class="pt-3 border-t border-kitsuden-border">
            <p class="label mb-3">{tr("schemaBuilder.options")}</p>
            <div class="space-y-2">
              {#each selectedField.options || [] as opt, oi}
                <div class="flex items-center gap-2">
                  <input
                    bind:value={opt.label}
                    oninput={() =>
                      (opt.value = opt.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}
                    type="text"
                    placeholder={tr("schemaBuilder.option", { v: oi + 1 })}
                    class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 flex-1"
                  />
                  <button
                    onclick={() => selectedField.options!.splice(oi, 1)}
                    class="btn-icon p-1.5 hover:!text-kitsuden-accent-2"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              {/each}
            </div>
            <button onclick={addSelectOption} class="btn-ghost btn-sm mt-2 w-full justify-center">
              <Plus class="w-3.5 h-3.5" />
              {tr("schemaBuilder.addOption")}
            </button>
          </div>
        {/if}

        <!-- ── Relation Config ── -->
        {#if selectedField.type === "relation"}
          <div class="pt-3 border-t border-kitsuden-border">
            <p class="label mb-3">
              <GitBranch class="w-3 h-3 inline text-kitsuden-accent-2 mr-1" />
              {tr("schemaBuilder.relationship")}
            </p>

            <!-- Target collection -->
            <div class="mb-3">
              <label class="label mb-1.5 block">{tr("schemaBuilder.linkToCollection")}</label>
              {#if selectedField.relation}
                <select
                  bind:value={selectedField.relation.target}
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 appearance-none"
                >
                  <option value="">{tr("schemaBuilder.selectCollection")}</option>
                  <option value="games">{tr("schemaBuilder.games")}</option>
                  <option value="blog-posts">{tr("schemaBuilder.blogPosts")}</option>
                  <option value="platforms">{tr("schemaBuilder.platforms")}</option>
                  <option value="tags">{tr("schemaBuilder.tags")}</option>
                  <option value="streamers">{tr("schemaBuilder.streamers")}</option>
                  <optgroup label={tr("schemaBuilder.datasets")}>
                    {#each otherDatasets as ds}
                      <option value="dataset:{ds.id}">{ds.icon || "📦"} {ds.name}</option>
                    {/each}
                  </optgroup>
                </select>
              {/if}
            </div>

            <!-- Relationship type -->
            <div class="mb-3">
              <label class="label mb-1.5 block">{tr("schemaBuilder.cardinality")}</label>
              <div class="grid grid-cols-3 gap-2">
                {#each ["one-to-one", "one-to-many", "many-to-many"] as rt}
                  <button
                    onclick={() => setRelationType(rt as RelationType)}
                    class="card-glow p-3 text-center transition-all text-xs font-medium {selectedField
                      .relation?.type === rt
                      ? 'border-kitsuden-accent-2-40 bg-kitsuden-accent-2-5 text-kitsuden-accent-2'
                      : 'text-kitsuden-text-dim hover:text-kitsuden-text'}"
                  >
                    <p class="text-lg mb-1">
                      {rt === "one-to-one" ? "1↔1" : rt === "one-to-many" ? "1→N" : "M↔N"}
                    </p>
                    <p>
                      {rt === "one-to-one"
                        ? tr("schemaBuilder.hasOne")
                        : rt === "one-to-many"
                          ? tr("schemaBuilder.hasMany")
                          : tr("schemaBuilder.manyMany")}
                    </p>
                  </button>
                {/each}
              </div>
            </div>

            <!-- Display field -->
            <div>
              <label class="label mb-1.5 block">{tr("schemaBuilder.displayField")}</label>
              {#if selectedField.relation}
                <input
                  bind:value={selectedField.relation.displayField}
                  type="text"
                  placeholder={tr("schemaBuilder.eGTitleName")}
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <p class="text-[10px] text-kitsuden-subtle mt-1">
                  {tr("schemaBuilder.whichFieldToShowIn")}
                </p>
              {/if}
            </div>
          </div>
        {/if}

        <!-- ── Repeater: shape of each row ── -->
        {#if selectedField.type === "repeater"}
          <div class="pt-3 border-t border-kitsuden-border">
            <p class="label mb-1">
              <Rows3 class="w-3 h-3 inline text-kitsuden-accent-2 mr-1" />
              {tr("schemaBuilder.rowFields")}
            </p>
            <p class="text-[10px] text-kitsuden-subtle mb-3">
              {tr("schemaBuilder.eachEntryStoresAList")}
            </p>

            <div class="space-y-2">
              {#each selectedField.subFields || [] as sub, si (sub.id)}
                <div class="rounded-lg border border-kitsuden-border p-2.5 bg-slate-900/40">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="text-[10px] text-kitsuden-subtle font-mono w-4">{si + 1}</span>
                    <input
                      bind:value={sub.label}
                      oninput={() => autoSubKey(sub)}
                      type="text"
                      placeholder={tr("schemaBuilder.label2")}
                      class="flex-1 px-2 py-1.5 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    <button
                      onclick={() => moveSubField(si, -1)}
                      disabled={si === 0}
                      title={tr("schemaBuilder.moveUp")}
                      class="btn-icon p-1 disabled:opacity-30"
                    >
                      <GripVertical class="w-3 h-3" />
                    </button>
                    <button
                      onclick={() => removeSubField(si)}
                      title={tr("schemaBuilder.removeSubfield")}
                      class="btn-icon p-1 hover:!text-kitsuden-accent-2"
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </div>

                  <div class="grid grid-cols-2 gap-2">
                    <select
                      bind:value={sub.type}
                      class="px-2 py-1.5 bg-slate-800 border border-slate-700 text-gray-100 rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                    >
                      {#each SUBFIELD_TYPES as t}
                        <option value={t.type}>{t.label}</option>
                      {/each}
                    </select>
                    <input
                      bind:value={sub.key}
                      type="text"
                      placeholder="key"
                      class="px-2 py-1.5 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded font-mono text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                  </div>

                  <label class="flex items-center gap-2 mt-2 text-[11px] text-kitsuden-subtle">
                    <input type="checkbox" bind:checked={sub.isRequired} class="accent-teal-500" />
                    {tr("schemaBuilder.requiredInEveryRow")}
                  </label>

                  {#if sub.type === "select"}
                    <!-- A dropdown with no options cannot be filled in; it is
                         flagged here instead of letting it fail on save. -->
                    <p class="text-[10px] text-kitsuden-subtle mt-1.5">
                      {tr("schemaBuilder.optionsForSubfieldSelectsAre")}
                    </p>
                  {/if}
                </div>
              {/each}
            </div>

            {#if !selectedField.subFields?.length}
              <p class="text-[11px] text-kitsuden-subtle italic py-2">
                {tr("schemaBuilder.noRowFieldsYetRows")}
              </p>
            {/if}

            <button onclick={addSubField} class="btn-ghost btn-sm mt-2 w-full justify-center">
              <Plus class="w-3.5 h-3.5" />
              {tr("schemaBuilder.addRowField")}
            </button>

            <!-- minLength/maxLength of a repeater are rows, not characters. -->
            <div class="pt-3 grid grid-cols-2 gap-3">
              <div>
                <label for="minrows" class="label mb-1.5 block">{tr("schemaBuilder.minRows")}</label
                >
                <input
                  id="minrows"
                  bind:value={selectedField.minLength}
                  type="number"
                  min="0"
                  placeholder="0"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label for="maxrows" class="label mb-1.5 block">{tr("schemaBuilder.maxRows")}</label
                >
                <input
                  id="maxrows"
                  bind:value={selectedField.maxLength}
                  type="number"
                  min="0"
                  placeholder="∞"
                  class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>
          </div>
        {/if}

        <!-- ── Conditional visibility ── -->
        <div class="pt-3 border-t border-kitsuden-border">
          <div class="flex items-center justify-between">
            <div>
              <p class="label mb-0.5">
                <Eye class="w-3 h-3 inline text-kitsuden-accent mr-1" />
                {tr("schemaBuilder.conditional")}
              </p>
              <p class="text-[10px] text-kitsuden-subtle">
                {tr("schemaBuilder.showOnlyWhenAnotherField")}
              </p>
            </div>
            <button
              onclick={toggleCondition}
              disabled={conditionSources(selectedField).length === 0}
              class="relative w-10 h-6 rounded-full transition-colors disabled:opacity-30 {selectedField.showIf
                ? 'bg-kitsuden-accent'
                : 'bg-kitsuden-border'}"
            >
              <span
                class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {selectedField.showIf
                  ? 'translate-x-4.5'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>

          {#if conditionSources(selectedField).length === 0}
            <p class="text-[10px] text-kitsuden-subtle italic mt-2">
              {tr("schemaBuilder.needsAtLeastOneOther")}
            </p>
          {/if}

          {#if selectedField.showIf}
            <div class="mt-3 space-y-2">
              <select
                bind:value={selectedField.showIf.field}
                class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              >
                {#each conditionSources(selectedField) as f}
                  <option value={f.key}>{f.label || f.key}</option>
                {/each}
              </select>

              <div class="grid grid-cols-2 gap-2">
                <select
                  bind:value={selectedField.showIf.operator}
                  class="px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="eq">{tr("schemaBuilder.equals")}</option>
                  <option value="neq">{tr("schemaBuilder.notEquals")}</option>
                  <option value="contains">{tr("schemaBuilder.contains")}</option>
                  <option value="gt">{tr("schemaBuilder.greaterThan")}</option>
                  <option value="lt">{tr("schemaBuilder.lessThan")}</option>
                </select>
                <input
                  bind:value={selectedField.showIf.value}
                  type="text"
                  placeholder="value"
                  class="px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>

              {#if selectedField.isRequired}
                <!-- What people do not expect: a conditional required field is only
                     enforced when it is shown. Saying so here avoids the ticket. -->
                <p class="text-[10px] text-kitsuden-subtle">
                  {tr("schemaBuilder.requiredOnlyWhileThisCondition")}
                </p>
              {/if}
              {#if selectedField.showIf.operator === "gt" || selectedField.showIf.operator === "lt"}
                <p class="text-[10px] text-kitsuden-subtle">
                  {tr("schemaBuilder.comparedAsNumbersNonNumeric")}
                </p>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Grid settings -->
        <div class="pt-3 border-t border-kitsuden-border">
          <p class="label mb-3">{tr("schemaBuilder.display")}</p>
          <div class="flex items-center justify-between py-2">
            <div>
              <p class="text-sm text-kitsuden-text">{tr("schemaBuilder.hiddenInGrid")}</p>
              <p class="text-[10px] text-kitsuden-subtle">
                {tr("schemaBuilder.onlyVisibleInForm")}
              </p>
            </div>
            <button
              onclick={() => (selectedField.hidden = !selectedField.hidden)}
              class="relative w-10 h-6 rounded-full transition-colors {selectedField.hidden
                ? 'bg-kitsuden-subtle'
                : 'bg-kitsuden-border'}"
            >
              <span
                class="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {selectedField.hidden
                  ? 'translate-x-4.5'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>
          <div class="pt-2">
            <label for="width" class="label mb-1.5 block">{tr("schemaBuilder.columnWidthPx")}</label
            >
            <input
              id="width"
              bind:value={selectedField.width}
              type="number"
              placeholder={tr("schemaBuilder.auto")}
              class="w-full px-3 py-2 bg-slate-800 border border-slate-700 text-gray-100 placeholder-slate-400 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .bg-kitsuden-accent-10 {
    background-color: rgb(168 85 247 / 0.1);
  }
  .border-kitsuden-accent-20 {
    border-color: rgb(168 85 247 / 0.2);
  }
  .border-kitsuden-accent-40 {
    border-color: rgb(168 85 247 / 0.4);
  }
  .bg-kitsuden-accent-5 {
    background-color: rgb(168 85 247 / 0.05);
  }
  .bg-kitsuden-accent-2-5 {
    background-color: rgb(255 45 111 / 0.05);
  }
  .border-kitsuden-accent-2-40 {
    border-color: rgb(255 45 111 / 0.4);
  }
</style>
