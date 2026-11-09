<script lang="ts">
  /**
   * Entries of a dataset: list, create, edit and delete.
   *
   * Before, this screen reused the generic tables DataExplorer with
   * `views: []`. With no view there was no active table, so "Add" did
   * nothing (the notice went to a toast nobody rendered), no column from the
   * schema appeared, the title was the dataset's uuid and editing or deleting requested
   * /api/explorer routes that are not dataset ones. Here we use what the
   * dataset already knows about itself: its schema draws the columns and the form
   * (DynamicForm), and writes go to /api/datasets/:id/entries.
   */
  import { t, localeFormat } from "$lib/i18n";
  import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";

  import { api } from "$lib/api";
  import DynamicForm from "$lib/components/forms/DynamicForm.svelte";
  import Modal from "$lib/components/ui/Modal.svelte";
  import {
    Button,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/tallao";
  import type { FieldDefinition } from "$types/datasets";

  import { page } from "$app/stores";

  interface Input {
    id: string;
    title?: string;
    status?: string;
    data?: Record<string, unknown>;
    updatedAt?: string;
  }

  const datasetId = $derived($page.params.id ?? "");

  let name = $state("");
  let fields = $state<FieldDefinition[]>([]);
  let inputs = $state<Input[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let formOpen = $state(false);
  let editing = $state<Input | null>(null);
  let saving = $state(false);

  const visible = $derived(
    fields
      .filter((c) => !c.hidden)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .slice(0, 6)
  );

  async function load() {
    loading = true;
    error = null;
    try {
      const [ds, list] = await Promise.all([
        api.get<{ name: string; schema?: FieldDefinition[] }>(`/datasets/${datasetId}`),
        api.get<{ docs?: Input[] }>(`/datasets/${datasetId}/entries?limit=100`),
      ]);
      name = ds.name;
      fields = Array.isArray(ds.schema) ? ds.schema : [];
      inputs = list.docs ?? [];
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openSignup() {
    editing = null;
    formOpen = true;
  }

  function openEdit(e: Input) {
    editing = e;
    formOpen = true;
  }

  /** The entry's title comes from the first text field with a value. */
  function titleOf(data: Record<string, unknown>): string {
    const text = fields.find((c) => typeof data[c.key] === "string" && String(data[c.key]).trim());
    return text ? String(data[text.key]).slice(0, 200) : t("entriesPage.withoutTitle");
  }

  async function save(data: Record<string, unknown>) {
    saving = true;
    try {
      const body = { title: titleOf(data), data: data };
      if (editing) {
        await api.patch(`/datasets/${datasetId}/entries/${editing.id}`, body);
        toast.success(t("entriesPage.updatedInput"));
      } else {
        await api.post(`/datasets/${datasetId}/entries`, body);
        toast.success(t("entriesPage.createdInput"));
      }
      formOpen = false;
      editing = null;
      await load();
    } catch (err) {
      toast.error(t("entriesPage.couldNotSave"), { description: (err as Error)?.message });
    } finally {
      saving = false;
    }
  }

  async function remove(e: Input) {
    if (!confirm(t("entriesPage.confirmDelete", { title: e.title ?? e.id }))) return;
    try {
      await api.delete(`/datasets/${datasetId}/entries/${e.id}`);
      toast.success(t("entriesPage.deletedInput"));
      await load();
    } catch (err) {
      toast.error(t("entriesPage.couldNotDelete"), { description: (err as Error)?.message });
    }
  }

  function show(value: unknown): string {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? t("common.yes") : t("common.no");
    if (typeof value === "number") return value.toLocaleString(localeFormat());
    if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
    return String(value).slice(0, 80);
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <Button
        href="/g/kon-datasets"
        variant="ghost"
        size="icon"
        ariaLabel={t("entriesPage.comeBack")}
      >
        <ArrowLeft class="w-5 h-5" />
      </Button>
      <div>
        <h2 class="text-xl font-bold text-kitsuden-text">{name || t("entriesPage.entries")}</h2>
        <p class="text-sm text-kitsuden-text-dim mt-0.5">
          {t("entriesPage.records", { n: inputs.length })}
        </p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="ghost" onclick={load}>
        <RefreshCw class="w-4 h-4" />
        {t("dataExplorer.update")}
      </Button>
      <Button
        onclick={openSignup}
        disabled={loading || fields.length === 0}
        data-testid="new-entry"
      >
        <Plus class="w-4 h-4" />
        {t("entriesPage.newEntry")}
      </Button>
    </div>
  </div>

  {#if loading}
    <div class="flex justify-center py-20">
      <Spinner class="text-kitsuden-accent" />
    </div>
  {:else if error}
    <div class="card p-6 text-sm text-kitsuden-accent-2">{error}</div>
  {:else if fields.length === 0}
    <div class="card p-16 text-center">
      <p class="text-kitsuden-text-dim">{t("entriesPage.withoutFields")}</p>
      <a
        href="/datasets/{datasetId}/edit"
        class="text-sm text-kitsuden-accent hover:underline mt-2 inline-block"
      >
        {t("entriesPage.editSchema")}
      </a>
    </div>
  {:else if inputs.length === 0}
    <div class="card p-16 text-center">
      <p class="text-kitsuden-text-dim">{t("dataExplorer.noRecordsFound")}</p>
    </div>
  {:else}
    <Table aria-label={name || t("entriesPage.entries")}>
      <TableHeader>
        <TableRow>
          {#each visible as c (c.id)}
            <TableHead>{c.label}</TableHead>
          {/each}
          <TableHead class="text-right!">{t("common.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each inputs as e (e.id)}
          <TableRow>
            {#each visible as c (c.id)}
              <TableCell>{show(e.data?.[c.key])}</TableCell>
            {/each}
            <TableCell>
              <div class="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onclick={() => openEdit(e)}
                  title={t("common.edit")}
                  ariaLabel={t("common.edit")}
                >
                  <Pencil class="w-4 h-4" />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="icon"
                  onclick={() => remove(e)}
                  title={t("common.delete")}
                  ariaLabel={t("common.delete")}
                >
                  <Trash2 class="w-4 h-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
</div>

<Modal
  open={formOpen}
  title={editing ? t("entriesPage.editInput") : t("entriesPage.newEntry")}
  size="lg"
  onClose={() => {
    formOpen = false;
    editing = null;
  }}
>
  {#if formOpen}
    {#key editing?.id ?? "new"}
      <DynamicForm
        {fields}
        initialData={editing?.data ?? {}}
        submitLabel={saving ? t("common.saving") : undefined}
        onSubmit={save}
        onCancel={() => {
          formOpen = false;
          editing = null;
        }}
      />
    {/key}
  {/if}
</Modal>
