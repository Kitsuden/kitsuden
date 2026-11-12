<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import {
    Badge,
    Button,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
    Dialog,
    EmptyState,
    Field,
    Input,
    Select,
    Skeleton,
    Spinner,
    Stat,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
  } from "$lib/tallao";
  import { t } from "$lib/i18n";
  import {
    Plug,
    Plus,
    RefreshCw,
    Trash2,
    Globe,
    TestTube,
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
        toast.error(err.error || t("connectorsView.failedToCreateConnector"));
      }
    } catch (e: any) {
      toast.error(e.message);
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
    if (!(await confirmDialog(t("connectorsView.deleteThisConnectorThisCannot")))) return;
    try {
      await fetch(`${API_URL}/api/custom/connectors/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await loadConnectors();
    } catch (e: any) {
      toast.error(e.message);
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
      toast.error(e.message);
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

<Page
  title={t("connectorsView.dataConnectors")}
  description={t("connectorsView.connectExternalDatabasesMysqlMariadb")}
  crumbs={[{ label: t("connectorsView.dataConnectors") }]}
>
  {#snippet actions()}
    <Button
      variant="secondary"
      size="icon"
      class="connectors-touch"
      onclick={loadConnectors}
      ariaLabel={t("common.retry")}
    >
      <RefreshCw size={16} aria-hidden="true" />
    </Button>
    <Button class="connectors-touch" onclick={() => (showCreate = true)}>
      <Plus size={16} aria-hidden="true" />
      {t("connectorsView.newConnector")}
    </Button>
  {/snippet}
  <div class="connectors">
    <!-- Stats -->
    <div class="connectors-stats">
      <Stat label={t("connectorsView.total")} value={connectors.length} />
      <Stat
        label={t("connectorsView.databases")}
        value={connectors.filter((c) => c.type === "database").length}
      />
      <Stat
        label={t("connectorsView.apis")}
        value={connectors.filter((c) => c.type === "api").length}
      />
    </div>

    <!-- Create Form -->
    {#if showCreate}
      <Card>
        <form onsubmit={createConnector}>
          <CardHeader class="connectors-form-head">
            <CardTitle level={2}>{t("connectorsView.newConnector")}</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              ariaLabel={t("common.cancel")}
              onclick={() => {
                showCreate = false;
                resetForm();
              }}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </CardHeader>
          <CardContent class="connectors-form">
            <div class="connectors-row connectors-row--2">
              <Field label={t("common.name2")}>
                <Input
                  id="formname"
                  bind:value={formName}
                  placeholder={t("connectorsView.eGLegacyMysql")}
                  required
                />
              </Field>
              <Field label={t("connectorsView.type")}>
                <Select
                  id="formtype"
                  value={formType}
                  onchange={(e: Event) =>
                    (formType = (e.currentTarget as HTMLSelectElement).value as "api" | "database")}
                  options={[
                    { value: "database", label: t("connectorsView.databaseMysqlMariadb") },
                    { value: "api", label: t("connectorsView.restApi") },
                  ]}
                />
              </Field>
            </div>

            {#if formType === "database"}
              <div class="connectors-row connectors-row--4">
                <Field label={t("connectorsView.host")} class="connectors-span-2">
                  <Input id="formhost" bind:value={formHost} placeholder="localhost" />
                </Field>
                <Field label={t("connectorsView.port")}>
                  <Input
                    id="formport"
                    inputmode="numeric"
                    bind:value={formPort}
                    placeholder="3306"
                  />
                </Field>
                <Field label={t("connectorsView.dialect")}>
                  <Select
                    id="formdialect"
                    bind:value={formDialect}
                    options={[
                      { value: "mysql", label: t("connectorsView.mysql") },
                      { value: "mariadb", label: t("connectorsView.mariadb") },
                    ]}
                  />
                </Field>
              </div>
              <div class="connectors-row connectors-row--3">
                <Field label={t("connectorsView.database")}>
                  <Input
                    id="formdbname"
                    bind:value={formDbName}
                    placeholder="my_database"
                    required
                  />
                </Field>
                <Field label={t("connectorsView.user")}>
                  <Input id="formuser" bind:value={formUser} placeholder="root" required />
                </Field>
                <Field label={t("common.password")}>
                  <Input
                    id="formpass"
                    type="password"
                    bind:value={formPass}
                    placeholder="********"
                    autocomplete="new-password"
                  />
                </Field>
              </div>
            {:else}
              <div class="connectors-row connectors-row--2">
                <Field label={t("connectorsView.baseUrl")}>
                  <Input
                    id="formbaseurl"
                    type="url"
                    bind:value={formBaseUrl}
                    placeholder="https://api.example.com/v1"
                    required
                  />
                </Field>
                <Field label={t("connectorsView.apiKey")}>
                  <Input
                    id="formapikey"
                    type="password"
                    bind:value={formApiKey}
                    placeholder="sk-..."
                    autocomplete="new-password"
                  />
                </Field>
              </div>
            {/if}
          </CardContent>
          <CardFooter class="connectors-form-foot">
            <Button
              variant="ghost"
              onclick={() => {
                showCreate = false;
                resetForm();
              }}>{t("common.cancel")}</Button
            >
            <Button type="submit" loading={creating} disabled={creating || !formName}>
              {t("connectorsView.createConnector")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    {/if}

    <!-- Connectors List -->
    {#if loading}
      <div class="connectors-loading">
        <Spinner />
      </div>
    {:else if connectors.length === 0 && !showCreate}
      <Card>
        <EmptyState
          icon={emptyIcon}
          title={t("connectorsView.noConnectorsConfigured")}
          description={t("connectorsView.connectExternalDatabasesOrApis")}
          actionLabel={t("connectorsView.createFirstConnector")}
          onAction={() => (showCreate = true)}
        />
      </Card>
    {:else}
      <ul class="connectors-list">
        {#each connectors as conn}
          <li>
            <Card>
              <CardContent class="connector">
                <div class="connector-main">
                  <div
                    class="connector-icon {conn.type === 'database'
                      ? 'connector-icon--db'
                      : 'connector-icon--api'}"
                    aria-hidden="true"
                  >
                    {#if conn.type === "database"}
                      <Server size={20} />
                    {:else}
                      <Globe size={20} />
                    {/if}
                  </div>
                  <div class="connector-text">
                    <h3>{conn.name}</h3>
                    <div class="connector-meta">
                      <Badge variant={conn.type === "database" ? "accent" : "success"}
                        >{conn.type}</Badge
                      >
                      {#if !conn.enabled}
                        <Badge>{t("connectorsView.disabled")}</Badge>
                      {/if}
                      {#if conn.config?.host}
                        <span class="connector-addr"
                          >{conn.config.host}:{conn.config.port || 3306}</span
                        >
                      {:else if conn.config?.baseUrl}
                        <span class="connector-addr">{conn.config.baseUrl}</span>
                      {/if}
                      {#if conn.lastSyncedAt}
                        <span>{t("connectorsView.lastSync")} {formatDate(conn.lastSyncedAt)}</span>
                      {/if}
                    </div>
                    {#if testResults[conn.id]}
                      <Badge
                        variant={testResults[conn.id].ok ? "success" : "error"}
                        dot
                        class="connector-test"
                      >
                        {testResults[conn.id].message}
                      </Badge>
                    {/if}
                  </div>
                </div>

                <div class="connector-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={testing === conn.id}
                    disabled={testing === conn.id}
                    onclick={() => testConnection(conn.id)}
                  >
                    {#if testing !== conn.id}<TestTube size={14} aria-hidden="true" />{/if}
                    {t("connectorsView.testConnection")}
                  </Button>
                  <Button variant="secondary" size="sm" onclick={() => browseConnector(conn.id)}>
                    <Eye size={14} aria-hidden="true" />
                    {t("connectorsView.browseData")}
                  </Button>
                  <Switch
                    size="sm"
                    checked={conn.enabled}
                    label={conn.enabled
                      ? t("connectorsView.enabled")
                      : t("connectorsView.disabled")}
                    onchange={() => toggleConnector(conn.id, conn.enabled)}
                  />
                  <Button
                    variant="danger-ghost"
                    size="icon"
                    ariaLabel={t("common.delete")}
                    title={t("common.delete")}
                    onclick={() => deleteConnector(conn.id)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Browse Modal -->
    <Dialog
      open={browsing !== null}
      onClose={() => (browsing = null)}
      size="2xl"
      title={`${t("connectorsView.browse")} ${
        connectors.find((c) => c.id === browsing?.connectorId)?.name ?? ""
      }${browsing?.table ? ` / ${browsing.table}` : ""}`}
    >
      {#if browsing}
        {#if !browsing.tables && !browsing.data}
          <Skeleton lines={5} />
        {:else if browsing.tables && !browsing.table}
          <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            {#each browsing.tables as table}
              <Button
                variant="secondary"
                class="justify-start!"
                onclick={() => browseTable(browsing!.connectorId, table)}
              >
                <Table2 size={16} aria-hidden="true" />
                {table}
              </Button>
            {/each}
          </div>
        {:else if browsing.data}
          {#if browsing.data.length === 0}
            <EmptyState size="sm" level={null} title={t("connectorsView.noRowsFound")} />
          {:else}
            <Table density="compact" aria-label={browsing.table ?? t("connectorsView.browse")}>
              <TableHeader>
                <TableRow>
                  {#each Object.keys(browsing.data[0] || {}) as col}
                    <TableHead>{col}</TableHead>
                  {/each}
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each browsing.data.slice(0, 50) as row}
                  <TableRow>
                    {#each Object.values(row) as val}
                      <TableCell class="truncate max-w-[200px]">
                        {val === null
                          ? "-"
                          : typeof val === "object"
                            ? JSON.stringify(val).slice(0, 50)
                            : String(val)}
                      </TableCell>
                    {/each}
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          {/if}
        {/if}
      {/if}
      {#snippet footer()}
        {#if browsing?.data}
          <Button
            variant="secondary"
            onclick={() => (browsing = { ...browsing!, table: undefined, data: undefined })}
          >
            {t("connectorsView.backToTables")}
          </Button>
        {/if}
      {/snippet}
    </Dialog>
  </div>
</Page>

{#snippet emptyIcon()}
  <Plug size={32} aria-hidden="true" />
{/snippet}

<style>
  .connectors {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-width: 0;
  }
  .connectors-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
    gap: 1rem;
  }
  :global(.connectors-form-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  :global(.connectors-form) {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .connectors-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }
  @media (min-width: 768px) {
    .connectors-row--2 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .connectors-row--3 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .connectors-row--4 {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    :global(.connectors-span-2) {
      grid-column: span 2;
    }
  }
  :global(.connectors-form-foot) {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .connectors-loading {
    display: flex;
    justify-content: center;
    padding-block: 5rem;
  }
  .connectors-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  :global(.connector) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1rem;
  }
  .connector-main {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    flex: 1 1 18rem;
    min-width: 0;
  }
  .connector-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--ta-radius-lg);
  }
  .connector-icon--db {
    background: rgb(var(--ta-accent) / 0.1);
    color: rgb(var(--ta-accent));
  }
  .connector-icon--api {
    background: rgb(var(--ta-success) / 0.1);
    color: rgb(var(--ta-success));
  }
  .connector-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }
  .connector-text h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .connector-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    font-size: 0.75rem;
    color: rgb(var(--ta-text-dim));
    min-width: 0;
  }
  .connector-addr {
    overflow-wrap: anywhere;
    font-family: var(--ta-font-mono, monospace);
  }
  .connector-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  /* Phone: every control reaches a 44px touch target. */
  @media (max-width: 767px) {
    :global(.connectors-touch),
    .connectors :global(.ta-btn),
    .connectors :global(.ta-input),
    .connectors :global(.ta-select) {
      min-height: 2.75rem;
    }
    :global(.connectors-touch.ta-btn--icon),
    .connectors :global(.ta-btn--icon) {
      min-width: 2.75rem;
    }
    /* The switch's text toggles it too: it is the 44px target beside the small track. */
    .connector-actions :global(.ta-switch-label) {
      display: inline-flex;
      align-items: center;
      min-height: 2.75rem;
    }
  }
</style>
