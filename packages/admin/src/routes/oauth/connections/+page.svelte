<!--
  MCP clients connected with OAuth (docs/agents/oauth.md): which app acts
  as which agent, who authorized it and with which scopes. Revoking cuts
  the connection on the next request (tokens, refreshes and their key). An admin
  sees all of them; an editor, the ones they authorized.
-->
<script lang="ts">
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
      !confirm(t("oauthConnections.confirmRevoke", { client: c.client.name, agent: c.agent.name }))
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
      <div class="p-2 rounded-lg bg-indigo-500/10 text-indigo-300"><Plug size={20} /></div>
      <div>
        <h1 class="text-xl font-semibold text-zinc-100">{t("oauthConnections.title")}</h1>
        <p class="text-sm text-zinc-400">{t("oauthConnections.help")}</p>
      </div>
    </div>
    <label class="flex items-center gap-2 text-sm text-zinc-400">
      <input type="checkbox" bind:checked={viewRevoked} onchange={load} />
      {t("oauthConnections.showRevoked")}
    </label>
  </div>

  {#if loading}
    <div class="flex items-center justify-center h-24">
      <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-500"></div>
    </div>
  {:else if error}
    <div class="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>
  {:else if connections.length === 0}
    <p class="text-sm text-zinc-500" data-testid="oauth-connections-empty">
      {t("oauthConnections.empty")}
    </p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-zinc-500">
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
            <tr class="border-t border-zinc-800 align-top" data-testid="oauth-connection-row">
              <td class="py-2 pr-3 text-zinc-100">
                {c.client.name}
                <span class="block text-xs text-zinc-500 break-all">{c.client.id}</span>
              </td>
              <td class="py-2 pr-3"
                ><a class="text-indigo-300 hover:underline" href={`/agents/${c.agent.id}`}
                  >{c.agent.name}</a
                ></td
              >
              <td class="py-2 pr-3 text-zinc-300"
                >{c.grantedBy.name ?? c.grantedBy.email ?? c.grantedBy.id}</td
              >
              <td class="py-2 pr-3"
                ><code class="text-xs text-zinc-300">{c.scopes.join(" ")}</code></td
              >
              <td class="py-2 pr-3 text-zinc-400">{date(c.createdAt)}</td>
              <td class="py-2 pr-3 text-zinc-400">{date(c.lastUsedAt)}</td>
              <td class="py-2 text-right">
                {#if c.revokedAt}
                  <span class="text-xs text-zinc-500"
                    >{t("oauthConnections.revokedAt", { date: date(c.revokedAt) })}</span
                  >
                {:else}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-red-400"
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
