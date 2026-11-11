<!--
  Agents, on the list template: name (a link to the agent's page), state, type or model,
  scopes, rate limit, the proposals of each agent that wait for a person, last change.
  Filters come from the fields (state, type); the row menu opens the page, its settings or
  the playground, and deletes.

  "New agent" opens the create dialog (`/agents?new=1` opens it too: the command palette
  links there). The key of a new agent is shown once, with a copy button (TokenDisplay).
-->
<script lang="ts">
  import { AGENT_PRESETS } from "@kitsuden/shared";
  import { untrack } from "svelte";

  import { agentRow, pendingByAgent } from "$lib/agents/agent-rows";
  import { isStaff } from "$lib/auth.svelte";
  import TokenDisplay from "$lib/components/agents/TokenDisplay.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import { t } from "$lib/i18n";
  import { memorySource, type Row } from "$lib/list/source";
  import { setQuery } from "$lib/page";
  import { createAgent, deleteAgent, listAgents } from "$lib/services/agents";
  import { listProposals } from "$lib/services/approvals";
  import {
    Alert,
    Button,
    Checkbox,
    Dialog,
    Field,
    Input,
    MenuItem,
    Select,
    Textarea,
  } from "$lib/tallao";
  import type { Agent, CreateAgentInput } from "$lib/types/agents";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  let agents = $state<Agent[]>([]);
  let pending = $state(new Map<string, number>());
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let total = $state<number | null>(null);
  let reloadKey = $state(0);
  let newToken = $state<string | undefined>();

  // Without read permissions, every MCP tool answers "lacks required scope". Read only by
  // default; the rest is adjusted later on the agent's page.
  const ACCESS_PRESETS = AGENT_PRESETS.filter((p) =>
    ["read-only", "data-editor", "connect-only"].includes(p.id)
  );
  const emptyForm = (): CreateAgentInput => ({
    name: "",
    description: "",
    identityId: "",
    model: "gpt-4",
    enabled: true,
  });
  let access = $state("read-only");
  let formData = $state<CreateAgentInput>(emptyForm());
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // The create dialog is `?new=1`: a link opens it, and Back closes it.
  const creatingOpen = $derived($page.url.searchParams.get("new") === "1");
  function setCreating(open: boolean) {
    if (open === creatingOpen) return;
    createError = null;
    void setQuery($page.url, { new: open ? "1" : null }, { replace: !open });
  }

  async function load() {
    loadError = null;
    try {
      const [list, proposals] = await Promise.all([
        listAgents(),
        // The counter of what waits is the team's; without it the column stays at zero.
        isStaff()
          ? listProposals({ status: "pending", limit: 200 })
              .then((r) => r.proposals)
              .catch(() => [])
          : Promise.resolve([]),
      ]);
      agents = list;
      pending = pendingByAgent(proposals);
    } catch (e) {
      loadError = e instanceof Error ? e.message : t("agentsView.errorLoadingAgents");
    } finally {
      loaded = true;
      reloadKey += 1;
    }
  }

  $effect(() => {
    untrack(() => void load());
  });

  const typeOptions = $derived(
    [...new Set(agents.map((a) => a.model ?? a.type ?? "").filter(Boolean))]
      .sort()
      .map((value) => ({ value, label: value }))
  );

  const source = $derived(
    memorySource({
      id: "agents",
      label: t("shell.agents"),
      singular: t("agentPage.agent"),
      titleField: "name",
      fields: [
        { key: "name", label: t("common.name"), kind: "text", sortable: true },
        {
          key: "status",
          label: t("common.status"),
          kind: "select",
          sortable: true,
          options: [
            { value: "active", label: t("agentsView.status_active") },
            { value: "paused", label: t("agentsView.status_paused") },
            { value: "error", label: t("agentsView.status_error") },
          ],
        },
        {
          key: "kind",
          label: t("agentPage.kind"),
          kind: "select",
          sortable: true,
          options: typeOptions,
        },
        { key: "pending", label: t("agentPage.pendingColumn"), kind: "number", sortable: true },
        { key: "scopes", label: t("agentPage.scopesColumn"), kind: "number", sortable: true },
        { key: "rateLimit", label: t("agentPage.rateLimitColumn"), kind: "number", sortable: true },
        { key: "description", label: t("common.description"), kind: "text", hidden: true },
        { key: "updatedAt", label: t("agentPage.updatedColumn"), kind: "datetime", sortable: true },
      ],
      rows: () => agents.map((agent) => agentRow(agent, pending)),
      remove: async (id) => {
        await deleteAgent(id);
        agents = agents.filter((a) => a.id !== id);
      },
    })
  );

  async function handleCreate() {
    if (creating) return;
    createError = null;
    try {
      creating = true;
      const result = await createAgent({
        ...formData,
        scopes: [...(ACCESS_PRESETS.find((p) => p.id === access)?.scopes ?? ["mcp:connect"])],
      });
      newToken = result.token;
      formData = emptyForm();
      access = "read-only";
      setCreating(false);
      await load();
    } catch (e) {
      createError = e instanceof Error ? e.message : t("agentsView.errorCreatingAgent");
    } finally {
      creating = false;
    }
  }

  const hrefFor = (row: Row) => `/agents/${String(row.id)}`;
</script>

<Page title={t("shell.agents")} description={t("agentsView.manageYourAiAgentsAnd")}>
  {#snippet meta()}
    {#if total !== null}
      {total === 1 ? t("agentPage.countOne") : t("agentPage.count", { n: total })}
    {/if}
  {/snippet}
  {#snippet actions()}
    <Button onclick={() => setCreating(true)} data-testid="new-agent">
      {t("agentsView.newAgent")}
    </Button>
  {/snippet}

  <ListView
    {source}
    bind:total
    {reloadKey}
    {hrefFor}
    pending={!loaded}
    {loadError}
    onRetry={load}
    onNew={() => setCreating(true)}
    emptyTitle={t("agentsView.noAgents")}
    emptyDescription={t("agentsView.createsYourFirstAgentFor")}
  >
    {#snippet rowMenu(row)}
      <MenuItem onSelect={() => goto(`${hrefFor(row)}?tab=settings`)}>
        {t("agentsView.configure")}
      </MenuItem>
      <MenuItem onSelect={() => goto(`${hrefFor(row)}?playground=1`)}>
        {t("agentsView.playground")}
      </MenuItem>
    {/snippet}
  </ListView>
</Page>

<Dialog
  open={creatingOpen}
  onOpenChange={setCreating}
  title={t("agentsView.createNewAgent")}
  description={t("agentsView.configuresANewAiAgent")}
>
  <form
    class="space-y-4"
    data-testid="create-agent-form"
    onsubmit={(e) => {
      e.preventDefault();
      void handleCreate();
    }}
  >
    {#if createError}<Alert variant="error">{createError}</Alert>{/if}

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

    <Checkbox
      bind:checked={() => formData.enabled ?? true, (v) => (formData.enabled = v)}
      label={t("agentsView.activateImmediately")}
    />

    <div class="flex justify-end gap-3 pt-2">
      <Button type="button" variant="secondary" onclick={() => setCreating(false)}>
        {t("common.cancel")}
      </Button>
      <Button type="submit" loading={creating}>{t("common.create")}</Button>
    </div>
  </form>
</Dialog>

<!-- The key of the agent just created: shown once, with a copy button. -->
{#if newToken}
  {#key newToken}
    <TokenDisplay token={newToken} onCopy={() => {}} />
  {/key}
{/if}
