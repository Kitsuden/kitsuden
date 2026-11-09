<script lang="ts">
  import { t as tr } from "$lib/i18n";
  import { Search, Clock, Database, LayoutDashboard, FileText, ArrowRight } from "lucide-svelte";
  import { onMount, tick } from "svelte";

  import { datasetStore } from "$lib/states/datasets.svelte";

  import { goto } from "$app/navigation";

  // ═══════════════════════════════════════════════════════════════════════════
  // Types
  // ═══════════════════════════════════════════════════════════════════════════

  type SearchResult = {
    id: string;
    title: string;
    subtitle?: string;
    path: string;
    icon: any;
    category: "navigation" | "datasets" | "entries" | "recent";
    score: number;
  };

  type NavItem = {
    path: string;
    label: string;
    icon: any;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Props
  // ═══════════════════════════════════════════════════════════════════════════

  interface Props {
    navItems: NavItem[];
    bottomNavItems: NavItem[];
    filesystemNavItems: NavItem[];
  }

  const { navItems, bottomNavItems, filesystemNavItems }: Props = $props();

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════

  let query = $state("");
  let isOpen = $state(false);
  let selectedIndex = $state(0);
  let searchInput: HTMLInputElement;
  let dropdownEl = $state<HTMLDivElement | null>(null);
  let entryResults = $state<SearchResult[]>([]);
  let isSearchingEntries = $state(false);
  let recentItems = $state<SearchResult[]>([]);
  let abortController: AbortController | null = null;

  const API_URL = import.meta.env.VITE_API_URL ?? "";
  const RECENT_STORAGE_KEY = "kitsuden-admin-recent-pages";
  const MAX_RECENT = 5;
  const MAX_DATASET_ENTRIES = 8;

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  onMount(() => {
    loadRecentPages();
    if (datasetStore.datasets.length === 0) {
      datasetStore.fetchDatasets();
    }

    // Note: Cmd/Ctrl+K is handled by CommandPalette component to avoid conflicts.
    // This search is accessible by clicking the input in the top bar.
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Recent Pages (localStorage)
  // ═══════════════════════════════════════════════════════════════════════════

  function loadRecentPages() {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Array<{ path: string; title: string; timestamp: number }>;
        recentItems = parsed.slice(0, MAX_RECENT).map((item, idx) => ({
          id: `recent-${idx}`,
          title: item.title,
          subtitle: item.path,
          path: item.path,
          icon: Clock,
          category: "recent" as const,
          score: 1000, // Always top when no query
        }));
      }
    } catch {
      recentItems = [];
    }
  }

  function saveRecentPage(path: string, title: string) {
    try {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      let pages: Array<{ path: string; title: string; timestamp: number }> = raw
        ? JSON.parse(raw)
        : [];
      pages = pages.filter((p) => p.path !== path);
      pages.unshift({ path, title, timestamp: Date.now() });
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(pages.slice(0, MAX_RECENT)));
    } catch {
      // ignore
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fuzzy Matching
  // ═══════════════════════════════════════════════════════════════════════════

  function fuzzyScore(pattern: string, text: string): number {
    const p = pattern.toLowerCase().trim();
    const t = text.toLowerCase().trim();
    if (!p) return 0;
    if (t === p) return 1000;
    if (t.startsWith(p)) return 800;
    if (t.includes(" " + p)) return 700;
    if (t.includes(p)) return 500;

    // Character-by-character ordered matching
    let score = 0;
    let pIdx = 0;
    let tIdx = 0;
    let consecutive = 0;
    let maxConsecutive = 0;

    while (pIdx < p.length && tIdx < t.length) {
      if (p[pIdx] === t[tIdx]) {
        score += 10;
        // Word boundary bonus
        if (tIdx === 0 || t[tIdx - 1] === " " || t[tIdx - 1] === "-" || t[tIdx - 1] === "_") {
          score += 15;
        }
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
        pIdx++;
      } else {
        consecutive = 0;
      }
      tIdx++;
    }

    if (pIdx < p.length) return 0; // Not all characters matched

    score += maxConsecutive * 20;
    // Penalty for length difference
    score -= (t.length - p.length) * 2;
    return Math.max(1, score);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Derived Results
  // ═══════════════════════════════════════════════════════════════════════════

  const allNavigationItems = $derived([
    ...navItems.map((n) => ({ ...n, category: "navigation" as const })),
    ...bottomNavItems.map((n) => ({ ...n, category: "navigation" as const })),
    ...filesystemNavItems.map((n) => ({
      ...n,
      category: "navigation" as const,
      icon: n.icon || LayoutDashboard,
    })),
  ]);

  const filteredNavigation = $derived(
    allNavigationItems
      .map((item) => ({
        id: `nav-${item.path}`,
        title: item.label,
        subtitle: undefined as string | undefined,
        path: item.path,
        icon: item.icon,
        category: "navigation" as const,
        score: fuzzyScore(query, item.label),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  );

  const filteredDatasets = $derived(
    datasetStore.datasets
      .map((ds) => ({
        id: `ds-${ds.id}`,
        title: ds.name,
        subtitle: ds.slug,
        path: `/datasets/${ds.id}/entries`,
        icon: Database,
        category: "datasets" as const,
        score: fuzzyScore(query, ds.name) + fuzzyScore(query, ds.slug) * 0.5,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  );

  // Debounced dataset entry search
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const q = query.trim();
    if (q.length < 2) {
      entryResults = [];
      isSearchingEntries = false;
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      return;
    }

    isSearchingEntries = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchDatasetEntries(q), 250);
  });

  async function searchDatasetEntries(searchQuery: string) {
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    const datasetsToSearch = datasetStore.datasets.slice(0, MAX_DATASET_ENTRIES);
    if (datasetsToSearch.length === 0) {
      entryResults = [];
      isSearchingEntries = false;
      return;
    }

    const results: SearchResult[] = [];

    await Promise.all(
      datasetsToSearch.map(async (ds) => {
        try {
          const res = await fetch(
            `${API_URL}/api/data-sets/${ds.id}/entries?search=${encodeURIComponent(searchQuery)}&limit=5`,
            { credentials: "include", signal }
          );
          if (!res.ok) return;
          const data = await res.json();
          const entries = data.data || data.docs || (Array.isArray(data) ? data : []);
          for (const entry of entries) {
            const title = extractEntryTitle(entry);
            if (!title) continue;
            const score = fuzzyScore(searchQuery, title);
            if (score > 0) {
              results.push({
                id: `entry-${ds.id}-${entry.id}`,
                title,
                subtitle: tr("globalSearch.dataset", { name: ds.name }),
                path: `/datasets/${ds.id}/entries`,
                icon: FileText,
                category: "entries" as const,
                score,
              });
            }
          }
        } catch {
          // ignore aborted or failed requests
        }
      })
    );

    if (!signal.aborted) {
      entryResults = results.sort((a, b) => b.score - a.score).slice(0, 8);
      isSearchingEntries = false;
    }
  }

  function extractEntryTitle(entry: Record<string, any>): string | null {
    const titleFields = ["title", "name", "label", "displayName", "display_name", "slug", "id"];
    for (const field of titleFields) {
      if (entry[field] && typeof entry[field] === "string") {
        return entry[field];
      }
    }
    return null;
  }

  const groupedResults = $derived.by(() => {
    const q = query.trim();
    if (!q) {
      // Show recent pages when no query
      return {
        recent: recentItems,
        navigation: [],
        datasets: [],
        entries: [],
      };
    }
    return {
      navigation: filteredNavigation,
      datasets: filteredDatasets,
      entries: entryResults,
      recent: [],
    };
  });

  const flatResults = $derived([
    ...groupedResults.navigation,
    ...groupedResults.datasets,
    ...groupedResults.entries,
    ...groupedResults.recent,
  ]);

  // Reset selection when results change
  $effect(() => {
    flatResults;
    selectedIndex = 0;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  function handleSelect(result: SearchResult) {
    isOpen = false;
    query = "";
    saveRecentPage(result.path, result.title);
    goto(result.path);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!isOpen) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(flatResults.length, 1);
      scrollSelectedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + Math.max(flatResults.length, 1)) % Math.max(flatResults.length, 1);
      scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatResults[selectedIndex]) {
        handleSelect(flatResults[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      isOpen = false;
      searchInput?.blur();
    }
  }

  function scrollSelectedIntoView() {
    tick().then(() => {
      const el = dropdownEl?.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleInputFocus() {
    isOpen = true;
  }

  function handleBlur(e: FocusEvent) {
    // Delay to allow clicks on dropdown items
    setTimeout(() => {
      if (!dropdownEl?.contains(document.activeElement)) {
        isOpen = false;
      }
    }, 150);
  }

  function getCategoryLabel(category: string) {
    switch (category) {
      case "navigation":
        return "Navigation";
      case "datasets":
        return "Datasets";
      case "entries":
        return "Entries";
      case "recent":
        return "Recent";
      default:
        return category;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative w-full max-w-md" onkeydown={handleKeyDown}>
  <div class="relative">
    <Search
      class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-text-dim pointer-events-none"
    />
    <input
      bind:this={searchInput}
      type="text"
      placeholder={tr("common.search")}
      class="w-full h-9 pl-10 pr-4 text-sm rounded-lg border border-kitsuden-border bg-kitsuden-card text-kitsuden-text placeholder:text-kitsuden-text-dim/60 focus:outline-hidden focus:ring-2 focus:ring-kitsuden-accent/30 focus:border-kitsuden-accent/50 transition-all"
      bind:value={query}
      onfocus={handleInputFocus}
      onblur={handleBlur}
    />
    {#if isSearchingEntries}
      <div class="absolute right-3 top-1/2 -translate-y-1/2">
        <div
          class="w-3.5 h-3.5 rounded-full border-2 border-kitsuden-accent/30 border-t-kitsuden-accent animate-spin"
        ></div>
      </div>
    {/if}
  </div>

  {#if isOpen}
    <div
      bind:this={dropdownEl}
      class="absolute left-0 right-0 top-full mt-2 bg-kitsuden-card border border-kitsuden-border rounded-lg shadow-2xl shadow-black/40 overflow-hidden z-50 max-h-[70vh] overflow-y-auto"
    >
      {#if flatResults.length === 0}
        <div class="px-4 py-8 text-center text-sm text-kitsuden-text-dim">
          {#if query.trim()}
            {tr("globalSearch.noResultsFoundFor", { query })}
          {:else}
            {tr("globalSearch.startTypingToSearchAcross")}
          {/if}
        </div>
      {:else}
        {@const categories = [
          { key: "recent", items: groupedResults.recent },
          { key: "navigation", items: groupedResults.navigation },
          { key: "datasets", items: groupedResults.datasets },
          { key: "entries", items: groupedResults.entries },
        ]}
        {@const renderedIndices = { value: 0 }}

        {#each categories as cat}
          {#if cat.items.length > 0}
            <div
              class="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-kitsuden-subtle bg-kitsuden-bg/50 border-b border-kitsuden-border/50"
            >
              {getCategoryLabel(cat.key)}
            </div>
            <div class="divide-y divide-kitsuden-border/30">
              {#each cat.items as item}
                {@const idx = renderedIndices.value++}
                <button
                  type="button"
                  data-index={idx}
                  class="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors {selectedIndex ===
                  idx
                    ? 'bg-kitsuden-accent/10'
                    : 'hover:bg-kitsuden-bg/50'}"
                  onmouseenter={() => (selectedIndex = idx)}
                  onclick={() => handleSelect(item)}
                >
                  <div
                    class="w-7 h-7 rounded-md bg-kitsuden-bg border border-kitsuden-border flex items-center justify-center shrink-0"
                  >
                    <item.icon class="w-3.5 h-3.5 text-kitsuden-text-dim" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-kitsuden-text truncate">
                      {item.title}
                    </p>
                    {#if item.subtitle}
                      <p class="text-xs text-kitsuden-subtle truncate">{item.subtitle}</p>
                    {/if}
                  </div>
                  <ArrowRight
                    class="w-3.5 h-3.5 text-kitsuden-subtle opacity-0 {selectedIndex === idx
                      ? 'opacity-100'
                      : ''} transition-opacity shrink-0"
                  />
                </button>
              {/each}
            </div>
          {/if}
        {/each}

        <div
          class="px-3 py-1.5 text-[10px] text-kitsuden-subtle bg-kitsuden-bg/30 border-t border-kitsuden-border/50 flex items-center justify-between"
        >
          <span
            >{flatResults.length}
            {tr("globalSearch.result")}{flatResults.length === 1 ? "" : "s"}</span
          >
          <span class="hidden sm:inline">{tr("globalSearch.toNavigateEnterToSelect")}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Click outside to close -->
{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40" onclick={() => (isOpen = false)}></div>
{/if}
