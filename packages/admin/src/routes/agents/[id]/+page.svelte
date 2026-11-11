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
  import { toast } from "svelte-sonner";

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
  import StateMessage from "$lib/components/feedback/StateMessage.svelte";
  import UnsavedGuard from "$lib/components/feedback/UnsavedGuard.svelte";
  import { pageTitle, queryChoice, setQuery } from "$lib/page";
  import { ConfirmDialog, Input, Select, Tabs, Textarea, type TabItem } from "$lib/tallao";
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
  /**
   * The tab IS the `?tab=` of the address: choosing one navigates (a history entry), so
   * back/forward walk the tabs and a copied link opens the same one. It used to be local
   * state read once from the URL and never written back.
   */
  const activeTab = $derived(queryChoice($page.url, "tab", TABS, "playground"));
  function selectTab(tab: string) {
    void setQuery($page.url, { tab: tab === "playground" ? null : tab });
  }

  const TAB_ICONS: Partial<Record<Tab, typeof Play>> = {
    playground: Play,
    access: ShieldCheck,
    keys: KeyRound,
    quotas: Gauge,
    sponsor: PenLine,
    approval: UserCheck,
    history: History,
  };
  const TAB_LABELS: Record<Tab, () => string> = {
    playground: () => t("idPage.playground"),
    settings: () => t("idPage.configuration"),
    access: () => t("agentAccess.tab"),
    keys: () => t("agentKeys.tab"),
    quotas: () => t("agentQuotas.tab"),
    sponsor: () => t("agentSponsor.tab"),
    approval: () => t("agentApproval.tab"),
    history: () => t("agentVersions.tab"),
    traces: () => t("common.traces"),
  };
  const TAB_ITEMS = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: TAB_LABELS[id](),
      controls: "agent-panel",
      tabId: `agent-tab-${id}`,
    }))
  );

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
  /** The settings form differs from the saved agent: leaving would lose it. */
  const settingsDirty = $derived(
    !!agent &&
      (["name", "description", "model"] as const).some(
        (key) => (formData[key] ?? "") !== (agent?.[key] ?? "")
      )
  );

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
      toast.success(t("idPage.saved"));
    } catch (e) {
      // A toast, not the page's `error`: that one replaces the whole form with a message.
      toast.error(t("idPage.errorSavingChanges"), {
        description: e instanceof Error ? e.message : undefined,
      });
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

<svelte:head>
  <title
    >{pageTitle(agent?.name ? `${agent.name} · ${t("titles.agents")}` : t("titles.agent"))}</title
  >
</svelte:head>

<!-- Unsaved settings: ask before leaving the page (the form survives a change of tab). -->
<UnsavedGuard dirty={settingsDirty} />

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="flex items-center gap-4 px-6 py-4 border-b border-kitsuden-border">
    <Button variant="ghost" size="sm" href="/agents" aria-label={t("idPage.backToAgents")}>
      <ArrowLeft size={18} />
    </Button>

    {#if loading}
      <div class="animate-pulse h-6 w-48 bg-kitsuden-border rounded-sm"></div>
    {:else if agent}
      <div class="flex items-center gap-3">
        <div class="p-2 bg-kitsuden-accent/10 rounded-lg">
          <Bot size={20} class="text-kitsuden-accent" />
        </div>
        <div>
          <h1 class="text-xl font-semibold text-kitsuden-text">{agent.name}</h1>
          <p class="text-xs text-kitsuden-subtle">
            {[agent.model ?? agent.type, t(`agentsView.status_${agent.status}`)]
              .filter(Boolean)
              .join(" • ")}
          </p>
        </div>
      </div>
    {/if}

    <div class="flex-1"></div>

    <!-- Tabs (tallao: tablist/tab roles, arrow keys). The panel is the content below. -->
    <Tabs
      items={TAB_ITEMS}
      bind:value={() => activeTab, selectTab}
      variant="pills"
      wrap
      panels={false}
      ariaLabel={agent?.name ?? t("titles.agent")}
    >
      {#snippet tab(item)}
        {@const Icon = TAB_ICONS[item.id as Tab]}
        {#if Icon}<Icon size={14} />{/if}
        {item.label}
      {/snippet}
    </Tabs>
  </div>

  <!-- Content -->
  <div
    class="flex-1 overflow-hidden"
    id="agent-panel"
    role="tabpanel"
    aria-labelledby="agent-tab-{activeTab}"
  >
    {#if loading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-kitsuden-accent"></div>
      </div>
    {:else if error}
      <div class="p-6">
        <StateMessage
          kind="error"
          title={t("idPage.errorLoadingAgent")}
          description={error}
          onRetry={loadAgent}
        />
      </div>
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
              <label for="name" class="block text-sm font-medium text-kitsuden-text mb-1.5"
                >{t("common.name")}</label
              >
              <Input id="name" bind:value={() => formData.name ?? "", (v) => (formData.name = v)} />
            </div>

            <div>
              <label for="description" class="block text-sm font-medium text-kitsuden-text mb-1.5"
                >{t("common.description")}</label
              >
              <Textarea
                id="description"
                bind:value={() => formData.description ?? "", (v) => (formData.description = v)}
                rows={3}
              />
            </div>

            <div>
              <label for="model" class="block text-sm font-medium text-kitsuden-text mb-1.5"
                >{t("common.model")}</label
              >
              <Select
                id="model"
                bind:value={() => formData.model ?? "", (v) => (formData.model = v)}
              >
                <option value="gpt-4">{t("idPage.gpt4")}</option>
                <option value="gpt-4-turbo">{t("idPage.gpt4Turbo")}</option>
                <option value="gpt-3.5-turbo">{t("idPage.gpt35Turbo")}</option>
                <option value="claude-3-opus">{t("idPage.claude3Opus")}</option>
                <option value="claude-3-sonnet">{t("idPage.claude3Sonnet")}</option>
              </Select>
            </div>

            <div class="flex items-center justify-between pt-4 border-t border-kitsuden-border">
              <Button
                variant="secondary"
                class="text-kitsuden-danger hover:text-kitsuden-danger"
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
              <div
                class="animate-spin rounded-full h-8 w-8 border-b-2 border-kitsuden-accent"
              ></div>
            </div>
          {:else if traceSteps.length === 0}
            <div class="text-center text-kitsuden-subtle py-12">
              {t("idPage.noTracesAvailable")}
            </div>
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
