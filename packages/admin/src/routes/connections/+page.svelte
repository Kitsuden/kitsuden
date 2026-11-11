<!--
  Connections: who can reach this installation from outside. OAuth clients (the MCP
  clients people connected, and their revocation) and the external MCP servers agents may
  call (admin only), as tabs. /oauth/connections and /mcp-servers land here.
-->
<script lang="ts">
  import { isAdmin } from "$lib/auth.svelte";
  import McpServers from "$lib/components/connections/McpServers.svelte";
  import OAuthClients from "$lib/components/connections/OAuthClients.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import { t } from "$lib/i18n";
  import { queryChoice, setQuery } from "$lib/page";
  import { Tabs, type TabItem } from "$lib/tallao";

  import { page } from "$app/stores";

  // The external servers are an administrator's: an editor only sees the OAuth clients.
  const TABS = $derived(isAdmin() ? (["oauth", "mcp"] as const) : (["oauth"] as const));
  const active = $derived(queryChoice($page.url, "tab", TABS, "oauth"));
  const items = $derived<TabItem[]>(
    TABS.map((id) => ({
      id,
      label: id === "mcp" ? t("connections.tabMcp") : t("connections.tabOauth"),
      controls: "connections-panel",
      tabId: `connections-tab-${id}`,
    }))
  );
  const select = (tab: string) => void setQuery($page.url, { tab: tab === "oauth" ? null : tab });
</script>

<Page title={t("shell.connections")} description={t("connections.description")}>
  {#snippet tabs()}
    <Tabs
      {items}
      bind:value={() => active, select}
      panels={false}
      ariaLabel={t("shell.connections")}
    />
  {/snippet}

  <div id="connections-panel" role="tabpanel" aria-labelledby="connections-tab-{active}">
    {#if active === "mcp"}
      <McpServers />
    {:else}
      <OAuthClients />
    {/if}
  </div>
</Page>
