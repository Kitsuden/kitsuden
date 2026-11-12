<script lang="ts">
  import { t as tr, localeFormat } from "$lib/i18n";
  import CustomViewHost from "./CustomViewHost.svelte";
  /**
   * GrimoirePage.svelte — Hybrid Rendering Edition
   *
   * Supports two modes:
   * 1. LEGACY: Full custom Svelte view (monolith) — loaded via GRIMOIRE_VIEW_REGISTRY
   * 2. HYBRID: Multiple views per grimoire — DataExplorer for grid/kanban/calendar,
   *    Custom Svelte components only for type: "custom" views
   *
   * Flow:
   * 1. Fetch grimoire config from /api/admin/registry
   * 2. If legacy custom view exists → load monolith (backward compat)
   * 3. If admin.views declared → render tabs (DataExplorer + custom views)
   * 4. Fallback to auto-generated DataExplorer config
   */
  import { untrack, type Component } from "svelte";

  import CalendarView from "$lib/components/admin/CalendarView.svelte";
  import KanbanBoard from "$lib/components/admin/KanbanBoard.svelte";
  import Page from "$lib/components/layout/Page.svelte";
  import ListView from "$lib/components/list/ListView.svelte";
  import QuickAddDialog from "$lib/components/list/QuickAddDialog.svelte";
  import RecordPage from "$lib/components/list/RecordPage.svelte";
  import { konViewActions } from "$lib/list/kon-actions";
  import { explorerSource, type RecordSource } from "$lib/list/source";
  import { Button, EmptyState, Skeleton, Tabs, type TabItem } from "$lib/tallao";
  import { moduleStore } from "$lib/states/modules.svelte";
  import {
    getGrimoireConfig,
    loadCustomView,
    generateExplorerConfig,
    generateDefaultConfig,
    hasCustomView,
    type GrimoireAdminConfig,
    type AdminViewConfig,
  } from "$lib/grimoire-loader";
  import type {
    AdminConfig,
    CalendarView as CalendarViewConfig,
    GridView,
    KanbanView,
  } from "$lib/types/admin";

  import { goto } from "$app/navigation";

  const {
    grimoireId,
    initialViewId,
    recordId,
  }: {
    grimoireId: string;
    initialViewId?: string;
    /** `/g/<kon>/<view>/<record>`: one record of the view's table (or "new"). */
    recordId?: string;
  } = $props();

  // Legacy mode state
  let LegacyView: Component | null = $state(null);

  // Hybrid mode state
  let grimoireConfig = $state<GrimoireAdminConfig | null>(null);
  let activeViewId = $state<string>(initialViewId || "");
  let customViews = $state<Record<string, Component>>({});

  // Shared state
  let loading = $state(true);
  let error = $state<string | null>(null);

  /**
   * Is this kon enabled?
   *
   * Without this, entering a DISABLED kon rendered its data explorer as if
   * nothing were wrong: header, «0 records» and an «Add» button that opened a form
   * complaining it could not find the table. And it cannot find it because the kon is
   * not installed — its migrations have not run and its tables do not exist.
   *
   * The resulting message talked about a missing table, when what is missing
   * is the whole kon. Asking here turns a technical dead-end error into
   * a sentence with a button.
   */
  const withoutPrefix = $derived(grimoireId.replace(/^kon-/, ""));

  /**
   * Does the URL id correspond to a KON?
   *
   * Not everything under `/g/` is one. `grimoire-loader.ts` registers
   * system views by key —`system-tools-editor`, `system-tools-builder`— and the
   * content editor lives at `/g/system-tools/editor`.
   *
   * The first version of the check below did not distinguish this, so
   * `system-tools` did not appear among the active kons and the editor started
   * answering «This kon is not enabled». That broke a working screen
   * while trying to fix another — and two rounds earlier a note had been left in
   * `routes/content/edit/+page.ts` that `system-tools` is NOT a kon, precisely
   * to avoid this mistake.
   */
  const isKon = $derived(
    moduleStore.modules.some(
      (m) => m.key === grimoireId || m.key.replace(/^kon-/, "") === withoutPrefix
    )
  );

  /**
   * Only what IS a kon and is disabled gets blocked.
   *
   * If the id belongs to no kon, this screen has nothing to say
   * about it: it is served by the system view registry or does not exist, and in the
   * second case the loader itself will give its error.
   */
  // `activeKon` already compares by kon —prefixed or not—, which is what was done
  // by hand here with two `has()`. A single rule, in the store.
  const activatedKon = $derived(!isKon || moduleStore.activeKon(grimoireId));

  // Core engines with custom views that are not in the registry
  const CORE_ENGINES_WITH_VIEWS = ["media-library", "media"];

  /**
   * `$effect` and not `onMount`: we must reload when the kon CHANGES.
   *
   * When navigating between kons in the menu, SvelteKit reuses this same component
   * instead of mounting it again, so `onMount` did not fire again: the
   * page kept the previous kon's configuration and only
   * updated on F5. With two different kons that means seeing the data
   * of the one you did not ask for, which is worse than an error.
   *
   * Reading `grimoireId` inside the effect is what creates the dependency; as
   * soon as it changes, this runs again by itself.
   */
  $effect(() => {
    const kon = grimoireId;

    // Clean state on every change: without this the previous kon's view would be seen
    // while the new one loads, and an old error would survive navigation.
    loading = true;
    error = null;
    LegacyView = null;
    grimoireConfig = null;
    customViews = {};
    activeViewId = untrack(() => initialViewId) || "";

    void loadKon(kon);
  });

  // Another view of the same kon (a tab, a link): switch without loading the kon again.
  $effect(() => {
    const requested = initialViewId;
    untrack(() => {
      if (loading) return;
      const next = requested || grimoireConfig?.defaultView || grimoireConfig?.views[0]?.id || "";
      if (next && next !== activeViewId) activeViewId = next;
    });
  });

  async function loadKon(grimoireId: string) {
    try {
      // Step 1: Fetch auto-discovered config from registry
      const config = await getGrimoireConfig(grimoireId);
      grimoireConfig = config;

      if (config) {
        // Set default active view (respect URL if provided)
        if (!activeViewId) {
          activeViewId = config.defaultView || config.views[0]?.id || "";
        }

        // Step 2: Check for LEGACY monolith view (full grimoire custom view)
        // This takes precedence for backward compatibility during migration
        const hasLegacyCustom =
          hasCustomView(grimoireId) || CORE_ENGINES_WITH_VIEWS.includes(grimoireId);

        if (hasLegacyCustom && !hasHybridViews(config)) {
          // Legacy mode: load the full monolith view
          const view = await loadCustomView(grimoireId);
          if (view) {
            LegacyView = view;
            loading = false;
            return;
          }
        }

        // Step 3: Hybrid mode — load custom views for type: "custom" entries
        for (const view of config.views) {
          if (view.type === "custom") {
            const custom = await loadCustomView(grimoireId, view.id);
            if (custom) {
              customViews = { ...customViews, [view.id]: custom };
            }
          }
        }
      } else {
        // No registry config — try per-view custom component first (e.g. system-tools/editor)
        if (initialViewId) {
          const view = await loadCustomView(grimoireId, initialViewId);
          if (view) {
            LegacyView = view;
            loading = false;
            return;
          }
        }

        // Fallback to legacy monolith view
        if (hasCustomView(grimoireId) || CORE_ENGINES_WITH_VIEWS.includes(grimoireId)) {
          const view = await loadCustomView(grimoireId);
          if (view) {
            LegacyView = view;
            loading = false;
            return;
          }
        }

        console.warn(`[GrimoirePage] No registry config for ${grimoireId}, using defaults`);
      }
    } catch (err) {
      console.error(`[GrimoirePage] Failed to load grimoire "${grimoireId}":`, err);
      error = err instanceof Error ? err.message : tr("grimoirePage.failedToLoadGrimoire");
    } finally {
      loading = false;
    }
  }

  /**
   * Check if grimoire config uses hybrid rendering (mix of custom + DataExplorer views)
   */
  function hasHybridViews(config: GrimoireAdminConfig): boolean {
    const customCount = config.views.filter((v) => v.type === "custom").length;
    const explorerCount = config.views.filter((v) => v.type !== "custom").length;
    // Hybrid = has BOTH custom and explorer views, OR only explorer views (no legacy monolith)
    return customCount > 0 || explorerCount > 0;
  }

  /**
   * Get DataExplorer config for the currently active view
   */
  function getActiveExplorerConfig(): AdminConfig | undefined {
    if (!grimoireConfig) return undefined;
    return generateExplorerConfig(grimoireConfig, activeViewId);
  }

  /**
   * Check if the active view is a custom Svelte component
   *
   * Declared-but-unloaded custom views count too: DataExplorer cannot render
   * them, so the template shows the "not yet implemented" card instead.
   */
  function isActiveViewCustom(): boolean {
    if (!grimoireConfig) return false;
    const view = grimoireConfig.views.find((v) => v.id === activeViewId);
    return view?.type === "custom";
  }

  /**
   * The active view, if it is a Web Component contributed by a kon.
   *
   * DataExplorer does not render these and they are not Svelte components of the admin: they are
   * artifacts served by the kon itself and mounted by `CustomViewHost`. Four
   * kons bring them —tierlist, broadcast, broadcast-moba and esports— and until
   * now none was displayed: the registry turned their type into «grid» and here
   * there was no branch that mounted them.
   */
  const activeElementView = $derived.by(() => {
    if (!grimoireConfig) return null;
    const viewValue = grimoireConfig.views.find((v) => v.id === activeViewId);
    if (viewValue?.type !== "element" || !viewValue.element || !viewValue.src) return null;
    return { element: viewValue.element, src: viewValue.src, konId: grimoireId };
  });

  /**
   * Get the active custom view component
   */
  function getActiveCustomView(): Component | undefined {
    return customViews[activeViewId];
  }

  /**
   * Get label for a view tab
   */
  function getViewLabel(view: AdminViewConfig): string {
    return view.title || view.id;
  }

  // ── The generic experience: a view over a table, on the list template ────────────

  /** The explorer config of the active view, or the fallback one for a kon with no views. */
  let fallbackConfig = $state<AdminConfig | null>(null);
  const explorerConfig = $derived<AdminConfig | undefined>(
    grimoireConfig && grimoireConfig.views.length > 0
      ? getActiveExplorerConfig()
      : (fallbackConfig ?? undefined)
  );
  const explorerView = $derived(
    (explorerConfig?.views.find((v) => v.id === activeViewId) ?? explorerConfig?.views[0]) as
      GridView | KanbanView | CalendarViewConfig | undefined
  );
  const isCustomActive = $derived(isActiveViewCustom());
  const isGrid = $derived(
    !!explorerView && explorerView.type === "grid" && !activeElementView && !isCustomActive
  );

  let source = $state<RecordSource | null>(null);
  let sourceError = $state<string | null>(null);
  let total = $state<number | null>(null);
  let quickAdd = $state(false);
  let reloadKey = $state(0);

  // A kon with tables but no declared views: one grid per table, from the explorer.
  $effect(() => {
    const kon = grimoireId;
    fallbackConfig = null;
    if (loading || LegacyView || !grimoireConfig) return;
    if (grimoireConfig.views.length > 0 || grimoireConfig.tables.length === 0) return;
    generateDefaultConfig(kon)
      .then((config) => (fallbackConfig = config))
      .catch(() => (fallbackConfig = null));
  });

  $effect(() => {
    const view = explorerView;
    const config = explorerConfig;
    const kon = grimoireId;
    source = null;
    sourceError = null;
    total = null;
    if (!isGrid || !view || !config || !("table" in view)) return;
    const table = view.table;
    const tableLabel =
      grimoireConfig?.tables.find((tb) => tb.name === table)?.label ?? view.title ?? table;
    const endpoint = config.apiEndpoint;
    let cancelled = false;
    explorerSource({
      konId: kon,
      viewId: view.id,
      table,
      label: view.title || tableLabel,
      singular: tableLabel.replace(/s$/, "") || tr("dataExplorer.record"),
      apiEndpoint: endpoint,
      fixedFilter: (view as GridView & { defaultFilter?: Record<string, unknown> }).defaultFilter,
      ...konViewActions(view as GridView, endpoint, table),
    })
      .then((s) => {
        if (!cancelled) source = s;
      })
      .catch((e) => {
        if (!cancelled) sourceError = (e as Error)?.message ?? String(e);
      });
    return () => {
      cancelled = true;
    };
  });

  const viewTabs = $derived<TabItem[]>(
    (grimoireConfig?.views ?? []).map((view) => ({
      id: view.id,
      label: getViewLabel(view),
      controls: "kon-view-panel",
      tabId: `kon-view-tab-${view.id}`,
    }))
  );
  const konName = $derived(
    grimoireConfig?.name ??
      moduleStore.modules.find((m) => m.key === grimoireId)?.name ??
      grimoireId.replace(/^kon-/, "")
  );
  const viewBase = $derived(`/g/${grimoireId}/${activeViewId || explorerView?.id || "default"}`);
  const manyViews = $derived((grimoireConfig?.views.length ?? 0) > 1);
  const activeViewLabel = $derived.by(() => {
    const view = grimoireConfig?.views.find((v) => v.id === activeViewId);
    return view ? getViewLabel(view) : (explorerView?.title ?? "");
  });

  function selectView(viewId: string) {
    // Each view has its own address; the list state of one view does not follow to another.
    void goto(`/g/${grimoireId}/${viewId}`);
  }
</script>

<!--
  Every state of a kon's page sits under the same PageHeader (`<Page>`): a disabled kon, a
  load failure, a kon that stores nothing, a custom view (a Svelte view bundled here or a
  Web Component the kon ships), and the generic experience (list template + record pages).
  A full-page view bundled in the panel (Media, Blog…) draws its own `<Page>`.
-->
{#if !loading && !activatedKon}
  <!--
    A disabled kon is stated, not hidden: its explorer used to render anyway, with an
    "Add" button that complained about a missing table when what was missing was the kon.
  -->
  <Page title={konName}>
    <EmptyState
      title={tr("grimoirePage.thisKonIsNotActivated")}
      actionLabel={tr("grimoirePage.irAKons")}
      actionHref="/kons"
    />
  </Page>
{:else if loading}
  <Page title={konName}>
    <div role="status" aria-busy="true">
      <span class="sr-only">{tr("grimoirePage.loading", { grimoireId })}</span>
      <Skeleton lines={6} />
    </div>
  </Page>
{:else if error && !grimoireConfig && !LegacyView}
  <Page title={konName}>
    <EmptyState variant="error" title={tr("grimoirePage.failedToLoad")} description={error} />
  </Page>
{:else if LegacyView}
  <!-- A full-page view bundled in the panel: it draws its own header. -->
  <LegacyView />
{:else if recordId && source && isGrid}
  <RecordPage
    {source}
    id={recordId}
    listHref={viewBase}
    hrefFor={(id) => `${viewBase}/${id}`}
    crumbs={[{ label: activeViewLabel || source.label, href: viewBase }]}
  />
{:else if explorerView || (grimoireConfig && grimoireConfig.views.length > 0)}
  <!--
    The count and the add buttons belong to a list: a custom view (a form, reports) gets
    neither, and no empty meta / actions box that pushed its tabs down on a phone.
  -->
  <Page
    title={konName}
    crumbs={manyViews && activeViewLabel ? [{ label: activeViewLabel }] : []}
    meta={isGrid && total !== null ? listMeta : undefined}
    actions={isGrid && source && source.formFields.length > 0 ? listActions : undefined}
  >
    {#snippet tabs()}
      {#if manyViews}
        <Tabs
          items={viewTabs}
          bind:value={() => activeViewId, selectView}
          panels={false}
          ariaLabel={konName}
        />
      {/if}
    {/snippet}

    <div
      id="kon-view-panel"
      role={manyViews ? "tabpanel" : undefined}
      aria-labelledby={manyViews ? `kon-view-tab-${activeViewId}` : undefined}
    >
      {#if activeElementView}
        <!-- A Web Component the kon ships: mounted under the same header. -->
        <CustomViewHost descriptor={activeElementView} viewId={activeViewId} />
      {:else if isCustomActive}
        {@const CustomComponent = getActiveCustomView()}
        {#if CustomComponent}
          <!--
            `viewId` is passed because one component can serve several views of a kon
            (Games: "All Games" and "Collections"); without it it cannot know which.
          -->
          <CustomComponent viewId={activeViewId} />
        {:else}
          <EmptyState title={tr("grimoirePage.customViewIsNotYet", { activeViewId })} />
        {/if}
      {:else if explorerView?.type === "kanban"}
        <KanbanBoard view={explorerView} apiEndpoint={explorerConfig?.apiEndpoint} />
      {:else if explorerView?.type === "calendar"}
        <CalendarView view={explorerView} apiEndpoint={explorerConfig?.apiEndpoint} />
      {:else if sourceError}
        <EmptyState variant="error" description={sourceError} />
      {:else if source}
        {#key source.id}
          <ListView
            {source}
            bind:total
            {reloadKey}
            hrefFor={(row) => `${viewBase}/${source!.rowId(row)}`}
            newHref={source.formFields.length > 0 ? `${viewBase}/new` : undefined}
          />
        {/key}
        <QuickAddDialog bind:open={quickAdd} {source} onCreated={() => (reloadKey += 1)} />
      {:else if explorerView}
        <Skeleton lines={6} />
      {:else}
        <EmptyState title={tr("grimoirePage.noExplorerConfigurationForView", { activeViewId })} />
      {/if}
    </div>
  </Page>
{:else if grimoireConfig && grimoireConfig.tables.length === 0}
  <!--
    The kon exists and is loaded, but exposes no data: neither tables nor a view. Some only
    contribute behaviour to other kons. It used to fall back to the explorer, which asked
    for a table named after the kon and answered "Collection not found".
  -->
  <Page title={konName}>
    <EmptyState title={tr("grimoirePage.thisKonStoresNoData")} />
  </Page>
{:else if grimoireConfig}
  <Page title={konName}><Skeleton lines={6} /></Page>
{:else}
  <Page title={konName}>
    <EmptyState
      title={tr("grimoirePage.noConfiguration")}
      description={tr("grimoirePage.thisGrimoireHasNoAdmin")}
    />
  </Page>
{/if}

{#snippet listMeta()}
  {total === 1
    ? tr("list.countOne")
    : tr("list.count", { n: (total ?? 0).toLocaleString(localeFormat()) })}
{/snippet}

{#snippet listActions()}
  {#if source}
    <Button variant="secondary" onclick={() => (quickAdd = true)}>
      {tr("list.quickAdd")}
    </Button>
    <Button href={`${viewBase}/new`}>{tr("list.newOne", { name: source.singular })}</Button>
  {/if}
{/snippet}
