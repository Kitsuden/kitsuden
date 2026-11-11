<!--
  The list template: one way to list the records of any source (a dataset's entries, a kon
  table, a model, or a list the API returns whole).

    FilterBar (+ SavedViews)  chips generated from the model's fields, search when the API has it
    SelectionBar              bulk actions: the model's own, then Export and Delete
    DataTable                 the title cell links to the record; a pinned "⋯" row menu;
                              density toggle; column chooser; skeleton rows while loading
    Pagination

  Search, filters, sort, page, density and columns live in the URL (`$lib/list/url-state`),
  so a list can be linked and the back button undoes a filter. Saved views are per user
  (`$lib/list/saved-views`). The page above owns the header (`<Page>`); this owns the rest.
-->
<script lang="ts">
  import { untrack, type Snippet } from "svelte";

  import { getUser } from "$lib/auth.svelte";
  import { confirmDialog } from "$lib/confirm.svelte";
  import { localeFormat, t } from "$lib/i18n";
  import { toCsv } from "$lib/list/csv";
  import { filtersFromFields, type ListField } from "$lib/list/model-filters";
  import { rememberNeighbours } from "$lib/list/neighbours";
  import { browserViewStore, currentView, type StoredView } from "$lib/list/saved-views";
  import type { BulkAction, RecordSource, Row } from "$lib/list/source";
  import {
    hasFilters,
    listStateQuery,
    readListState,
    SEARCH_KEY,
    withListState,
    type ListDefaults,
    type ListFilters,
    type ListState,
  } from "$lib/list/url-state";
  import {
    Button,
    DataTable,
    DropdownMenu,
    EmptyState,
    FilterBar,
    MenuItem,
    MenuSeparator,
    Pagination,
    SavedViews,
    SelectionBar,
    toast,
    type DataColumn,
    type DataDensity,
    type DataSort,
    type SavedView,
  } from "$lib/tallao";

  import ListCell from "./ListCell.svelte";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  interface Props {
    source: RecordSource;
    /** Where a row leads: its title cell becomes a link. */
    hrefFor?: (row: Row) => string | undefined;
    /** "New" in the empty state: a link to the record page… */
    newHref?: string;
    /** …or the quick-add dialog. */
    onNew?: () => void;
    pageSize?: number;
    /** Rows can be deleted from here (the row menu and the bulk action). */
    canDelete?: boolean;
    /** How many records the API has for the current filters (bindable, for the header). */
    total?: number | null;
    /** Bump to reload (after a quick-add). */
    reloadKey?: number;
    /** Text of the empty state, when the list has its own. */
    emptyTitle?: string;
    emptyDescription?: string;
    /** Draws a cell yourself; render nothing to keep the default for that field. */
    cell?: Snippet<[Row, ListField]>;
    /** Extra entries of the row menu, before Delete. */
    rowMenu?: Snippet<[Row]>;
    /**
     * For a list the page fetches whole and hands over (`memorySource`): the rows are not
     * here yet (skeleton rows), or fetching them failed (the error state, with `onRetry`).
     */
    pending?: boolean;
    loadError?: string | null;
    onRetry?: () => void;
  }

  let {
    source,
    hrefFor,
    newHref,
    onNew,
    pageSize = 25,
    canDelete = true,
    total = $bindable(null),
    reloadKey = 0,
    emptyTitle,
    emptyDescription,
    cell: customCell,
    rowMenu,
    pending = false,
    loadError = null,
    onRetry,
  }: Props = $props();

  // ── What the model gives: filters and columns ────────────────────────────────────
  const filterDefs = $derived(filtersFromFields(source.fields, { dateRange: source.dateFilters }));
  const defaults = $derived<ListDefaults>({ sort: source.defaultSort ?? null });

  /** The title first, then the fields a list shows by default; the rest wait in the chooser. */
  const orderedFields = $derived.by(() => {
    const title = source.fields.find((f) => f.key === source.titleField);
    return [...(title ? [title] : []), ...source.fields.filter((f) => f !== title)];
  });
  const defaultColumns = $derived(
    orderedFields
      .filter((f) => f.key === source.titleField || !f.hidden)
      .slice(0, 7)
      .map((f) => f.key)
  );
  const fieldByKey = $derived(new Map(source.fields.map((f) => [f.key, f])));
  const columns = $derived<DataColumn<Row>[]>(
    orderedFields.map((f, i) => ({
      key: f.key,
      header: f.label,
      sortable: f.sortable === true,
      align: f.kind === "number" ? ("right" as const) : undefined,
      hideable: i !== 0,
      value: (row: Row) => source.value(row, f.key),
    }))
  );

  // ── State: the URL is the source of truth ────────────────────────────────────────
  const urlState = $derived(readListState($page.url.searchParams, filterDefs, defaults));
  const visibleColumns = $derived(urlState.columns ?? defaultColumns);

  /** What the FilterBar shows: follows the URL, runs ahead of it while typing. */
  let filters = $state<ListFilters>({});
  $effect(() => {
    const next = urlState.filters;
    untrack(() => {
      if (JSON.stringify(next) !== JSON.stringify(filters)) filters = { ...next };
    });
  });

  function navigate(next: ListState, replace = false) {
    const target = withListState($page.url, next, defaults);
    if (target === `${$page.url.pathname}${$page.url.search}${$page.url.hash}`) return;
    void goto(target, { replaceState: replace, keepFocus: true, noScroll: true });
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function onFilters(next: ListFilters) {
    filters = next;
    clearTimeout(searchTimer);
    const typed = (next[SEARCH_KEY] ?? "") !== (urlState.filters[SEARCH_KEY] ?? "");
    const apply = () => navigate({ ...urlState, filters: next, page: 1 }, typed);
    // Each keystroke of the search arrives here: wait for a pause before asking the API.
    if (typed) searchTimer = setTimeout(apply, 250);
    else apply();
  }

  // ── Loading ──────────────────────────────────────────────────────────────────────
  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selected = $state<string[]>([]);
  let request = 0;

  async function load() {
    const id = ++request;
    loading = true;
    error = null;
    if (pending) return;
    try {
      const result = await source.list({
        filters: urlState.filters,
        sort: urlState.sort,
        page: urlState.page,
        pageSize,
      });
      if (id !== request) return;
      // On local values: reading `rows` right after assigning it would tie this function
      // to its own output as soon as an effect calls it.
      const ids = result.rows.map((r) => source.rowId(r));
      const known = new Set(ids);
      rows = result.rows;
      total = result.total;
      selected = untrack(() => selected).filter((s) => known.has(s));
      rememberNeighbours(source.id, ids);
    } catch (e) {
      if (id !== request) return;
      rows = [];
      total = null;
      error = (e as Error)?.message || t("list.loadFailed");
    } finally {
      if (id === request) loading = false;
    }
  }

  $effect(() => {
    // Everything that changes what the API is asked.
    void source;
    void reloadKey;
    void pending;
    void JSON.stringify([urlState.filters, urlState.sort, urlState.page]);
    untrack(() => void load());
  });

  const pageCount = $derived(Math.max(1, Math.ceil((total ?? 0) / pageSize)));
  const filtered = $derived(hasFilters(urlState));

  // ── Saved views ──────────────────────────────────────────────────────────────────
  const viewStore = $derived(browserViewStore(getUser()?.id ?? ""));
  let views = $state<StoredView[]>([]);
  $effect(() => {
    views = viewStore.list(source.id);
  });
  const viewQuery = $derived(listStateQuery(urlState, defaults, { page: false }));
  const activeView = $derived(currentView(views, viewQuery));

  function openView(view: SavedView<string>) {
    const params = new URLSearchParams(view.query);
    navigate({ ...readListState(params, filterDefs, defaults), page: 1 });
  }

  // ── Actions ──────────────────────────────────────────────────────────────────────
  const selectedRows = $derived(rows.filter((r) => selected.includes(source.rowId(r))));
  let busy = $state(false);

  async function removeRows(targets: Row[]) {
    const one = targets.length === 1;
    const ok = await confirmDialog({
      title: one
        ? t("list.deleteOneTitle", { name: source.title(targets[0]!) || source.singular })
        : t("list.deleteManyTitle", { n: targets.length }),
      description: t("list.deleteDescription"),
      confirmLabel: t("common.delete"),
    });
    if (!ok) return;
    busy = true;
    const results = await Promise.allSettled(
      targets.map((row) => source.remove(source.rowId(row)))
    );
    busy = false;
    const failed = results.filter((r) => r.status === "rejected");
    const done = results.length - failed.length;
    if (done > 0) toast.success(t("list.deleted", { n: done }));
    if (failed.length > 0) {
      toast.error(t("list.deleteFailed", { n: failed.length }), {
        description: String((failed[0] as PromiseRejectedResult).reason?.message ?? ""),
      });
    }
    selected = [];
    // The last row of the last page is gone: step back a page instead of showing none.
    if (done >= rows.length && urlState.page > 1)
      navigate({ ...urlState, page: urlState.page - 1 });
    else await load();
  }

  function exportRows(targets: Row[]) {
    const fields = orderedFields.filter((f) => visibleColumns.includes(f.key));
    const csv = toCsv(
      fields.map((f) => f.label),
      targets.map((row) => fields.map((f) => source.value(row, f.key)))
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${source.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "export"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t("list.exported", { n: targets.length }));
  }

  async function runBulk(action: BulkAction) {
    if (action.confirm) {
      const ok = await confirmDialog({
        title: action.label,
        description: action.confirm.replace("{n}", String(selected.length)),
        confirmLabel: action.label,
        variant: action.danger ? "danger" : "primary",
      });
      if (!ok) return;
    }
    busy = true;
    try {
      await action.run([...selected], selectedRows);
      toast.success(t("list.actionDone", { action: action.label, n: selected.length }));
      selected = [];
      await load();
    } catch (e) {
      toast.error(t("list.actionFailed", { action: action.label }), {
        description: (e as Error)?.message,
      });
    } finally {
      busy = false;
    }
  }
</script>

<div class="kitsuden-list" data-testid="list-view">
  <FilterBar
    filters={filterDefs}
    value={filters}
    onchange={onFilters}
    search={source.searchable}
    searchPlaceholder={t("list.searchIn", { name: source.label })}
    ariaLabel={t("list.filtersOf", { name: source.label })}
    locale={localeFormat()}
  >
    {#snippet end()}
      <SavedViews
        views={views.map((v) => ({ name: v.name, query: v.query }))}
        current={activeView}
        query={viewQuery}
        label={t("list.views")}
        onSelect={openView}
        onSave={(v) => (views = viewStore.save(source.id, { name: v.name, query: v.query }))}
        onRename={(v, name) => (views = viewStore.rename(source.id, v.name, name))}
        onDelete={(v) => (views = viewStore.remove(source.id, v.name))}
      />
    {/snippet}
  </FilterBar>

  {#if selected.length > 0}
    <SelectionBar
      total={rows.length}
      selected={selected.length}
      onToggleAll={(checked) => (selected = checked ? rows.map((r) => source.rowId(r)) : [])}
      ariaLabel={t("list.bulkActions")}
    >
      {#snippet actions()}
        {#each source.bulkActions ?? [] as action (action.id)}
          <Button
            size="sm"
            variant={action.danger ? "danger-ghost" : "secondary"}
            disabled={busy}
            onclick={() => runBulk(action)}
          >
            {action.label}
          </Button>
        {/each}
        <Button size="sm" variant="secondary" onclick={() => exportRows(selectedRows)}>
          {t("list.export")}
        </Button>
        {#if canDelete}
          <Button
            size="sm"
            variant="danger-ghost"
            disabled={busy}
            onclick={() => removeRows(selectedRows)}
            data-testid="bulk-delete"
          >
            {t("common.delete")}
          </Button>
        {/if}
      {/snippet}
    </SelectionBar>
  {/if}

  <DataTable
    caption={source.label}
    {rows}
    {columns}
    rowKey={(row) => source.rowId(row)}
    rowLabel={(row) => source.title(row) || source.rowId(row)}
    manual
    selectable
    bind:selected
    sort={urlState.sort as DataSort | null}
    onSortChange={(sort) => navigate({ ...urlState, sort, page: 1 })}
    density={urlState.density as DataDensity}
    onDensityChange={(density) => navigate({ ...urlState, density }, true)}
    densityToggle
    {visibleColumns}
    onVisibleColumnsChange={(keys) => navigate({ ...urlState, columns: keys }, true)}
    columnChooser
    rowHref={hrefFor}
    linkColumn={orderedFields[0]?.key}
    {loading}
    loadingRows={Math.min(pageSize, 8)}
    error={loadError ?? error}
    onRetry={onRetry ?? load}
  >
    {#snippet toolbar()}
      <span class="kitsuden-list-count" aria-live="polite" data-testid="list-count">
        {#if total !== null}
          {total === 1
            ? t("list.countOne")
            : t("list.count", { n: total.toLocaleString(localeFormat()) })}
        {/if}
      </span>
    {/snippet}

    {#snippet cell(row, col)}
      {@const field = fieldByKey.get(col.key)}
      {#if field}
        {#if customCell}
          {@render customCell(row, field)}
        {:else}
          <ListCell
            {field}
            value={source.value(row, field.key)}
            title={field.key === source.titleField}
          />
        {/if}
      {/if}
    {/snippet}

    {#snippet rowActions(row)}
      {@const name = source.title(row) || source.rowId(row)}
      {@const href = hrefFor?.(row)}
      <DropdownMenu label={t("list.actionsOf", { name })} placement="bottom-end">
        {#snippet trigger(props)}
          <Button
            {...props}
            variant="ghost"
            size="icon"
            class="kitsuden-row-menu"
            ariaLabel={t("list.actionsOf", { name })}
          >
            <span aria-hidden="true">⋯</span>
          </Button>
        {/snippet}
        {#if href}
          <MenuItem onSelect={() => goto(href)}>{t("list.open")}</MenuItem>
        {/if}
        {@render rowMenu?.(row)}
        {#each (source.rowActions ?? []).filter((a) => !a.visible || a.visible(row)) as action (action.id)}
          <MenuItem
            variant={action.danger ? "danger" : "default"}
            onSelect={async () => {
              if (
                action.confirm &&
                !(await confirmDialog({
                  title: action.label,
                  description: action.confirm,
                  confirmLabel: action.label,
                  variant: action.danger ? "danger" : "primary",
                }))
              )
                return;
              try {
                await action.run(row);
                toast.success(t("list.actionDone", { action: action.label, n: 1 }));
                await load();
              } catch (e) {
                toast.error(t("list.actionFailed", { action: action.label }), {
                  description: (e as Error)?.message,
                });
              }
            }}
          >
            {action.label}
          </MenuItem>
        {/each}
        <MenuItem onSelect={() => exportRows([row])}>{t("list.export")}</MenuItem>
        {#if canDelete}
          <MenuSeparator />
          <MenuItem variant="danger" onSelect={() => removeRows([row])}>
            {t("common.delete")}
          </MenuItem>
        {/if}
      </DropdownMenu>
    {/snippet}

    {#snippet empty()}
      {#if filtered}
        <EmptyState
          variant="no-results"
          size="sm"
          level={null}
          description={t("list.noResultsHint")}
          onClearFilters={() => navigate({ ...urlState, filters: {}, page: 1 })}
        />
      {:else}
        <EmptyState
          size="sm"
          level={null}
          title={emptyTitle ?? t("list.emptyTitle", { name: source.label })}
          description={emptyDescription ?? t("list.emptyDescription")}
          actionLabel={newHref || onNew ? t("list.newOne", { name: source.singular }) : undefined}
          actionHref={newHref}
          onAction={newHref ? undefined : onNew}
        />
      {/if}
    {/snippet}
  </DataTable>

  {#if pageCount > 1}
    <div class="kitsuden-list-foot">
      <Pagination
        page={urlState.page}
        {pageCount}
        total={total ?? undefined}
        {pageSize}
        ariaLabel={t("list.paginationOf", { name: source.label })}
        onchange={(next) => navigate({ ...urlState, page: next })}
      />
    </div>
  {/if}
</div>

<style>
  .kitsuden-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .kitsuden-list-count {
    font-size: 0.8125rem;
    color: rgb(var(--ta-text-dim));
  }
  /*
    Row height: the "⋯" button was the tallest thing in a row (2.5rem + the cell padding gave
    64px rows, 9 to a screen). A smaller button and a tighter cell give 44px rows, and the
    compact density 36px; a touch pointer keeps tallao's 44px target.
  */
  .kitsuden-list :global(.kitsuden-row-menu) {
    width: 1.75rem;
    height: 1.75rem;
    min-height: 0;
  }
  .kitsuden-list :global(.ta-datatable:not(.ta-datatable--compact) .ta-table-td) {
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }
  /* Values stay on one line (a SKU broken at every hyphen made 110px rows on a phone); the
     table scrolls sideways inside its box and the row menu stays pinned. The title wraps. */
  .kitsuden-list :global(.ta-table-td) {
    white-space: nowrap;
  }
  @media (pointer: coarse) {
    .kitsuden-list :global(.kitsuden-row-menu) {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
  .kitsuden-list-foot {
    display: flex;
    justify-content: flex-end;
  }
</style>
