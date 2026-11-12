<script lang="ts">
  import {
    Badge,
    Button,
    Card,
    CardContent,
    Checkbox,
    EmptyState,
    Field,
    Input,
    NumberInput,
    RadioGroup,
    Select,
    Switch,
    Tabs,
    ToggleGroup,
    type TabItem,
  } from "$lib/tallao";
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
    type RelationTarget,
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
  const tabItems: TabItem[] = tabs.map((x) => ({ id: x.id, label: x.label }));

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
    {
      value: "public" as const,
      label: tr("schemaBuilder.public"),
      desc: tr("schemaBuilder.everyone"),
      icon: Globe,
    },
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

<div class="sb" class:sb--palette={activeTab === "fields"}>
  <!-- ═══ LEFT: Field Type Palette ═══ -->
  {#if activeTab === "fields"}
    <Card class="sb-palette">
      <div class="sb-pane-head">
        <h2 class="sb-pane-title">{tr("schemaBuilder.fieldTypes")}</h2>
        <p class="sb-pane-note">{tr("schemaBuilder.dragOrClickToAdd")}</p>
      </div>
      <div class="sb-palette-list">
        {#each FIELD_TYPE_OPTIONS as ft}
          <!-- A whole tile that adds the type on click and can be dragged: no kit equivalent. -->
          <button
            type="button"
            onclick={() => addField(ft.type)}
            draggable="true"
            ondragstart={(e) => onDragStartPalette(e, ft.type)}
            class="sb-type"
          >
            <span class="sb-type-icon" style="background: {ft.color}12; border-color: {ft.color}25">
              {#if iconMap[ft.icon]}
                {@const IconComponent = iconMap[ft.icon]}
                <IconComponent size={16} style="color: {ft.color}" aria-hidden="true" />
              {/if}
            </span>
            <span class="sb-type-text">
              <span class="sb-type-label">{ft.label}</span>
              <span class="sb-type-desc">{ft.description}</span>
            </span>
          </button>
        {/each}
      </div>
    </Card>
  {/if}

  <!-- ═══ CENTER: Tabbed Content ═══ -->
  <div class="sb-main">
    <!-- Dataset header -->
    <Card>
      <CardContent class="sb-head">
        <div class="sb-grid-2">
          <Field label={tr("schemaBuilder.datasetName")}>
            <Input
              id="name"
              bind:value={localDef.name}
              oninput={autoSlug}
              placeholder={tr("schemaBuilder.eGProducts")}
            />
          </Field>
          <div class="sb-slug">
            <Field label={tr("common.slug")} class="sb-slug-field">
              <Input bind:value={localDef.slug} placeholder="products" class="font-mono" />
            </Field>
            <Field label={tr("schemaBuilder.icon")} class="sb-icon-field">
              <Select
                value={localDef.icon ?? ""}
                onchange={(e: Event) =>
                  (localDef.icon = (e.currentTarget as HTMLSelectElement).value)}
                options={(localDef.icon && !iconOptions.includes(localDef.icon)
                  ? [localDef.icon, ...iconOptions]
                  : iconOptions
                ).map((ic) => ({ value: ic, label: ic }))}
              />
            </Field>
          </div>
        </div>
        <Field label={tr("common.description")}>
          <Input
            id="description"
            bind:value={() => localDef.description ?? "", (v) => (localDef.description = v)}
            placeholder={tr("schemaBuilder.optionalDescriptionForThisData")}
          />
        </Field>
      </CardContent>
    </Card>

    <!-- ═══ Tab Navigation ═══ -->
    <Tabs
      items={tabItems}
      value={activeTab}
      onchange={(id) => (activeTab = id as TabId)}
      panels={false}
      ariaLabel={tr("schemaBuilder.sections")}
    >
      {#snippet tab(item)}
        {@const def = tabs.find((x) => x.id === item.id)}
        <span class="sb-tab">
          {#if def}<def.icon size={14} aria-hidden="true" />{/if}
          {item.label}
          {#if item.id === "security" && localDef.policyJson}
            <span class="sb-dot sb-dot--amber" aria-hidden="true"></span>
          {/if}
          {#if item.id === "workflow" && localDef.workflowJson?.requireApproval}
            <span class="sb-dot sb-dot--purple" aria-hidden="true"></span>
          {/if}
        </span>
      {/snippet}
    </Tabs>

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Fields -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "fields"}
      <Card class="sb-pane">
        <div
          class="sb-pane-scroll"
          role="group"
          aria-label={tr("schemaBuilder.schemaFields")}
          ondragover={(e) => {
            e.preventDefault();
            dragOverIndex = -1;
          }}
          ondrop={(e) => {
            e.preventDefault();
            onDropZone();
          }}
        >
          <div class="sb-pane-head sb-pane-head--row">
            <div class="sb-pane-title-row">
              <h2 class="sb-pane-title">{tr("schemaBuilder.schemaFields")}</h2>
              <Badge variant="info">{localDef.fields.length}</Badge>
            </div>
            {#if localDef.fields.length > 0}
              <Button variant="ghost" size="sm" onclick={collapseAll}
                >{tr("schemaBuilder.collapseAll")}</Button
              >
            {/if}
          </div>

          {#if localDef.fields.length === 0}
            <EmptyState
              size="sm"
              icon={layersIcon}
              title={tr("schemaBuilder.noFieldsYet")}
              description={tr("schemaBuilder.clickOrDragFieldTypes")}
            />
          {:else}
            <div class="sb-fields" role="list">
              {#each localDef.fields as field, idx}
                <div
                  role="listitem"
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
                  class="sb-field"
                  class:sb-field--over={dragOverIndex === idx}
                  class:sb-field--on={selectedFieldId === field.id}
                >
                  <!-- Field row: the whole row opens the field (a large target). -->
                  <div
                    role="button"
                    tabindex="0"
                    class="sb-field-row"
                    onclick={() => selectField(field.id)}
                    onkeydown={(e) => {
                      if (e.key === "Enter" || e.key === " ") selectField(field.id);
                    }}
                  >
                    <GripVertical size={16} class="sb-grip" aria-hidden="true" />

                    <span
                      class="sb-field-icon"
                      style="background: {getFieldColor(
                        field.type
                      )}15; border-color: {getFieldColor(field.type)}20"
                      aria-hidden="true"
                    >
                      {#if getFieldIcon(field.type)}
                        {@const FieldIcon = getFieldIcon(field.type)}
                        <FieldIcon size={14} style="color: {getFieldColor(field.type)}" />
                      {/if}
                    </span>

                    <span class="sb-field-text">
                      <span class="sb-field-label">
                        {field.label || tr("schemaBuilder.untitledField")}
                        {#if field.isRequired}<span class="sb-required" aria-hidden="true">*</span
                          >{/if}
                      </span>
                      <span class="sb-field-key">
                        {field.key || tr("schemaBuilder.noKey")} · {field.type}
                      </span>
                    </span>

                    {#if field.isUnique || field.relation}
                      <span class="sb-field-badges">
                        {#if field.isUnique}<Badge variant="warning"
                            >{tr("schemaBuilder.unq")}</Badge
                          >{/if}
                        {#if field.relation}
                          <Badge variant="accent-2">
                            {field.relation.type === "many-to-many"
                              ? "M:N"
                              : field.relation.type === "one-to-many"
                                ? "1:N"
                                : "1:1"}
                          </Badge>
                        {/if}
                      </span>
                    {/if}

                    <Button
                      variant="danger-ghost"
                      size="icon"
                      class="sb-field-remove"
                      ariaLabel={tr("schemaBuilder.removeField")}
                      title={tr("schemaBuilder.removeField")}
                      onclick={(e) => {
                        e.stopPropagation();
                        removeField(idx);
                      }}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </Card>
    {/if}

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Security -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "security"}
      <Card class="sb-pane">
        <div class="sb-pane-scroll">
          <div class="sb-pane-head">
            <div class="sb-pane-title-row">
              <Shield size={16} class="sb-amber" aria-hidden="true" />
              <h2 class="sb-pane-title">{tr("schemaBuilder.accessControl")}</h2>
            </div>
            <p class="sb-pane-note">{tr("schemaBuilder.configureWhoCanReadAnd")}</p>
          </div>

          {#if !localDef.policyJson}
            <EmptyState
              size="sm"
              icon={shieldOffIcon}
              title={tr("schemaBuilder.defaultAdminOnly")}
              description={tr("schemaBuilder.onlyAdminsCanReadAnd")}
            >
              {#snippet actions()}
                <Button onclick={enablePolicy}>
                  <Shield size={16} aria-hidden="true" />
                  {tr("schemaBuilder.enableCustomSecurity")}
                </Button>
              {/snippet}
            </EmptyState>
          {:else}
            <div class="sb-pane-body">
              <RadioGroup
                legend={tr("schemaBuilder.whoCanRead")}
                orientation="horizontal"
                value={localDef.policyJson!.readAccess}
                options={readAccessOptions.map((o) => ({
                  value: o.value,
                  label: o.label,
                  description: o.desc,
                }))}
                onchange={(v) =>
                  (localDef.policyJson!.readAccess =
                    v as (typeof readAccessOptions)[number]["value"])}
              />

              <RadioGroup
                legend={tr("schemaBuilder.whoCanWrite")}
                orientation="horizontal"
                value={localDef.policyJson!.writeAccess}
                options={writeAccessOptions.map((o) => ({
                  value: o.value,
                  label: o.label,
                  description: o.desc,
                }))}
                onchange={(v) =>
                  (localDef.policyJson!.writeAccess =
                    v as (typeof writeAccessOptions)[number]["value"])}
              />

              <!-- RLS Toggle -->
              <div class="sb-section">
                <div class="sb-switch-row">
                  <div>
                    <p class="sb-switch-title">
                      <Lock size={14} class="sb-amber" aria-hidden="true" />
                      {tr("schemaBuilder.rowLevelSecurity")}
                    </p>
                    <p class="sb-hint">{tr("schemaBuilder.filterRowsBasedOnUser")}</p>
                  </div>
                  <Switch
                    checked={!!localDef.policyJson!.enableRLS}
                    ariaLabel={tr("schemaBuilder.rowLevelSecurity")}
                    onchange={() =>
                      (localDef.policyJson!.enableRLS = !localDef.policyJson!.enableRLS)}
                  />
                </div>

                <!-- RLS Rules -->
                {#if localDef.policyJson!.enableRLS}
                  <div class="sb-rows">
                    {#each localDef.policyJson!.rlsRules || [] as rule, ri}
                      <div class="sb-rule">
                        <Input
                          bind:value={rule.field}
                          placeholder="field_key"
                          aria-label={tr("schemaBuilder.ruleField")}
                          class="font-mono sb-rule-field"
                        />
                        <Select
                          value={rule.operator}
                          aria-label={tr("schemaBuilder.operator")}
                          class="sb-rule-op"
                          onchange={(e: Event) =>
                            (rule.operator = (e.currentTarget as HTMLSelectElement)
                              .value as typeof rule.operator)}
                          options={[
                            { value: "eq", label: tr("schemaBuilder.equals") },
                            { value: "neq", label: tr("schemaBuilder.notEqual") },
                            { value: "contains", label: tr("schemaBuilder.contains") },
                            { value: "gt", label: tr("schemaBuilder.greater") },
                            { value: "lt", label: tr("schemaBuilder.less") },
                          ]}
                        />
                        <Input
                          bind:value={rule.value}
                          placeholder={tr("schemaBuilder.valueOrUserId")}
                          aria-label={tr("schemaBuilder.valueOrUserId")}
                          class="sb-rule-value"
                        />
                        <Button
                          variant="danger-ghost"
                          size="icon"
                          ariaLabel={tr("schemaBuilder.removeRule")}
                          onclick={() => localDef.policyJson!.rlsRules!.splice(ri, 1)}
                        >
                          <X size={14} aria-hidden="true" />
                        </Button>
                      </div>
                    {/each}
                    <Button variant="secondary" size="sm" class="sb-add" onclick={addRLSRule}>
                      <Plus size={14} aria-hidden="true" />
                      {tr("schemaBuilder.addRule")}
                    </Button>
                  </div>
                {/if}
              </div>

              <!-- Remove policy -->
              <div class="sb-section">
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onclick={() => (localDef.policyJson = null)}
                >
                  <X size={14} aria-hidden="true" />
                  {tr("schemaBuilder.removeCustomSecurity")}
                </Button>
              </div>
            </div>
          {/if}
        </div>
      </Card>
    {/if}

    <!-- ════════════════════════════════════════ -->
    <!-- TAB: Workflow -->
    <!-- ════════════════════════════════════════ -->
    {#if activeTab === "workflow"}
      <Card class="sb-pane">
        <div class="sb-pane-scroll">
          <div class="sb-pane-head">
            <div class="sb-pane-title-row">
              <GitPullRequest size={16} class="sb-purple" aria-hidden="true" />
              <h2 class="sb-pane-title">{tr("schemaBuilder.workflowApprovals")}</h2>
            </div>
            <p class="sb-pane-note">{tr("schemaBuilder.requireReviewBeforeEntriesGo")}</p>
          </div>

          {#if !localDef.workflowJson || !localDef.workflowJson.requireApproval}
            <EmptyState
              size="sm"
              icon={zapIcon}
              title={tr("schemaBuilder.defaultInstantPublish")}
              description={tr("schemaBuilder.newEntriesArePublishedImmediately")}
            >
              {#snippet actions()}
                <Button onclick={enableWorkflow}>
                  <GitPullRequest size={16} aria-hidden="true" />
                  {tr("schemaBuilder.enableApprovalWorkflow")}
                </Button>
              {/snippet}
            </EmptyState>
          {:else}
            <div class="sb-pane-body">
              <!-- Require Approval Toggle -->
              <div class="sb-switch-row">
                <div>
                  <p class="sb-switch-title">
                    <CheckCircle size={14} class="sb-purple" aria-hidden="true" />
                    {tr("schemaBuilder.requireApproval")}
                  </p>
                  <p class="sb-hint">{tr("schemaBuilder.newEntriesStartAsDrafts")}</p>
                </div>
                <Switch
                  checked={!!localDef.workflowJson!.requireApproval}
                  ariaLabel={tr("schemaBuilder.requireApproval")}
                  onchange={() =>
                    (localDef.workflowJson!.requireApproval =
                      !localDef.workflowJson!.requireApproval)}
                />
              </div>

              <!-- Approver IDs -->
              <div>
                <h3 class="sb-sub-title">{tr("schemaBuilder.approverUserIds")}</h3>
                <p class="sb-hint">{tr("schemaBuilder.usersWhoCanReviewAnd")}</p>
                <div class="sb-rows">
                  {#each localDef.workflowJson!.approverUserIds || [] as _, ai}
                    <div class="sb-inline">
                      <Input
                        bind:value={localDef.workflowJson!.approverUserIds![ai]}
                        placeholder={tr("common.userId")}
                        aria-label={tr("common.userId")}
                        class="font-mono"
                      />
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        ariaLabel={tr("schemaBuilder.removeApprover")}
                        onclick={() => localDef.workflowJson!.approverUserIds!.splice(ai, 1)}
                      >
                        <X size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  {/each}
                  <Button variant="secondary" size="sm" class="sb-add" onclick={addApprover}>
                    <Plus size={14} aria-hidden="true" />
                    {tr("schemaBuilder.addApprover")}
                  </Button>
                </div>
              </div>

              <!-- Remove workflow -->
              <div class="sb-section">
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onclick={() => (localDef.workflowJson = null)}
                >
                  <X size={14} aria-hidden="true" />
                  {tr("schemaBuilder.removeWorkflow")}
                </Button>
              </div>
            </div>
          {/if}
        </div>
      </Card>
    {/if}

    <!-- Bottom action bar -->
    <div class="sb-actions">
      {#if validationErrors.length > 0}
        <p class="sb-error" role="alert">{validationErrors[0]}</p>
      {:else}
        <div></div>
      {/if}
      <div class="sb-actions-buttons">
        <Button variant="ghost" onclick={onCancel}>{tr("common.cancel")}</Button>
        <Button onclick={save} disabled={!canSave}>
          <Save size={16} aria-hidden="true" />
          {localDef.id ? tr("schemaBuilder.updateSchema") : tr("common.create")}
        </Button>
      </div>
    </div>
  </div>

  <!-- ═══ RIGHT: Field Settings Panel ═══ -->
  {#if selectedField && activeTab === "fields"}
    <div transition:slide={{ duration: 200, axis: "x" }} class="sb-panel-wrap">
      <Card class="sb-panel">
        <div class="sb-pane-head">
          <div class="sb-pane-head--row">
            <h2 class="sb-pane-title">{tr("schemaBuilder.fieldSettings")}</h2>
            <Button
              variant="ghost"
              size="icon"
              ariaLabel={tr("schemaBuilder.closeFieldSettings")}
              onclick={() => (selectedFieldId = null)}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
          <div class="sb-pane-title-row">
            <span
              class="sb-field-icon sb-field-icon--sm"
              style="background: {getFieldColor(selectedField.type)}15"
              aria-hidden="true"
            >
              {#if getFieldIcon(selectedField.type)}
                {@const SFI = getFieldIcon(selectedField.type)}
                <SFI size={12} style="color: {getFieldColor(selectedField.type)}" />
              {/if}
            </span>
            <span class="sb-type-label">{getFieldTypeLabel(selectedField.type)}</span>
          </div>
        </div>

        <div class="sb-panel-body">
          <Field label={tr("schemaBuilder.label")}>
            <Input
              id="label"
              bind:value={selectedField.label}
              oninput={() => autoFieldKey(selectedField)}
              placeholder={tr("schemaBuilder.eGWeaponName")}
            />
          </Field>

          <Field label={tr("schemaBuilder.machineKey")}>
            <Input
              id="key"
              bind:value={selectedField.key}
              placeholder={tr("schemaBuilder.eGWeaponName2")}
              class="font-mono"
            />
          </Field>

          <Field label={tr("schemaBuilder.helpText")}>
            <Input
              id="helptext"
              bind:value={() => selectedField.helpText ?? "", (v) => (selectedField.helpText = v)}
              placeholder={tr("schemaBuilder.shownBelowTheField")}
            />
          </Field>

          <!-- ── Validation Rules ── -->
          <div class="sb-section">
            <h3 class="sb-sub-title">{tr("schemaBuilder.validationRules")}</h3>

            <div class="sb-switch-row">
              <div>
                <p class="sb-switch-title">{tr("schemaBuilder.required")}</p>
                <p class="sb-hint">{tr("schemaBuilder.mustHaveAValue")}</p>
              </div>
              <Switch
                checked={!!selectedField.isRequired}
                ariaLabel={tr("schemaBuilder.required")}
                onchange={() => (selectedField.isRequired = !selectedField.isRequired)}
              />
            </div>

            <div class="sb-switch-row">
              <div>
                <p class="sb-switch-title">{tr("schemaBuilder.unique")}</p>
                <p class="sb-hint">{tr("schemaBuilder.noDuplicateValues")}</p>
              </div>
              <Switch
                checked={!!selectedField.isUnique}
                ariaLabel={tr("schemaBuilder.unique")}
                onchange={() => (selectedField.isUnique = !selectedField.isUnique)}
              />
            </div>

            <Field label={tr("schemaBuilder.defaultValue")}>
              <Input
                id="defaultvalue"
                bind:value={
                  () => selectedField.defaultValue ?? "", (v) => (selectedField.defaultValue = v)
                }
                placeholder={tr("schemaBuilder.eGUnknown")}
              />
            </Field>

            {#if ["text", "email", "url"].includes(selectedField.type)}
              <Field label={tr("schemaBuilder.validationRegex")}>
                <Input
                  id="validationregex"
                  bind:value={
                    () => selectedField.validationRegex ?? "",
                    (v) => (selectedField.validationRegex = v)
                  }
                  placeholder={tr("schemaBuilder.eGAZaZ0")}
                  class="font-mono"
                />
              </Field>
            {/if}

            {#if selectedField.type === "number"}
              <div class="sb-grid-2 sb-grid-2--always">
                <Field label={tr("schemaBuilder.min")}>
                  <NumberInput
                    id="minvalue"
                    value={selectedField.minValue ?? null}
                    clamp={false}
                    placeholder="0"
                    onchange={(v) => (selectedField.minValue = v ?? undefined)}
                  />
                </Field>
                <Field label={tr("schemaBuilder.max")}>
                  <NumberInput
                    id="maxvalue"
                    value={selectedField.maxValue ?? null}
                    clamp={false}
                    placeholder="100"
                    onchange={(v) => (selectedField.maxValue = v ?? undefined)}
                  />
                </Field>
              </div>
            {/if}

            {#if selectedField.type === "text"}
              <div class="sb-grid-2 sb-grid-2--always">
                <Field label={tr("schemaBuilder.minLength")}>
                  <NumberInput
                    id="minlength"
                    value={selectedField.minLength ?? null}
                    clamp={false}
                    placeholder="0"
                    onchange={(v) => (selectedField.minLength = v ?? undefined)}
                  />
                </Field>
                <Field label={tr("schemaBuilder.maxLength")}>
                  <NumberInput
                    id="maxlength"
                    value={selectedField.maxLength ?? null}
                    clamp={false}
                    placeholder="255"
                    onchange={(v) => (selectedField.maxLength = v ?? undefined)}
                  />
                </Field>
              </div>
            {/if}
          </div>

          <!-- ── Select Options ── -->
          {#if selectedField.type === "select"}
            <div class="sb-section">
              <h3 class="sb-sub-title">{tr("schemaBuilder.options")}</h3>
              <div class="sb-rows">
                {#each selectedField.options || [] as opt, oi}
                  <div class="sb-inline">
                    <Input
                      bind:value={opt.label}
                      oninput={() =>
                        (opt.value = opt.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"))}
                      placeholder={tr("schemaBuilder.option", { v: oi + 1 })}
                      aria-label={tr("schemaBuilder.option", { v: oi + 1 })}
                    />
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      ariaLabel={tr("schemaBuilder.removeOption")}
                      onclick={() => selectedField.options!.splice(oi, 1)}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </div>
                {/each}
                <Button variant="secondary" size="sm" class="sb-add" onclick={addSelectOption}>
                  <Plus size={14} aria-hidden="true" />
                  {tr("schemaBuilder.addOption")}
                </Button>
              </div>
            </div>
          {/if}

          <!-- ── Relation Config ── -->
          {#if selectedField.type === "relation"}
            <div class="sb-section">
              <h3 class="sb-sub-title">
                <GitBranch size={12} class="sb-pink" aria-hidden="true" />
                {tr("schemaBuilder.relationship")}
              </h3>

              {#if selectedField.relation}
                <Field label={tr("schemaBuilder.linkToCollection")}>
                  <Select
                    value={selectedField.relation.target}
                    onchange={(e: Event) =>
                      (selectedField.relation!.target = (e.currentTarget as HTMLSelectElement)
                        .value as RelationTarget)}
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
                  </Select>
                </Field>
              {/if}

              <ToggleGroup
                label={tr("schemaBuilder.cardinality")}
                hideLabel={false}
                required
                value={selectedField.relation?.type ?? ""}
                onchange={(v) => setRelationType(v as RelationType)}
                options={[
                  { value: "one-to-one", label: `1↔1 · ${tr("schemaBuilder.hasOne")}` },
                  { value: "one-to-many", label: `1→N · ${tr("schemaBuilder.hasMany")}` },
                  { value: "many-to-many", label: `M↔N · ${tr("schemaBuilder.manyMany")}` },
                ]}
                class="sb-cardinality"
              />

              {#if selectedField.relation}
                <Field label={tr("schemaBuilder.displayField")}>
                  <Input
                    bind:value={
                      () => selectedField.relation?.displayField ?? "",
                      (v) => (selectedField.relation!.displayField = v)
                    }
                    placeholder={tr("schemaBuilder.eGTitleName")}
                  />
                </Field>
                <p class="sb-hint">{tr("schemaBuilder.whichFieldToShowIn")}</p>
              {/if}
            </div>
          {/if}

          <!-- ── Repeater: shape of each row ── -->
          {#if selectedField.type === "repeater"}
            <div class="sb-section">
              <h3 class="sb-sub-title">
                <Rows3 size={12} class="sb-pink" aria-hidden="true" />
                {tr("schemaBuilder.rowFields")}
              </h3>
              <p class="sb-hint">{tr("schemaBuilder.eachEntryStoresAList")}</p>

              <div class="sb-rows">
                {#each selectedField.subFields || [] as sub, si (sub.id)}
                  <div class="sb-sub">
                    <div class="sb-inline">
                      <span class="sb-sub-n" aria-hidden="true">{si + 1}</span>
                      <Input
                        bind:value={sub.label}
                        oninput={() => autoSubKey(sub)}
                        placeholder={tr("schemaBuilder.label2")}
                        aria-label={tr("schemaBuilder.label2")}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={si === 0}
                        ariaLabel={tr("schemaBuilder.moveUp")}
                        title={tr("schemaBuilder.moveUp")}
                        onclick={() => moveSubField(si, -1)}
                      >
                        <GripVertical size={14} aria-hidden="true" />
                      </Button>
                      <Button
                        variant="danger-ghost"
                        size="icon"
                        ariaLabel={tr("schemaBuilder.removeSubfield")}
                        title={tr("schemaBuilder.removeSubfield")}
                        onclick={() => removeSubField(si)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </div>

                    <div class="sb-grid-2 sb-grid-2--always">
                      <Select
                        size="sm"
                        value={sub.type}
                        aria-label={tr("schemaBuilder.subfieldType")}
                        onchange={(e: Event) =>
                          (sub.type = (e.currentTarget as HTMLSelectElement).value as FieldType)}
                        options={SUBFIELD_TYPES.map((st) => ({ value: st.type, label: st.label }))}
                      />
                      <Input
                        bind:value={sub.key}
                        placeholder="key"
                        aria-label={tr("schemaBuilder.machineKey")}
                        class="font-mono"
                      />
                    </div>

                    <Checkbox
                      bind:checked={() => !!sub.isRequired, (v) => (sub.isRequired = v)}
                      label={tr("schemaBuilder.requiredInEveryRow")}
                    />

                    {#if sub.type === "select"}
                      <!-- A dropdown with no options cannot be filled in; it is
                           flagged here instead of letting it fail on save. -->
                      <p class="sb-hint">{tr("schemaBuilder.optionsForSubfieldSelectsAre")}</p>
                    {/if}
                  </div>
                {/each}
              </div>

              {#if !selectedField.subFields?.length}
                <p class="sb-hint sb-hint--empty">{tr("schemaBuilder.noRowFieldsYetRows")}</p>
              {/if}

              <Button variant="secondary" size="sm" class="sb-add" onclick={addSubField}>
                <Plus size={14} aria-hidden="true" />
                {tr("schemaBuilder.addRowField")}
              </Button>

              <!-- minLength/maxLength of a repeater are rows, not characters. -->
              <div class="sb-grid-2 sb-grid-2--always">
                <Field label={tr("schemaBuilder.minRows")}>
                  <NumberInput
                    id="minrows"
                    min={0}
                    value={selectedField.minLength ?? null}
                    clamp={false}
                    placeholder="0"
                    onchange={(v) => (selectedField.minLength = v ?? undefined)}
                  />
                </Field>
                <Field label={tr("schemaBuilder.maxRows")}>
                  <NumberInput
                    id="maxrows"
                    min={0}
                    value={selectedField.maxLength ?? null}
                    clamp={false}
                    placeholder="∞"
                    onchange={(v) => (selectedField.maxLength = v ?? undefined)}
                  />
                </Field>
              </div>
            </div>
          {/if}

          <!-- ── Conditional visibility ── -->
          <div class="sb-section">
            <div class="sb-switch-row">
              <div>
                <p class="sb-sub-title">
                  <Eye size={12} class="sb-accent" aria-hidden="true" />
                  {tr("schemaBuilder.conditional")}
                </p>
                <p class="sb-hint">{tr("schemaBuilder.showOnlyWhenAnotherField")}</p>
              </div>
              <Switch
                checked={!!selectedField.showIf}
                ariaLabel={tr("schemaBuilder.conditional")}
                disabled={conditionSources(selectedField).length === 0}
                onchange={toggleCondition}
              />
            </div>

            {#if conditionSources(selectedField).length === 0}
              <p class="sb-hint sb-hint--empty">{tr("schemaBuilder.needsAtLeastOneOther")}</p>
            {/if}

            {#if selectedField.showIf}
              <div class="sb-rows">
                <Select
                  value={selectedField.showIf.field}
                  aria-label={tr("schemaBuilder.conditionSource")}
                  onchange={(e: Event) =>
                    (selectedField.showIf!.field = (e.currentTarget as HTMLSelectElement).value)}
                  options={conditionSources(selectedField).map((f) => ({
                    value: f.key,
                    label: f.label || f.key,
                  }))}
                />

                <div class="sb-grid-2 sb-grid-2--always">
                  <Select
                    value={selectedField.showIf.operator}
                    aria-label={tr("schemaBuilder.operator")}
                    onchange={(e: Event) =>
                      (selectedField.showIf!.operator = (e.currentTarget as HTMLSelectElement)
                        .value as "eq" | "neq" | "contains" | "gt" | "lt")}
                    options={[
                      { value: "eq", label: tr("schemaBuilder.equals") },
                      { value: "neq", label: tr("schemaBuilder.notEquals") },
                      { value: "contains", label: tr("schemaBuilder.contains") },
                      { value: "gt", label: tr("schemaBuilder.greaterThan") },
                      { value: "lt", label: tr("schemaBuilder.lessThan") },
                    ]}
                  />
                  <Input
                    bind:value={selectedField.showIf.value}
                    placeholder="value"
                    aria-label={tr("schemaBuilder.conditionValue")}
                  />
                </div>

                {#if selectedField.isRequired}
                  <!-- What people do not expect: a conditional required field is only
                       enforced when it is shown. Saying so here avoids the ticket. -->
                  <p class="sb-hint">{tr("schemaBuilder.requiredOnlyWhileThisCondition")}</p>
                {/if}
                {#if selectedField.showIf.operator === "gt" || selectedField.showIf.operator === "lt"}
                  <p class="sb-hint">{tr("schemaBuilder.comparedAsNumbersNonNumeric")}</p>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Grid settings -->
          <div class="sb-section">
            <h3 class="sb-sub-title">{tr("schemaBuilder.display")}</h3>
            <div class="sb-switch-row">
              <div>
                <p class="sb-switch-title">{tr("schemaBuilder.hiddenInGrid")}</p>
                <p class="sb-hint">{tr("schemaBuilder.onlyVisibleInForm")}</p>
              </div>
              <Switch
                checked={!!selectedField.hidden}
                ariaLabel={tr("schemaBuilder.hiddenInGrid")}
                onchange={() => (selectedField.hidden = !selectedField.hidden)}
              />
            </div>
            <Field label={tr("schemaBuilder.columnWidthPx")}>
              <NumberInput
                id="width"
                value={selectedField.width ?? null}
                clamp={false}
                placeholder={tr("schemaBuilder.auto")}
                onchange={(v) => (selectedField.width = v ?? undefined)}
              />
            </Field>
          </div>
        </div>
      </Card>
    </div>
  {/if}
</div>

{#snippet layersIcon()}<Layers size={32} aria-hidden="true" />{/snippet}
{#snippet shieldOffIcon()}<ShieldOff size={32} aria-hidden="true" />{/snippet}
{#snippet zapIcon()}<Zap size={32} aria-hidden="true" />{/snippet}

<style>
  /* Three columns on a wide screen (types · fields · the field's settings), one column
     on a phone: nothing may push the page sideways at 390px. */
  .sb {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .sb-main {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
    flex: 1;
  }
  :global(.sb-palette),
  :global(.sb-pane),
  :global(.sb-panel) {
    min-width: 0;
    overflow: hidden;
  }
  .sb-pane-scroll {
    height: 100%;
    overflow-y: auto;
  }
  .sb-pane-head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid rgb(var(--ta-border));
    background: rgb(var(--ta-surface));
  }
  .sb-pane-head--row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .sb-pane-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .sb-pane-title {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .sb-pane-note,
  .sb-hint {
    margin: 0.125rem 0 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  .sb-hint--empty {
    font-style: italic;
  }
  .sb-pane-body,
  .sb-panel-body {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1rem 1.25rem 1.25rem;
  }
  .sb-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--ta-border));
  }
  .sb-sub-title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .sb-switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .sb-switch-title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: 0.875rem;
    font-weight: 500;
  }
  :global(.sb-head) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sb-grid-2 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.75rem 1rem;
  }
  .sb-grid-2--always {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }
  .sb-slug {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    min-width: 0;
  }
  :global(.sb-slug-field) {
    flex: 1;
    min-width: 0;
  }
  :global(.sb-icon-field) {
    flex: 0 0 7rem;
    min-width: 0;
  }
  .sb-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sb-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
  }
  .sb-dot--amber {
    background: rgb(var(--ta-warning));
  }
  .sb-dot--purple {
    background: rgb(var(--ta-accent));
  }
  :global(.sb-amber) {
    color: rgb(var(--ta-warning));
  }
  :global(.sb-purple),
  :global(.sb-accent) {
    color: rgb(var(--ta-accent));
  }
  :global(.sb-pink) {
    color: rgb(var(--ta-accent-2));
  }

  /* Palette */
  .sb-palette-list {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem;
    overflow-x: auto;
  }
  .sb-type {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 0 0 13rem;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 0;
    border-radius: var(--ta-radius-lg);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: grab;
  }
  .sb-type:hover {
    background: rgb(var(--ta-border) / 0.3);
  }
  .sb-type:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: -2px;
  }
  .sb-type:active {
    cursor: grabbing;
  }
  .sb-type-icon,
  .sb-field-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border: 1px solid transparent;
    border-radius: var(--ta-radius-md, 0.5rem);
  }
  .sb-field-icon {
    width: 1.75rem;
    height: 1.75rem;
  }
  .sb-field-icon--sm {
    width: 1.5rem;
    height: 1.5rem;
  }
  .sb-type-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sb-type-label {
    font-size: 0.875rem;
    font-weight: 500;
  }
  .sb-type-desc {
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Field list */
  .sb-fields > * + * {
    border-top: 1px solid rgb(var(--ta-border) / 0.5);
  }
  .sb-field:hover {
    background: rgb(var(--ta-border) / 0.2);
  }
  .sb-field--on,
  .sb-field--on:hover {
    background: rgb(var(--ta-accent) / 0.06);
  }
  .sb-field--over {
    box-shadow: inset 0 0 0 2px rgb(var(--ta-accent) / 0.3);
  }
  .sb-field-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 3.25rem;
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    cursor: pointer;
  }
  .sb-field-row:focus-visible {
    outline: 2px solid rgb(var(--ta-accent));
    outline-offset: -2px;
  }
  :global(.sb-grip) {
    flex-shrink: 0;
    color: rgb(var(--ta-text-dim));
    opacity: 0.6;
    cursor: grab;
  }
  .sb-field-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .sb-field-label {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-required {
    margin-left: 0.25rem;
    color: rgb(var(--ta-accent-2));
  }
  .sb-field-key {
    font-family: var(--ta-font-mono, monospace);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sb-field-badges {
    display: flex;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  /* Rows of inputs (rules, approvers, options, subfields) */
  .sb-rows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sb-inline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .sb-inline > :global(*:not(button)) {
    flex: 1;
    min-width: 0;
  }
  .sb-rule {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
  }
  .sb-rule > :global(:first-child) {
    grid-column: 1 / -1;
  }
  :global(.sb-add) {
    align-self: flex-start;
  }
  .sb-sub {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem;
    border: 1px solid rgb(var(--ta-border));
    border-radius: var(--ta-radius-lg);
  }
  .sb-sub-n {
    flex: 0 0 1rem !important;
    font-family: var(--ta-font-mono, monospace);
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
  }
  :global(.sb-cardinality) {
    flex-wrap: wrap;
  }

  .sb-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .sb-actions-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-left: auto;
  }
  .sb-error {
    margin: 0;
    font-size: 0.75rem;
    color: rgb(var(--ta-danger, var(--ta-accent-2)));
  }

  @media (min-width: 640px) {
    .sb-grid-2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .sb-rule {
      grid-template-columns: minmax(0, 1fr) 8rem minmax(0, 1fr) auto;
    }
    .sb-rule > :global(:first-child) {
      grid-column: auto;
    }
  }

  /* Phone: every control reaches a 44px touch target. */
  @media (max-width: 767px) {
    .sb :global(.ta-btn--icon) {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }
    .sb :global(.ta-btn),
    .sb :global(.ta-input),
    .sb :global(.ta-select),
    .sb :global(.ta-tab) {
      min-height: 2.75rem;
    }
  }

  /* Wide screen: the three columns, each scrolling on its own. */
  @media (min-width: 1024px) {
    .sb {
      flex-direction: row;
      height: calc(100vh - 9rem);
    }
    :global(.sb-palette) {
      flex: 0 0 14rem;
      overflow-y: auto;
    }
    .sb-palette-list {
      flex-direction: column;
      overflow-x: visible;
    }
    .sb-type {
      flex: none;
      width: 100%;
    }
    :global(.sb-pane) {
      flex: 1;
      min-height: 0;
    }
    .sb-panel-wrap {
      flex: 0 0 20rem;
      min-height: 0;
      display: flex;
    }
    :global(.sb-panel) {
      flex: 1;
      overflow-y: auto;
    }
  }
</style>
