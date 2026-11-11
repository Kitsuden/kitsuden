<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import {
    Button,
    EmptyState,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr } from "$lib/i18n";
  /**
   * KITSUDEN Vault — Dynamic schemas panel (KITSUDEN architecture §3)
   *
   * Real CREATE/ALTER TABLE in PostgreSQL with automatic RLS, behind the
   * KITSUDEN_VAULT_ENABLED feature flag. It coexists with the JSONB Dataset Engine:
   * Vault is the opt-in path when you need native types and indexes.
   * Data reads via the Graphify Engine (/api/graph/vault_<collection>).
   */
  import {
    Archive,
    Plus,
    Trash2,
    RefreshCw,
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Copy,
    Columns3,
    X,
    ShieldCheck,
  } from "lucide-svelte";
  import { onMount } from "svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  const COLUMN_TYPES = [
    "text",
    "varchar",
    "integer",
    "bigint",
    "numeric",
    "boolean",
    "timestamp",
    "date",
    "uuid",
    "jsonb",
  ] as const;

  interface VaultColumn {
    name: string;
    type: string;
    nullable?: boolean;
    isPrimaryKey?: boolean;
  }

  interface VaultCollection {
    collection: string;
    table: string;
    columns: VaultColumn[];
    estimatedRowCount: number;
  }

  interface DraftColumn {
    name: string;
    type: (typeof COLUMN_TYPES)[number];
    required: boolean;
    unique: boolean;
    indexed: boolean;
  }

  let collections = $state<VaultCollection[]>([]);
  let loading = $state(true);
  let vaultDisabled = $state(false);
  let error = $state<string | null>(null);
  let successMsg = $state<string | null>(null);
  let expanded = $state<Set<string>>(new Set());

  // Create collection
  let showCreate = $state(false);
  let newCollection = $state("");
  let draftColumns = $state<DraftColumn[]>([
    { name: "", type: "text", required: false, unique: false, indexed: false },
  ]);
  let creating = $state(false);

  // Add column to an existing collection
  let addColTarget = $state<string | null>(null);
  let addColDraft = $state<DraftColumn>({
    name: "",
    type: "text",
    required: false,
    unique: false,
    indexed: false,
  });

  // Deletion with confirmation by name
  let dropTarget = $state<string | null>(null);
  let dropConfirmText = $state("");

  const NAME_RE = /^[a-z][a-z0-9_]{0,50}$/;
  const RESERVED = new Set(["id", "owner_id", "created_at", "updated_at"]);

  function flash(msg: string) {
    successMsg = msg;
    setTimeout(() => (successMsg = null), 3500);
  }

  function toggleExpand(collection: string) {
    const next = new Set(expanded);
    if (next.has(collection)) next.delete(collection);
    else next.add(collection);
    expanded = next;
  }

  /** The vault could not be read at all: shown instead of "no collections", with Retry. */
  let loadError = $state<string | null>(null);

  async function fetchCollections() {
    loading = true;
    error = null;
    loadError = null;
    try {
      const res = await fetch(`${API_URL}/api/admin/vault`, { credentials: "include" });
      if (res.status === 503) {
        vaultDisabled = true;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      vaultDisabled = false;
      collections = data.collections ?? [];
    } catch (e) {
      loadError = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function addDraftColumn() {
    draftColumns = [
      ...draftColumns,
      { name: "", type: "text", required: false, unique: false, indexed: false },
    ];
  }

  function removeDraftColumn(i: number) {
    draftColumns = draftColumns.filter((_, idx) => idx !== i);
  }

  const draftValid = $derived(
    NAME_RE.test(newCollection) &&
      draftColumns.length > 0 &&
      draftColumns.every((c) => NAME_RE.test(c.name) && !RESERVED.has(c.name)) &&
      new Set(draftColumns.map((c) => c.name)).size === draftColumns.length
  );

  async function createCollection() {
    if (!draftValid) return;
    creating = true;
    error = null;
    try {
      const res = await fetch(`${API_URL}/api/admin/vault`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ collection: newCollection, columns: draftColumns }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(tr("vaultView.realVaultTableCreatedWith", { newCollection }));
      showCreate = false;
      newCollection = "";
      draftColumns = [{ name: "", type: "text", required: false, unique: false, indexed: false }];
      await fetchCollections();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      creating = false;
    }
  }

  async function addColumn(collection: string) {
    if (!NAME_RE.test(addColDraft.name) || RESERVED.has(addColDraft.name)) return;
    error = null;
    try {
      const res = await fetch(
        `${API_URL}/api/admin/vault/${encodeURIComponent(collection)}/columns`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(addColDraft),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(tr("vaultView.columnAddedHot", { name: addColDraft.name }));
      addColTarget = null;
      addColDraft = { name: "", type: "text", required: false, unique: false, indexed: false };
      await fetchCollections();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function dropColumn(collection: string, column: string) {
    if (!(await confirmDialog(tr("vaultView.removeVaultColumn", { column, collection })))) return;
    error = null;
    try {
      const res = await fetch(
        `${API_URL}/api/admin/vault/${encodeURIComponent(collection)}/columns/${encodeURIComponent(column)}`,
        { method: "DELETE", credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(tr("vaultView.removedColumn", { column }));
      await fetchCollections();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function dropCollection(collection: string) {
    if (dropConfirmText !== collection) return;
    error = null;
    try {
      const res = await fetch(
        `${API_URL}/api/admin/vault/${encodeURIComponent(collection)}?confirm=${encodeURIComponent(collection)}`,
        { method: "DELETE", credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      flash(`vault_${collection} deleted (DROP TABLE)`);
      dropTarget = null;
      dropConfirmText = "";
      await fetchCollections();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function copyEndpoint(table: string) {
    await navigator.clipboard.writeText(`${API_URL || window.location.origin}/api/graph/${table}`);
    flash(tr("vaultView.graphifyEndpointCopiedToClipboard"));
  }

  onMount(fetchCollections);
</script>

<Page title={tr("shell.vault")}>
  {#snippet actions()}
    {#if !vaultDisabled}
      <Button onclick={() => (showCreate = !showCreate)}>
        <Plus size={16} aria-hidden="true" />
        {tr("vaultView.newCollection")}
      </Button>
    {/if}
  {/snippet}
  <div class="space-y-6">
    <p class="text-sm text-kitsuden-text-dim">
      {tr("vaultView.dynamicSchemasWith")}
      <code class="text-kitsuden-accent text-xs">CREATE/ALTER TABLE</code>
      {tr("vaultView.realRlsAutomaticServedData")}
    </p>

    {#if error}
      <div
        class="flex items-center gap-2 p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/30 text-kitsuden-accent-2 text-sm"
      >
        <AlertCircle class="w-4 h-4 shrink-0" />
        {error}
        <button class="ml-auto" onclick={() => (error = null)}><X class="w-4 h-4" /></button>
      </div>
    {/if}
    {#if successMsg}
      <div
        class="flex items-center gap-2 p-3 rounded-lg bg-kitsuden-green/10 border border-kitsuden-green/30 text-kitsuden-green text-sm"
      >
        <CheckCircle2 class="w-4 h-4 shrink-0" />
        {successMsg}
      </div>
    {/if}

    {#if loading}
      <div class="flex items-center justify-center py-16 text-kitsuden-subtle text-sm">
        <RefreshCw class="w-4 h-4 animate-spin mr-2" />
        {tr("vaultView.loadingVault")}
      </div>
    {:else if loadError}
      <EmptyState
        variant="error"
        title={tr("vaultView.loadFailed")}
        description={loadError}
        onRetry={fetchCollections}
      />
    {:else if vaultDisabled}
      <!-- Feature flag off: discovery screen -->
      <div class="rounded-xl border border-dashed border-kitsuden-border p-8 text-center space-y-3">
        <Archive class="w-10 h-10 text-kitsuden-subtle mx-auto" />
        <h2 class="text-kitsuden-text font-medium">{tr("vaultView.kitsudenVaultIsDisabled")}</h2>
        <p class="text-sm text-kitsuden-subtle max-w-lg mx-auto">
          {tr("vaultView.vaultCreatesPostgresqlTables")} <strong>{tr("vaultView.real")}</strong>
          {tr("vaultView.withIndexesNativeTypesAnd")}
        </p>
        <div
          class="inline-block text-left rounded-lg bg-kitsuden-card border border-kitsuden-border px-4 py-3 font-mono text-xs text-kitsuden-accent"
        >
          {tr("vaultView.env")}<br />{tr("vaultView.kitsudenVaultEnabledTrue")}
        </div>
        <p class="text-xs text-kitsuden-subtle">{tr("vaultView.restartsApiAndReloads")}</p>
      </div>
    {:else}
      <!-- Create collection -->
      {#if showCreate}
        <div class="p-4 rounded-xl bg-kitsuden-card border border-kitsuden-border space-y-4">
          <div>
            <label class="block text-xs text-kitsuden-subtle mb-1" for="vault-name"
              >{tr("vaultView.snakeCollectionName")} <code>vault_&lt;name&gt;</code>)</label
            >
            <input
              id="vault-name"
              class="w-full md:w-72 px-3 py-2 text-sm rounded-lg bg-kitsuden-bg border {newCollection ===
                '' || NAME_RE.test(newCollection)
                ? 'border-kitsuden-input'
                : 'border-kitsuden-accent-2'} text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
              placeholder={tr("vaultView.exampleCollection")}
              bind:value={newCollection}
            />
          </div>

          <div class="space-y-2">
            <div class="text-xs text-kitsuden-subtle flex items-center gap-2">
              <Columns3 class="w-4 h-4" />
              {tr("vaultView.columns")}
              <span class="text-kitsuden-subtle">{tr("vaultView.idOwnerIdCreatedAt")}</span>
            </div>
            {#each draftColumns as col, i (i)}
              <div class="flex flex-wrap items-center gap-2">
                <input
                  class="w-44 px-3 py-1.5 text-sm rounded-lg bg-kitsuden-bg border {col.name ===
                    '' ||
                  (NAME_RE.test(col.name) && !RESERVED.has(col.name))
                    ? 'border-kitsuden-input'
                    : 'border-kitsuden-accent-2'} text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
                  placeholder={tr("vaultView.exampleColumn")}
                  bind:value={col.name}
                />
                <select
                  class="px-2 py-1.5 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text focus:border-kitsuden-accent outline-hidden"
                  bind:value={col.type}
                >
                  {#each COLUMN_TYPES as t (t)}
                    <option value={t}>{t}</option>
                  {/each}
                </select>
                <label class="flex items-center gap-1 text-xs text-kitsuden-subtle cursor-pointer">
                  <input type="checkbox" bind:checked={col.required} class="accent-[#a855f7]" />
                  {tr("vaultView.notNull")}
                </label>
                <label class="flex items-center gap-1 text-xs text-kitsuden-subtle cursor-pointer">
                  <input type="checkbox" bind:checked={col.unique} class="accent-[#a855f7]" />
                  {tr("vaultView.unique")}
                </label>
                <label class="flex items-center gap-1 text-xs text-kitsuden-subtle cursor-pointer">
                  <input type="checkbox" bind:checked={col.indexed} class="accent-[#a855f7]" />
                  {tr("vaultView.index")}
                </label>
                {#if draftColumns.length > 1}
                  <button
                    class="p-1 text-kitsuden-subtle hover:text-kitsuden-accent-2"
                    onclick={() => removeDraftColumn(i)}
                  >
                    <X class="w-4 h-4" />
                  </button>
                {/if}
              </div>
            {/each}
            <button
              class="text-xs text-kitsuden-accent hover:underline flex items-center gap-1"
              onclick={addDraftColumn}
            >
              <Plus class="w-3 h-3" />
              {tr("vaultView.addColumn")}
            </button>
          </div>

          <div class="flex items-center gap-2">
            <button
              class="px-4 py-2 text-sm rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/30 hover:bg-kitsuden-accent/20 transition-colors disabled:opacity-50"
              onclick={createCollection}
              disabled={creating || !draftValid}
            >
              {creating ? tr("vaultView.creating") : tr("vaultView.createTableRls")}
            </button>
            <button
              class="px-4 py-2 text-sm rounded-lg text-kitsuden-subtle hover:text-kitsuden-text"
              onclick={() => (showCreate = false)}
            >
              {tr("common.cancel")}
            </button>
          </div>
        </div>
      {/if}

      <!-- Collections list -->
      {#if collections.length === 0}
        <div
          class="flex flex-col items-center justify-center py-12 rounded-xl border border-dashed border-kitsuden-border text-center"
        >
          <Archive class="w-8 h-8 text-kitsuden-subtle mb-3" />
          <p class="text-sm text-kitsuden-text font-medium">
            {tr("vaultView.withoutVaultCollections")}
          </p>
          <p class="text-xs text-kitsuden-subtle mt-1">
            {tr("vaultView.createsTheFirstAndConsumeIt")}
            <code>/api/graph/vault_&lt;name&gt;</code>.
          </p>
        </div>
      {:else}
        <div class="space-y-3">
          {#each collections as col (col.table)}
            <div class="rounded-xl border border-kitsuden-border bg-kitsuden-card overflow-hidden">
              <div class="flex items-center gap-3 px-4 py-3">
                <button class="text-kitsuden-subtle" onclick={() => toggleExpand(col.collection)}>
                  {#if expanded.has(col.collection)}
                    <ChevronDown class="w-4 h-4" />
                  {:else}
                    <ChevronRight class="w-4 h-4" />
                  {/if}
                </button>
                <div class="flex-1 min-w-0">
                  <div class="font-mono text-sm text-kitsuden-text">{col.table}</div>
                  <div class="text-xs text-kitsuden-subtle">
                    {tr("vaultView.columnsRows", {
                      columnsCount: col.columns.length,
                      estimatedRowCount: col.estimatedRowCount,
                    })}
                    <ShieldCheck class="w-3 h-3 inline text-kitsuden-green" />
                    {tr("vaultView.rlsEnabled")}
                  </div>
                </div>
                <button
                  class="flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-kitsuden-accent hover:bg-kitsuden-accent/10 font-mono"
                  title={tr("vaultView.copyGraphifyEndpoint")}
                  onclick={() => copyEndpoint(col.table)}
                >
                  <Copy class="w-3 h-3" />
                  {tr("vaultView.apiGraph", { table: col.table })}
                </button>
                {#if dropTarget === col.collection}
                  <input
                    class="w-36 px-2 py-1 text-xs rounded-lg bg-kitsuden-bg border border-kitsuden-accent-2/50 text-kitsuden-text font-mono outline-hidden"
                    placeholder={tr("vaultView.writes", { collection: col.collection })}
                    bind:value={dropConfirmText}
                  />
                  <button
                    class="px-2 py-1 rounded-lg text-xs bg-kitsuden-accent-2/10 text-kitsuden-accent-2 border border-kitsuden-accent-2/30 disabled:opacity-40"
                    disabled={dropConfirmText !== col.collection}
                    onclick={() => dropCollection(col.collection)}
                  >
                    {tr("vaultView.drop")}
                  </button>
                  <button
                    class="p-1 text-kitsuden-subtle hover:text-kitsuden-text"
                    onclick={() => {
                      dropTarget = null;
                      dropConfirmText = "";
                    }}
                  >
                    <X class="w-4 h-4" />
                  </button>
                {:else}
                  <button
                    class="p-1.5 rounded-lg text-kitsuden-subtle hover:text-kitsuden-accent-2 hover:bg-kitsuden-accent-2/10 transition-colors"
                    title={tr("vaultView.dropTableConfirmationByName")}
                    onclick={() => (dropTarget = col.collection)}
                  >
                    <Trash2 class="w-4 h-4" />
                  </button>
                {/if}
              </div>

              {#if expanded.has(col.collection)}
                <div class="border-t border-kitsuden-border px-4 py-3 space-y-3">
                  <Table density="compact">
                    <TableHeader>
                      <TableRow>
                        <TableHead class="text-left">{tr("vaultView.column")}</TableHead>
                        <TableHead class="text-left">{tr("vaultView.type")}</TableHead>
                        <TableHead class="text-left">{tr("vaultView.nullable")}</TableHead>
                        <TableHead class="text-right"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {#each col.columns as c (c.name)}
                        <TableRow>
                          <TableCell class="font-mono">
                            {c.name}
                            {#if c.isPrimaryKey}<span class="text-kitsuden-amber ml-1"
                                >{tr("vaultView.pk")}</span
                              >{/if}
                          </TableCell>
                          <TableCell class="font-mono">{c.type}</TableCell>
                          <TableCell>{c.nullable ? tr("vaultView.si") : "no"}</TableCell>
                          <TableCell class="text-right">
                            {#if !RESERVED.has(c.name)}
                              <button
                                class="text-kitsuden-subtle hover:text-kitsuden-accent-2"
                                title={tr("vaultView.dropColumn")}
                                onclick={() => dropColumn(col.collection, c.name)}
                              >
                                <Trash2 class="w-3.5 h-3.5" />
                              </button>
                            {/if}
                          </TableCell>
                        </TableRow>
                      {/each}
                    </TableBody>
                  </Table>

                  {#if addColTarget === col.collection}
                    <div class="flex flex-wrap items-center gap-2">
                      <input
                        class="w-44 px-3 py-1.5 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text font-mono focus:border-kitsuden-accent outline-hidden"
                        placeholder={tr("vaultView.exampleNewColumn")}
                        bind:value={addColDraft.name}
                      />
                      <select
                        class="px-2 py-1.5 text-sm rounded-lg bg-kitsuden-bg border border-kitsuden-input text-kitsuden-text outline-hidden"
                        bind:value={addColDraft.type}
                      >
                        {#each COLUMN_TYPES as t (t)}
                          <option value={t}>{t}</option>
                        {/each}
                      </select>
                      <label
                        class="flex items-center gap-1 text-xs text-kitsuden-subtle cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          bind:checked={addColDraft.unique}
                          class="accent-[#a855f7]"
                        />
                        {tr("vaultView.unique")}
                      </label>
                      <label
                        class="flex items-center gap-1 text-xs text-kitsuden-subtle cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          bind:checked={addColDraft.indexed}
                          class="accent-[#a855f7]"
                        />
                        {tr("vaultView.index")}
                      </label>
                      <button
                        class="px-3 py-1.5 text-xs rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/30 disabled:opacity-40"
                        disabled={!NAME_RE.test(addColDraft.name) || RESERVED.has(addColDraft.name)}
                        onclick={() => addColumn(col.collection)}
                      >
                        {tr("vaultView.alterTableAdd")}
                      </button>
                      <button
                        class="p-1 text-kitsuden-subtle hover:text-kitsuden-text"
                        onclick={() => (addColTarget = null)}
                      >
                        <X class="w-4 h-4" />
                      </button>
                    </div>
                  {:else}
                    <button
                      class="text-xs text-kitsuden-accent hover:underline flex items-center gap-1"
                      onclick={() => (addColTarget = col.collection)}
                    >
                      <Plus class="w-3 h-3" />
                      {tr("vaultView.addColumnAlterTableIn")}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
        <p class="text-xs text-kitsuden-subtle">
          {tr("vaultView.theNewColumnsEnterAs")} <code>apps/api/drizzle/vault/</code>.
        </p>
      {/if}
    {/if}
  </div>
</Page>
