<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * RelationshipField.svelte — Combobox / MultiSelect for relation fields
   * Fetches related records from API, supports 1:1, 1:N, M:N
   */
  import { Search, ChevronDown, Check, X } from "lucide-svelte";
  import { onMount, onDestroy } from "svelte";

  import type { RelationType, RelationTarget } from "../../../types/datasets";

  // ─── Types ──────────────────────────────────────────
  interface RelatedItem {
    id: string;
    label: string;
    subtitle?: string;
    image?: string;
  }

  // ─── Props ──────────────────────────────────────────
  interface Props {
    value: string | string[] | null;
    target: RelationTarget;
    targetDatasetId?: string;
    relationType: RelationType;
    displayField?: string;
    label?: string;
    placeholder?: string;
    helpText?: string;
    required?: boolean;
    error?: string;
    onChange?: (value: string | string[] | null) => void;
  }

  const {
    value,
    target,
    targetDatasetId,
    relationType,
    displayField = "title",
    label = "",
    placeholder = t("relationshipField.select"),
    helpText = "",
    required = false,
    error = "",
    onChange,
  }: Props = $props();

  // ─── State ──────────────────────────────────────────
  let open = $state(false);
  let searchQuery = $state("");
  let fetching = $state(false);
  let items = $state<RelatedItem[]>([]);
  // `bind:this` references as $state: in runes mode, a plain `let` does not
  // notify the change and any reactive read is left with the
  // initial value (undefined).
  let wrapperRef = $state<HTMLElement | null>(null);
  let searchInputRef = $state<HTMLInputElement | null>(null);
  let multiInputRef = $state<HTMLInputElement | null>(null);

  // ─── Computed ───────────────────────────────────────
  const selectedIds = $derived.by<string[]>(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  });

  const selectedItem = $derived.by<RelatedItem | null>(() => {
    if (!value || Array.isArray(value)) return null;
    return items.find((i) => i.id === value) || null;
  });

  const filteredItems = $derived.by(() => {
    if (!searchQuery) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.subtitle?.toLowerCase().includes(q)
    );
  });

  // ─── API Fetch ──────────────────────────────────────
  const API_URL = import.meta.env.VITE_API_URL ?? "";

  const endpointMap: Record<string, string> = {
    games: "/api/games",
    "blog-posts": "/api/blog",
    platforms: "/api/platforms",
    tags: "/api/tags",
    streamers: "/api/streamers",
  };

  async function fetchItems() {
    fetching = true;
    try {
      let url: string;
      if (target === "dataset" && targetDatasetId) {
        url = `${API_URL}/api/data-sets/${targetDatasetId}/entries?limit=200`;
      } else {
        url = `${API_URL}${endpointMap[target] || "/api/" + target}?limit=200`;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error("fetch failed");
      const json = await res.json();
      const docs = json.docs || json.data || (Array.isArray(json) ? json : []);

      items = docs.map((doc: any) => {
        const displayKey = displayField || "title";
        const labelValue =
          doc[displayKey] ||
          doc.title ||
          doc.name ||
          doc.displayName ||
          (doc.data && (doc.data[displayKey] || doc.data.title || doc.data.name)) ||
          doc.id;

        return {
          id: doc.id,
          label: String(labelValue),
          subtitle: doc.developer || doc.slug || undefined,
          image: doc.coverArt?.url || doc.avatarUrl || doc.image?.url || undefined,
        };
      });
    } catch {
      items = [];
    } finally {
      fetching = false;
    }
  }

  // ─── Actions ────────────────────────────────────────
  function toggleOpen() {
    open = !open;
    if (open) {
      setTimeout(() => searchInputRef?.focus(), 0);
    }
  }

  function openMulti() {
    open = true;
    setTimeout(() => multiInputRef?.focus(), 0);
  }

  function selectSingle(item: RelatedItem | null) {
    onChange?.(item?.id || null);
    open = false;
    searchQuery = "";
  }

  function toggleMulti(item: RelatedItem) {
    const current = selectedIds;
    const idx = current.indexOf(item.id);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(item.id);
    onChange?.(current);
  }

  function removeId(id: string) {
    const current = selectedIds.filter((i) => i !== id);
    onChange?.(current.length > 0 ? current : relationType === "one-to-one" ? null : []);
  }

  function getDisplayLabel(item: RelatedItem): string {
    return item.label;
  }

  function getDisplayById(id: string): string {
    const item = items.find((i) => i.id === id);
    return item?.label || id.slice(0, 8) + "...";
  }

  // ─── Click outside ──────────────────────────────────
  function onClickOutside(e: MouseEvent) {
    if (wrapperRef && !wrapperRef.contains(e.target as Node)) {
      open = false;
    }
  }

  onMount(() => {
    fetchItems();
    document.addEventListener("mousedown", onClickOutside);
  });

  onDestroy(() => {
    document.removeEventListener("mousedown", onClickOutside);
  });

  // Re-fetch when target changes
  $effect(() => {
    target;
    targetDatasetId;
    fetchItems();
  });
</script>

<div class="space-y-1.5">
  {#if label}
    <label class="label block">
      {label}
      {#if required}<span class="text-kitsuden-accent-2">*</span>{/if}
    </label>
  {/if}

  <!-- ═══ Single select (1:1) ═══ -->
  {#if relationType === "one-to-one"}
    <div class="relative" bind:this={wrapperRef}>
      <button
        type="button"
        onclick={toggleOpen}
        class="input flex items-center justify-between gap-2 text-left {!selectedItem
          ? 'text-kitsuden-subtle'
          : ''}"
      >
        <span class="truncate">{selectedItem ? getDisplayLabel(selectedItem!) : placeholder}</span>
        <ChevronDown
          class="w-4 h-4 text-kitsuden-subtle transition-transform shrink-0 {open
            ? 'rotate-180'
            : ''}"
        />
      </button>

      {#if open}
        <div
          class="absolute z-50 top-full mt-1 w-full card shadow-xl shadow-black/30 max-h-64 overflow-hidden"
        >
          <div class="p-2 border-b border-kitsuden-border">
            <div class="relative">
              <Search
                class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-kitsuden-subtle"
              />
              <input
                bind:this={searchInputRef}
                bind:value={searchQuery}
                type="text"
                placeholder={t("common.search")}
                class="input pl-8 py-1.5 text-xs bg-kitsuden-bg"
              />
            </div>
          </div>
          <div class="overflow-y-auto max-h-48">
            {#if fetching}
              <div class="flex justify-center py-4">
                <div
                  class="w-4 h-4 border-2 border-kitsuden-accent-30 border-t-kitsuden-accent rounded-full animate-spin"
                ></div>
              </div>
            {:else if filteredItems.length === 0}
              <div class="py-4 text-center text-xs text-kitsuden-subtle">
                {t("relationshipField.noResultsFound")}
              </div>
            {:else}
              {#if value}
                <button
                  type="button"
                  onclick={() => selectSingle(null)}
                  class="flex items-center gap-3 w-full px-3 py-2 text-left text-xs text-kitsuden-subtle hover:bg-kitsuden-border/30 transition-colors border-b border-kitsuden-border/30"
                >
                  <X class="w-3 h-3" />
                  {t("relationshipField.clearSelection")}
                </button>
              {/if}
              {#each filteredItems as item}
                <button
                  type="button"
                  onclick={() => selectSingle(item)}
                  class="flex items-center gap-3 w-full px-3 py-2 text-left text-sm hover:bg-kitsuden-border/30 transition-colors {value ===
                  item.id
                    ? 'bg-kitsuden-accent/[0.06] text-kitsuden-accent'
                    : ''}"
                >
                  {#if item.image}
                    <img
                      src={item.image}
                      alt={item.label}
                      class="w-6 h-6 rounded object-cover shrink-0"
                    />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="truncate">{getDisplayLabel(item)}</p>
                    {#if item.subtitle}
                      <p class="text-[10px] text-kitsuden-subtle truncate">{item.subtitle}</p>
                    {/if}
                  </div>
                  {#if value === item.id}
                    <Check class="w-4 h-4 text-kitsuden-accent shrink-0" />
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ═══ Multi select (1:N, M:N) ═══ -->
  {#if relationType !== "one-to-one"}
    <div bind:this={wrapperRef}>
      <button
        type="button"
        class="input min-h-[2.5rem] flex flex-wrap items-center gap-1.5 cursor-text w-full text-left"
        onclick={openMulti}
      >
        {#each selectedIds as id}
          <span
            class="inline-flex items-center gap-1 rounded-md bg-kitsuden-accent-10 border border-kitsuden-accent-20 px-2 py-0.5 text-xs text-kitsuden-accent"
          >
            {getDisplayById(id)}
            <span
              onclick={(e) => {
                e.stopPropagation();
                removeId(id);
              }}
              class="hover:text-kitsuden-accent-2 transition-colors cursor-pointer"
            >
              <X class="w-3 h-3" />
            </span>
          </span>
        {/each}
        <input
          bind:this={multiInputRef}
          bind:value={searchQuery}
          type="text"
          placeholder={selectedIds.length === 0 ? placeholder : ""}
          class="flex-1 min-w-[60px] bg-transparent text-sm outline-none placeholder:text-kitsuden-subtle"
          onfocus={() => (open = true)}
        />
      </button>

      {#if open}
        <div class="relative">
          <div
            class="absolute z-50 top-1 w-full card shadow-xl shadow-black/30 max-h-56 overflow-y-auto"
          >
            {#if fetching}
              <div class="flex justify-center py-4">
                <div
                  class="w-4 h-4 border-2 border-kitsuden-accent-30 border-t-kitsuden-accent rounded-full animate-spin"
                ></div>
              </div>
            {:else if filteredItems.length === 0}
              <div class="py-4 text-center text-xs text-kitsuden-subtle">
                {t("relationshipField.noResultsFound")}
              </div>
            {:else}
              {#each filteredItems as item}
                <button
                  type="button"
                  onclick={() => toggleMulti(item)}
                  class="flex items-center gap-3 w-full px-3 py-2 text-left text-sm hover:bg-kitsuden-border/30 transition-colors {selectedIds.includes(
                    item.id
                  )
                    ? 'bg-kitsuden-accent/[0.06]'
                    : ''}"
                >
                  <div
                    class="w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 {selectedIds.includes(
                      item.id
                    )
                      ? 'bg-kitsuden-accent border-kitsuden-accent'
                      : 'border-kitsuden-border'}"
                  >
                    {#if selectedIds.includes(item.id)}
                      <Check class="w-3 h-3 text-kitsuden-bg" />
                    {/if}
                  </div>
                  {#if item.image}
                    <img
                      src={item.image}
                      alt={item.label}
                      class="w-6 h-6 rounded object-cover shrink-0"
                    />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="truncate">{getDisplayLabel(item)}</p>
                    {#if item.subtitle}
                      <p class="text-[10px] text-kitsuden-subtle truncate">{item.subtitle}</p>
                    {/if}
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if helpText}
    <p class="text-[10px] text-kitsuden-subtle">{helpText}</p>
  {/if}
  {#if error}
    <p class="text-[10px] text-kitsuden-accent-2">{error}</p>
  {/if}
</div>

<style>
  .border-kitsuden-accent-30 {
    border-color: rgb(168 85 247 / 0.3);
  }
  .bg-kitsuden-accent-10 {
    background-color: rgb(168 85 247 / 0.1);
  }
  .border-kitsuden-accent-20 {
    border-color: rgb(168 85 247 / 0.2);
  }
</style>
