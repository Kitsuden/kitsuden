<!--
  One agent. The header says what it is at a glance (state, type or model, sponsor, working
  keys, proposals that wait, calls this week); six tabs, each with its own address
  (`?tab=`), hold the rest:

    Overview            what it can do, what waits for a person, what it did last
    Permissions         scopes (AgentPermissions)
    Keys                API keys (AgentKeys)
    Limits & approval   quotas, MCP limits, approval mode, code promotion
    Activity            its traces, step by step, and what it chose not to do
    Settings            name, description, model, sponsor, versions of its definition, delete

  The playground is a Sheet over the page (`?playground=1`), opened from the header.
  The older tab names (`access`, `quotas`, `approval`, `sponsor`, `history`, `traces`,
  `playground`) still open the tab that holds them now.
-->
<script lang="ts">
  import { MessageSquare } from "lucide-svelte";
  import { untrack } from "svelte";

  import { activeKeyCount, agentMetaParts } from "$lib/agents/agent-rows";
  import { isStaff } from "$lib/auth.svelte";
  import AgentApproval from "$lib/components/agents/AgentApproval.svelte";
  import AgentKeys from "$lib/components/agents/AgentKeys.svelte";
  import AgentMcpSettings from "$lib/components/agents/AgentMcpSettings.svelte";
  import AgentPermissions from "$lib/components/agents/AgentPermissions.svelte";
  import AgentPromotion from "$lib/components/agents/AgentPromotion.svelte";
  import AgentQuotas from "$lib/components/agents/AgentQuotas.svelte";
  import AgentSponsor from "$lib/components/agents/AgentSponsor.svelte";
  import AgentVersions from "$lib/components/agents/AgentVersions.svelte";
  import ChatInterface from "$lib/components/agents/ChatInterface.svelte";
  import StepTimeline from "$lib/components/agents/Timeline.svelte";
  import AgentDecisions from "$lib/components/approvals/AgentDecisions.svelte";
  import UnsavedGuard from "$lib/components/feedback/UnsavedGuard.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { localeFormat, t } from "$lib/i18n";
  import { setQuery } from "$lib/page";
  import {
    deleteAgent,
    getAgent,
    getAgentSponsor,
    getAgentStats,
    listAgentKeys,
    listAgentLogs,
    listTraces,
    listTraceSteps,
    sendPlaygroundMessage,
    updateAgent,
    type AgentLogEntry,
  } from "$lib/services/agents";
  import { listProposals } from "$lib/services/approvals";
  import {
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    EmptyState,
    Field,
    Input,
    SaveBar,
    Select,
    Sheet,
    Skeleton,
    Tabs,
    Textarea,
    Timeline,
    toast,
    type TabItem,
  } from "$lib/tallao";
  import type { Agent, AgentTraceStep } from "$lib/types/agents";
  import type { Proposal } from "$lib/types/approvals";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  const agentId = $derived($page.params.id ?? "");

  let agent = $state<Agent | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // ── Tabs ─────────────────────────────────────────────────────────────────────────
  const TABS = ["overview", "permissions", "keys", "limits", "activity", "settings"] as const;
  type Tab = (typeof TABS)[number];
  /** Where the older tab names live now. */
  const MOVED: Record<string, Tab> = {
    access: "permissions",
    quotas: "limits",
    approval: "limits",
    sponsor: "settings",
    history: "settings",
    traces: "activity",
    playground: "overview",
  };
  const activeTab = $derived.by<Tab>(() => {
    const raw = $page.url.searchParams.get("tab") ?? "";
    if ((TABS as readonly string[]).includes(raw)) return raw as Tab;
    return MOVED[raw] ?? "overview";
  });
  function selectTab(tab: string) {
    void setQuery($page.url, { tab: tab === "overview" ? null : tab });
  }
  const TAB_LABELS: Record<Tab, () => string> = {
    overview: () => t("agentPage.tabOverview"),
    permissions: () => t("agentPage.tabPermissions"),
    keys: () => t("agentPage.tabKeys"),
    limits: () => t("agentPage.tabLimits"),
    activity: () => t("agentPage.tabActivity"),
    settings: () => t("agentPage.tabSettings"),
  };

  // ── Playground (a Sheet; `?playground=1`, and the older `?tab=playground`) ───────
  const playgroundOpen = $derived(
    $page.url.searchParams.get("playground") === "1" ||
      $page.url.searchParams.get("tab") === "playground"
  );
  function setPlayground(open: boolean) {
    if (open === playgroundOpen) return;
    void setQuery(
      $page.url,
      {
        playground: open ? "1" : null,
        ...(open ? {} : { tab: activeTab === "overview" ? null : activeTab }),
      },
      { replace: !open }
    );
  }

  type Message = {
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
  };
  let messages = $state<Message[]>([]);
  let sessionId = $state<string | undefined>(undefined);
  let chatLoading = $state(false);

  async function handleSendMessage(content: string) {
    messages = [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content, timestamp: new Date() },
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

  // ── The agent and the facts of its header ────────────────────────────────────────
  let formData = $state<Partial<Agent>>({});
  /** The settings form differs from the saved agent: leaving would lose it. */
  const settingsDirty = $derived(
    !!agent &&
      (["name", "description", "model"] as const).some(
        (key) => (formData[key] ?? "") !== (agent?.[key] ?? "")
      )
  );

  let sponsor = $state<string | null>(null);
  let activeKeys = $state<number | null>(null);
  let totalKeys = $state<number | null>(null);
  let pendingProposals = $state<Proposal[] | null>(null);
  let calls = $state<number | null>(null);
  let failedCalls = $state<number | null>(null);
  let logs = $state<AgentLogEntry[] | null>(null);

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

  /** Each fact asks its own endpoint; one that fails leaves its fact out, not the page. */
  function loadFacts(id: string) {
    sponsor = null;
    activeKeys = totalKeys = calls = failedCalls = null;
    pendingProposals = null;
    logs = null;
    void getAgentSponsor(id)
      .then((r) => (sponsor = r.sponsor?.name ?? r.sponsor?.email ?? null))
      .catch(() => {});
    void listAgentKeys(id)
      .then((keys) => {
        totalKeys = keys.length;
        activeKeys = activeKeyCount(keys);
      })
      .catch(() => {});
    void getAgentStats(id)
      .then((stats) => {
        calls = Number(stats.totalCalls) || 0;
        failedCalls = Number(stats.failedCalls) || 0;
      })
      .catch(() => {});
    void listAgentLogs(id, 8)
      .then((list) => (logs = list))
      .catch(() => (logs = []));
    if (isStaff()) {
      void listProposals({ status: "pending", agentId: id, limit: 20 })
        .then((r) => (pendingProposals = r.proposals))
        .catch(() => (pendingProposals = []));
    } else pendingProposals = [];
  }

  $effect(() => {
    const id = agentId;
    untrack(() => {
      messages = [];
      sessionId = undefined;
      void loadAgent();
      loadFacts(id);
    });
  });

  const metaParts = $derived(
    agent
      ? agentMetaParts(
          {
            kind: agent.model ?? agent.type ?? "",
            sponsor,
            activeKeys,
            totalKeys,
            pending: pendingProposals?.length ?? null,
            calls,
          },
          t
        )
      : []
  );

  const scopes = $derived(
    Array.isArray((agent as (Agent & { scopes?: unknown }) | null)?.scopes)
      ? ((agent as Agent & { scopes: string[] }).scopes ?? [])
      : []
  );

  const dateTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : new Intl.DateTimeFormat(localeFormat(), { dateStyle: "medium", timeStyle: "short" }).format(
          d
        );
  };

  const logLines = $derived(
    (logs ?? []).map((entry) => ({
      date: dateTime(entry.createdAt),
      title: entry.resource ? `${entry.action} · ${entry.resource}` : entry.action,
      description: entry.success ? undefined : (entry.errorMessage ?? t("agentPage.failed")),
      tone: entry.success ? ("default" as const) : ("error" as const),
      tag: entry.success ? undefined : t("agentPage.failed"),
    }))
  );

  // ── Settings ─────────────────────────────────────────────────────────────────────
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

  async function handleRemove() {
    const ok = await confirmDialog({
      title: t("agentsView.removeAgent"),
      description: t("agentsView.areYouSureThisActionNot"),
      confirmLabel: t("common.remove"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      await deleteAgent(agentId);
      // The form may differ from an agent that no longer exists: nothing to guard.
      formData = { ...agent };
      await goto("/agents");
    } catch (e) {
      toast.error(t("agentsView.errorRemovingAgent"), {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  // ── Activity: the agent's traces, step by step ───────────────────────────────────
  let tracesLoading = $state(false);
  let traceSteps = $state<AgentTraceStep[]>([]);
  let tracesFor = "";

  async function loadTraces() {
    if (!agentId || tracesFor === agentId) return;
    tracesFor = agentId;
    tracesLoading = true;
    try {
      const traces = await listTraces({ agentId, limit: 20 });
      const all: AgentTraceStep[] = [];
      for (const trace of traces) {
        // The step as the API sends it: it already has `toolOutput`.
        all.push(...(await listTraceSteps(trace.id)));
      }
      traceSteps = all.sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } catch {
      traceSteps = [];
    } finally {
      tracesLoading = false;
    }
  }

  $effect(() => {
    if (activeTab === "activity") untrack(() => void loadTraces());
  });

  const statusVariant = (status: string) =>
    status === "active" ? "success" : status === "error" ? "error" : "warning";
  const statusLabel = (status: string) =>
    status === "active"
      ? t("agentsView.status_active")
      : status === "error"
        ? t("agentsView.status_error")
        : t("agentsView.status_paused");

  const tabItems = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: TAB_LABELS[id](),
      count: id === "overview" && pendingProposals?.length ? pendingProposals.length : undefined,
      controls: "agent-panel",
      tabId: `agent-tab-${id}`,
    }))
  );
</script>

<!-- Unsaved settings: ask before leaving the page (the form survives a change of tab). -->
<UnsavedGuard dirty={settingsDirty} />

<Page
  title={agent?.name ?? t("titles.agent")}
  description={agent?.description}
  crumbs={[{ label: agent?.name ?? "…" }]}
>
  {#snippet status()}
    {#if agent}
      <Badge variant={statusVariant(agent.status)} dot data-testid="agent-status">
        {statusLabel(agent.status)}
      </Badge>
    {/if}
  {/snippet}
  {#snippet meta()}
    <span data-testid="agent-meta">{metaParts.join(" · ")}</span>
  {/snippet}
  {#snippet actions()}
    {#if agent}
      <Button variant="secondary" onclick={() => setPlayground(true)} data-testid="open-playground">
        <MessageSquare size={16} aria-hidden="true" />
        {t("idPage.playground")}
      </Button>
    {/if}
  {/snippet}
  {#snippet tabs()}
    {#if agent}
      <Tabs
        items={tabItems}
        bind:value={() => activeTab, selectTab}
        panels={false}
        ariaLabel={agent.name}
      />
    {/if}
  {/snippet}

  {#if loading && !agent}
    <div role="status" aria-busy="true">
      <span class="sr-only">{t("common.loading")}</span>
      <Skeleton lines={8} />
    </div>
  {:else if error && !agent}
    <EmptyState
      variant="error"
      title={t("idPage.errorLoadingAgent")}
      description={error}
      onRetry={loadAgent}
    />
  {:else if agent}
    <div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-{activeTab}">
      {#if activeTab === "overview"}
        <div class="agent-overview">
          <Card>
            <CardHeader><CardTitle level={2}>{t("agentPage.canDo")}</CardTitle></CardHeader>
            <CardContent>
              {#if scopes.length === 0}
                <p class="agent-dim">{t("agentPage.noScopes")}</p>
              {:else}
                <ul class="agent-scopes" aria-label={t("agentPage.canDo")}>
                  {#each scopes as scope (scope)}
                    <li>
                      <Badge variant={scope.startsWith("!") ? "error" : "default"} size="sm">
                        <code>{scope}</code>
                      </Badge>
                    </li>
                  {/each}
                </ul>
                <p class="agent-dim">{t("agentPage.scopesHint")}</p>
              {/if}
              <p class="agent-link">
                <a href="/agents/{agentId}?tab=permissions">{t("agentPage.editPermissions")}</a>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle level={2}>{t("agentPage.waiting")}</CardTitle></CardHeader>
            <CardContent>
              {#if pendingProposals === null}
                <Skeleton lines={3} />
              {:else if pendingProposals.length === 0}
                <p class="agent-dim">{t("agentPage.nothingWaiting")}</p>
              {:else}
                <ul class="agent-pending">
                  {#each pendingProposals as p (p.id)}
                    <li>
                      <a href="/approvals?id={p.id}"><code>{p.method} {p.tool ?? p.path}</code></a>
                      <span class="agent-dim">{dateTime(p.createdAt)}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle level={2}>{t("agentPage.recent")}</CardTitle></CardHeader>
            <CardContent>
              {#if calls !== null}
                <p class="agent-dim">
                  {t("agentPage.callsWeek", { n: calls, failed: failedCalls ?? 0 })}
                </p>
              {/if}
              {#if logs === null}
                <Skeleton lines={4} />
              {:else}
                <Timeline
                  items={logLines}
                  ariaLabel={t("agentPage.recent")}
                  emptyText={t("agentPage.noActivity")}
                />
              {/if}
              <p class="agent-link">
                <a href="/agents/{agentId}?tab=activity">{t("agentPage.allActivity")}</a>
              </p>
            </CardContent>
          </Card>
        </div>
      {:else if activeTab === "permissions"}
        <AgentPermissions {agentId} />
      {:else if activeTab === "keys"}
        <AgentKeys {agentId} />
      {:else if activeTab === "limits"}
        <div class="agent-stack">
          <AgentQuotas {agentId} />
          <AgentMcpSettings {agentId} />
          <AgentApproval {agentId} />
          <AgentPromotion {agentId} />
        </div>
      {:else if activeTab === "activity"}
        <div class="agent-stack">
          <section>
            <h2 class="agent-h">{t("agentPage.traces")}</h2>
            {#if tracesLoading}
              <Skeleton lines={5} />
            {:else if traceSteps.length === 0}
              <EmptyState size="sm" title={t("idPage.noTracesAvailable")} />
            {:else}
              <StepTimeline steps={traceSteps} />
            {/if}
          </section>
          <AgentDecisions {agentId} />
        </div>
      {:else}
        <div class="agent-stack agent-settings">
          <Card>
            <CardHeader><CardTitle level={2}>{t("agentPage.definition")}</CardTitle></CardHeader>
            <CardContent>
              <form
                id="agent-settings-form"
                class="agent-form"
                onsubmit={(e) => {
                  e.preventDefault();
                  void handleSave();
                }}
              >
                <Field label={t("common.name")} required>
                  <Input
                    bind:value={() => formData.name ?? "", (v) => (formData.name = v)}
                    required
                  />
                </Field>
                <Field label={t("common.description")}>
                  <Textarea
                    bind:value={() => formData.description ?? "", (v) => (formData.description = v)}
                    rows={3}
                  />
                </Field>
                <Field label={t("common.model")}>
                  <Select
                    bind:value={() => formData.model ?? "", (v) => (formData.model = v)}
                    placeholder={t("agentPage.noModel")}
                    options={[
                      { value: "gpt-4", label: t("idPage.gpt4") },
                      { value: "gpt-4-turbo", label: t("idPage.gpt4Turbo") },
                      { value: "gpt-3.5-turbo", label: t("idPage.gpt35Turbo") },
                      { value: "claude-3-opus", label: t("idPage.claude3Opus") },
                      { value: "claude-3-sonnet", label: t("idPage.claude3Sonnet") },
                    ]}
                  />
                </Field>
              </form>
              <SaveBar
                form="agent-settings-form"
                sticky={false}
                dirty={settingsDirty}
                {saving}
                disableWhenClean
                saveLabel={t("idPage.saveChanges")}
                cancelLabel={t("record.discard")}
                onCancel={settingsDirty && agent ? () => (formData = { ...agent }) : undefined}
              />
            </CardContent>
          </Card>

          <AgentSponsor {agentId} />
          <AgentVersions {agentId} onRestored={loadAgent} />

          <Card>
            <CardHeader><CardTitle level={2}>{t("agentPage.danger")}</CardTitle></CardHeader>
            <CardContent>
              <p class="agent-dim">{t("agentPage.deleteHint")}</p>
              <p class="agent-link">
                <Button variant="danger-ghost" onclick={handleRemove} data-testid="delete-agent">
                  {t("agentsView.removeAgent")}
                </Button>
              </p>
            </CardContent>
          </Card>
        </div>
      {/if}
    </div>
  {/if}
</Page>

<Sheet
  open={playgroundOpen}
  onClose={() => setPlayground(false)}
  title={t("idPage.playground")}
  description={agent?.name}
  size="xl"
>
  {#if agent}
    <div class="agent-chat" data-testid="playground-sheet">
      <ChatInterface
        {messages}
        loading={chatLoading}
        agentName={agent.name}
        onSend={handleSendMessage}
        class="h-full"
      />
    </div>
  {/if}
</Sheet>

<style>
  .agent-overview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr));
    gap: 1rem;
    align-items: start;
  }
  .agent-stack {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    min-width: 0;
  }
  .agent-settings {
    max-width: 46rem;
  }
  .agent-h {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .agent-dim {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
  .agent-link {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
  }
  .agent-link a,
  .agent-pending a {
    color: rgb(var(--ta-accent));
  }
  .agent-scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
  }
  .agent-pending {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.8125rem;
  }
  .agent-pending li {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .agent-pending code {
    word-break: break-all;
  }
  .agent-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  /* The chat fills the sheet: the message box sits at the bottom of the window. */
  .agent-chat {
    height: 100%;
    min-height: 20rem;
  }
</style>
