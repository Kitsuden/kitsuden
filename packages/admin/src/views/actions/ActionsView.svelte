<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * ActionsView.svelte — Unified UI for Workers + Webhooks
   *
   * Uses the new unified /api/actions API.
   * Falls back to legacy APIs if the new API is not available.
   */
  import {
    Zap,
    Webhook,
    Plus,
    Play,
    Pause,
    RotateCcw,
    X,
    Loader2,
    Activity,
    Code,
    Globe,
    Terminal,
  } from "lucide-svelte";
  import { onMount } from "svelte";

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
  let activeTab = $state<"all" | "code" | "webhook_out">("all");
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

  const filteredActions = $derived(
    activeTab === "all" ? actions : actions.filter((a) => a.type === activeTab)
  );

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

  async function loadActions() {
    loading = true;
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
      // Try legacy as fallback
      await loadLegacyActions();
    } finally {
      loading = false;
    }
  }

  // Fallback to legacy APIs
  async function loadLegacyActions() {
    try {
      const [workersRes, webhooksRes] = await Promise.all([
        fetch(`${API}/api/functions`, { credentials: "include" }),
        fetch(`${API}/api/custom/webhooks`, { credentials: "include" }).catch(() => null),
      ]);

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
      alert(err.message || t("actionsView.failedToCreateAction"));
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
      console.error("Failed to toggle action:", err);
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
      console.error("Failed to run action:", err);
    }
  }

  function getTriggerLabel(action: Action): string {
    if (action.trigger === "cron" && action.triggerConfig?.cronExpression) {
      return t("actionsView.cron", { cronExpression: action.triggerConfig.cronExpression });
    }
    if (action.trigger === "event" && action.triggerConfig?.eventName) {
      return `On ${action.triggerConfig.eventName}`;
    }
    return action.trigger;
  }

  function getTriggerBadgeClass(action: Action): string {
    switch (action.trigger) {
      case "cron":
        return "badge-cyan";
      case "event":
        return "badge-amber";
      case "http":
        return "badge-purple";
      case "manual":
        return "badge-muted";
      default:
        return "badge-muted";
    }
  }

  function getTypeIcon(type: ActionType) {
    switch (type) {
      case "code":
        return Terminal;
      case "webhook_out":
        return Globe;
      case "webhook_in":
        return Webhook;
      case "agent":
        return Zap;
      default:
        return Zap;
    }
  }

  function getTypeColor(type: ActionType): string {
    switch (type) {
      case "code":
        return "text-kitsuden-amber bg-kitsuden-amber/10";
      case "webhook_out":
        return "text-kitsuden-purple bg-kitsuden-purple/10";
      case "webhook_in":
        return "text-kitsuden-accent bg-kitsuden-accent/10";
      case "agent":
        return "text-kitsuden-accent-2 bg-kitsuden-accent-2/10";
      default:
        return "text-kitsuden-subtle bg-kitsuden-subtle/10";
    }
  }
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-linear-to-br from-kitsuden-accent/20 to-kitsuden-purple/20 border border-kitsuden-accent/20 flex items-center justify-center"
        >
          <Zap class="w-5 h-5 text-kitsuden-accent" />
        </div>
        {t("common.actions")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("actionsView.automationsWebhooksAndScheduledTasks")}
        {#if !useNewApi}
          <span class="text-kitsuden-amber">{t("actionsView.legacyMode")}</span>
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        onclick={() => openCreateModal("code")}
        class="group inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-amber-500/5 hover:border-amber-500/20 hover:text-amber-400 transition-all duration-200"
      >
        <Code class="w-4 h-4 group-hover:scale-110 transition-transform" />
        {t("actionsView.newWorker")}
      </button>
      <button
        onclick={() => openCreateModal("webhook_out")}
        class="group inline-flex items-center gap-2 px-5 py-2.5 bg-linear-to-r from-kitsuden-accent to-kitsuden-accent text-black rounded-xl font-semibold shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200"
      >
        <Webhook class="w-4 h-4 group-hover:rotate-12 transition-transform" />
        {t("actionsView.newWebhook")}
      </button>
    </div>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center">
          <Zap class="w-5 h-5 text-kitsuden-accent" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">{stats.total}</p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("actionsView.totalActions")}
          </p>
        </div>
      </div>
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-green/10 flex items-center justify-center">
          <Activity class="w-5 h-5 text-kitsuden-green" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">{stats.active}</p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("actionsView.active")}
          </p>
        </div>
      </div>
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-amber/10 flex items-center justify-center">
          <Terminal class="w-5 h-5 text-kitsuden-amber" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">{stats.code}</p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("actionsView.workers")}
          </p>
        </div>
      </div>
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-purple/10 flex items-center justify-center">
          <Globe class="w-5 h-5 text-kitsuden-purple" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">{stats.webhooks}</p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("actionsView.webhooks")}
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="border-b border-kitsuden-border">
    <div class="flex gap-1">
      {#each [{ id: "all", label: t("actionsView.allActions"), icon: Zap }, { id: "code", label: t("actionsView.workers2"), icon: Terminal }, { id: "webhook_out", label: t("actionsView.webhooks2"), icon: Globe }] as tab}
        <button
          onclick={() => (activeTab = tab.id as any)}
          class="group px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-200 inline-flex items-center gap-2"
          class:border-kitsuden-accent={activeTab === tab.id}
          class:text-kitsuden-accent={activeTab === tab.id}
          class:border-transparent={activeTab !== tab.id}
          class:text-kitsuden-text-dim={activeTab !== tab.id}
          class:hover:text-kitsuden-text={activeTab !== tab.id}
        >
          <tab.icon class="w-4 h-4 group-hover:scale-110 transition-transform" />
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Actions List -->
  <div class="card overflow-hidden">
    {#if loading}
      <div class="flex justify-center py-20">
        <div
          class="w-6 h-6 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
        ></div>
      </div>
    {:else if filteredActions.length === 0}
      <div class="p-16 text-center">
        <Zap class="w-16 h-16 mx-auto text-kitsuden-accent/30 mb-4" />
        <h3 class="text-lg font-medium text-kitsuden-text mb-2">
          {t("actionsView.noActionsConfigured")}
        </h3>
        <p class="text-sm text-kitsuden-subtle mb-4">
          {t("actionsView.createYourFirstAutomationTo")}
        </p>
        <div class="flex justify-center gap-3">
          <button
            onclick={() => openCreateModal("code")}
            class="group inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-amber-500/5 hover:border-amber-500/20 hover:text-amber-400 transition-all duration-200"
          >
            <Code class="w-4 h-4 group-hover:scale-110 transition-transform" />
            {t("actionsView.newWorker")}
          </button>
          <button
            onclick={() => openCreateModal("webhook_out")}
            class="group inline-flex items-center gap-2 px-5 py-2.5 bg-linear-to-r from-kitsuden-accent to-kitsuden-accent text-black rounded-xl font-semibold shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200"
          >
            <Webhook class="w-4 h-4 group-hover:rotate-12 transition-transform" />
            {t("actionsView.newWebhook")}
          </button>
        </div>
      </div>
    {:else}
      <table class="w-full">
        <thead class="bg-kitsuden-surface/50 border-b border-kitsuden-border">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-kitsuden-subtle uppercase"
              >{t("actionsView.type")}</th
            >
            <th class="px-4 py-3 text-left text-xs font-medium text-kitsuden-subtle uppercase"
              >{t("common.name")}</th
            >
            <th class="px-4 py-3 text-left text-xs font-medium text-kitsuden-subtle uppercase"
              >{t("actionsView.trigger")}</th
            >
            <th class="px-4 py-3 text-left text-xs font-medium text-kitsuden-subtle uppercase"
              >{t("common.status")}</th
            >
            <th class="px-4 py-3 text-right text-xs font-medium text-kitsuden-subtle uppercase"
              >{t("common.actions")}</th
            >
          </tr>
        </thead>
        <tbody class="divide-y divide-kitsuden-border">
          {#each filteredActions as action}
            {@const Icon = getTypeIcon(action.type)}
            <tr class="hover:bg-kitsuden-surface/30 group">
              <td class="px-4 py-3">
                <div class="flex items-center gap-3">
                  <div
                    class="w-8 h-8 rounded-lg flex items-center justify-center {getTypeColor(
                      action.type
                    )}"
                  >
                    <Icon class="w-4 h-4" />
                  </div>
                  <span class="text-sm text-kitsuden-text capitalize"
                    >{action.type.replace("_", " ")}</span
                  >
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="font-medium text-kitsuden-text">{action.name}</div>
                {#if action.description}
                  <div class="text-xs text-kitsuden-subtle">{action.description}</div>
                {/if}
                {#if action.config?.url}
                  <div class="text-xs text-kitsuden-subtle font-mono truncate max-w-[200px]">
                    {action.config.url}
                  </div>
                {/if}
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full border {getTriggerBadgeClass(
                    action
                  )}"
                >
                  {getTriggerLabel(action)}
                </span>
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full border {action.status ===
                  'active'
                    ? 'border-kitsuden-green/30 bg-kitsuden-green/10 text-kitsuden-green'
                    : 'border-kitsuden-subtle/30 bg-kitsuden-subtle/10 text-kitsuden-subtle'}"
                >
                  {action.status === "active" ? t("actionsView.active") : t("actionsView.paused")}
                </span>
              </td>
              <td class="px-4 py-3 text-right">
                <div
                  class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {#if action.type === "code"}
                    <button
                      class="group/btn p-2 rounded-xl text-kitsuden-text-dim hover:text-kitsuden-accent hover:bg-kitsuden-accent/10 transition-all duration-200 hover:scale-110"
                      title={t("actionsView.runNow")}
                      onclick={() => runAction(action)}
                    >
                      <RotateCcw
                        class="w-4 h-4 group-hover/btn:rotate-180 transition-transform duration-500"
                      />
                    </button>
                  {/if}
                  <button
                    class="group/btn p-2 rounded-xl transition-all duration-200 hover:scale-110 {action.status !==
                    'active'
                      ? 'text-emerald-400 hover:bg-emerald-500/10'
                      : 'text-amber-400 hover:bg-amber-500/10'}"
                    title={action.status === "active"
                      ? t("actionsView.pause")
                      : t("actionsView.resume")}
                    onclick={() => toggleAction(action)}
                  >
                    {#if action.status === "active"}
                      <Pause class="w-4 h-4 group-hover/btn:scale-90 transition-transform" />
                    {:else}
                      <Play class="w-4 h-4 group-hover/btn:scale-110 transition-transform" />
                    {/if}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>

<!-- Create Modal -->
{#if showCreateModal}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <div
      class="absolute inset-0 bg-black/60 backdrop-blur-xs"
      onclick={() => (showCreateModal = false)}
    ></div>

    <div
      class="relative bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
    >
      <div class="flex items-center justify-between p-6 border-b border-kitsuden-border">
        <h3 class="text-lg font-semibold text-kitsuden-text">
          {t("actionsView.newItem")}
          {createType === "code" ? t("actionsView.worker") : t("actionsView.webhook")}
        </h3>
        <button
          onclick={() => (showCreateModal = false)}
          class="group p-2 rounded-xl text-kitsuden-text-dim hover:text-kitsuden-text hover:bg-kitsuden-bg transition-all duration-200 hover:rotate-90"
        >
          <X class="w-5 h-5 transition-transform" />
        </button>
      </div>

      <form onsubmit={saveAction} class="p-6 space-y-4">
        <div>
          <label for="formname" class="block text-xs text-kitsuden-subtle mb-1"
            >{t("actionsView.name")}</label
          >
          <input
            id="formname"
            bind:value={formName}
            type="text"
            placeholder={createType === "code"
              ? t("actionsView.exDailyEmailDigest")
              : t("actionsView.exNotifySlack")}
            class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-hidden"
            required
          />
        </div>

        <div>
          <label for="formdescription" class="block text-xs text-kitsuden-subtle mb-1"
            >{t("common.description")}</label
          >
          <input
            id="formdescription"
            bind:value={formDescription}
            type="text"
            placeholder={t("actionsView.whatThisActionDoes")}
            class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-hidden"
          />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label for="formtrigger" class="block text-xs text-kitsuden-subtle mb-1"
              >{t("actionsView.trigger")}</label
            >
            <select
              id="formtrigger"
              bind:value={formTrigger}
              class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-hidden"
            >
              {#if createType === "code"}
                <option value="cron">{t("actionsView.cronSchedule")}</option>
                <option value="event">{t("actionsView.systemEvent")}</option>
              {:else}
                <option value="event">{t("actionsView.inEvent")}</option>
              {/if}
              <option value="manual">{t("actionsView.manualOnly")}</option>
            </select>
          </div>

          {#if formTrigger === "cron"}
            <div>
              <label for="formcronexpression" class="block text-xs text-kitsuden-subtle mb-1"
                >{t("actionsView.cronExpression")}</label
              >
              <input
                id="formcronexpression"
                bind:value={formCronExpression}
                type="text"
                placeholder="0 * * * *"
                class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm font-mono focus:border-kitsuden-accent/50 focus:outline-hidden"
              />
            </div>
          {:else if formTrigger === "event"}
            <div>
              <label for="formeventname" class="block text-xs text-kitsuden-subtle mb-1"
                >{t("actionsView.eventName")}</label
              >
              <select
                id="formeventname"
                bind:value={formEventName}
                class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-hidden"
              >
                <option value="entry.created">{t("actionsView.entryCreated")}</option>
                <option value="entry.updated">{t("actionsView.entryUpdated")}</option>
                <option value="entry.deleted">{t("actionsView.entryDeleted")}</option>
                <option value="post.published">{t("actionsView.postPublished")}</option>
              </select>
            </div>
          {/if}
        </div>

        {#if createType === "code"}
          <div>
            <label for="formcode" class="block text-xs text-kitsuden-subtle mb-1"
              >{t("actionsView.code")}</label
            >
            <textarea
              id="formcode"
              bind:value={formCode}
              rows="6"
              class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm font-mono focus:border-kitsuden-accent/50 focus:outline-hidden"
            ></textarea>
          </div>
        {:else}
          <div>
            <label for="formurl" class="block text-xs text-kitsuden-subtle mb-1"
              >{t("actionsView.targetUrl")}</label
            >
            <input
              id="formurl"
              bind:value={formUrl}
              type="url"
              placeholder="https://hooks.slack.com/services/..."
              class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-hidden"
              required
            />
          </div>

          <div>
            <label for="formheaders" class="block text-xs text-kitsuden-subtle mb-1"
              >{t("actionsView.headersJson")}</label
            >
            <textarea
              id="formheaders"
              bind:value={formHeaders}
              rows="3"
              placeholder={'{"Authorization": "Bearer token"}'}
              class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm font-mono focus:border-kitsuden-accent/50 focus:outline-hidden"
            ></textarea>
          </div>
        {/if}

        <div class="flex justify-end gap-3 pt-4 border-t border-kitsuden-border">
          <button
            type="button"
            onclick={() => (showCreateModal = false)}
            class="px-5 py-2.5 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-bg transition-all duration-200"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving || !formName || (createType === "webhook_out" && !formUrl)}
            class="group inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl bg-linear-to-r from-kitsuden-accent to-kitsuden-accent text-black shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200 disabled:opacity-50 disabled:hover:scale-100"
          >
            {#if saving}
              <Loader2 class="w-4 h-4 animate-spin" />
              {t("actionsView.creating")}
            {:else}
              <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
              {t("common.create")}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
