<!--
  MCP clients connected with OAuth (docs/agents/oauth.md): which app acts
  as which agent, who authorized it and with which scopes. Revoking cuts
  the connection on the next request (tokens, refreshes and their key). An admin
  sees all of them; an editor, the ones they authorized.
-->
<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t, localeFormat } from "$lib/i18n";
  import { onMount } from "svelte";
  import {
    Badge,
    Button,
    EmptyState,
    Skeleton,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
  } from "$lib/tallao";

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

<div class="space-y-4" data-testid="oauth-connections">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <p class="text-sm text-kitsuden-text-dim">{t("oauthConnections.help")}</p>
    <Switch bind:checked={viewRevoked} onchange={load} label={t("oauthConnections.showRevoked")} />
  </div>

  {#if loading}
    <Skeleton lines={4} />
  {:else if error}
    <EmptyState variant="error" size="sm" description={error} onRetry={load} />
  {:else if connections.length === 0}
    <div data-testid="oauth-connections-empty">
      <EmptyState size="sm" level={2} title={t("oauthConnections.empty")} />
    </div>
  {:else}
    <!-- `relative`: the rows hold absolutely positioned (screen-reader) text; without a
         positioned box here it would widen the whole page when the table scrolls. -->
    <div class="relative overflow-x-auto">
      <Table aria-label={t("oauthConnections.title")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("oauthConnections.client")}</TableHead>
            <TableHead>{t("oauthConnections.agent")}</TableHead>
            <TableHead>{t("oauthConnections.grantedBy")}</TableHead>
            <TableHead>{t("oauthConnections.scopes")}</TableHead>
            <TableHead>{t("oauthConnections.created")}</TableHead>
            <TableHead>{t("oauthConnections.lastUsed")}</TableHead>
            <TableHead><span class="sr-only">{t("common.actions")}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each connections as c (c.id)}
            <TableRow data-testid="oauth-connection-row">
              <TableCell>
                <span class="font-medium">{c.client.name}</span>
                <span class="block text-xs text-kitsuden-text-dim break-all">{c.client.id}</span>
              </TableCell>
              <TableCell>
                <a class="text-kitsuden-accent hover:underline" href={`/agents/${c.agent.id}`}>
                  {c.agent.name}
                </a>
              </TableCell>
              <TableCell>{c.grantedBy.name ?? c.grantedBy.email ?? c.grantedBy.id}</TableCell>
              <TableCell><code class="text-xs">{c.scopes.join(" ")}</code></TableCell>
              <TableCell>{date(c.createdAt)}</TableCell>
              <TableCell>{date(c.lastUsedAt)}</TableCell>
              <TableCell class="text-right">
                {#if c.revokedAt}
                  <Badge size="sm"
                    >{t("oauthConnections.revokedAt", { date: date(c.revokedAt) })}</Badge
                  >
                {:else}
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    loading={revoking === c.id}
                    onclick={() => revoke(c)}
                  >
                    {t("oauthConnections.revoke")}
                  </Button>
                {/if}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {/if}
</div>
