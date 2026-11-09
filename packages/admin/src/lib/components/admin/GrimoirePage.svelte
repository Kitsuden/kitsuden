<script lang="ts">
  import { t as tr } from "$lib/i18n";
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
  import type { Component } from "svelte";

  import DataExplorer from "$lib/components/admin/DataExplorer.svelte";
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
  import type { AdminConfig } from "$lib/types/admin";

  const { grimoireId, initialViewId }: { grimoireId: string; initialViewId?: string } = $props();

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
    activeViewId = initialViewId || "";

    void loadKon(kon);
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
</script>

<!--
  A disabled kon is stated, not hidden.

  Before, its explorer was rendered anyway: header, «0 records» and an «Add»
  button that opened a form complaining about a table that does not exist —
  because the kon is not installed and its migrations have not run. The user
  read «table builder_definitions is missing» when what was missing was enabling
  the kon.
-->
{#if !loading && !activatedKon}
  <div class="card p-12 text-center">
    <h2 class="mb-2 text-lg font-semibold">{grimoireConfig?.name ?? grimoireId}</h2>
    <p class="mx-auto mb-6 max-w-md text-sm text-kitsuden-subtle">
      {tr("grimoirePage.thisKonIsNotActivated")}
    </p>
    <a href="/kons" class="btn-primary inline-flex items-center gap-2"
      >{tr("grimoirePage.irAKons")}</a
    >
  </div>
{:else if loading}
  <div class="flex items-center justify-center h-96">
    <div class="flex flex-col items-center gap-4">
      <div
        class="w-8 h-8 border-2 border-kitsuden-accent/30 border-t-kitsuden-accent rounded-full animate-spin"
      ></div>
      <p class="text-kitsuden-subtle text-sm">{tr("grimoirePage.loading", { grimoireId })}</p>
    </div>
  </div>
{:else if error && !grimoireConfig && !LegacyView}
  <div class="flex items-center justify-center h-96">
    <div class="text-center">
      <div class="text-4xl mb-4">⚠️</div>
      <h3 class="text-lg font-semibold text-kitsuden-text mb-2">
        {tr("grimoirePage.failedToLoad")}
      </h3>
      <p class="text-sm text-kitsuden-subtle">{error}</p>
    </div>
  </div>
{:else if LegacyView}
  <!-- LEGACY MODE: Full custom monolith view -->
  <LegacyView />
{:else if grimoireConfig && grimoireConfig.views.length > 0}
  <!-- HYBRID MODE: Tabs with DataExplorer + Custom views -->
  <div class="space-y-4">
    <!-- View Tabs -->
    {#if grimoireConfig.views.length > 1}
      <div class="border-b border-kitsuden-border">
        <div class="flex gap-1">
          {#each grimoireConfig.views as view}
            {@const isActive = activeViewId === view.id}
            {@const isCustomReady = view.type === "custom" ? view.id in customViews : true}
            <button
              onclick={() => (activeViewId = view.id)}
              class="group px-4 py-2.5 text-sm font-medium border-b-2 transition-all duration-200 inline-flex items-center gap-2"
              class:border-kitsuden-accent={isActive}
              class:text-kitsuden-accent={isActive}
              class:border-transparent={!isActive}
              class:text-kitsuden-text-dim={!isActive}
              class:hover:text-kitsuden-text={!isActive}
              disabled={view.type === "custom" && !isCustomReady}
              title={view.type === "custom" && !isCustomReady
                ? tr("grimoirePage.customViewNotYetImplemented")
                : undefined}
            >
              {#if view.type === "custom"}
                <span class="w-2 h-2 rounded-full bg-kitsuden-accent-2"></span>
              {:else if view.type === "kanban"}
                <span class="w-2 h-2 rounded-full bg-kitsuden-purple"></span>
              {:else if view.type === "calendar"}
                <span class="w-2 h-2 rounded-full bg-kitsuden-amber"></span>
              {:else}
                <span class="w-2 h-2 rounded-full bg-kitsuden-accent"></span>
              {/if}
              {getViewLabel(view)}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- View Content -->
    <div class="animate-fade-in">
      {#if activeElementView}
        <CustomViewHost descriptor={activeElementView} viewId={activeViewId} />
      {:else if isActiveViewCustom()}
        {@const CustomComponent = getActiveCustomView()}
        {#if CustomComponent}
          <!--
            ── WHY `viewId` IS PASSED ───────────────────────────────────────

            The same component can be registered for SEVERAL views of the
            kon. Games does it: «All Games» and «Collections» both point to
            `GamesView.svelte`, which has its own tabs inside and always opened
            on the games one.

            Result: you pressed «Collections» and the games list came up. Nothing
            failed — it showed what it should not, which is the same problem as
            «Scheduled» with the drafts inside.

            Without the prop, the component has no way of knowing which one was pressed.
            Views that do not declare it simply ignore it.
          -->
          <CustomComponent viewId={activeViewId} />
        {:else}
          <div class="card p-12 text-center">
            <p class="text-kitsuden-subtle">
              {tr("grimoirePage.customViewIsNotYet", { activeViewId })}
            </p>
          </div>
        {/if}
      {:else}
        {@const explorerConfig = getActiveExplorerConfig()}
        {#if explorerConfig}
          <DataExplorer
            {grimoireId}
            config={explorerConfig}
            viewId={activeViewId || "default"}
            allTables={grimoireConfig.tables.map((t) => ({ name: t.name, label: t.label }))}
          />
        {:else}
          <div class="card p-12 text-center">
            <p class="text-kitsuden-subtle">
              {tr("grimoirePage.noExplorerConfigurationForView", { activeViewId })}
            </p>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{:else if grimoireConfig && grimoireConfig.tables.length === 0}
  <!--
    The kon exists and is loaded, but exposes no data: neither its own tables nor
    a custom view: some only contribute behavior to other kons and
    store nothing of their own.

    Before, it fell back to the automatic explorer, which requested a table named after the
    kon and answered «Collection not found» with 0 columns — an error that
    suggested something was broken when there was nothing to fix.
  -->
  <div class="card p-12 text-center">
    <h2 class="mb-2 text-lg font-semibold">{grimoireConfig.name}</h2>
    <p class="mx-auto max-w-md text-sm text-kitsuden-subtle">
      {tr("grimoirePage.thisKonStoresNoData")}
    </p>
  </div>
{:else}
  <!-- FALLBACK: Auto-generated DataExplorer -->
  {#await generateDefaultConfig(grimoireId) then fallbackConfig}
    <DataExplorer
      {grimoireId}
      config={fallbackConfig}
      viewId="default"
      allTables={grimoireConfig?.tables.map((t) => ({ name: t.name, label: t.label }))}
    />
  {:catch}
    <div class="flex items-center justify-center h-96">
      <div class="text-center">
        <div class="text-4xl mb-4">📭</div>
        <h3 class="text-lg font-semibold text-kitsuden-text mb-2">
          {tr("grimoirePage.noConfiguration")}
        </h3>
        <p class="text-sm text-kitsuden-subtle">{tr("grimoirePage.thisGrimoireHasNoAdmin")}</p>
      </div>
    </div>
  {/await}
{/if}

<style>
  .animate-fade-in {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
