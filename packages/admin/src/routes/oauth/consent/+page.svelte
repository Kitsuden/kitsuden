<!--
  OAuth consent for MCP (docs/agents/oauth.md). An MCP client
  (Claude, Cursor…) asked to connect: the human chooses AS WHICH AGENT it acts
  (or creates one, if admin) and which scopes to give it. The scopes only narrow what
  the agent and the human already have; whoever approves becomes the agent's
  signer. The API checks everything again (routes/oauth.ts).
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { AlertTriangle, Bot, Check, KeyRound, X } from "lucide-svelte";
  import { onMount } from "svelte";

  import Page from "$lib/components/layout/Page.svelte";
  import { Alert, Button, Skeleton } from "$lib/tallao";
  import { decide, readConsent, inputScopes, type ConsentView } from "$lib/services/oauth";

  import { page } from "$app/stores";

  const requestId = $page.url.searchParams.get("request") ?? "";

  let view = $state<ConsentView | null>(null);
  let loading = $state(true);
  let sending = $state(false);
  let error = $state<string | null>(null);
  /** agent id, or "__new__" to create one */
  let chosenAgent = $state<string>("");
  let newName = $state("");
  let chosenItems = $state<string[]>([]);

  const NEW = "__new__";

  onMount(async () => {
    if (!requestId) {
      error = t("oauthConsent.missingRequest");
      loading = false;
      return;
    }
    try {
      view = await readConsent(requestId);
      newName = view.client.name;
      if (view.agents.length === 1) choose(view.agents[0]!.id);
      else if (view.agents.length === 0 && view.human.canCreateAgent) choose(NEW);
    } catch (e) {
      error =
        (e as { status?: number }).status === 404
          ? t("oauthConsent.expired")
          : e instanceof Error
            ? e.message
            : String(e);
    } finally {
      loading = false;
    }
  });

  const agent = $derived(view?.agents.find((a) => a.id === chosenAgent) ?? null);

  /** What can be checked: the agent's delegable scopes, or (new agent) the basics + what was requested. */
  const offered = $derived.by(() => {
    if (!view) return [] as string[];
    if (chosenAgent === NEW) {
      return [...new Set([...view.basicScopes, ...view.request.requestedScopes])].filter(
        (s) => !s.startsWith("!")
      );
    }
    return agent?.grantable ?? [];
  });

  function choose(id: string) {
    chosenAgent = id;
    if (!view) return;
    const delegable =
      id === NEW
        ? [...new Set([...view.basicScopes, ...view.request.requestedScopes])]
        : (view.agents.find((a) => a.id === id)?.grantable ?? []);
    chosenItems = inputScopes(view.request.requestedScopes, view.basicScopes, delegable);
  }

  function toggle(s: string) {
    chosenItems = chosenItems.includes(s)
      ? chosenItems.filter((x) => x !== s)
      : [...chosenItems, s];
  }

  const canApprove = $derived(
    !!view &&
      !!chosenAgent &&
      chosenItems.includes("mcp:connect") &&
      (chosenAgent !== NEW || newName.trim().length > 0)
  );

  async function send(decision: "approve" | "deny") {
    if (!view) return;
    sending = true;
    error = null;
    try {
      const r = await decide(
        requestId,
        decision === "deny"
          ? { decision }
          : chosenAgent === NEW
            ? { decision, newAgent: { name: newName.trim() }, scopes: chosenItems }
            : { decision, agentId: chosenAgent, scopes: chosenItems }
      );
      window.location.href = r.redirectTo;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      sending = false;
    }
  }
</script>

<Page
  title={view ? t("oauthConsent.title", { client: view.client.name }) : t("titles.oauthConsent")}
  description={view ? t("oauthConsent.subtitle") : undefined}
  crumbs={[{ label: t("titles.oauthConsent") }]}
>
  <div class="max-w-2xl space-y-6" data-testid="oauth-consent">
    {#if loading}
      <Skeleton lines={5} />
    {:else if !view}
      <div data-testid="oauth-consent-error">
        <Alert variant="error">{error}</Alert>
      </div>
    {:else}
      <section class="p-4 rounded-lg border border-kitsuden-border space-y-1 text-sm">
        <p class="text-kitsuden-text">
          {t("oauthConsent.clientId")}
          <code class="text-xs text-kitsuden-text-dim break-all">{view.client.id}</code>
        </p>
        <p class="text-kitsuden-text">
          {view.client.kind === "cimd" ? t("oauthConsent.kindCimd") : t("oauthConsent.kindDcr")}
        </p>
        <p class="text-kitsuden-text" data-testid="oauth-redirect-host">
          {t("oauthConsent.redirectsTo", { host: view.client.redirectHost })}
        </p>
        {#if view.client.localhostRedirect}
          <p
            class="flex items-start gap-2 text-kitsuden-amber text-xs pt-1"
            data-testid="oauth-localhost-warning"
          >
            <AlertTriangle size={14} class="mt-0.5 shrink-0" />
            {t("oauthConsent.localhostWarning", { host: view.client.redirectHost })}
          </p>
        {/if}
      </section>

      <section class="space-y-2">
        <h2 class="text-sm font-semibold text-kitsuden-text flex items-center gap-2">
          <Bot size={16} />{t("oauthConsent.actAs")}
        </h2>
        {#if view.agents.length === 0 && !view.human.canCreateAgent}
          <p class="text-sm text-kitsuden-amber">{t("oauthConsent.noAgents")}</p>
        {/if}
        {#if view.moreAgents}
          <p class="text-xs text-kitsuden-subtle" data-testid="consent-more-agents">
            {t("oauthConsent.moreAgents")}
          </p>
        {/if}
        {#each view.agents as a (a.id)}
          <label
            class="flex items-start gap-3 p-3 rounded-lg border {chosenAgent === a.id
              ? 'border-kitsuden-accent/60 bg-kitsuden-accent/5'
              : 'border-kitsuden-border'} cursor-pointer"
          >
            <input
              type="radio"
              name="agent"
              checked={chosenAgent === a.id}
              onchange={() => choose(a.id)}
              class="mt-1"
            />
            <span>
              <span class="block text-sm text-kitsuden-text">{a.name}</span>
              {#if a.description}<span class="block text-xs text-kitsuden-subtle"
                  >{a.description}</span
                >{/if}
              {#if a.sponsorUserId && a.sponsorUserId !== view.human.id}
                <span class="block text-xs text-kitsuden-amber"
                  >{t("oauthConsent.signerChanges")}</span
                >
              {/if}
            </span>
          </label>
        {/each}
        {#if view.human.canCreateAgent}
          <label
            class="flex items-start gap-3 p-3 rounded-lg border {chosenAgent === NEW
              ? 'border-kitsuden-accent/60 bg-kitsuden-accent/5'
              : 'border-kitsuden-border'} cursor-pointer"
          >
            <input
              type="radio"
              name="agent"
              checked={chosenAgent === NEW}
              onchange={() => choose(NEW)}
              class="mt-1"
            />
            <span class="flex-1">
              <span class="block text-sm text-kitsuden-text">{t("oauthConsent.newAgent")}</span>
              {#if chosenAgent === NEW}
                <input
                  type="text"
                  bind:value={newName}
                  maxlength="100"
                  aria-label={t("oauthConsent.newAgentName")}
                  placeholder={t("oauthConsent.newAgentName")}
                  class="mt-2 w-full px-3 py-2 bg-kitsuden-bg border border-kitsuden-input rounded-lg text-sm text-kitsuden-text"
                />
              {/if}
            </span>
          </label>
        {/if}
      </section>

      {#if chosenAgent}
        <section class="space-y-2" data-testid="oauth-scopes">
          <h2 class="text-sm font-semibold text-kitsuden-text flex items-center gap-2">
            <KeyRound size={16} />{t("oauthConsent.scopes")}
          </h2>
          <p class="text-xs text-kitsuden-subtle">{t("oauthConsent.scopesHelp")}</p>
          {#if offered.length === 0}
            <p class="text-sm text-kitsuden-amber">{t("oauthConsent.noScopes")}</p>
          {/if}
          <div class="grid gap-1">
            {#each offered as s (s)}
              <label class="flex items-center gap-2 text-sm text-kitsuden-text">
                <input
                  type="checkbox"
                  checked={chosenItems.includes(s)}
                  onchange={() => toggle(s)}
                />
                <code class="text-xs">{s}</code>
                {#if view.request.requestedScopes.includes(s)}
                  <span class="text-xs uppercase tracking-wide text-kitsuden-accent"
                    >{t("oauthConsent.requested")}</span
                  >
                {/if}
              </label>
            {/each}
          </div>
          {#if agent && agent.notDelegable.length}
            <p class="text-xs text-kitsuden-subtle">
              {t("oauthConsent.notDelegable", { scopes: agent.notDelegable.join(", ") })}
            </p>
          {/if}
          {#if agent && agent.denies.length}
            <p class="text-xs text-kitsuden-subtle">
              {t("oauthConsent.denies", { scopes: agent.denies.join(", ") })}
            </p>
          {/if}
          {#if !chosenItems.includes("mcp:connect")}
            <p class="text-xs text-kitsuden-amber">{t("oauthConsent.needsConnect")}</p>
          {/if}
        </section>
      {/if}

      <ul class="text-xs text-kitsuden-subtle list-disc pl-5 space-y-1">
        <li>{t("oauthConsent.ruleSigner")}</li>
        <li>{t("oauthConsent.ruleNarrow")}</li>
        <li>{t("oauthConsent.ruleRevoke")}</li>
      </ul>

      {#if error}
        <div
          class="p-3 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-sm text-kitsuden-danger"
          data-testid="oauth-consent-error"
        >
          {error}
        </div>
      {/if}

      <div class="flex justify-end gap-3">
        <Button variant="ghost" disabled={sending} onclick={() => send("deny")}>
          <X size={14} class="mr-1" />{t("oauthConsent.deny")}
        </Button>
        <Button
          variant="primary"
          loading={sending}
          disabled={!canApprove}
          onclick={() => send("approve")}
        >
          <Check size={14} class="mr-1" />{t("oauthConsent.approve")}
        </Button>
      </div>
    {/if}
  </div>
</Page>
