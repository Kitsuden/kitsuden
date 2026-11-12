<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * RelationshipField.svelte — Combobox / MultiSelect for relation fields
   * Fetches related records from API, supports 1:1, 1:N, M:N
   */
  import { X } from "lucide-svelte";
  import { onMount } from "svelte";

  import { Button, Combobox, type ComboboxOption } from "$lib/tallao";

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
  let fetching = $state(false);
  let items = $state<RelatedItem[]>([]);

  // ─── Computed ───────────────────────────────────────
  const selectedIds = $derived.by<string[]>(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  });

  const single = $derived(value && !Array.isArray(value) ? value : null);

  // The list filters by label and by the subtitle (developer, slug) shown beside it.
  const options = $derived<ComboboxOption[]>(
    items.map((i) => ({
      value: i.id,
      label: i.subtitle ? `${i.label} · ${i.subtitle}` : i.label,
    }))
  );

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

  onMount(() => {
    fetchItems();
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
    <p class="text-sm font-medium text-kitsuden-text">
      {label}
      {#if required}<span class="text-kitsuden-danger" aria-hidden="true">*</span>{/if}
    </p>
  {/if}

  {#if relationType === "one-to-one"}
    <!-- ═══ Single select (1:1) ═══ -->
    <div class="flex items-center gap-2">
      <Combobox
        class="min-w-0 flex-1"
        {options}
        value={single}
        {placeholder}
        {required}
        ariaLabel={label || placeholder}
        emptyText={fetching ? t("common.loading") : t("relationshipField.noResultsFound")}
        onValueChange={(v) => onChange?.(v || null)}
      />
      {#if single}
        <Button
          variant="ghost"
          size="icon"
          ariaLabel={t("relationshipField.clearSelection")}
          title={t("relationshipField.clearSelection")}
          onclick={() => onChange?.(null)}
        >
          <X class="w-4 h-4" />
        </Button>
      {/if}
    </div>
  {:else}
    <!-- ═══ Multi select (1:N, M:N) ═══ -->
    <Combobox
      multiple
      {options}
      values={selectedIds}
      {placeholder}
      {required}
      ariaLabel={label || placeholder}
      emptyText={fetching ? t("common.loading") : t("relationshipField.noResultsFound")}
      onValuesChange={(v) => onChange?.(v)}
    />
  {/if}

  {#if helpText}
    <p class="text-xs text-kitsuden-subtle">{helpText}</p>
  {/if}
  {#if error}
    <p class="text-xs text-kitsuden-danger" role="alert">{error}</p>
  {/if}
</div>
