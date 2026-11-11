<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import { t } from "$lib/i18n";
  import { memorySource, type Row } from "$lib/list/source";
  import {
    Badge,
    Button,
    Dialog,
    Field,
    Input,
    MenuItem,
    Select,
    Textarea,
    toast,
  } from "$lib/tallao";
  /**
   * ActionsView.svelte — Unified UI for Workers + Webhooks, on the list template
   *
   * Uses the new unified /api/actions API.
   * Falls back to legacy APIs if the new API is not available.
   */
  import { Code, Webhook } from "lucide-svelte";
  import { onMount, untrack } from "svelte";

  const API = import.meta.env.VITE_API_URL ?? "";

  // ═══════════════════════════════════════════════════════════════════════════
  // Types
  // ═══════════════════════════════════════════════════════════════════════════

  type ActionType = "code" | "webhook_out" | "webhook_in" | "agent";
  type ActionTrigger = "manual" | "cron" | "event" | "http";
  type ActionStatus = "active" | "paused" | "error";

  interface Action {
    id: string;
    type: ActionType;
    name: string;
    slug: string;
    description?: string;
    trigger: ActionTrigger;
    status: ActionStatus;
    triggerConfig?: {
      cronExpression?: string;
      eventName?: string;
      datasetId?: string;
      httpMethod?: string;
      httpPath?: string;
    };
    config?: {
      code?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    lastExecutedAt?: string;
    executionCount: number;
    errorCount: number;
    createdAt: string;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════

  let actions = $state<Action[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let createType = $state<"code" | "webhook_out">("code");
  let useNewApi = $state(true); // Will fall back to legacy if new API fails

  // Form states
  let saving = $state(false);
  let formName = $state("");
  let formDescription = $state("");
  let formTrigger = $state<ActionTrigger>("cron");
  let formCronExpression = $state("0 * * * *");
  let formEventName = $state("entry.created");
  let formCode = $state(
    "export default async function(context) {\n  console.log('Action running');\n  // context.action, context.event, context.env\n}"
  );
  let formUrl = $state("");
  let formHeaders = $state("{}");

  // ═══════════════════════════════════════════════════════════════════════════
  // Computed
  // ═══════════════════════════════════════════════════════════════════════════

  const stats = $derived({
    total: actions.length,
    code: actions.filter((a) => a.type === "code").length,
    webhooks: actions.filter((a) => a.type === "webhook_out").length,
    active: actions.filter((a) => a.status === "active").length,
    paused: actions.filter((a) => a.status === "paused").length,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Data Loading
  // ═══════════════════════════════════════════════════════════════════════════

  onMount(async () => {
    await loadActions();
  });

  // The list template reads `actions`: tell it when they changed.
  $effect(() => {
    void actions;
    if (!loading) {
      // `untrack`: the counter is written here; reading it back must not re-run the effect.
      untrack(() => {
        loaded = true;
        reloadKey += 1;
      });
    }
  });

  /** Neither the actions API nor the legacy one answered: shown instead of "no actions". */
  let loadError = $state<string | null>(null);

  async function loadActions() {
    loading = true;
    loadError = null;
    try {
      // Try new API first
      const res = await fetch(`${API}/api/actions`, { credentials: "include" });

      if (res.ok) {
        const data = await res.json();
        actions = data.docs || [];
        useNewApi = true;
      } else if (res.status === 404) {
        // New API not available, fall back to legacy
        console.log("[Actions] New API not available, falling back to legacy");
        useNewApi = false;
        await loadLegacyActions();
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("Failed to load actions:", err);
      // The API exists and failed (a 404 already went to the legacy routes above): say so.
      // Falling back here answered an empty legacy list, and a 500 read as "no actions".
      loadError = err instanceof Error ? err.message : String(err);
      actions = [];
    } finally {
      loading = false;
    }
  }

  // Fallback to legacy APIs
  async function loadLegacyActions(primaryError?: string) {
    try {
      const [workersRes, webhooksRes] = await Promise.all([
        fetch(`${API}/api/functions`, { credentials: "include" }),
        fetch(`${API}/api/custom/webhooks`, { credentials: "include" }).catch(() => null),
      ]);

      // The legacy route failed as well: an empty list here would read as "no actions".
      if (!workersRes.ok) {
        loadError = primaryError ?? `HTTP ${workersRes.status}`;
        actions = [];
        return;
      }

      const workers = workersRes.ok ? await workersRes.json() : { docs: [] };
      const webhooks = webhooksRes?.ok ? await webhooksRes.json() : { docs: [] };

      // Normalize to Action interface
      const workerActions: Action[] = (workers.docs || []).map((w: any) => ({
        id: w.id,
        type: "code",
        name: w.name,
        slug: w.slug,
        description: w.description,
        trigger: w.trigger === "cron" ? "cron" : "event",
        status: w.status === "active" ? "active" : "paused",
        triggerConfig: w.cronExpression
          ? { cronExpression: w.cronExpression }
          : { eventName: w.trigger },
        config: { code: w.code },
        lastExecutedAt: w.lastExecutedAt,
        executionCount: w.executionCount || 0,
        errorCount: w.errorCount || 0,
        createdAt: w.createdAt,
      }));

      const webhookActions: Action[] = (webhooks.docs || []).map((w: any) => ({
        id: w.id,
        type: "webhook_out",
        name: w.name,
        slug: w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: t("actionsView.webhookFor", { event: w.event }),
        trigger: "event",
        status: w.enabled ? "active" : "paused",
        triggerConfig: { eventName: w.event },
        config: { url: w.targetUrl || w.url },
        executionCount: 0,
        errorCount: 0,
        createdAt: w.createdAt || new Date().toISOString(),
      }));

      actions = [...workerActions, ...webhookActions];
    } catch (err) {
      console.error("Failed to load legacy actions:", err);
      loadError = primaryError ?? (err instanceof Error ? err.message : String(err));
      actions = [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════════════════════════════

  function openCreateModal(type: "code" | "webhook_out") {
    createType = type;
    formName = "";
    formDescription = "";
    formTrigger = type === "code" ? "cron" : "event";
    formCronExpression = "0 * * * *";
    formEventName = "entry.created";
    formCode = "export default async function(context) {\n  console.log('Action running');\n}";
    formUrl = "";
    formHeaders = "{}";
    showCreateModal = true;
  }

  function closeCreateModal() {
    showCreateModal = false;
  }

  async function saveAction(e: Event) {
    e.preventDefault();
    if (!formName) return;

    saving = true;
    try {
      if (useNewApi) {
        await saveViaNewApi();
      } else {
        await saveViaLegacyApi();
      }

      showCreateModal = false;
      await loadActions();
    } catch (err: any) {
      console.error("Failed to save action:", err);
      toast.error(err.message || t("actionsView.failedToCreateAction"));
    } finally {
      saving = false;
    }
  }

  async function saveViaNewApi() {
    const payload: any = {
      name: formName,
      description: formDescription || undefined,
      type: createType,
      trigger: formTrigger,
      triggerConfig:
        formTrigger === "cron"
          ? { cronExpression: formCronExpression }
          : { eventName: formEventName },
      config:
        createType === "code"
          ? { code: formCode }
          : { url: formUrl, headers: JSON.parse(formHeaders || "{}") },
      status: "active",
    };

    const res = await fetch(`${API}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(t("actionsView.failedToCreateAction2"));
  }

  async function saveViaLegacyApi() {
    if (createType === "code") {
      const payload = {
        name: formName,
        description: formDescription,
        trigger: formTrigger === "cron" ? "cron" : formEventName.replace(".", "_"),
        cronExpression: formTrigger === "cron" ? formCronExpression : undefined,
        code: formCode,
        status: "active",
      };

      const res = await fetch(`${API}/api/functions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(t("actionsView.failedToCreateWorker"));
    } else {
      const payload = {
        name: formName,
        event: formEventName.replace(".", "_"),
        targetUrl: formUrl,
        enabled: true,
      };

      const res = await fetch(`${API}/api/custom/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(t("actionsView.failedToCreateWebhook"));
    }
  }

  async function toggleAction(action: Action) {
    const newStatus = action.status === "active" ? "paused" : "active";

    try {
      if (useNewApi) {
        await fetch(`${API}/api/actions/${action.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: newStatus }),
        });
      } else {
        // Legacy API
        const endpoint =
          action.type === "code"
            ? `${API}/api/functions/${action.id}`
            : `${API}/api/custom/webhooks/${action.id}`;

        await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            status: newStatus === "active" ? "active" : "inactive",
            enabled: newStatus === "active",
          }),
        });
      }

      await loadActions();
    } catch (err) {
      toast.error(t("actionsView.toggleFailed"), { description: (err as Error)?.message });
    }
  }

  async function runAction(action: Action) {
    if (action.type !== "code") return;

    try {
      const endpoint = useNewApi
        ? `${API}/api/actions/${action.id}/execute`
        : `${API}/api/functions/${action.id}/execute`;

      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });

      await loadActions();
    } catch (err) {
      toast.error(t("actionsView.runFailed"), { description: (err as Error)?.message });
    }
  }

  function getTriggerLabel(action: Action): string {
    if (action.trigger === "cron" && action.triggerConfig?.cronExpression) {
      return t("actionsView.cron", { cronExpression: action.triggerConfig.cronExpression });
    }
    if (action.trigger === "event" && action.triggerConfig?.eventName) {
      return t("actionsView.onEvent", { event: action.triggerConfig.eventName });
    }
    return action.trigger;
  }

  // ── The list ───────────────────────────────────────────────────────────────────────

  let loaded = $state(false);
  let reloadKey = $state(0);
  let total = $state<number | null>(null);

  const TYPE_LABEL: Record<ActionType, () => string> = {
    code: () => t("actionsView.worker"),
    webhook_out: () => t("actionsView.webhook"),
    webhook_in: () => t("actionsView.webhookIn"),
    agent: () => t("actionsView.agentAction"),
  };
  const STATUS_LABEL: Record<ActionStatus, () => string> = {
    active: () => t("actionsView.active"),
    paused: () => t("actionsView.paused"),
    error: () => t("common.error"),
  };

  const byId = $derived(new Map(actions.map((a) => [a.id, a])));

  const source = $derived(
    memorySource({
      id: "actions",
      label: t("common.actions"),
      singular: t("actionsView.action"),
      titleField: "name",
      fields: [
        { key: "name", label: t("common.name"), kind: "text", sortable: true },
        {
          key: "type",
          label: t("actionsView.type"),
          kind: "select",
          sortable: true,
          options: (["code", "webhook_out", "webhook_in", "agent"] as ActionType[]).map((v) => ({
            value: v,
            label: TYPE_LABEL[v](),
          })),
        },
        { key: "triggerLabel", label: t("actionsView.trigger"), kind: "text", filterable: false },
        {
          key: "status",
          label: t("common.status"),
          kind: "select",
          sortable: true,
          options: (["active", "paused", "error"] as ActionStatus[]).map((v) => ({
            value: v,
            label: STATUS_LABEL[v](),
          })),
        },
        { key: "executionCount", label: t("actionsView.runs"), kind: "number", sortable: true },
        { key: "errorCount", label: t("actionsView.errors"), kind: "number", sortable: true },
        {
          key: "lastExecutedAt",
          label: t("actionsView.lastRun"),
          kind: "datetime",
          sortable: true,
        },
        { key: "description", label: t("common.description"), kind: "text", hidden: true },
      ],
      rows: () =>
        actions.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          status: a.status,
          triggerLabel: getTriggerLabel(a),
          executionCount: a.executionCount ?? 0,
          errorCount: a.errorCount ?? 0,
          lastExecutedAt: a.lastExecutedAt ?? null,
          description: a.description ?? a.config?.url ?? "",
        })),
      remove: async (id) => {
        const res = await fetch(`${API}/api/actions/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        actions = actions.filter((a) => a.id !== id);
      },
    })
  );

  const actionOf = (row: Row) => byId.get(String(row.id));
</script>

<Page
  title={t("common.actions")}
  description={t("actionsView.automationsWebhooksAndScheduledTasks")}
>
  {#snippet meta()}
    {#if loaded && !loadError}
      {t("actionsView.summary", {
        total: stats.total,
        active: stats.active,
        paused: stats.paused,
        workers: stats.code,
        webhooks: stats.webhooks,
      })}
      {#if !useNewApi}<Badge variant="warning" size="sm">{t("actionsView.legacyMode")}</Badge>{/if}
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button variant="secondary" onclick={() => openCreateModal("code")}>
      <Code size={16} aria-hidden="true" />
      {t("actionsView.newWorker")}
    </Button>
    <Button onclick={() => openCreateModal("webhook_out")}>
      <Webhook size={16} aria-hidden="true" />
      {t("actionsView.newWebhook")}
    </Button>
  {/snippet}

  <ListView
    {source}
    bind:total
    {reloadKey}
    pending={!loaded}
    {loadError}
    onRetry={loadActions}
    canDelete={useNewApi}
    onNew={() => openCreateModal("code")}
    emptyTitle={t("actionsView.noActionsConfigured")}
    emptyDescription={t("actionsView.createYourFirstAutomationTo")}
  >
    {#snippet rowMenu(row)}
      {@const action = actionOf(row)}
      {#if action}
        {#if action.type === "code"}
          <MenuItem onSelect={() => runAction(action)}>{t("actionsView.runNow")}</MenuItem>
        {/if}
        <MenuItem onSelect={() => toggleAction(action)}>
          {action.status === "active" ? t("actionsView.pause") : t("actionsView.resume")}
        </MenuItem>
      {/if}
    {/snippet}
  </ListView>
</Page>

<Dialog
  bind:open={showCreateModal}
  title={createType === "code" ? t("actionsView.newWorker") : t("actionsView.newWebhook")}
  size="lg"
>
  <form id="action-form" onsubmit={saveAction} class="kitsuden-action-form">
    <Field label={t("actionsView.name")} required>
      <Input
        bind:value={formName}
        required
        placeholder={createType === "code"
          ? t("actionsView.exDailyEmailDigest")
          : t("actionsView.exNotifySlack")}
      />
    </Field>
    <Field label={t("common.description")}>
      <Input bind:value={formDescription} placeholder={t("actionsView.whatThisActionDoes")} />
    </Field>
    <div class="kitsuden-action-row">
      <Field label={t("actionsView.trigger")}>
        <Select
          bind:value={formTrigger}
          options={[
            ...(createType === "code"
              ? [
                  { value: "cron", label: t("actionsView.cronSchedule") },
                  { value: "event", label: t("actionsView.systemEvent") },
                ]
              : [{ value: "event", label: t("actionsView.inEvent") }]),
            { value: "manual", label: t("actionsView.manualOnly") },
          ]}
        />
      </Field>
      {#if formTrigger === "cron"}
        <Field label={t("actionsView.cronExpression")}>
          <Input bind:value={formCronExpression} placeholder="0 * * * *" class="font-mono" />
        </Field>
      {:else if formTrigger === "event"}
        <Field label={t("actionsView.eventName")}>
          <Select
            bind:value={formEventName}
            options={[
              { value: "entry.created", label: t("actionsView.entryCreated") },
              { value: "entry.updated", label: t("actionsView.entryUpdated") },
              { value: "entry.deleted", label: t("actionsView.entryDeleted") },
              { value: "post.published", label: t("actionsView.postPublished") },
            ]}
          />
        </Field>
      {/if}
    </div>
    {#if createType === "code"}
      <Field label={t("actionsView.code")}>
        <Textarea bind:value={formCode} rows={8} class="font-mono" />
      </Field>
    {:else}
      <Field label={t("actionsView.targetUrl")} required>
        <Input
          bind:value={formUrl}
          type="url"
          required
          placeholder="https://hooks.slack.com/services/..."
        />
      </Field>
      <Field label={t("actionsView.headersJson")}>
        <Textarea bind:value={formHeaders} rows={3} class="font-mono" />
      </Field>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={closeCreateModal}>{t("common.cancel")}</Button>
    <Button
      type="submit"
      form="action-form"
      loading={saving}
      disabled={saving || !formName || (createType === "webhook_out" && !formUrl)}
    >
      {saving ? t("actionsView.creating") : t("common.create")}
    </Button>
  {/snippet}
</Dialog>

<style>
  .kitsuden-action-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .kitsuden-action-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 1rem;
  }
</style>
