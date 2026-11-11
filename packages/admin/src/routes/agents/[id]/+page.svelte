<script lang="ts">
  import { t } from "$lib/i18n";
  import {
    ArrowLeft,
    Save,
    Bot,
    Play,
    Trash2,
    ShieldCheck,
    KeyRound,
    Gauge,
    UserCheck,
    PenLine,
    History,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  import AgentApproval from "$lib/components/agents/AgentApproval.svelte";
  import AgentPromotion from "$lib/components/agents/AgentPromotion.svelte";
  import AgentKeys from "$lib/components/agents/AgentKeys.svelte";
  import AgentPermissions from "$lib/components/agents/AgentPermissions.svelte";
  import AgentQuotas from "$lib/components/agents/AgentQuotas.svelte";
  import AgentMcpSettings from "$lib/components/agents/AgentMcpSettings.svelte";
  import AgentSponsor from "$lib/components/agents/AgentSponsor.svelte";
  import AgentVersions from "$lib/components/agents/AgentVersions.svelte";
  import AgentDecisions from "$lib/components/approvals/AgentDecisions.svelte";
  import ChatInterface from "$lib/components/agents/ChatInterface.svelte";
  import Timeline from "$lib/components/agents/Timeline.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Card from "$lib/components/ui/Card.svelte";
  import {
    deleteAgent,
    getAgent,
    updateAgent,
    sendPlaygroundMessage,
    listTraces,
    listTraceSteps,
  } from "$lib/services/agents";
  import { ConfirmDialog } from "$lib/tallao";
  import type { Agent, AgentTraceStep } from "$lib/types/agents";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  const agentId = $page.params.id;

  let agent: Agent | null = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  // The "Remove" button of the settings tab had no handler: it looked like it deleted.
  let confirmingRemoval = $state(false);

  async function handleRemove() {
    try {
      await deleteAgent(agentId);
      await goto("/agents");
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentsView.errorRemovingAgent");
    }
  }
  // `?tab=settings` directly opens the configuration ("Configure" button in the list).
  // Also `?tab=access`, `?tab=keys` and `?tab=quotas`; human approval, `?tab=approval` and `?tab=sponsor`.
  // `?tab=history`: versions of the definition and what the agent chose not to do.
  type Tab =
    | "settings"
    | "playground"
    | "traces"
    | "access"
    | "keys"
    | "quotas"
    | "approval"
    | "sponsor"
    | "history";
  const TABS: Tab[] = [
    "playground",
    "settings",
    "access",
    "keys",
    "quotas",
    "sponsor",
    "approval",
    "history",
    "traces",
  ];
  const initialTab = $page.url.searchParams.get("tab") as Tab | null;
  let activeTab = $state<Tab>(initialTab && TABS.includes(initialTab) ? initialTab : "playground");

  // Playground state
  let messages = $state<
    Array<{
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      timestamp: Date;
      metadata?: {
        tokensIn?: number;
        tokensOut?: number;
        durationMs?: number;
        provider?: string;
        model?: string;
        cached?: boolean;
      };
      toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; result: string }>;
    }>
  >([]);
  let sessionId = $state<string | undefined>(undefined);
  let chatLoading = $state(false);
  let tracesLoading = $state(false);
  let traceSteps = $state<any[]>([]);

  // Settings form
  let formData = $state<Partial<Agent>>({});

  onMount(async () => {
    await loadAgent();
  });

  async function loadAgent() {
    try {
      loading = true;
      error = null;
      agent = await getAgent(agentId);
      formData = { ...agent };
    } catch (e) {
      error = e instanceof Error ? e.message : t("idPage.errorLoadingAgent");
    } finally {
      loading = false;
    }
  }

  async function handleSave() {
    try {
      saving = true;
      await updateAgent(agentId, formData);
      await loadAgent();
    } catch (e) {
      error = e instanceof Error ? e.message : t("idPage.errorSavingChanges");
    } finally {
      saving = false;
    }
  }

  async function loadTraces() {
    if (!agentId) return;
    tracesLoading = true;
    try {
      const traces = await listTraces({ agentId, limit: 20 });
      const allSteps: any[] = [];
      for (const trace of traces) {
        const steps = await listTraceSteps(trace.id);
        for (const step of steps) {
          // The step as the API sends it: it already has `toolOutput`. Overwriting it
          // with `content` showed the model's text as the tool's answer.
          allSteps.push(step);
        }
      }
      traceSteps = allSteps.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } catch (e) {
      traceSteps = [];
    } finally {
      tracesLoading = false;
    }
  }

  $effect(() => {
    if (activeTab === "traces") {
      loadTraces();
    }
  });

  async function handleSendMessage(content: string) {
    messages = [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: new Date(),
      },
    ];

    chatLoading = true;

    try {
      const response = await sendPlaygroundMessage(agentId, content, sessionId);
      sessionId = response.sessionId;

      messages = [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.response,
          timestamp: new Date(),
          metadata: {
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            durationMs: response.durationMs,
            provider: response.provider,
            model: response.model,
            cached: response.cached,
          },
          toolCalls: response.toolCalls,
        },
      ];
    } catch (e) {
      messages = [
        ...messages,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: t("idPage.error", {
            v: e instanceof Error ? e.message : t("idPage.unknownError"),
          }),
          timestamp: new Date(),
        },
      ];
    } finally {
      chatLoading = false;
    }
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="flex items-center gap-4 px-6 py-4 border-b border-zinc-800">
    <Button variant="ghost" size="sm" href="/agents">
      <ArrowLeft size={18} />
    </Button>

    {#if loading}
      <div class="animate-pulse h-6 w-48 bg-zinc-800 rounded-sm"></div>
    {:else if agent}
      <div class="flex items-center gap-3">
        <div class="p-2 bg-indigo-500/10 rounded-lg">
          <Bot size={20} class="text-indigo-400" />
        </div>
        <div>
          <h1 class="text-xl font-semibold text-zinc-100">{agent.name}</h1>
          <p class="text-xs text-zinc-500">
            {[agent.model ?? agent.type, t(`agentsView.status_${agent.status}`)]
              .filter(Boolean)
              .join(" • ")}
          </p>
        </div>
      </div>
    {/if}

    <div class="flex-1"></div>

    <!-- Tabs -->
    <div class="flex flex-wrap items-center gap-1 bg-zinc-900 p-1 rounded-lg">
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'playground'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "playground")}
      >
        <Play size={14} class="inline mr-1.5" />
        {t("idPage.playground")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'settings'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "settings")}
      >
        {t("idPage.configuration")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'access'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "access")}
      >
        <ShieldCheck size={14} class="inline mr-1.5" />
        {t("agentAccess.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'keys'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "keys")}
      >
        <KeyRound size={14} class="inline mr-1.5" />
        {t("agentKeys.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'quotas'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "quotas")}
      >
        <Gauge size={14} class="inline mr-1.5" />
        {t("agentQuotas.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'sponsor'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "sponsor")}
      >
        <PenLine size={14} class="inline mr-1.5" />
        {t("agentSponsor.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'approval'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "approval")}
      >
        <UserCheck size={14} class="inline mr-1.5" />
        {t("agentApproval.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'history'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "history")}
      >
        <History size={14} class="inline mr-1.5" />
        {t("agentVersions.tab")}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-md transition-colors {activeTab === 'traces'
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'}"
        onclick={() => (activeTab = "traces")}
      >
        {t("common.traces")}
      </button>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-hidden">
    {#if loading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      </div>
    {:else if error}
      <div class="p-8 text-center text-red-400">{error}</div>
    {:else if agent}
      {#if activeTab === "playground"}
        <div class="h-full p-4">
          <ChatInterface
            {messages}
            loading={chatLoading}
            agentName={agent.name}
            onSend={handleSendMessage}
            class="h-full"
          />
        </div>
      {:else if activeTab === "settings"}
        <div class="p-6 max-w-2xl">
          <Card class="p-6 space-y-6">
            <div>
              <label for="name" class="block text-sm font-medium text-zinc-300 mb-1.5"
                >{t("common.name")}</label
              >
              <input
                id="name"
                type="text"
                bind:value={formData.name}
                class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/50"
              />
            </div>

            <div>
              <label for="description" class="block text-sm font-medium text-zinc-300 mb-1.5"
                >{t("common.description")}</label
              >
              <textarea
                id="description"
                bind:value={formData.description}
                rows={3}
                class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/50 resize-none"
              ></textarea>
            </div>

            <div>
              <label for="model" class="block text-sm font-medium text-zinc-300 mb-1.5"
                >{t("common.model")}</label
              >
              <select
                id="model"
                bind:value={formData.model}
                class="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-zinc-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/50"
              >
                <option value="gpt-4">{t("idPage.gpt4")}</option>
                <option value="gpt-4-turbo">{t("idPage.gpt4Turbo")}</option>
                <option value="gpt-3.5-turbo">{t("idPage.gpt35Turbo")}</option>
                <option value="claude-3-opus">{t("idPage.claude3Opus")}</option>
                <option value="claude-3-sonnet">{t("idPage.claude3Sonnet")}</option>
              </select>
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-zinc-800">
              <Button
                variant="secondary"
                class="text-red-400 hover:text-red-300"
                onclick={() => (confirmingRemoval = true)}
              >
                <Trash2 size={16} class="mr-2" />
                {t("common.remove")}
              </Button>
              <Button variant="primary" loading={saving} onclick={handleSave}>
                <Save size={16} class="mr-2" />
                {t("idPage.saveChanges")}
              </Button>
            </div>
          </Card>
        </div>
      {:else if activeTab === "access"}
        <div class="h-full overflow-y-auto p-6 max-w-6xl">
          <AgentPermissions {agentId} />
        </div>
      {:else if activeTab === "keys"}
        <div class="h-full overflow-y-auto p-6 max-w-6xl">
          <AgentKeys {agentId} />
        </div>
      {:else if activeTab === "quotas"}
        <div class="h-full overflow-y-auto p-6 max-w-4xl space-y-8">
          <AgentQuotas {agentId} />
          <AgentMcpSettings {agentId} />
        </div>
      {:else if activeTab === "sponsor"}
        <div class="h-full overflow-y-auto p-6 max-w-3xl">
          <AgentSponsor {agentId} />
        </div>
      {:else if activeTab === "approval"}
        <div class="h-full overflow-y-auto p-6 max-w-3xl space-y-8">
          <AgentApproval {agentId} />
          <AgentPromotion {agentId} />
        </div>
      {:else if activeTab === "history"}
        <div class="h-full overflow-y-auto p-6 max-w-5xl space-y-8">
          <AgentVersions {agentId} onRestored={loadAgent} />
          <AgentDecisions {agentId} />
        </div>
      {:else if activeTab === "traces"}
        <div class="p-6 space-y-6">
          {#if tracesLoading}
            <div class="flex items-center justify-center h-32">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
            </div>
          {:else if traceSteps.length === 0}
            <div class="text-center text-zinc-500 py-12">{t("idPage.noTracesAvailable")}</div>
          {:else}
            <Timeline steps={traceSteps} />
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>

<ConfirmDialog
  bind:open={confirmingRemoval}
  variant="danger"
  title={t("agentsView.removeAgent")}
  description={t("agentsView.areYouSureThisActionNot")}
  confirmLabel={t("common.remove")}
  cancelLabel={t("common.cancel")}
  onConfirm={handleRemove}
/>
