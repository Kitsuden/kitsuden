<script lang="ts">
  import { t } from "$lib/i18n";
  import {
    Plug,
    Plus,
    RefreshCw,
    Trash2,
    Zap,
    Database as DbIcon,
    Globe,
    TestTube,
    CheckCircle,
    XCircle,
    Loader2,
    X,
    Eye,
    Server,
    Table2,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  interface Connector {
    id: string;
    name: string;
    type: "api" | "database";
    config: Record<string, any>;
    lastSyncedAt?: string;
    enabled: boolean;
    createdAt: string;
  }

  let connectors = $state<Connector[]>([]);
  let loading = $state(true);
  let showCreate = $state(false);
  let testing = $state<string | null>(null);
  let testResults = $state<Record<string, { ok: boolean; message: string }>>({});
  let creating = $state(false);
  let browsing = $state<{
    connectorId: string;
    tables?: string[];
    data?: any[];
    table?: string;
  } | null>(null);

  // Form
  let formName = $state("");
  let formType = $state<"api" | "database">("database");
  // Database fields
  let formHost = $state("localhost");
  let formPort = $state("3306");
  let formDbName = $state("");
  let formUser = $state("");
  let formPass = $state("");
  let formDialect = $state("mysql");
  // API fields
  let formBaseUrl = $state("");
  let formApiKey = $state("");
  let formHeaders = $state("{}");

  onMount(loadConnectors);

  async function loadConnectors() {
    loading = true;
    try {
      const res = await fetch(`${API_URL}/api/custom/connectors`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        connectors = data.docs || [];
      }
    } catch (e) {
      console.error("Failed to load connectors:", e);
    } finally {
      loading = false;
    }
  }

  async function createConnector(e: Event) {
    e.preventDefault();
    creating = true;
    try {
      const config =
        formType === "database"
          ? {
              host: formHost,
              port: Number(formPort),
              database: formDbName,
              user: formUser,
              password: formPass,
              dialect: formDialect,
            }
          : { baseUrl: formBaseUrl, apiKey: formApiKey, headers: JSON.parse(formHeaders || "{}") };

      const res = await fetch(`${API_URL}/api/custom/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: formName, type: formType, config, enabled: true }),
      });
      if (res.ok) {
        showCreate = false;
        resetForm();
        await loadConnectors();
      } else {
        const err = await res.json();
        alert(err.error || t("connectorsView.failedToCreateConnector"));
      }
    } catch (e: any) {
      alert(e.message);
    } finally {
      creating = false;
    }
  }

  async function testConnection(id: string) {
    testing = id;
    try {
      const res = await fetch(`${API_URL}/api/custom/connectors/${id}/test`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      testResults = {
        ...testResults,
        [id]: { ok: data.success || res.ok, message: data.message || data.error || "OK" },
      };
    } catch (e: any) {
      testResults = { ...testResults, [id]: { ok: false, message: e.message } };
    } finally {
      testing = null;
    }
  }

  async function browseConnector(id: string) {
    browsing = { connectorId: id };
    try {
      const res = await fetch(`${API_URL}/api/custom/connectors/${id}/data`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        browsing = { connectorId: id, tables: data.tables || [] };
      }
    } catch (e: any) {
      console.error("Browse failed:", e);
      browsing = null;
    }
  }

  async function browseTable(connectorId: string, table: string) {
    try {
      const res = await fetch(
        `${API_URL}/api/custom/connectors/${connectorId}/data/${table}?limit=50`,
        { credentials: "include" }
      );
      if (res.ok) {
        const data = await res.json();
        browsing = { ...browsing!, table, data: data.rows || data.data || [] };
      }
    } catch (e: any) {
      console.error("Browse table failed:", e);
    }
  }

  async function deleteConnector(id: string) {
    if (!confirm(t("connectorsView.deleteThisConnectorThisCannot"))) return;
    try {
      await fetch(`${API_URL}/api/custom/connectors/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await loadConnectors();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function toggleConnector(id: string, enabled: boolean) {
    try {
      await fetch(`${API_URL}/api/custom/connectors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: !enabled }),
      });
      await loadConnectors();
    } catch (e: any) {
      alert(e.message);
    }
  }

  function resetForm() {
    formName = "";
    formType = "database";
    formHost = "localhost";
    formPort = "3306";
    formDbName = "";
    formUser = "";
    formPass = "";
    formDialect = "mysql";
    formBaseUrl = "";
    formApiKey = "";
    formHeaders = "{}";
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<div class="space-y-6 animate-fade-in">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-kitsuden-text flex items-center gap-3">
        <div
          class="w-10 h-10 rounded-xl bg-gradient-to-br from-kitsuden-purple/20 to-kitsuden-accent/20 border border-kitsuden-purple/20 flex items-center justify-center"
        >
          <Plug class="w-5 h-5 text-kitsuden-purple" />
        </div>
        {t("connectorsView.dataConnectors")}
      </h1>
      <p class="text-sm text-kitsuden-subtle mt-1">
        {t("connectorsView.connectExternalDatabasesMysqlMariadb")}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button class="btn-secondary-sm" onclick={loadConnectors}>
        <RefreshCw class="w-4 h-4" />
      </button>
      <button class="btn-primary" onclick={() => (showCreate = true)}>
        <Plus class="w-4 h-4" />
        {t("connectorsView.newConnector")}
      </button>
    </div>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-purple/10 flex items-center justify-center">
          <Plug class="w-5 h-5 text-kitsuden-purple" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">{connectors.length}</p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("connectorsView.total")}
          </p>
        </div>
      </div>
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center">
          <DbIcon class="w-5 h-5 text-kitsuden-accent" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">
            {connectors.filter((c) => c.type === "database").length}
          </p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("connectorsView.databases")}
          </p>
        </div>
      </div>
    </div>
    <div class="card p-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-lg bg-kitsuden-green/10 flex items-center justify-center">
          <Globe class="w-5 h-5 text-kitsuden-green" />
        </div>
        <div>
          <p class="text-2xl font-bold text-kitsuden-text">
            {connectors.filter((c) => c.type === "api").length}
          </p>
          <p class="text-xs text-kitsuden-subtle uppercase tracking-wider">
            {t("connectorsView.apis")}
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- Create Form -->
  {#if showCreate}
    <form class="card p-6 border-kitsuden-purple/20 space-y-4" onsubmit={createConnector}>
      <div class="flex items-center justify-between">
        <h3 class="font-semibold text-kitsuden-text">{t("connectorsView.newConnector")}</h3>
        <button
          type="button"
          class="p-1 text-kitsuden-subtle hover:text-kitsuden-text"
          onclick={() => {
            showCreate = false;
            resetForm();
          }}
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label for="formname" class="text-xs text-kitsuden-subtle block mb-1"
            >{t("common.name2")}</label
          >
          <input
            id="formname"
            type="text"
            bind:value={formName}
            placeholder={t("connectorsView.eGLegacyMysql")}
            required
            class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
          />
        </div>
        <div>
          <label for="formtype" class="text-xs text-kitsuden-subtle block mb-1"
            >{t("connectorsView.type")}</label
          >
          <select
            id="formtype"
            bind:value={formType}
            class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
          >
            <option value="database">{t("connectorsView.databaseMysqlMariadb")}</option>
            <option value="api">{t("connectorsView.restApi")}</option>
          </select>
        </div>
      </div>

      {#if formType === "database"}
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div class="md:col-span-2">
            <label for="formhost" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.host")}</label
            >
            <input
              id="formhost"
              type="text"
              bind:value={formHost}
              placeholder="localhost"
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label for="formport" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.port")}</label
            >
            <input
              id="formport"
              type="text"
              bind:value={formPort}
              placeholder="3306"
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label for="formdialect" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.dialect")}</label
            >
            <select
              id="formdialect"
              bind:value={formDialect}
              class="w-full bg-kitsuden-bg text-kitsuden-text border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            >
              <option value="mysql">{t("connectorsView.mysql")}</option>
              <option value="mariadb">{t("connectorsView.mariadb")}</option>
            </select>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label for="formdbname" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.database")}</label
            >
            <input
              id="formdbname"
              type="text"
              bind:value={formDbName}
              placeholder="my_database"
              required
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label for="formuser" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.user")}</label
            >
            <input
              id="formuser"
              type="text"
              bind:value={formUser}
              placeholder="root"
              required
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label for="formpass" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("common.password")}</label
            >
            <input
              id="formpass"
              type="password"
              bind:value={formPass}
              placeholder="********"
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label for="formbaseurl" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.baseUrl")}</label
            >
            <input
              id="formbaseurl"
              type="url"
              bind:value={formBaseUrl}
              placeholder="https://api.example.com/v1"
              required
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label for="formapikey" class="text-xs text-kitsuden-subtle block mb-1"
              >{t("connectorsView.apiKey")}</label
            >
            <input
              id="formapikey"
              type="password"
              bind:value={formApiKey}
              placeholder="sk-..."
              class="w-full bg-kitsuden-bg text-kitsuden-text placeholder-kitsuden-text-dim border border-kitsuden-border rounded-lg px-3 py-2 text-sm focus:border-kitsuden-accent/50 focus:outline-none"
            />
          </div>
        </div>
      {/if}

      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="btn-secondary-sm"
          onclick={() => {
            showCreate = false;
            resetForm();
          }}>{t("common.cancel")}</button
        >
        <button type="submit" class="btn-primary" disabled={creating || !formName}>
          {#if creating}<Loader2 class="w-4 h-4 animate-spin" />{/if}
          {t("connectorsView.createConnector")}
        </button>
      </div>
    </form>
  {/if}

  <!-- Connectors List -->
  {#if loading}
    <div class="flex justify-center py-20">
      <div
        class="w-6 h-6 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
      ></div>
    </div>
  {:else if connectors.length === 0 && !showCreate}
    <div class="card p-16 text-center">
      <div class="flex justify-center mb-4">
        <div class="w-16 h-16 rounded-full bg-kitsuden-purple/10 flex items-center justify-center">
          <Plug class="w-8 h-8 text-kitsuden-purple" />
        </div>
      </div>
      <h3 class="text-lg font-medium text-kitsuden-text mb-2">
        {t("connectorsView.noConnectorsConfigured")}
      </h3>
      <p class="text-sm text-kitsuden-subtle mb-4">
        {t("connectorsView.connectExternalDatabasesOrApis")}
      </p>
      <button onclick={() => (showCreate = true)} class="btn-primary">
        <Plus class="w-4 h-4" />
        {t("connectorsView.createFirstConnector")}
      </button>
    </div>
  {:else}
    <div class="space-y-3">
      {#each connectors as conn}
        <div class="card p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
              <div
                class="w-10 h-10 rounded-lg flex items-center justify-center {conn.type ===
                'database'
                  ? 'bg-kitsuden-accent/10'
                  : 'bg-kitsuden-green/10'}"
              >
                {#if conn.type === "database"}
                  <Server class="w-5 h-5 text-kitsuden-accent" />
                {:else}
                  <Globe class="w-5 h-5 text-kitsuden-green" />
                {/if}
              </div>
              <div>
                <h3 class="font-semibold text-kitsuden-text">{conn.name}</h3>
                <div class="flex items-center gap-3 mt-0.5 text-xs text-kitsuden-subtle">
                  <span
                    class="uppercase font-medium {conn.type === 'database'
                      ? 'text-kitsuden-accent'
                      : 'text-kitsuden-green'}">{conn.type}</span
                  >
                  {#if conn.config?.host}
                    <span>{conn.config.host}:{conn.config.port || 3306}</span>
                  {:else if conn.config?.baseUrl}
                    <span class="truncate max-w-[200px]">{conn.config.baseUrl}</span>
                  {/if}
                  {#if conn.lastSyncedAt}
                    <span>{t("connectorsView.lastSync")} {formatDate(conn.lastSyncedAt)}</span>
                  {/if}
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <!-- Test Result -->
              {#if testResults[conn.id]}
                <span
                  class="text-xs px-2 py-1 rounded-full {testResults[conn.id].ok
                    ? 'bg-kitsuden-green/10 text-kitsuden-green'
                    : 'bg-kitsuden-accent-2/10 text-kitsuden-accent-2'}"
                >
                  {#if testResults[conn.id].ok}
                    <CheckCircle class="w-3 h-3 inline mr-1" />
                  {:else}
                    <XCircle class="w-3 h-3 inline mr-1" />
                  {/if}
                  {testResults[conn.id].message}
                </span>
              {/if}

              <button
                class="btn-secondary-sm"
                onclick={() => testConnection(conn.id)}
                disabled={testing === conn.id}
                title={t("connectorsView.testConnection")}
              >
                {#if testing === conn.id}
                  <Loader2 class="w-4 h-4 animate-spin" />
                {:else}
                  <TestTube class="w-4 h-4" />
                {/if}
              </button>

              <button
                class="btn-secondary-sm"
                onclick={() => browseConnector(conn.id)}
                title={t("connectorsView.browseData")}
              >
                <Eye class="w-4 h-4" />
              </button>

              <button
                class="btn-secondary-sm"
                onclick={() => toggleConnector(conn.id, conn.enabled)}
                title={conn.enabled ? t("connectorsView.disable") : t("connectorsView.enable")}
              >
                <Zap
                  class="w-4 h-4 {conn.enabled ? 'text-kitsuden-green' : 'text-kitsuden-subtle'}"
                />
              </button>

              <button
                class="p-2 rounded-lg hover:bg-kitsuden-accent-2/10 text-kitsuden-text-dim hover:text-kitsuden-accent-2 transition-colors"
                onclick={() => deleteConnector(conn.id)}
                title={t("common.delete")}
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Browse Modal -->
  {#if browsing}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        class="bg-kitsuden-card border border-kitsuden-border rounded-2xl shadow-2xl max-w-4xl w-full mx-4 max-h-[80vh] flex flex-col"
      >
        <div class="flex items-center justify-between p-4 border-b border-kitsuden-border">
          <h3 class="text-lg font-semibold text-kitsuden-text flex items-center gap-2">
            <Table2 class="w-5 h-5 text-kitsuden-accent" />
            {t("connectorsView.browse")}
            {connectors.find((c) => c.id === browsing?.connectorId)?.name || ""}
            {#if browsing.table}
              <span class="text-kitsuden-subtle"> / {browsing.table}</span>
            {/if}
          </h3>
          <button
            class="p-1.5 rounded-lg hover:bg-kitsuden-bg text-kitsuden-subtle"
            onclick={() => (browsing = null)}
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="flex-1 overflow-auto p-4">
          {#if !browsing.tables && !browsing.data}
            <div class="flex justify-center py-12">
              <Loader2 class="w-6 h-6 text-kitsuden-accent animate-spin" />
            </div>
          {:else if browsing.tables && !browsing.table}
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              {#each browsing.tables as table}
                <button
                  class="card p-3 text-left hover:border-kitsuden-accent/30 transition-colors"
                  onclick={() => browseTable(browsing!.connectorId, table)}
                >
                  <div class="flex items-center gap-2">
                    <Table2 class="w-4 h-4 text-kitsuden-accent" />
                    <span class="text-sm font-medium text-kitsuden-text">{table}</span>
                  </div>
                </button>
              {/each}
            </div>
          {:else if browsing.data}
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-kitsuden-border">
                    {#each Object.keys(browsing.data[0] || {}) as col}
                      <th class="p-2 text-left text-xs font-semibold uppercase text-kitsuden-subtle"
                        >{col}</th
                      >
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each browsing.data.slice(0, 50) as row}
                    <tr class="border-b border-kitsuden-border/50">
                      {#each Object.values(row) as val}
                        <td class="p-2 text-kitsuden-text-dim text-xs truncate max-w-[200px]">
                          {val === null
                            ? "-"
                            : typeof val === "object"
                              ? JSON.stringify(val).slice(0, 50)
                              : String(val)}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if browsing.data.length === 0}
                <p class="text-center py-8 text-kitsuden-subtle">
                  {t("connectorsView.noRowsFound")}
                </p>
              {/if}
            </div>
            <button
              class="btn-secondary-sm mt-3"
              onclick={() => (browsing = { ...browsing!, table: undefined, data: undefined })}
            >
              {t("connectorsView.backToTables")}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
