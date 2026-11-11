<script lang="ts">
  import { confirmDialog } from "$lib/confirm.svelte";
  import { t as tr, localeFormat } from "$lib/i18n";
  import {
    Search,
    Filter,
    Plus,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
    Eye,
    EyeOff,
    Edit,
    Trash2,
    Download,
    RefreshCw,
    X,
    Check,
    ExternalLink,
    Mail,
    FileJson,
    Columns3,
    Copy,
    MoreHorizontal,
  } from "lucide-svelte";
  import { onMount, untrack } from "svelte";

  import type {
    AdminConfig,
    SchemaColumn,
    KanbanView,
    CalendarView as CalendarViewType,
    RowAction,
  } from "$lib/types/admin";

  import { toast } from "svelte-sonner";

  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  import StateMessage from "$lib/components/feedback/StateMessage.svelte";
  import {
    ariaSort,
    columnLabel,
    defaultHiddenColumns,
    orderColumns,
    relationDisplay,
    rowTitle,
  } from "$lib/data-explorer/table-columns";
  import { explorerEndpoint, isApiBase, sortParams } from "$lib/explorer-endpoint";
  import { resolveRelatedTable } from "$lib/explorer-relations";
  import { Button, DropdownMenu, MenuItem, MenuSeparator } from "$lib/tallao";
  import { knownTables } from "$lib/explorer-tables";

  import AutoFormModal from "./AutoFormModal.svelte";
  import CalendarView from "./CalendarView.svelte";
  import KanbanBoard from "./KanbanBoard.svelte";

  interface TableSchema {
    name: string;
    columns: SchemaColumn[];
    primaryKey: string;
  }

  interface Props {
    grimoireId: string;
    config?: AdminConfig;
    viewId?: string;
    /** All tables in this grimoire (for inline relation detection) */
    allTables?: Array<{ name: string; label: string }>;
  }

  let { grimoireId, config, viewId, allTables }: Props = $props();

  // State
  let loading = $state(true);
  let data = $state<any[]>([]);
  let selectedRows = $state<Set<string>>(new Set());
  let searchQuery = $state("");
  let currentPage = $state(1);
  let pageSize = $state(25);
  let totalCount = $state(0);
  // Multi-column sort: array of { column, direction } in priority order
  let sortStack = $state<{ column: string; direction: "asc" | "desc" }[]>([]);
  // Backward-compatible single sort accessors
  const sortColumn = $derived(sortStack[0]?.column || null);
  const sortDirection = $derived<"asc" | "desc">(sortStack[0]?.direction || "asc");
  // Column visibility
  /**
   * The user's own choice of hidden columns; `null` until they touch the chooser. Before
   * that the defaults apply: a row's identifiers (id, uuid) start hidden and stay one
   * click away in the column chooser.
   */
  let hiddenChoice = $state<Set<string> | null>(null);
  /** A failed load, so it is never drawn as "no records". */
  let loadError = $state<string | null>(null);
  let showColumnMenu = $state(false);
  let activeFilters = $state<Record<string, any>>({});
  let showFilters = $state(false);
  let schema = $state<TableSchema | null>(null);
  let bulkActionLoading = $state(false);

  // Modal state
  let showFormModal = $state(false);
  let editRecord = $state<Record<string, any> | null>(null);

  // FK display cache: { "games": { "uuid-123": "Fortnite" } }
  let fkDisplayCache = $state<Record<string, Record<string, string>>>({});
  // FK options for filter dropdowns
  let filterRelationOptions = $state<Record<string, { value: string; label: string }[]>>({});

  // Dynamic table discovery for grimoires
  let discoveredViews = $state<Array<{ id: string; type: "grid"; title: string; table: string }>>(
    []
  );

  // View tabs (when config has multiple views) + discovered views
  const views = $derived([
    ...(config?.views || []),
    ...discoveredViews.filter(
      (dv) => !(config?.views || []).some((cv: any) => cv.table === dv.table)
    ),
  ]);

  /**
   * The active tab and the table it shows
   * --------------------------------------------------------------------------
   *
   * ── THE BUG THIS FIXES ───────────────────────────────────────────────────
   *
   * `activeView` was derived from the `viewId` PROP, and clicking a tab
   * wrote to a local `activeViewId` that only fed the button's color.
   * Result: the tab was marked active, `loadData()` requested the PREVIOUS
   * table again, and `loadSchema()` was never called.
   *
   * It looked like an incoherence with no apparent cause: the «Topics» tab
   * highlighted, the button header saying «Add User training
   * profile» and below it the rows of another table. Three things on screen
   * describing three different states.
   *
   * Now `activeViewId` is the single source: the prop only INITIALIZES it, and
   * everything else is derived from it.
   *
   * ── NO TABLE MEANS NO TABLE ──────────────────────────────────────────────
   *
   * `activeTable` can be `null`, and that is a valid answer: a view of type
   * `dashboard`, `custom` or `element` has no table to show.
   *
   * Before, it fell back to `|| grimoireId`, which turned «this view is not a table» into
   * «the table is called kon-booking». The panel requested the schema of a table with
   * that name, it did not exist, and the diagnostic it showed was
   *
   *     Could not load schema for table "kon-booking"
   *
   * that is: the kon's id disguised as a missing table. A fallback that
   * fabricates a false name costs more to debug than the absence of the datum.
   */
  let activeViewId = $state("");

  const activeView = $derived(views.find((v) => v.id === activeViewId) || views[0]);

  /** Name of the active view's table, or `null` if the view does not show one. */
  const activeTable = $derived<string | null>((activeView as any)?.table ?? null);

  const displayTable = $derived(activeTable ?? grimoireId);

  /**
   * Name for the «Add» button, or `null` if there is no reliable one.
   *
   * ── WHY IT IS NO LONGER SINGULARIZED ─────────────────────────────────────
   *
   * There used to be a rule here that stripped the final `s` or `es` from the view title.
   * With «Cursos» → «Curso» it worked, and that is why it slipped through. With the first
   * English view it produced this:
   *
   *     "All Games".replace(/e?s$/i, "")  →  "All Gam"
   *
   * And the button said **«Add All Gam»**. The rule does not fail: it is right
   * sometimes, which is worse — nobody reviews it until a broken word shows up on screen.
   *
   * The correct approach in this architecture is the same as for everything else:
   * **the kon declares it**. If it does not declare it, the button just says «Add»,
   * which is not as pretty but is never an invented word. The context —the
   * screen title, right above— already says what it is about.
   */
  const signupTag = $derived.by<string | null>(() => {
    const view = activeView as { singularName?: string } | undefined;
    if (view?.singularName) return view.singularName;

    /**
     * ── THE LABEL IS THAT OF THE TABLE BEING VIEWED ────────────────────────
     *
     * `config.singularName` comes from `grimoire.tables[0].label`: the FIRST
     * table of the kon, fixed, the same for all tabs. In CardSim, which
     * has seven tables and no declared views, that meant being on
     * «Cards» and the button saying **«Add Games»** — because
     * `cardsim_games` is first in the list.
     *
     * It is the same family as the `apiBase` that served the first table to the
     * eleven tabs of Academy: grabbing `[0]` and calling it «the kon's» works
     * as long as there is only one.
     *
     * The label of `activeTable` is looked up in the tables the kon declares.
     * If it is not there —a view without a table, or a discovered table that the
     * manifest does not name— it falls back to the previous behavior and, if that fails too,
     * the button says just «Add»: never a word that does not belong.
     */
    const fromTable = allTables?.find((t) => t.name === activeTable)?.label;
    if (fromTable) return fromTable;

    return config?.singularName || null;
  });

  const columns = $derived<SchemaColumn[]>(schema?.columns || generateColumnsFromData(data));

  // Separate columns for display vs filtering
  const hiddenColumns = $derived<Set<string>>(hiddenChoice ?? defaultHiddenColumns(columns));
  // The column that titles the row goes first, identifiers last (see table-columns.ts).
  const visibleColumns = $derived(orderColumns(columns).filter((c) => !hiddenColumns.has(c.name)));
  const displayColumns = $derived(visibleColumns.slice(0, 12));
  const filterableColumns = $derived(
    columns.filter(
      (c) =>
        c.name !== "id" &&
        !c.name.endsWith("At") &&
        c.name !== "created_at" &&
        c.name !== "updated_at" &&
        c.type !== "json"
    )
  );

  // Search fields: all text-like columns
  const searchFields = $derived(
    columns
      .filter(
        (c) =>
          ["text", "string", "varchar", "email", "url"].includes(c.type || "") ||
          [
            "name",
            "title",
            "label",
            "slug",
            "description",
            "displayName",
            "display_name",
            "email",
          ].includes(c.name)
      )
      .map((c) => c.name)
  );

  // ── Row Actions ──
  const rowActions = $derived<RowAction[]>((activeView as any)?.rowActions || []);

  /**
   * The view's fixed filter, declared in the kon's `kon.json`.
   *
   * It is not the same as `activeFilters`: this one is set by the manifest and defines WHAT
   * THE TAB IS —«Drafts» are those with `status: draft`—, while
   * `activeFilters` is what the viewer adds. That is why it always applies,
   * even when the person has cleared their filters: without it, «Drafts»
   * would stop being «Drafts».
   */
  const viewFilter = $derived<Record<string, unknown>>((activeView as any)?.defaultFilter ?? {});

  /**
   * The `viewId` prop INITIALIZES the tab; it does not govern it.
   *
   * ── THE LOOP THIS AVOIDS ─────────────────────────────────────────────────
   *
   * The previous version of this effect simply did:
   *
   *     const pedida = viewId || config?.defaultView;
   *     if (pedida && views.some(...)) activeViewId = pedida;
   *     else if (!activeViewId && ...) activeViewId = views[0].id;
   *
   * and read `activeViewId` in the second branch, so the effect was DEPENDENT
   * on `activeViewId`. When a tab was clicked, `switchView` wrote
   * `activeViewId = another`, that fired the effect again, `requested` was still
   * the original prop… and it put it back. The tab bounced back
   * the instant you clicked it.
   *
   * It is worse than the bug it came to fix: before, tabs did nothing
   * because `activeView` did not depend on `activeViewId`; afterwards they did nothing
   * because the effect reverted them. From the outside it looked identical.
   *
   * ── THE RULE ─────────────────────────────────────────────────────────────
   *
   * The prop is applied ONCE for each new value of the prop. What the
   * user does afterwards governs until the prop changes again — which is
   * what happens when navigating from the side menu, and then it must take precedence.
   *
   * `untrack` on the read of `activeViewId` is the other half: without it, the
   * effect would keep reacting to its own writes.
   */
  let lastAppliedProp = $state<string | undefined>(undefined);

  $effect(() => {
    const requested = viewId || config?.defaultView;
    const availableItems = views;

    if (requested !== lastAppliedProp) {
      lastAppliedProp = requested;
      if (requested && availableItems.some((v) => v.id === requested)) {
        activeViewId = requested;
        return;
      }
    }

    // First paint with nothing chosen: the first tab is opened.
    if (!untrack(() => activeViewId) && availableItems.length > 0) {
      activeViewId = availableItems[0]!.id;
    }
  });

  const API_URL = import.meta.env.VITE_API_URL ?? "";

  /**
   * Build the full API endpoint for the current table.
   *
   * Handles three cases:
   * 1. No apiEndpoint → falls back to /api/explorer/{tableName}
   * 2. Full endpoint path (e.g., /api/datasets/id/entries, /api/explorer/games) → use as-is
   * 3. Base path (e.g., /api/directory, /api/crm) → append table name
   *
   * We detect "full path" vs "base path" by checking segment count:
   *   /api/explorer/games → 3 segments → full (used as-is)
   *   /api/datasets/id/entries → 4 segments → full (used as-is)
   *   /api/directory → 2 segments → base (needs table appended)
   *   /api/crm → 2 segments → base (needs table appended)
   */
  function getEndpoint(tblName?: string): string {
    const table = tblName ?? activeTable ?? grimoireId;
    // The rule (and why `directory_employees` is asked as `/employees`) is in
    // `$lib/explorer-endpoint`, shared with the form modal.
    return explorerEndpoint(config?.apiEndpoint, table);
  }

  /** The base API endpoint (without table) — used by AutoFormModal */
  const apiBaseEndpoint = $derived.by(() => {
    const ep = config?.apiEndpoint;
    if (!ep) return undefined;
    // Only pass base paths (/api/directory, /api/crm) — 2 segments
    // Full paths (/api/explorer/games, /api/datasets/id/entries) should not be passed
    return isApiBase(ep) ? ep : undefined;
  });

  // FK column detection (the rules are shared with the form: $lib/explorer-relations)
  function isRelationColumn(colName: string): boolean {
    return colName.endsWith("_id") || (colName.endsWith("Id") && colName !== "id");
  }

  /**
   * The table each relation column points to, resolved against the tables the explorer
   * really has (also behind this table's own prefix: `directory_departments`). A column
   * that resolves to nothing has no entry and shows its sibling name or a short id.
   */
  let relatedTables = $state<Record<string, string>>({});

  function getRelatedTable(colName: string): string | undefined {
    return relatedTables[colName];
  }

  onMount(async () => {
    /**
     * ── DISCOVERY IS FOR WHEN THERE IS NO MANIFEST ──────────────────────────
     *
     * It looks at which tables the kon has IN THE DATABASE and makes up a name from
     * the table name (`cardsim_games` → «Cardsim games»). It serves the
     * zero-configuration case: you drop in a directory with its `kon.json` and
     * it shows up in the panel.
     *
     * But if the kon ALREADY DECLARES its tables, this is redundant and gets in the way. In CardSim
     * it looked like this: the top row of tabs with the good labels —Games,
     * Cards, Decks…— and RIGHT BELOW another row with the same seven tables
     * renamed «Cardsim games», «Cardsim decks»… The same thing twice, one
     * with worse names.
     *
     * The previous condition was `config.views.length === 0`, and it was not enough:
     * `onMount` runs on the first render, when the container has not yet
     * resolved which view is active, so `config.views` arrives empty and discovery
     * fires anyway.
     *
     * `allTables` comes from the manifest and is stable from the first moment.
     * If it brings anything, the manifest governs and there is nothing to discover — besides,
     * the explorer can only open declared tables, so discovering others
     * would be useless.
     */
    const theKonDeclaresItsTables = (allTables?.length ?? 0) > 0;
    if (theKonDeclaresItsTables) return;

    if (!config?.views || config.views.length === 0) {
      await discoverGrimoireTables();
    }
  });

  /**
   * Reload schema and data every time the table being shown changes.
   *
   * This was an `onMount`, and that is why switching tabs reloaded nothing:
   * `onMount` runs ONCE per mount, and the SvelteKit router reuses the
   * component. The tab changed, the table below did not.
   *
   * It is the same bug already fixed in `GrimoirePage` and in
   * `CustomViewHost`: in Svelte 5, «when this changes» is `$effect`, not
   * `onMount`. It was repeated here because it was fixed case by case instead of
   * looking for the pattern.
   *
   * The dependency is `activeTable` and not `activeViewId` on purpose: two
   * tabs can point to the SAME table with different filters (Blog has
   * «Drafts» and «Scheduled», both over `blog_posts`), and there reloading
   * the schema adds nothing.
   */
  $effect(() => {
    const tableValue = activeTable;
    if (!tableValue) {
      // A view without a table —panel, custom view— has nothing to request.
      // Previous data is cleared so as not to show the previous tab's rows
      // under a view that did not request them.
      schema = null;
      data = [];
      totalCount = 0;
      loading = false;
      return;
    }

    // The previous tab's settings do not apply to this table: a filter
    // on a column that does not exist here returns zero rows with no explanation of
    // why, and the sort would point to a nonexistent column.
    currentPage = 1;
    sortStack = [];
    activeFilters = {};
    hiddenChoice = null;
    relatedTables = {};
    schema = null;

    /**
     * ── WHY `untrack` IF THERE IS ALREADY AN `await` HERE ───────────────────
     *
     * Because isolation cannot depend on a subtle detail. Svelte 5
     * stops tracking reads after the first `await`, so this load
     * PROBABLY does not feed back today. «Probably» and «subtle» is
     * exactly how the same bug survived in the other explorer, where
     * the call was synchronous and tied the effect to what the load itself
     * writes: loading caused loading.
     *
     * Saying it explicitly costs nothing —`untrack` does not change what
     * runs, only what is depended on— and makes the guarantee readable in
     * the code instead of being deduced from the order of the `await`s.
     */
    untrack(() => {
      void (async () => {
        await loadSchema();
        await loadData();
      })();
    });
  });

  /**
   * Switching TABS reloads the data, even if the table is the same.
   *
   * The effect above depends on `activeTable`, and its own comment already
   * said two tabs can share a table with different filters —
   * Blog's «Drafts» and «Scheduled», both over `blog_posts`—. But
   * then `activeTable` does not change, the effect does not fire and the grid
   * keeps the previous tab's rows. With the filter already in place,
   * that would mean showing the drafts under the title «Scheduled».
   *
   * The first pass is skipped: the table effect already loads on open, and without
   * this two identical requests would be made right on entry.
   */
  let viewAlreadyLoaded = $state<string | null>(null);

  $effect(() => {
    const view = activeViewId;
    if (!view || !untrack(() => activeTable)) return;

    if (viewAlreadyLoaded === null) {
      viewAlreadyLoaded = view;
      return;
    }
    if (viewAlreadyLoaded === view) return;

    viewAlreadyLoaded = view;
    untrack(() => {
      currentPage = 1;
      activeFilters = {};
      void loadData();
    });
  });

  async function discoverGrimoireTables() {
    try {
      const res = await fetch(`${API_URL}/api/explorer/discover/${grimoireId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const result = await res.json();
        if (result.tables && result.tables.length > 0) {
          discoveredViews = result.tables.map((t: any) => ({
            id: `grid-${t.name}`,
            type: "grid" as const,
            // If the manifest named it, that name. Humanizing the
            // table name is the LAST resort, not the first: «Cardsim games» is
            // worse than «Games» in every language.
            title:
              allTables?.find((d) => d.name === t.name)?.label ??
              t.name.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase()),
            table: t.name,
          }));
          // If no config, build one from discovered tables
          if (!config) {
            config = {
              name: grimoireId
                .replace(/^grimoire-/, "")
                .replace(/_/g, " ")
                .replace(/^\w/, (c) => c.toUpperCase()),
              singularName: tr("dataExplorer.record"),
              views: discoveredViews,
              apiEndpoint: `/api/explorer/${result.tables[0].name}`,
            };
          }
        }
      }
    } catch (e) {
      console.warn("[DataExplorer] Discovery failed, using defaults:", e);
    }
  }

  function generateColumnsFromData(rows: any[]): SchemaColumn[] {
    if (!rows.length) return [];
    return Object.keys(rows[0]).map((key) => ({
      name: key,
      type: typeof rows[0][key],
      nullable: true,
    }));
  }

  // ── Schema-first loading ──
  async function loadSchema() {
    const tableName = activeTable;
    if (!tableName) return;

    // If using custom apiEndpoint (like /api/directory), skip schema introspection
    // and generate columns from data instead
    if (config?.apiEndpoint && !config.apiEndpoint.includes("/api/explorer")) {
      console.log(
        `[DataExplorer] Using custom API endpoint ${config.apiEndpoint}, skipping schema introspection`
      );
      schema = null; // Will generate columns from data
      return;
    }

    // Try endpoint 1: /api/explorer/schema/json/:table
    try {
      const res = await fetch(`${API_URL}/api/explorer/schema/json/${tableName}`, {
        credentials: "include",
      });
      if (res.ok) {
        const jsonSchema = await res.json();
        if (jsonSchema.properties) {
          const cols: SchemaColumn[] = Object.entries(jsonSchema.properties).map(
            ([name, prop]: [string, any]) => ({
              name,
              type: inferTypeFromJsonSchema(prop),
              nullable: !jsonSchema.required?.includes(name),
              isPrimary: name === jsonSchema["x-kitsuden"]?.primaryKey,
            })
          );
          schema = {
            name: tableName,
            columns: cols,
            primaryKey: jsonSchema["x-kitsuden"]?.primaryKey || "id",
          };
          return;
        }
      }
    } catch {
      // Continue to fallback
    }

    // Try endpoint 2: /api/schema/tables/:table (schema introspection)
    try {
      const res = await fetch(`${API_URL}/api/schema/tables/${tableName}`, {
        credentials: "include",
      });
      if (res.ok) {
        const result = await res.json();
        if (result.table) {
          const introspected = result.table;
          const cols: SchemaColumn[] = introspected.columns.map((c: any) => ({
            name: c.name,
            type: c.type || inferTypeFromDbType(c.type),
            nullable: c.nullable !== false,
            isPrimary: introspected.primaryKey?.includes(c.name),
          }));
          schema = {
            name: tableName,
            columns: cols,
            primaryKey: introspected.primaryKey?.[0] || "id",
          };
          return;
        }
      }
    } catch {
      // Schema endpoint might not exist for this table — will infer from data
    }
  }

  function inferTypeFromDbType(dataType: string): string {
    const type = dataType?.toLowerCase() || "";
    if (type.includes("int")) return "number";
    if (type.includes("float") || type.includes("decimal") || type.includes("numeric"))
      return "number";
    if (type.includes("bool")) return "boolean";
    if (type.includes("timestamp") || type.includes("date")) return "date";
    if (type.includes("json")) return "json";
    if (type.includes("uuid")) return "uuid";
    return "text";
  }

  function inferTypeFromJsonSchema(prop: any): string {
    if (prop["x-relation"]) return "relation";
    if (prop.format === "date-time") return "date";
    if (prop.format === "email") return "email";
    if (prop.format === "uri") return "url";
    if (prop.format === "uuid" && !prop["x-relation"]) return "id";
    if (prop.type === "boolean") return "boolean";
    if (prop.type === "integer" || prop.type === "number") return "number";
    if (prop.type === "object") return "json";
    if (prop.readOnly) return "readonly";
    return "text";
  }

  async function loadData() {
    loading = true;
    loadError = null;
    try {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("page", String(currentPage));

      // Global search across ALL text columns
      if (searchQuery) {
        params.set("search", searchQuery);
        // Fallback for APIs that don't support global search
        if (searchFields.length > 0) {
          params.set("search_fields", searchFields.join(","));
          // Also send legacy single-field filter for backward compat
          params.set("filter_field", searchFields[0]);
          params.set("filter_op", "contains");
          params.set("filter_value", searchQuery);
        }
      }

      // Sort, in the dialect of the endpoint that will answer (see `sortParams`).
      for (const [key, value] of Object.entries(sortParams(getEndpoint(), sortStack))) {
        params.set(key, value);
      }

      // Apply active filters
      Object.entries(activeFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== "" && value !== null) {
          params.set("filter_field", key);
          if (typeof value === "boolean") {
            params.set("filter_op", "equals");
            params.set("filter_value", String(value));
          } else {
            params.set("filter_op", "contains");
            params.set("filter_value", String(value));
          }
        }
      });

      /**
       * The view's filter goes AFTER, and with `equals`.
       *
       * After because it defines what the tab is and cannot be overridden by
       * what the viewer has chosen; the API only supports one filter per request
       * (`filter_field` is a single key in the URL), so the order IS the
       * precedence.
       *
       * `equals` and not `contains` because a `contains` on statuses would make
       * «draft» match any status that contains it. Today none
       * does; tomorrow a `draft_review` would break «Drafts» without touching anything.
       */
      Object.entries(viewFilter).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") return;
        params.set("filter_field", key);
        params.set("filter_op", "equals");
        params.set("filter_value", String(value));
      });

      const tableName = activeTable;
      if (!tableName) return;
      const endpoint = getEndpoint(tableName);

      const res = await fetch(`${API_URL}${endpoint}?${params}`, {
        credentials: "include",
      });

      if (res.ok) {
        const result = await res.json();
        // On a local variable: reading `data` right after assigning it
        // ties the function back to its own output as soon as someone
        // calls it from an effect. See the note above.
        const rowsValue = result.data || result.docs || result;
        data = rowsValue;
        totalCount =
          result.pagination?.total || result.totalDocs || result.total || rowsValue.length;

        // If we didn't get schema from the schema endpoint, infer from data
        if (!schema && result.columns && result.columns.length > 0) {
          schema = {
            name: tableName,
            columns: result.columns.map((col: any) => ({
              name: col.field,
              type: col.type,
              nullable: true,
            })),
            primaryKey: "id",
          };
        }

        // Load FK display values for relation columns
        await loadFkDisplayValues();
      } else {
        // A refused or failed request used to leave the table on "No records found".
        const body = (await res.json().catch(() => null)) as {
          detail?: string;
          message?: string;
          error?: string;
        } | null;
        loadError = body?.detail || body?.message || body?.error || `HTTP ${res.status}`;
        data = [];
        totalCount = 0;
      }
    } catch (e) {
      console.error("Failed to load data", e);
      loadError = e instanceof Error ? e.message : String(e);
      data = [];
      totalCount = 0;
    } finally {
      loading = false;
    }
  }

  async function loadFkDisplayValues() {
    const relationCols = columns.filter((c) => isRelationColumn(c.name));
    if (relationCols.length === 0 || data.length === 0) return;

    // The related table is a GUESS from the column's name (`managerId` → `managers`).
    // Only the ones the explorer really has are asked: the rest were a 404 per column.
    const known = await knownTables();

    for (const col of relationCols) {
      const relTable = resolveRelatedTable(col.name, activeTable ?? "", known);
      if (!relTable) continue;
      if (relatedTables[col.name] !== relTable) {
        relatedTables = { ...relatedTables, [col.name]: relTable };
      }
      if (fkDisplayCache[relTable]) continue;

      try {
        const res = await fetch(`${API_URL}/api/explorer/${relTable}/options`, {
          credentials: "include",
        });
        if (res.ok) {
          const result = await res.json();
          const map: Record<string, string> = {};
          const options: { value: string; label: string }[] = [];
          for (const opt of result.options || []) {
            map[String(opt.value)] = opt.label;
            options.push(opt);
          }
          fkDisplayCache[relTable] = map;
          fkDisplayCache = { ...fkDisplayCache }; // trigger reactivity
          // Store options for filter dropdowns
          filterRelationOptions[col.name] = options;
          filterRelationOptions = { ...filterRelationOptions };
        }
      } catch {
        // FK table not in registry — skip silently
      }
    }
  }

  /** A relation by its display field when the data has it; a short id otherwise. */
  function resolveFkDisplay(colName: string, row: Record<string, unknown>): string {
    const relTable = getRelatedTable(colName);
    return relationDisplay(row, colName, relTable ? fkDisplayCache[relTable] : undefined);
  }

  async function handleInlineEdit(rowId: string, field: string, value: any) {
    const endpoint = getEndpoint();
    try {
      const res = await fetch(`${API_URL}${endpoint}/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });

      if (!res.ok) {
        console.error("Failed to update", await res.text());
      }
    } catch (e) {
      console.error("Error updating record", e);
    }
  }

  async function handleDelete(record: any) {
    const endpoint = getEndpoint();
    try {
      const res = await fetch(`${API_URL}${endpoint}/${record.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        toast.success(tr("dataExplorer.recordRemoved"));
        await loadData();
      } else {
        // A refused delete used to close nothing and say nothing.
        const body = (await res.json().catch(() => null)) as {
          detail?: string;
          message?: string;
          error?: string;
        } | null;
        toast.error(tr("dataExplorer.couldNotRemove"), {
          description: body?.detail || body?.message || body?.error || `HTTP ${res.status}`,
        });
      }
    } catch (e) {
      console.error("Error deleting record", e);
      toast.error(tr("dataExplorer.couldNotRemove"), {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  // ── Row Actions ──
  async function executeRowAction(action: RowAction, row: any) {
    if (action.confirm && !(await confirmDialog(action.confirm))) return;
    const endpoint = getEndpoint();
    try {
      const url = action.endpoint
        ? `${API_URL}${endpoint}/${row.id}/${action.endpoint}`
        : `${API_URL}${endpoint}/${row.id}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: action.id }),
      });
      if (res.ok) {
        if (action.refresh) await loadData();
      } else {
        console.error("Row action failed", await res.text());
      }
    } catch (e) {
      console.error("Error executing row action", e);
    }
  }

  // ── Bulk Actions ──
  function deselectAll() {
    selectedRows = new Set();
  }

  function getSelectedRows() {
    return data.filter((row) => selectedRows.has(row.id));
  }

  function hasStatusField() {
    return data.length > 0 && data.some((row) => row.status !== undefined);
  }

  async function handleBulkStatusUpdate(status: string) {
    if (selectedRows.size === 0) return;
    bulkActionLoading = true;
    const endpoint = getEndpoint();
    for (const id of selectedRows) {
      try {
        await fetch(`${API_URL}${endpoint}/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status }),
        });
      } catch {}
    }
    bulkActionLoading = false;
    await loadData();
  }

  async function handleBulkPublish() {
    await handleBulkStatusUpdate("published");
  }

  async function handleBulkUnpublish() {
    await handleBulkStatusUpdate("draft");
  }

  async function handleBulkDuplicate() {
    if (selectedRows.size === 0) return;
    bulkActionLoading = true;
    const endpoint = getEndpoint();
    const selectedData = getSelectedRows();
    for (const row of selectedData) {
      try {
        const copy = { ...row };
        delete copy.id;
        delete copy.createdAt;
        delete copy.updatedAt;
        if (copy.status !== undefined) copy.status = "draft";
        if (copy.title) copy.title = `${copy.title} (Copy)`;

        await fetch(`${API_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(copy),
        });
      } catch {}
    }
    selectedRows = new Set();
    bulkActionLoading = false;
    await loadData();
  }

  /** Asks with the panel's dialog (tallao ConfirmDialog: focus trap, Escape, focus back). */
  async function confirmBulkDelete() {
    const ok = await confirmDialog({
      title: tr("dataExplorer.deleteRecords", { size: selectedRows.size }),
      description: tr("dataExplorer.thisActionCannotBeUndone"),
      confirmLabel: tr("common.delete"),
    });
    if (ok) await executeBulkDelete();
  }

  async function executeBulkDelete() {
    bulkActionLoading = true;
    const endpoint = getEndpoint();
    for (const id of selectedRows) {
      try {
        await fetch(`${API_URL}${endpoint}/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
      } catch {}
    }
    selectedRows = new Set();
    bulkActionLoading = false;
    await loadData();
  }

  function handleExportCsv() {
    /**
     * No rows means nothing to export — but it must be SAID.
     *
     * Before, it was a bare `return`: you pressed «Export», absolutely
     * nothing happened, no message appeared and no file was
     * downloaded. From the outside it is indistinguishable from a broken button, and it is
     * precisely the most frequent case on a new installation, where tables
     * are empty.
     */
    if (data.length === 0) {
      toast.info(tr("dataExplorer.nothingToExport"));
      return;
    }
    const headers = Object.keys(data[0]);
    const csvRows = [
      headers.join(","),
      ...data.map((row) =>
        headers
          .map((h) => {
            const val = row[h];
            if (val === null || val === undefined) return "";
            const str = typeof val === "object" ? JSON.stringify(val) : String(val);
            return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
          })
          .join(",")
      ),
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${grimoireId}-export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * `?crear=1` opens the create form right on entry.
   *
   * It is needed because other screens link «create an X», and without this
   * the only thing that could be done was take you to the list and hope the person
   * pressed again. The «New Game» button of the games view did
   * exactly that: it navigated to this screen and stayed there, so
   * it seemed to do nothing.
   *
   * The URL parameter is cleared afterwards: otherwise, reloading or going back
   * would reopen the form over and over.
   */
  let signupByUrlDone = $state(false);

  $effect(() => {
    if (signupByUrlDone) return;
    if (!browser) return;
    if ($page.url.searchParams.get("create") !== "1") return;
    if (!activeTable) return;

    signupByUrlDone = true;
    untrack(() => {
      void openCreateModal();
      const cleans = new URL($page.url);
      cleans.searchParams.delete("create");
      void goto(`${cleans.pathname}${cleans.search}`, { replaceState: true, noScroll: true });
    });
  });

  async function openCreateModal() {
    /**
     * Without a table the form is not opened.
     *
     * The `?? grimoireId` fallback was removed from `activeTable` a while ago for
     * fabricating false names, and it was still alive right here, in the place where it
     * hurts most: the modal requested the schema of a table named after the kon and
     * showed «Could not load schema for table "kon-character-builder"» — the kon's id
     * disguised as a missing table.
     *
     * Saying so is more useful than making it up: if the active view has no table,
     * there is nothing to create from here.
     */
    if (!activeTable) {
      toast.error(tr("dataExplorer.thisViewDoesNotHaveA"));
      return;
    }

    // Ensure schema is loaded before opening modal
    if (!schema || columns.length === 0) {
      await loadSchema();
    }
    editRecord = null;
    showFormModal = true;
  }

  async function openEditModal(row: any) {
    // Ensure schema is loaded before opening modal
    if (!schema || columns.length === 0) {
      await loadSchema();
    }
    editRecord = { ...row };
    showFormModal = true;
  }

  /** Asks with the panel's dialog, naming the record, then deletes it. */
  async function confirmDelete(row: any) {
    const title = rowTitle(row, columns);
    const ok = await confirmDialog({
      title: title
        ? tr("dataExplorer.removeRecordNamed", { title })
        : tr("dataExplorer.removeRecord"),
      description: tr("dataExplorer.thisActionCannot"),
      confirmLabel: tr("common.remove"),
    });
    if (ok) await handleDelete(row);
  }

  function handleSort(column: string, multi = false) {
    const existing = sortStack.findIndex((s) => s.column === column);

    if (multi) {
      // Shift+click: add/toggle column in multi-sort stack
      if (existing >= 0) {
        const current = sortStack[existing];
        if (current.direction === "desc") {
          // Third click: remove from stack
          sortStack = sortStack.filter((_, i) => i !== existing);
        } else {
          sortStack = sortStack.map((s, i) => (i === existing ? { ...s, direction: "desc" } : s));
        }
      } else {
        sortStack = [...sortStack, { column, direction: "asc" }];
      }
    } else {
      // Normal click: single-column sort
      if (existing >= 0 && sortStack.length === 1) {
        const current = sortStack[0];
        if (current.direction === "desc") {
          sortStack = []; // Third click: clear sort
        } else {
          sortStack = [{ column, direction: "desc" }];
        }
      } else {
        sortStack = [{ column, direction: "asc" }];
      }
    }
    loadData();
  }

  function getSortIndex(column: string): number {
    return sortStack.findIndex((s) => s.column === column);
  }

  function getSortDir(column: string): "asc" | "desc" | null {
    const s = sortStack.find((s) => s.column === column);
    return s?.direction || null;
  }

  function toggleColumnVisibility(colName: string) {
    const newSet = new Set(hiddenColumns);
    if (newSet.has(colName)) {
      newSet.delete(colName);
    } else {
      newSet.add(colName);
    }
    hiddenChoice = newSet;
  }

  function showAllColumns() {
    hiddenChoice = new Set();
  }

  function handleSortClick(column: string, e: MouseEvent) {
    handleSort(column, e.shiftKey);
  }

  function handleSearch(e: Event) {
    searchQuery = (e.target as HTMLInputElement).value;
    currentPage = 1;
    loadData();
  }

  function applyFilter(field: string, value: any) {
    if (value === "" || value === null || value === undefined) {
      const { [field]: _, ...rest } = activeFilters;
      activeFilters = rest;
    } else {
      activeFilters = { ...activeFilters, [field]: value };
    }
    currentPage = 1;
    loadData();
  }

  function clearAllFilters() {
    activeFilters = {};
    currentPage = 1;
    loadData();
  }

  function toggleRowSelection(id: string) {
    const newSet = new Set(selectedRows);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    selectedRows = newSet;
  }

  function toggleAllSelection() {
    if (selectedRows.size === data.length) {
      selectedRows = new Set();
    } else {
      selectedRows = new Set(data.map((row) => row.id));
    }
  }

  function getCellValue(row: any, column: string) {
    return column.split(".").reduce((obj, key) => obj?.[key], row);
  }

  // ── Typed Cell Rendering ──
  function getColumnType(colName: string): string {
    const col = columns.find((c) => c.name === colName);
    if (col?.type) return col.type;
    // Infer from name patterns
    if (isRelationColumn(colName)) return "relation";
    if (colName.includes("url") || colName.includes("Url")) return "url";
    if (colName.includes("email")) return "email";
    if (colName.includes("color") || colName.includes("Color")) return "color";
    if (
      colName.endsWith("At") ||
      colName.endsWith("_at") ||
      colName.includes("date") ||
      colName.includes("Date")
    )
      return "date";
    return "text";
  }

  function formatValue(value: any): string {
    if (value === null || value === undefined) return "-";
    if (typeof value === "boolean") return value ? "✓" : "✗";
    if (value instanceof Date) return value.toLocaleDateString(localeFormat());
    if (typeof value === "object") return JSON.stringify(value).slice(0, 50) + "...";
    return String(value);
  }

  function formatDate(value: any): string {
    if (!value) return "-";
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return String(value);
    }
  }

  function formatDateTime(value: any): string {
    if (!value) return "-";
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(value);
    }
  }

  /**
   * Switches tab.
   *
   * It reloads nothing on its own: it writes the state and the `$effect` above
   * takes care of it. Before, it called `loadData()` directly —and never
   * `loadSchema()`—, so the load and the tab could end up describing different
   * tables.
   *
   * It also updates the URL, because `/g/[id]/[viewId]` exists as a route: without
   * this, reloading the page returned to the first tab and a specific view
   * could not be linked.
   */
  function switchView(vId: string) {
    if (vId === activeViewId) return;
    activeViewId = vId;

    if (typeof window !== "undefined") {
      const target = `/g/${grimoireId}/${vId}`;
      if (window.location.pathname !== target) {
        // `replaceState` and not `goto`: navigating would remount the component and
        // lose the state we just set.
        window.history.replaceState(window.history.state, "", target);
      }
    }
  }

  function getFilterInputType(col: SchemaColumn): string {
    if (isRelationColumn(col.name)) return "relation";
    const t = col.type?.toLowerCase() || "text";
    if (t === "boolean") return "boolean";
    if (t === "number" || t === "integer") return "number";
    if (t === "date") return "date";
    return "text";
  }

  const totalPages = $derived(Math.ceil(totalCount / pageSize));
  const activeFilterCount = $derived(Object.keys(activeFilters).length);
</script>

<!-- View-type routing -->
{#if activeView?.type === "kanban"}
  <KanbanBoard view={activeView as KanbanView} apiEndpoint={config?.apiEndpoint} />
{:else if activeView?.type === "calendar"}
  <CalendarView view={activeView as CalendarViewType} apiEndpoint={config?.apiEndpoint} />
{:else}
  <!-- Grid View (default) -->
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-kitsuden-text">
          {config?.name || activeView?.title || grimoireId}
        </h1>
        <p class="text-sm text-kitsuden-text-dim">
          {tr("dataExplorer.records", { v: totalCount.toLocaleString(localeFormat()) })}
        </p>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="group inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-accent/5 hover:border-kitsuden-accent/20 hover:text-kitsuden-accent transition-all duration-200"
          onclick={() => loadData()}
          title={tr("dataExplorer.update")}
        >
          <RefreshCw class="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
          <span class="hidden sm:inline">{tr("dataExplorer.update")}</span>
        </button>

        <button
          class="group inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-green/5 hover:border-kitsuden-green/20 hover:text-kitsuden-green transition-all duration-200"
          onclick={handleExportCsv}
          title={tr("dataExplorer.exportAsCsv")}
        >
          <Download class="w-4 h-4 group-hover:translate-y-0.5 transition-transform" />
          <span class="hidden sm:inline">{tr("dataExplorer.exportData")}</span>
        </button>

        <button
          class="group inline-flex items-center gap-2 px-5 py-2.5 bg-kitsuden-accent text-kitsuden-on-accent rounded-xl font-semibold shadow-lg shadow-kitsuden-accent/25 hover:shadow-kitsuden-accent/40 hover:scale-105 active:scale-95 transition-all duration-200"
          onclick={openCreateModal}
        >
          <Plus class="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
          <span>{tr("dataExplorer.add")}{signupTag ? ` ${signupTag}` : ""}</span>
        </button>
      </div>
    </div>

    <!-- View Tabs (when multiple views exist) -->
    {#if views.length > 1}
      <div
        class="flex items-center gap-1 p-1 bg-kitsuden-bg border border-kitsuden-border rounded-lg w-fit"
        role="tablist"
        aria-label={tr("dataExplorer.views")}
      >
        {#each views as v}
          <button
            role="tab"
            aria-selected={activeView?.id === v.id}
            class="px-3 py-1.5 text-sm rounded-md transition-colors {activeView?.id === v.id
              ? 'bg-kitsuden-card text-kitsuden-text shadow-xs'
              : 'text-kitsuden-text-dim hover:text-kitsuden-text'}"
            onclick={() => switchView(v.id)}
          >
            {v.title}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Toolbar -->
    <div
      class="flex items-center gap-3 p-3 bg-kitsuden-card border border-kitsuden-border rounded-lg"
    >
      <div class="relative flex-1 max-w-md">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-text-dim" />
        <input
          type="text"
          placeholder={tr("dataExplorer.searchAllFields")}
          class="input pl-10 w-full"
          value={searchQuery}
          oninput={handleSearch}
        />
      </div>

      <button
        class="group inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-accent/5 hover:border-kitsuden-accent/20 transition-all duration-200 {showFilters
          ? 'bg-kitsuden-accent/10 text-kitsuden-accent border-kitsuden-accent/30'
          : ''}"
        onclick={() => (showFilters = !showFilters)}
      >
        <Filter class="w-4 h-4 group-hover:scale-110 transition-transform" />
        <span class="hidden sm:inline">{tr("dataExplorer.filters")}</span>
        {#if activeFilterCount > 0}
          <span
            class="ml-1 px-2 py-0.5 text-xs font-bold rounded-full bg-kitsuden-accent text-kitsuden-on-accent"
          >
            {activeFilterCount}
          </span>
        {/if}
      </button>

      <!-- Column Visibility Toggle -->
      <div class="relative">
        <button
          class="group inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-xl bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-accent/5 hover:border-kitsuden-accent/20 transition-all duration-200 {showColumnMenu
            ? 'bg-kitsuden-accent/10 text-kitsuden-accent border-kitsuden-accent/30'
            : ''}"
          onclick={() => (showColumnMenu = !showColumnMenu)}
          title={tr("dataExplorer.showHideColumns")}
        >
          <Columns3 class="w-4 h-4 group-hover:scale-110 transition-transform" />
          <span class="hidden sm:inline">{tr("dataExplorer.columns")}</span>
          {#if hiddenColumns.size > 0}
            <span
              class="ml-1 px-2 py-0.5 text-xs font-bold rounded-full bg-kitsuden-amber text-kitsuden-on-status"
            >
              {hiddenColumns.size}
            </span>
          {/if}
        </button>

        {#if showColumnMenu}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-40" onclick={() => (showColumnMenu = false)}></div>
          <div
            class="absolute right-0 top-full mt-1 z-50 w-56 bg-kitsuden-card border border-kitsuden-border rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto"
          >
            <div class="flex items-center justify-between px-2 py-1 mb-1">
              <p class="text-xs font-semibold text-kitsuden-subtle uppercase tracking-wider">
                {tr("dataExplorer.columns")}
              </p>
              {#if hiddenColumns.size > 0}
                <button
                  class="text-xs text-kitsuden-accent hover:underline"
                  onclick={showAllColumns}>{tr("dataExplorer.showAll")}</button
                >
              {/if}
            </div>
            {#each columns as col}
              <label
                class="flex items-center gap-2 px-2 py-1.5 hover:bg-kitsuden-bg rounded-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={!hiddenColumns.has(col.name)}
                  onchange={() => toggleColumnVisibility(col.name)}
                  class="w-3.5 h-3.5 rounded-sm border-kitsuden-input accent-kitsuden-accent"
                />
                <span class="text-sm text-kitsuden-text-dim truncate">
                  {columnLabel(col.name)}
                </span>
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Sort indicator -->
      {#if sortStack.length > 0}
        <div class="flex items-center gap-1 text-xs text-kitsuden-subtle">
          <ArrowUpDown class="w-3.5 h-3.5" />
          {tr("dataExplorer.sort", { sortStackCount: sortStack.length })}{sortStack.length > 1
            ? "s"
            : ""}
          <button
            class="text-kitsuden-accent hover:underline ml-1"
            onclick={() => {
              sortStack = [];
              loadData();
            }}>{tr("dataExplorer.clear")}</button
          >
        </div>
      {/if}
    </div>

    <!-- Filter Sidebar -->
    {#if showFilters}
      <div class="p-4 bg-kitsuden-card border border-kitsuden-border rounded-lg space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-kitsuden-text">{tr("dataExplorer.filters")}</h3>
          {#if activeFilterCount > 0}
            <button class="text-xs text-kitsuden-accent hover:underline" onclick={clearAllFilters}>
              {tr("dataExplorer.clearAll", { activeFilterCount })}
            </button>
          {/if}
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {#each filterableColumns.slice(0, 12) as col}
            {@const filterType = getFilterInputType(col)}
            <div>
              <label
                for="filter-{col.name}"
                class="block text-xs font-medium text-kitsuden-text-dim mb-1"
              >
                {col.name
                  .replace(/_id$/, "")
                  .replace(/Id$/, "")
                  .replace(/([A-Z])/g, " $1")
                  .replace(/_/g, " ")
                  .replace(/^\w/, (c) => c.toUpperCase())
                  .trim()}
              </label>

              {#if filterType === "boolean"}
                <select
                  id="filter-{col.name}"
                  class="input w-full text-sm"
                  value={activeFilters[col.name] ?? ""}
                  onchange={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    applyFilter(col.name, v === "" ? null : v === "true");
                  }}
                >
                  <option value="">{tr("dataExplorer.all")}</option>
                  <option value="true">{tr("common.yes")}</option>
                  <option value="false">{tr("common.no")}</option>
                </select>
              {:else if filterType === "relation"}
                <select
                  id="filter-{col.name}"
                  class="input w-full text-sm"
                  value={activeFilters[col.name] ?? ""}
                  onchange={(e) =>
                    applyFilter(col.name, (e.target as HTMLSelectElement).value || null)}
                >
                  <option value="">{tr("dataExplorer.all")}</option>
                  {#if filterRelationOptions[col.name]}
                    {#each filterRelationOptions[col.name] as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  {/if}
                </select>
              {:else if filterType === "number"}
                <input
                  id="filter-{col.name}"
                  type="number"
                  class="input w-full text-sm"
                  placeholder={tr("dataExplorer.filter")}
                  value={activeFilters[col.name] ?? ""}
                  onchange={(e) =>
                    applyFilter(col.name, (e.target as HTMLInputElement).value || null)}
                />
              {:else if filterType === "date"}
                <input
                  id="filter-{col.name}"
                  type="date"
                  class="input w-full text-sm"
                  value={activeFilters[col.name] ?? ""}
                  onchange={(e) =>
                    applyFilter(col.name, (e.target as HTMLInputElement).value || null)}
                />
              {:else}
                <input
                  id="filter-{col.name}"
                  type="text"
                  class="input w-full text-sm"
                  placeholder={tr("dataExplorer.filter")}
                  value={activeFilters[col.name] ?? ""}
                  oninput={(e) =>
                    applyFilter(col.name, (e.target as HTMLInputElement).value || null)}
                />
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Bulk Actions Bar -->
    {#if selectedRows.size > 0}
      <div
        class="sticky top-4 z-20 flex flex-wrap items-center justify-between gap-3 p-3 bg-kitsuden-card border border-kitsuden-border rounded-lg shadow-lg shadow-black/10"
      >
        <div class="flex items-center gap-3">
          <span
            class="px-2.5 py-1 text-sm font-medium rounded-full bg-kitsuden-accent/10 text-kitsuden-accent border border-kitsuden-accent/20"
          >
            {tr("dataExplorer.selected", { size: selectedRows.size })}
          </span>
          {#if selectedRows.size < data.length}
            <button
              class="text-xs text-kitsuden-text-dim hover:text-kitsuden-accent transition-colors"
              onclick={() => {
                selectedRows = new Set(data.map((row) => row.id));
              }}
            >
              {tr("dataExplorer.selectAll", { dataCount: data.length })}
            </button>
          {:else}
            <button
              class="text-xs text-kitsuden-text-dim hover:text-kitsuden-accent transition-colors"
              onclick={deselectAll}
            >
              {tr("dataExplorer.deselectAll")}
            </button>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          {#if hasStatusField()}
            <button
              class="group inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-green/10 hover:border-kitsuden-green/30 hover:text-kitsuden-green transition-all duration-200 disabled:opacity-50"
              onclick={handleBulkPublish}
              disabled={bulkActionLoading}
              title={tr("dataExplorer.publishSelected")}
            >
              <Eye class="w-3.5 h-3.5" />
              {tr("dataExplorer.publish")}
            </button>
            <button
              class="group inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-amber/10 hover:border-kitsuden-amber/30 hover:text-kitsuden-amber transition-all duration-200 disabled:opacity-50"
              onclick={handleBulkUnpublish}
              disabled={bulkActionLoading}
              title={tr("dataExplorer.unpublishSelected")}
            >
              <EyeOff class="w-3.5 h-3.5" />
              {tr("dataExplorer.unpublish")}
            </button>
          {/if}

          <button
            class="group inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-kitsuden-surface border border-kitsuden-border text-kitsuden-text hover:bg-kitsuden-accent/10 hover:border-kitsuden-accent/30 hover:text-kitsuden-accent transition-all duration-200 disabled:opacity-50"
            onclick={handleBulkDuplicate}
            disabled={bulkActionLoading}
            title={tr("dataExplorer.duplicateSelected")}
          >
            <Copy class="w-3.5 h-3.5" />
            {tr("dataExplorer.duplicate")}
          </button>

          <div class="w-px h-6 bg-kitsuden-border mx-1"></div>

          <button
            class="group inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-linear-to-r from-kitsuden-danger/10 to-kitsuden-danger/10 text-kitsuden-danger border border-kitsuden-danger/20 hover:from-kitsuden-danger/20 hover:to-kitsuden-danger/20 hover:border-kitsuden-danger/30 transition-all duration-200 disabled:opacity-50"
            onclick={confirmBulkDelete}
            disabled={bulkActionLoading}
            title={tr("dataExplorer.deleteSelected")}
          >
            <Trash2 class="w-3.5 h-3.5 group-hover:animate-pulse" />
            {tr("common.delete")}
          </button>
        </div>
      </div>
    {/if}

    <!-- Data Table -->
    <div class="border border-kitsuden-border rounded-lg overflow-hidden bg-kitsuden-card">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-kitsuden-border bg-kitsuden-bg">
              <th class="w-10 px-3 py-2" scope="col">
                <input
                  type="checkbox"
                  checked={data.length > 0 && selectedRows.size === data.length}
                  indeterminate={selectedRows.size > 0 && selectedRows.size < data.length}
                  onchange={toggleAllSelection}
                  aria-label={tr("dataExplorer.selectAllRows")}
                  class="w-4 h-4 rounded-sm border-kitsuden-input accent-kitsuden-accent"
                />
              </th>
              {#each displayColumns as column}
                {@const dir = getSortDir(column.name)}
                {@const idx = getSortIndex(column.name)}
                <th class="px-3 py-2 text-left" scope="col" aria-sort={ariaSort(dir)}>
                  <button
                    class="group flex items-center gap-1 rounded-sm text-xs font-semibold uppercase tracking-wider whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kitsuden-accent {dir
                      ? 'text-kitsuden-accent'
                      : 'text-kitsuden-subtle hover:text-kitsuden-accent'}"
                    onclick={(e) => handleSortClick(column.name, e)}
                    title={tr("dataExplorer.clickToSortShiftClick")}
                  >
                    {columnLabel(column.name)}
                    {#if dir === "asc"}
                      <ArrowUp class="w-3 h-3" />
                    {:else if dir === "desc"}
                      <ArrowDown class="w-3 h-3" />
                    {:else}
                      <ArrowUpDown
                        class="w-3 h-3 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60"
                      />
                    {/if}
                    {#if sortStack.length > 1 && idx >= 0}
                      <span
                        class="text-xs font-bold bg-kitsuden-accent/20 text-kitsuden-accent rounded-full w-4 h-4 flex items-center justify-center"
                        >{idx + 1}</span
                      >
                    {/if}
                  </button>
                </th>
              {/each}
              <!-- One sticky column for every row action, behind a single "⋯" menu. -->
              <th
                scope="col"
                class="sticky -right-px z-10 w-12 border-l border-kitsuden-border bg-kitsuden-bg px-2 py-2"
              >
                <span class="sr-only">{tr("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {#if loading}
              {#each Array(5) as _, i}
                <tr class="h-11 border-b border-kitsuden-border">
                  {#each Array(Math.min(displayColumns.length + 2, 10)) as __}
                    <td class="px-3 py-1.5">
                      <div class="h-4 bg-kitsuden-border/30 rounded-sm animate-pulse"></div>
                    </td>
                  {/each}
                </tr>
              {/each}
            {:else if loadError}
              <!-- The error replaces the empty state: a failed load is not "no records". -->
              <tr>
                <td colspan="100" class="p-6">
                  <StateMessage
                    kind="error"
                    title={tr("dataExplorer.loadFailed")}
                    description={loadError}
                    onRetry={() => loadData()}
                    class="border-0 bg-transparent"
                  />
                </td>
              </tr>
            {:else if data.length === 0}
              <tr>
                <td colspan="100" class="p-12 text-center">
                  <div class="flex flex-col items-center gap-3">
                    <div
                      class="w-12 h-12 rounded-full bg-kitsuden-border/20 flex items-center justify-center"
                    >
                      <FileJson class="w-6 h-6 text-kitsuden-subtle" />
                    </div>
                    <p class="text-kitsuden-text-dim">{tr("dataExplorer.noRecordsFound")}</p>
                    {#if searchQuery || activeFilterCount > 0}
                      <button
                        class="text-xs px-3 py-1.5 rounded-lg bg-kitsuden-accent/10 text-kitsuden-accent hover:bg-kitsuden-accent/20 transition-colors"
                        onclick={() => {
                          searchQuery = "";
                          clearAllFilters();
                        }}
                      >
                        {tr("dataExplorer.clearSearchAndFilters")}
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {:else}
              {#each data as row}
                {@const title = rowTitle(row, columns)}
                <tr class="group/row h-11 border-b border-kitsuden-border transition-colors">
                  <td class="px-3 py-1.5 group-hover/row:bg-kitsuden-accent/5">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(row.id)}
                      onchange={() => toggleRowSelection(row.id)}
                      aria-label={tr("dataExplorer.selectRow", { title })}
                      class="w-4 h-4 rounded-sm border-kitsuden-input accent-kitsuden-accent"
                    />
                  </td>
                  {#each displayColumns as column}
                    {@const value = getCellValue(row, column.name)}
                    {@const colType = getColumnType(column.name)}
                    <td class="px-3 py-1.5 group-hover/row:bg-kitsuden-accent/5">
                      <!-- BOOLEAN: colored badge -->
                      {#if colType === "boolean"}
                        {#if value === true}
                          <span
                            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-kitsuden-green/10 text-kitsuden-green border border-kitsuden-green/20"
                          >
                            <Check class="w-3 h-3" />
                            {tr("dataExplorer.si")}
                          </span>
                        {:else if value === false}
                          <span
                            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-kitsuden-danger/10 text-kitsuden-danger border border-kitsuden-danger/20"
                          >
                            <X class="w-3 h-3" />
                            {tr("common.no")}
                          </span>
                        {:else}
                          <span class="text-kitsuden-subtle">-</span>
                        {/if}

                        <!-- DATE: formatted -->
                      {:else if colType === "date"}
                        <span
                          class="text-kitsuden-text-dim text-xs"
                          title={value ? String(value) : ""}
                        >
                          {formatDateTime(value)}
                        </span>

                        <!-- RELATION: FK badge -->
                      {:else if colType === "relation" || isRelationColumn(column.name)}
                        <span
                          class="inline-block max-w-[14rem] truncate align-middle whitespace-nowrap px-2 py-0.5 rounded-md bg-kitsuden-surface text-xs font-medium text-kitsuden-text-dim"
                          title={String(value || "")}
                        >
                          {resolveFkDisplay(column.name, row)}
                        </span>

                        <!-- URL: clickable link -->
                      {:else if colType === "url"}
                        {#if value}
                          <a
                            href={value}
                            target="_blank"
                            rel="noopener"
                            class="inline-flex items-center gap-1 text-kitsuden-accent hover:underline text-xs truncate max-w-[200px]"
                            onclick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink class="w-3 h-3 shrink-0" />
                            {String(value)
                              .replace(/^https?:\/\//, "")
                              .slice(0, 30)}
                          </a>
                        {:else}
                          <span class="text-kitsuden-subtle">-</span>
                        {/if}

                        <!-- EMAIL: clickable mailto -->
                      {:else if colType === "email"}
                        {#if value}
                          <a
                            href="mailto:{value}"
                            class="inline-flex items-center gap-1 text-kitsuden-accent hover:underline text-xs"
                            onclick={(e) => e.stopPropagation()}
                          >
                            <Mail class="w-3 h-3 shrink-0" />
                            {value}
                          </a>
                        {:else}
                          <span class="text-kitsuden-subtle">-</span>
                        {/if}

                        <!-- COLOR: swatch + hex -->
                      {:else if colType === "color"}
                        {#if value}
                          <div class="flex items-center gap-2">
                            <div
                              class="w-5 h-5 rounded-sm border border-kitsuden-border shrink-0"
                              style="background-color: {value}"
                            ></div>
                            <span class="text-xs text-kitsuden-text-dim font-mono">{value}</span>
                          </div>
                        {:else}
                          <span class="text-kitsuden-subtle">-</span>
                        {/if}

                        <!-- ID: truncated mono -->
                      {:else if colType === "id"}
                        <span class="text-xs text-kitsuden-subtle font-mono" title={value}>
                          {value ? String(value).slice(0, 8) + "…" : "-"}
                        </span>

                        <!-- IMAGE: thumbnail (detect by column name) -->
                      {:else if column.name === "image" || column.name === "portada" || column.name === "cover" || column.name === "thumbnailUrl" || column.name === "thumbnail_url"}
                        {#if value}
                          <img
                            src={value}
                            alt=""
                            class="w-10 h-10 object-cover rounded-sm border border-kitsuden-border"
                          />
                        {:else}
                          <div
                            class="w-10 h-10 bg-kitsuden-border/30 rounded-sm flex items-center justify-center text-xs text-kitsuden-text-dim"
                          >
                            N/A
                          </div>
                        {/if}

                        <!-- JSON: preview -->
                      {:else if colType === "json"}
                        {#if value !== null && value !== undefined}
                          <span
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs font-mono bg-kitsuden-surface text-kitsuden-subtle"
                            title={JSON.stringify(value, null, 2)}
                          >
                            <FileJson class="w-3 h-3" />
                            {Array.isArray(value)
                              ? `[${value.length}]`
                              : `{${Object.keys(value).length}}`}
                          </span>
                        {:else}
                          <span class="text-kitsuden-subtle">-</span>
                        {/if}

                        <!-- NUMBER: formatted -->
                      {:else if colType === "number"}
                        <span class="text-kitsuden-text tabular-nums">
                          {value !== null && value !== undefined
                            ? Number(value).toLocaleString(localeFormat())
                            : "-"}
                        </span>

                        <!-- DEFAULT TEXT -->
                      {:else}
                        <span class="text-kitsuden-text truncate max-w-[250px] block">
                          {formatValue(value)}
                        </span>
                      {/if}
                    </td>
                  {/each}
                  <!--
                    Every action of the row behind one "⋯" (tallao DropdownMenu): the kon's own
                    actions, Edit and Delete. The column is sticky, so it stays in reach on a
                    wide table, and the button is always drawn: nothing depends on hover.
                  -->
                  <td
                    class="sticky -right-px border-l border-kitsuden-border bg-kitsuden-card px-2 py-1 text-right"
                  >
                    <DropdownMenu
                      label={tr("dataExplorer.actionsFor", { title })}
                      placement="bottom-end"
                    >
                      {#snippet trigger(props)}
                        <Button
                          {...props}
                          variant="ghost"
                          size="icon"
                          ariaLabel={tr("dataExplorer.actionsFor", { title })}
                          title={tr("dataExplorer.rowActions")}
                          data-testid="row-actions"
                        >
                          <MoreHorizontal class="w-4 h-4" />
                        </Button>
                      {/snippet}
                      {#each rowActions as action}
                        {@const visible =
                          !action.showIf || row[action.showIf.field] === action.showIf.equals}
                        {#if visible}
                          <MenuItem
                            variant={action.variant === "danger" ? "danger" : "default"}
                            onSelect={() => executeRowAction(action, row)}
                          >
                            {action.label}
                          </MenuItem>
                        {/if}
                      {/each}
                      <MenuItem onSelect={() => openEditModal(row)}>
                        <Edit class="w-3.5 h-3.5" />
                        {tr("dataExplorer.edit")}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem variant="danger" onSelect={() => confirmDelete(row)}>
                        <Trash2 class="w-3.5 h-3.5" />
                        {tr("common.remove")}…
                      </MenuItem>
                    </DropdownMenu>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between p-3 border-t border-kitsuden-border">
        <div class="text-sm text-kitsuden-text-dim">
          {#if totalCount > 0}
            {tr("dataExplorer.showingToOf", {
              v: (currentPage - 1) * pageSize + 1,
              v2: Math.min(currentPage * pageSize, totalCount),
              totalCount,
            })}
          {:else}
            {tr("dataExplorer.noRecords")}
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <select
            class="px-3 py-2 text-sm rounded-xl bg-kitsuden-surface border border-kitsuden-input text-kitsuden-text focus:outline-hidden focus:ring-2 focus:ring-kitsuden-accent/50 focus:border-kitsuden-accent/50 transition-all duration-200 hover:border-kitsuden-accent/30 cursor-pointer"
            bind:value={pageSize}
            onchange={() => {
              currentPage = 1;
              loadData();
            }}
          >
            <option value={10}>{tr("dataExplorer.n10PerPage")}</option>
            <option value={25}>{tr("dataExplorer.n25PerPage")}</option>
            <option value={50}>{tr("dataExplorer.n50PerPage")}</option>
            <option value={100}>{tr("dataExplorer.n100PerPage")}</option>
          </select>

          <div
            class="flex items-center gap-1 bg-kitsuden-surface border border-kitsuden-border rounded-xl p-1"
          >
            <button
              class="group p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent/10 hover:text-kitsuden-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all duration-200"
              disabled={currentPage === 1}
              onclick={() => {
                currentPage = 1;
                loadData();
              }}
              title={tr("dataExplorer.firstPage")}
            >
              <ChevronsLeft class="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>
            <button
              class="group p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent/10 hover:text-kitsuden-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all duration-200"
              disabled={currentPage === 1}
              onclick={() => {
                currentPage--;
                loadData();
              }}
              title={tr("dataExplorer.previousPage")}
            >
              <ChevronLeft class="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>

            <span
              class="px-4 py-1 text-sm font-semibold text-kitsuden-text tabular-nums bg-kitsuden-bg rounded-lg border border-kitsuden-border min-w-[80px] text-center"
            >
              {currentPage} / {totalPages || 1}
            </span>

            <button
              class="group p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent/10 hover:text-kitsuden-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all duration-200"
              disabled={currentPage >= totalPages}
              onclick={() => {
                currentPage++;
                loadData();
              }}
              title={tr("dataExplorer.nextPage")}
            >
              <ChevronRight class="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <button
              class="group p-2 rounded-lg text-kitsuden-text-dim hover:bg-kitsuden-accent/10 hover:text-kitsuden-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all duration-200"
              disabled={currentPage >= totalPages}
              onclick={() => {
                currentPage = totalPages;
                loadData();
              }}
              title={tr("dataExplorer.lastPage")}
            >
              <ChevronsRight class="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Auto-Form Modal -->
<!--
  Without a table the form is not rendered. It is the other half of the guard in
  `openCreateModal`: the render condition and the open condition must say
  the same thing, or the type lies in one of the two.
-->
{#if showFormModal && activeTable}
  <AutoFormModal
    tableName={activeTable}
    {columns}
    editData={editRecord}
    apiEndpoint={apiBaseEndpoint}
    {grimoireId}
    onsave={() => loadData()}
    onclose={() => {
      showFormModal = false;
      editRecord = null;
    }}
  />
{/if}
