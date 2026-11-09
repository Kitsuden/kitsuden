<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { Plus, Bot, Play, Activity, Trash2, Key, Settings } from "lucide-svelte";
  import { onMount } from "svelte";

  import TokenDisplay from "$lib/components/agents/TokenDisplay.svelte";
  import Button from "$lib/components/ui/Button.svelte";
  import Card from "$lib/components/ui/Card.svelte";
  import Modal from "$lib/components/ui/Modal.svelte";
  import { AGENT_PRESETS } from "@kitsuden/shared";
  import { listAgents, createAgent, deleteAgent } from "$lib/services/agents";
  import { Alert, Checkbox, Field, Input, Select, Spinner, Textarea } from "$lib/tallao";
  import type { Agent, CreateAgentInput } from "$lib/types/agents";

  let agents: Agent[] = $state([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let newToken = $state<string | undefined>();

  // Modal states
  let showCreateModal = $state(false);
  let showDeleteModal = $state<string | null>(null);
  let creating = $state(false);

  // Without read permissions, every MCP tool answers «lacks required scope». Read
  // only by default; the rest is adjusted later under Configure.
  const ACCESS_PRESETS = AGENT_PRESETS.filter((p) =>
    ["read-only", "data-editor", "connect-only"].includes(p.id)
  );
  let access = $state("read-only");
  let deleting = $state(false);

  // Form state
  let formData = $state<CreateAgentInput>({
    name: "",
    description: "",
    identityId: "",
    model: "gpt-4",
    enabled: true,
  });

  onMount(async () => {
    await loadAgents();
  });

  async function loadAgents() {
    try {
      loading = true;
      error = null;
      agents = await listAgents();
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentsView.errorLoadingAgents");
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    try {
      creating = true;
      const result = await createAgent({
        ...formData,
        scopes: [...(ACCESS_PRESETS.find((p) => p.id === access)?.scopes ?? ["mcp:connect"])],
      });
      newToken = result.token;
      await loadAgents();
      showCreateModal = false;
      formData = { name: "", description: "", identityId: "", model: "gpt-4", enabled: true };
      access = "read-only";
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentsView.errorCreatingAgent");
    } finally {
      creating = false;
    }
  }

  async function handleDelete(id: string) {
    try {
      deleting = true;
      await deleteAgent(id);
      await loadAgents();
      showDeleteModal = null;
    } catch (e) {
      error = e instanceof Error ? e.message : t("agentsView.errorRemovingAgent");
    } finally {
      deleting = false;
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case "active":
        return "bg-emerald-500";
      case "paused":
        return "bg-amber-500";
      case "error":
        return "bg-red-500";
      default:
        return "bg-zinc-500";
    }
  }
</script>

<div class="p-6 space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-zinc-100">{t("agentsView.agents")}</h1>
      <p class="text-zinc-500 mt-1">{t("agentsView.manageYourAiAgentsAnd")}</p>
    </div>
    <Button variant="primary" onclick={() => (showCreateModal = true)}>
      <Plus size={18} class="mr-2" />
      {t("agentsView.newAgent")}
    </Button>
  </div>

  <!-- Error -->
  {#if error}
    <Alert variant="error" onDismiss={() => (error = null)}>{error}</Alert>
  {/if}

  <!-- Agents Grid -->
  {#if loading}
    <div class="flex items-center justify-center h-64">
      <Spinner size="lg" class="text-kitsuden-accent" />
    </div>
  {:else if agents.length === 0}
    <Card class="p-12 text-center">
      <Bot size={48} class="mx-auto text-zinc-600 mb-4" />
      <h3 class="text-lg font-medium text-zinc-300">{t("agentsView.noAgents")}</h3>
      <p class="text-zinc-500 mt-2 mb-6">{t("agentsView.createsYourFirstAgentFor")}</p>
      <Button variant="primary" onclick={() => (showCreateModal = true)}>
        <Plus size={18} class="mr-2" />
        {t("agentsView.createAgent")}
      </Button>
    </Card>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each agents as agent}
        <Card class="p-5 min-w-0 hover:border-indigo-500/30 transition-colors group">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <div class="p-2 bg-indigo-500/10 rounded-lg shrink-0">
                <Bot size={20} class="text-indigo-400" />
              </div>
              <div class="min-w-0">
                <h3 class="font-medium text-zinc-100 truncate" title={agent.name}>{agent.name}</h3>
                <p class="text-xs text-zinc-500 truncate">{agent.model}</p>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="w-2 h-2 rounded-full {getStatusColor(agent.status)}"></span>
            </div>
          </div>

          {#if agent.description}
            <p class="mt-3 text-sm text-zinc-400 line-clamp-2">{agent.description}</p>
          {/if}

          <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span class="flex items-center gap-1">
              <Activity size={14} />
              {t("agentsView.traces", { v: agent.totalTraces || 0 })}
            </span>
            <span class="flex items-center gap-1">
              <Key size={14} />
              {t("agentsView.tokens", {
                v: agent.totalTokens?.toLocaleString(localeFormat()) || 0,
              })}
            </span>
          </div>

          <!--
            `flex-wrap` + `min-w-0`: in the three-column grid the card
            is ~200 px and "Playground" + "Configure" + the trash button do not fit on
            one line; unable to wrap, the trash button spilled over the edge.
            Now the text buttons wrap to the next line and the trash button stays
            always inside, stuck to the right (`ml-auto`, `shrink-0`).
          -->
          <div
            class="mt-4 pt-4 border-t border-zinc-800 flex flex-wrap items-center gap-2 min-w-0"
            data-testid="agent-card-actions"
          >
            <Button variant="ghost" size="sm" href="/agents/{agent.id}">
              <Play size={16} class="mr-1" />
              {t("agentsView.playground")}
            </Button>
            <Button variant="ghost" size="sm" href="/agents/{agent.id}?tab=settings">
              <Settings size={16} class="mr-1" />
              {t("agentsView.configure")}
            </Button>
            <Button
              variant="danger-ghost"
              size="icon"
              class="ml-auto shrink-0"
              ariaLabel={t("agentsView.removeAgent")}
              title={t("agentsView.removeAgent")}
              onclick={() => (showDeleteModal = agent.id)}
            >
              <Trash2 size={16} />
            </Button>
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<!-- Create Modal -->
<Modal
  open={showCreateModal}
  title={t("agentsView.createNewAgent")}
  description={t("agentsView.configuresANewAiAgent")}
  onClose={() => (showCreateModal = false)}
>
  <form
    class="space-y-4"
    onsubmit={(e) => {
      e.preventDefault();
      handleCreate();
    }}
  >
    <Field label={t("common.name")} required>
      <Input
        bind:value={formData.name}
        placeholder={t("agentsView.myAgent")}
        required
        autocomplete="off"
      />
    </Field>

    <Field label={t("common.description")}>
      <Textarea
        bind:value={() => formData.description ?? "", (v) => (formData.description = v)}
        placeholder={t("agentsView.describesThePurposeOfThis")}
        rows={3}
      />
    </Field>

    <Field label={t("common.model")}>
      <Select
        bind:value={() => formData.model ?? "", (v) => (formData.model = v)}
        options={[
          { value: "gpt-4", label: t("agentsView.gpt4") },
          { value: "gpt-4-turbo", label: t("agentsView.gpt4Turbo") },
          { value: "gpt-3.5-turbo", label: t("agentsView.gpt35Turbo") },
          { value: "claude-3-opus", label: t("agentsView.claude3Opus") },
          { value: "claude-3-sonnet", label: t("agentsView.claude3Sonnet") },
        ]}
      />
    </Field>

    <Field label={t("agentsView.access")}>
      <Select
        bind:value={access}
        options={[
          { value: "read-only", label: t("agentsView.accessReadOnly") },
          { value: "data-editor", label: t("agentsView.accessReadAndEdit") },
          { value: "connect-only", label: t("agentsView.accessConnectOnly") },
        ]}
      />
    </Field>

    <div class="pt-2">
      <Checkbox
        bind:checked={() => formData.enabled ?? true, (v) => (formData.enabled = v)}
        label={t("agentsView.activateImmediately")}
      />
    </div>

    <div class="flex justify-end gap-3 pt-4">
      <Button type="button" variant="secondary" onclick={() => (showCreateModal = false)}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" variant="primary" loading={creating}>{t("common.create")}</Button>
    </div>
  </form>
</Modal>

<!-- Delete Confirmation Modal -->
<Modal
  open={!!showDeleteModal}
  title={t("agentsView.removeAgent")}
  description={t("agentsView.areYouSureThisActionNot")}
  size="sm"
  onClose={() => (showDeleteModal = null)}
>
  <div class="flex justify-end gap-3">
    <Button variant="secondary" onclick={() => (showDeleteModal = null)}
      >{t("common.cancel")}</Button
    >
    <Button
      variant="danger"
      loading={deleting}
      onclick={() => showDeleteModal && handleDelete(showDeleteModal)}
    >
      {t("common.remove")}
    </Button>
  </div>
</Modal>

<!-- Token Display: only after creating an agent (before it always showed, empty, under the list) -->
{#if newToken}
  <TokenDisplay token={newToken} onCopy={() => {}} />
{/if}
