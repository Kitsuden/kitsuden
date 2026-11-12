<script lang="ts">
  import Page from "$lib/components/layout/Page.svelte";
  import {
    Alert,
    Badge,
    Button,
    Card,
    CardContent,
    Checkbox,
    EmptyState,
    Field,
    Input,
    Select,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
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
  import { Plus, Trash2, ChevronDown, ChevronRight, Copy, X } from "lucide-svelte";
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

  const typeOptions = COLUMN_TYPES.map((type) => ({ value: type, label: type }));
  const columnType = (e: Event) =>
    (e.currentTarget as HTMLSelectElement).value as DraftColumn["type"];
  const nameOk = (name: string) => name === "" || (NAME_RE.test(name) && !RESERVED.has(name));

  function flash(msg: string) {
    toast.success(msg);
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
      flash(tr("vaultView.tableDropped", { collection }));
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
  <div class="flex min-w-0 flex-col gap-6">
    <p class="text-sm text-kitsuden-text-dim">
      {tr("vaultView.dynamicSchemasWith")}
      <code class="text-xs text-kitsuden-accent">CREATE/ALTER TABLE</code>
      {tr("vaultView.realRlsAutomaticServedData")}
    </p>

    {#if error}
      <Alert variant="error" onDismiss={() => (error = null)}>
        {error}
      </Alert>
    {/if}

    {#if loading}
      <div class="flex justify-center py-16">
        <Spinner size="lg" label={tr("vaultView.loadingVault")} />
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
      <EmptyState
        icon="info"
        title={tr("vaultView.kitsudenVaultIsDisabled")}
        description={`${tr("vaultView.vaultCreatesPostgresqlTables")} ${tr("vaultView.real")} ${tr("vaultView.withIndexesNativeTypesAnd")}`}
      >
        <pre
          class="mx-auto mt-3 inline-block rounded-lg border border-kitsuden-border bg-kitsuden-card px-4 py-3 text-left font-mono text-xs text-kitsuden-accent">{tr(
            "vaultView.env"
          )}
{tr("vaultView.kitsudenVaultEnabledTrue")}</pre>
        <p class="mt-3 text-xs text-kitsuden-subtle">{tr("vaultView.restartsApiAndReloads")}</p>
      </EmptyState>
    {:else}
      <!-- Create collection -->
      {#if showCreate}
        <Card>
          <CardContent>
            <div class="flex flex-col gap-4">
              <Field
                label={`${tr("vaultView.snakeCollectionName")} vault_<name>)`}
                class="md:max-w-xs"
                error={NAME_RE.test(newCollection) || newCollection === ""
                  ? undefined
                  : tr("vaultView.invalidName")}
              >
                <Input
                  id="vault-name"
                  class="font-mono"
                  placeholder={tr("vaultView.exampleCollection")}
                  bind:value={newCollection}
                />
              </Field>

              <fieldset class="flex min-w-0 flex-col gap-3">
                <legend class="mb-2 text-sm font-medium text-kitsuden-text">
                  {tr("vaultView.columns")}
                  <span class="text-xs font-normal text-kitsuden-subtle"
                    >{tr("vaultView.idOwnerIdCreatedAt")}</span
                  >
                </legend>
                {#each draftColumns as col, i (i)}
                  <div class="flex flex-wrap items-center gap-2">
                    <Input
                      class="min-w-0 flex-1 basis-40 font-mono {nameOk(col.name)
                        ? ''
                        : 'border-kitsuden-danger'}"
                      aria-label={tr("vaultView.columnN", { n: i + 1 })}
                      aria-invalid={nameOk(col.name) ? undefined : "true"}
                      placeholder={tr("vaultView.exampleColumn")}
                      bind:value={col.name}
                    />
                    <Select
                      width="auto"
                      aria-label={tr("vaultView.type")}
                      value={col.type}
                      onchange={(e: Event) => (col.type = columnType(e))}
                      options={typeOptions}
                    />
                    <Checkbox bind:checked={col.required} label={tr("vaultView.notNull")} />
                    <Checkbox bind:checked={col.unique} label={tr("vaultView.unique")} />
                    <Checkbox bind:checked={col.indexed} label={tr("vaultView.index")} />
                    {#if draftColumns.length > 1}
                      <Button
                        variant="ghost"
                        size="icon"
                        ariaLabel={tr("vaultView.removeDraftColumn", { n: i + 1 })}
                        title={tr("common.remove")}
                        onclick={() => removeDraftColumn(i)}
                      >
                        <X class="w-4 h-4" />
                      </Button>
                    {/if}
                  </div>
                {/each}
                <div>
                  <Button variant="ghost" size="sm" onclick={addDraftColumn}>
                    <Plus class="w-3.5 h-3.5" />
                    {tr("vaultView.addColumn")}
                  </Button>
                </div>
              </fieldset>

              <div class="flex flex-wrap items-center gap-2">
                <Button
                  onclick={createCollection}
                  loading={creating}
                  disabled={creating || !draftValid}
                >
                  {creating ? tr("vaultView.creating") : tr("vaultView.createTableRls")}
                </Button>
                <Button variant="ghost" onclick={() => (showCreate = false)}>
                  {tr("common.cancel")}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      {/if}

      <!-- Collections list -->
      {#if collections.length === 0}
        <EmptyState
          title={tr("vaultView.withoutVaultCollections")}
          description={`${tr("vaultView.createsTheFirstAndConsumeIt")} /api/graph/vault_<name>.`}
          actionLabel={tr("vaultView.newCollection")}
          onAction={() => (showCreate = true)}
        />
      {:else}
        <div class="flex flex-col gap-3">
          {#each collections as col (col.table)}
            {@const open = expanded.has(col.collection)}
            <Card>
              <CardContent>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    ariaLabel={open
                      ? tr("vaultView.collapse", { table: col.table })
                      : tr("vaultView.expand", { table: col.table })}
                    aria-expanded={open}
                    onclick={() => toggleExpand(col.collection)}
                  >
                    {#if open}
                      <ChevronDown class="w-4 h-4" />
                    {:else}
                      <ChevronRight class="w-4 h-4" />
                    {/if}
                  </Button>
                  <div class="min-w-0 flex-1 basis-40">
                    <div class="truncate font-mono text-sm text-kitsuden-text">{col.table}</div>
                    <div class="flex flex-wrap items-center gap-2 text-xs text-kitsuden-subtle">
                      {tr("vaultView.columnsRows", {
                        columnsCount: col.columns.length,
                        estimatedRowCount: col.estimatedRowCount,
                      })}
                      <Badge variant="success" dot>{tr("vaultView.rlsEnabled")}</Badge>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="min-w-0 font-mono"
                    title={tr("vaultView.copyGraphifyEndpoint")}
                    onclick={() => copyEndpoint(col.table)}
                  >
                    <Copy class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{tr("vaultView.apiGraph", { table: col.table })}</span>
                  </Button>
                  {#if dropTarget === col.collection}
                    <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                      <Input
                        class="min-w-0 flex-1 basis-36 font-mono"
                        aria-label={tr("vaultView.writes", { collection: col.collection })}
                        placeholder={tr("vaultView.writes", { collection: col.collection })}
                        autocomplete="off"
                        bind:value={dropConfirmText}
                      />
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={dropConfirmText !== col.collection}
                        onclick={() => dropCollection(col.collection)}
                      >
                        {tr("vaultView.drop")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        ariaLabel={tr("common.cancel")}
                        title={tr("common.cancel")}
                        onclick={() => {
                          dropTarget = null;
                          dropConfirmText = "";
                        }}
                      >
                        <X class="w-4 h-4" />
                      </Button>
                    </div>
                  {:else}
                    <Button
                      variant="danger-ghost"
                      size="icon"
                      ariaLabel={tr("vaultView.dropTableConfirmationByName")}
                      title={tr("vaultView.dropTableConfirmationByName")}
                      onclick={() => (dropTarget = col.collection)}
                    >
                      <Trash2 class="w-4 h-4" />
                    </Button>
                  {/if}
                </div>

                {#if open}
                  <div class="mt-3 flex flex-col gap-3 border-t border-kitsuden-border pt-3">
                    <Table density="compact">
                      <TableHeader>
                        <TableRow>
                          <TableHead>{tr("vaultView.column")}</TableHead>
                          <TableHead>{tr("vaultView.type")}</TableHead>
                          <TableHead>{tr("vaultView.nullable")}</TableHead>
                          <TableHead class="text-right"
                            ><span class="sr-only">{tr("common.actions")}</span></TableHead
                          >
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {#each col.columns as c (c.name)}
                          <TableRow>
                            <TableCell class="font-mono">
                              {c.name}
                              {#if c.isPrimaryKey}<Badge variant="warning" class="ml-1"
                                  >{tr("vaultView.pk")}</Badge
                                >{/if}
                            </TableCell>
                            <TableCell class="font-mono">{c.type}</TableCell>
                            <TableCell>{c.nullable ? tr("vaultView.si") : "no"}</TableCell>
                            <TableCell class="text-right">
                              {#if !RESERVED.has(c.name)}
                                <Button
                                  variant="danger-ghost"
                                  size="icon"
                                  ariaLabel={`${tr("vaultView.dropColumn")} ${c.name}`}
                                  title={tr("vaultView.dropColumn")}
                                  onclick={() => dropColumn(col.collection, c.name)}
                                >
                                  <Trash2 class="w-4 h-4" />
                                </Button>
                              {/if}
                            </TableCell>
                          </TableRow>
                        {/each}
                      </TableBody>
                    </Table>

                    {#if addColTarget === col.collection}
                      <div class="flex flex-wrap items-center gap-2">
                        <Input
                          class="min-w-0 flex-1 basis-40 font-mono"
                          aria-label={tr("vaultView.column")}
                          placeholder={tr("vaultView.exampleNewColumn")}
                          bind:value={addColDraft.name}
                        />
                        <Select
                          width="auto"
                          aria-label={tr("vaultView.type")}
                          value={addColDraft.type}
                          onchange={(e: Event) => (addColDraft.type = columnType(e))}
                          options={typeOptions}
                        />
                        <Checkbox
                          bind:checked={addColDraft.unique}
                          label={tr("vaultView.unique")}
                        />
                        <Checkbox
                          bind:checked={addColDraft.indexed}
                          label={tr("vaultView.index")}
                        />
                        <Button
                          size="sm"
                          disabled={!NAME_RE.test(addColDraft.name) ||
                            RESERVED.has(addColDraft.name)}
                          onclick={() => addColumn(col.collection)}
                        >
                          {tr("vaultView.alterTableAdd")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          ariaLabel={tr("common.cancel")}
                          title={tr("common.cancel")}
                          onclick={() => (addColTarget = null)}
                        >
                          <X class="w-4 h-4" />
                        </Button>
                      </div>
                    {:else}
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onclick={() => (addColTarget = col.collection)}
                        >
                          <Plus class="w-3.5 h-3.5" />
                          {tr("vaultView.addColumnAlterTableIn")}
                        </Button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </CardContent>
            </Card>
          {/each}
        </div>
        <p class="text-xs text-kitsuden-subtle">
          {tr("vaultView.theNewColumnsEnterAs")} <code>apps/api/drizzle/vault/</code>.
        </p>
      {/if}
    {/if}
  </div>
</Page>
