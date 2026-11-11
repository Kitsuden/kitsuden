<!--
  MCP clients connected with OAuth (docs/agents/oauth.md): which app acts
  as which agent, who authorized it and with which scopes. Revoking cuts
  the connection on the next request (tokens, refreshes and their key). An admin
  sees all of them; an editor, the ones they authorized.
-->
<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { Plug, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import Button from "$lib/components/ui/Button.svelte";
  import { listConnections, revokeConnection, type OAuthConnection } from "$lib/services/oauth";

  let connections = $state<OAuthConnection[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let viewRevoked = $state(false);
  let revoking = $state<string | null>(null);

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    try {
      connections = await listConnections({ includeRevoked: viewRevoked });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function revoke(c: OAuthConnection) {
    if (
      !(await confirmDialog(
        t("oauthConnections.confirmRevoke", { client: c.client.name, agent: c.agent.name })
      ))
    )
      return;
    revoking = c.id;
    try {
      await revokeConnection(c.id);
      toast.success(t("oauthConnections.revoked"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      revoking = null;
    }
  }

  const date = (f: string | null) =>
    f ? new Date(f).toLocaleString(localeFormat()) : t("oauthConnections.never");
</script>

<div class="p-6 space-y-4" data-testid="oauth-connections">
  <div class="flex items-start justify-between gap-4">
    <div class="flex items-start gap-3">
      <div class="p-2 rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent">
        <Plug size={20} />
      </div>
      <div>
        <h1 class="text-xl font-semibold text-kitsuden-text">{t("oauthConnections.title")}</h1>
        <p class="text-sm text-kitsuden-text-dim">{t("oauthConnections.help")}</p>
      </div>
    </div>
    <label class="flex items-center gap-2 text-sm text-kitsuden-text-dim">
      <input type="checkbox" bind:checked={viewRevoked} onchange={load} />
      {t("oauthConnections.showRevoked")}
    </label>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-kitsuden-accent"></div>
    </div>
  {:else if error}
    <div
      class="p-4 bg-kitsuden-danger/10 border border-kitsuden-danger/20 rounded-lg text-kitsuden-danger"
    >
      {error}
    </div>
  {:else if connections.length === 0}
    <p class="text-sm text-kitsuden-subtle" data-testid="oauth-connections-empty">
      {t("oauthConnections.empty")}
    </p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-kitsuden-subtle">
          <tr>
            <th class="py-2 pr-3">{t("oauthConnections.client")}</th>
            <th class="py-2 pr-3">{t("oauthConnections.agent")}</th>
            <th class="py-2 pr-3">{t("oauthConnections.grantedBy")}</th>
            <th class="py-2 pr-3">{t("oauthConnections.scopes")}</th>
            <th class="py-2 pr-3">{t("oauthConnections.created")}</th>
            <th class="py-2 pr-3">{t("oauthConnections.lastUsed")}</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each connections as c (c.id)}
            <tr
              class="border-t border-kitsuden-border align-top"
              data-testid="oauth-connection-row"
            >
              <td class="py-2 pr-3 text-kitsuden-text">
                {c.client.name}
                <span class="block text-xs text-kitsuden-subtle break-all">{c.client.id}</span>
              </td>
              <td class="py-2 pr-3"
                ><a class="text-kitsuden-accent hover:underline" href={`/agents/${c.agent.id}`}
                  >{c.agent.name}</a
                ></td
              >
              <td class="py-2 pr-3 text-kitsuden-text"
                >{c.grantedBy.name ?? c.grantedBy.email ?? c.grantedBy.id}</td
              >
              <td class="py-2 pr-3"
                ><code class="text-xs text-kitsuden-text">{c.scopes.join(" ")}</code></td
              >
              <td class="py-2 pr-3 text-kitsuden-text-dim">{date(c.createdAt)}</td>
              <td class="py-2 pr-3 text-kitsuden-text-dim">{date(c.lastUsedAt)}</td>
              <td class="py-2 text-right">
                {#if c.revokedAt}
                  <span class="text-xs text-kitsuden-subtle"
                    >{t("oauthConnections.revokedAt", { date: date(c.revokedAt) })}</span
                  >
                {:else}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-kitsuden-danger"
                    loading={revoking === c.id}
                    onclick={() => revoke(c)}
                  >
                    <Trash2 size={14} class="mr-1" />{t("oauthConnections.revoke")}
                  </Button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
