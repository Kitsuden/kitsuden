<script lang="ts">
  import { t as tr, localeFormat } from "$lib/i18n";
  /**
   * PromoteFromDataset.svelte — Production Ready
   *
   * Component to create a blog post based on data from a dataset.
   * Lets the writer select a dataset and a specific entry
   * to preload the post's content.
   *
   * @production Ready for production use
   * @version 1.0.0
   */
  import {
    Database,
    Search,
    ArrowRight,
    FileText,
    Tag,
    Image,
    X,
    Loader2,
    Check,
    AlertCircle,
    RefreshCw,
  } from "lucide-svelte";
  import { onDestroy } from "svelte";

  import { api } from "$lib/api";
  import { Dialog, Button } from "$lib/tallao";

  // ─── Types ──────────────────────────────────────────
  interface Dataset {
    id: string;
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    schema?: {
      fields?: Array<{
        name: string;
        type: string;
        label?: string;
      }>;
    };
    entryCount?: number;
    createdAt: string;
    updatedAt: string;
  }

  interface DatasetEntry {
    id: string;
    datasetId: string;
    data: Record<string, any>;
    status?: string;
    publishedAt?: string;
    createdAt: string;
    updatedAt: string;
  }

  interface PostData {
    title: string;
    content: string;
    excerpt: string;
    featuredImageId?: string;
    tags: string[];
    source: {
      type: "dataset";
      datasetId: string;
      entryId: string;
    };
  }

  // ─── Props ──────────────────────────────────────────
  interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (data: PostData) => void;
  }

  const { isOpen, onClose, onSelect }: Props = $props();

  // ─── State ──────────────────────────────────────────
  type Step = "datasets" | "entries" | "preview";
  let step = $state<Step>("datasets");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let searchQuery = $state("");
  let abortController = $state<AbortController | null>(null);

  // Data
  let datasets = $state<Dataset[]>([]);
  let selectedDataset = $state<Dataset | null>(null);
  let entries = $state<DatasetEntry[]>([]);
  let selectedEntry = $state<DatasetEntry | null>(null);
  let totalEntries = $state(0);

  // Pagination
  let currentPage = $state(1);
  const entriesPerPage = $state(20);

  // ─── Lifecycle ──────────────────────────────────────
  onDestroy(() => {
    abortController?.abort();
  });

  /**
   * Loading has already been attempted for this opening.
   *
   * A plain `let` and NOT `$state`: if it were reactive, reading it inside the effect
   * would trigger it again and the problem would stay the same.
   */
  let alreadyTriedLoading = false;

  /**
   * Loads the datasets on OPEN, just once.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THIS WAS AN INFINITE LOOP
   *
   * It used to be:
   *
   *     $effect(() => {
   *       if (isOpen && datasets.length === 0 && !loading) loadDatasets();
   *     });
   *
   * The effect READS `datasets` and `loading`, and `loadDatasets()` WRITES both.
   * As long as the list arrived with content, the condition stopped holding and
   * it stopped. But if it came **empty** —an installation with no datasets, or a network
   * error— the condition was still true at the end, the effect fired
   * again, and there was no way out: endless requests, the screen frozen and
   * the rest of the admin dead, because an effect loop in Svelte 5 takes
   * the whole application down with it.
   *
   * The empty case is precisely that of a new installation, which is when it
   * hurts most.
   * ───────────────────────────────────────────────────────────────────────────
   */
  $effect(() => {
    if (!isOpen) {
      // On close it is re-armed, so the next open looks again.
      alreadyTriedLoading = false;
      return;
    }
    if (alreadyTriedLoading) return;
    alreadyTriedLoading = true;
    void loadDatasets();
  });

  // ─── Data Loading ───────────────────────────────────
  async function loadDatasets() {
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    loading = true;
    error = null;

    try {
      const response = await api.getDatasets({
        limit: 100,
        search: searchQuery || undefined,
      });

      datasets = response.docs || [];
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Failed to load datasets:", err);
        error = err.message || tr("promoteFromDataset.failedToLoadDatasetsPlease");
      }
    } finally {
      loading = false;
    }
  }

  async function loadEntries(datasetId: string, page = 1) {
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    loading = true;
    error = null;
    currentPage = page;

    try {
      const response = await api.getDatasetEntries(datasetId, {
        limit: entriesPerPage,
        page,
        search: searchQuery || undefined,
      });

      entries = response.docs || [];
      totalEntries = response.totalDocs || 0;
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Failed to load entries:", err);
        error = err.message || tr("promoteFromDataset.failedToLoadEntriesPlease");
      }
    } finally {
      loading = false;
    }
  }

  // ─── Event Handlers ─────────────────────────────────
  function selectDataset(dataset: Dataset) {
    selectedDataset = dataset;
    step = "entries";
    searchQuery = "";
    currentPage = 1;
    loadEntries(dataset.id);
  }

  function selectEntry(entry: DatasetEntry) {
    selectedEntry = entry;
    step = "preview";
  }

  function handleConfirm() {
    if (!selectedEntry || !selectedDataset) {
      error = tr("promoteFromDataset.pleaseSelectADatasetEntry");
      return;
    }

    try {
      const postData = transformEntryToPost(selectedEntry, selectedDataset);
      onSelect(postData);
      handleClose();
    } catch (err: any) {
      console.error("Failed to transform entry:", err);
      error = err.message || tr("promoteFromDataset.failedToProcessEntryData");
    }
  }

  function handleClose() {
    abortController?.abort();
    step = "datasets";
    selectedDataset = null;
    selectedEntry = null;
    searchQuery = "";
    currentPage = 1;
    error = null;
    onClose();
  }

  function goBack() {
    error = null;
    if (step === "entries") {
      step = "datasets";
      selectedDataset = null;
      searchQuery = "";
    } else if (step === "preview") {
      step = "entries";
      selectedEntry = null;
    }
  }

  function handleSearch() {
    if (step === "datasets") {
      loadDatasets();
    } else if (step === "entries" && selectedDataset) {
      loadEntries(selectedDataset.id, 1);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      handleSearch();
    }
  }

  function goToPage(page: number) {
    if (selectedDataset && page >= 1 && page <= totalPages) {
      loadEntries(selectedDataset.id, page);
    }
  }

  // ─── Transform Logic ────────────────────────────────
  function transformEntryToPost(entry: DatasetEntry, dataset: Dataset): PostData {
    const data = entry.data;

    if (!data || typeof data !== "object") {
      throw new Error(tr("promoteFromDataset.invalidEntryData"));
    }

    // Extract common fields with fallbacks
    const title = extractTitle(data, dataset);
    const description = extractDescription(data);

    // Generate content based on dataset type/schema
    const content = generateContent(data, dataset, entry);

    // Generate excerpt
    const excerpt = generateExcerpt(description);

    // Extract tags from various possible fields
    const tags = extractTags(data);

    // Extract featured image
    const featuredImageId = extractImage(data);

    return {
      title,
      content,
      excerpt,
      featuredImageId,
      tags,
      source: {
        type: "dataset",
        datasetId: dataset.id,
        entryId: entry.id,
      },
    };
  }

  function extractTitle(data: Record<string, any>, dataset: Dataset): string {
    // Try common title fields
    const titleFields = ["title", "name", "headline", "subject", "heading"];

    for (const field of titleFields) {
      if (data[field] && typeof data[field] === "string") {
        return data[field].trim();
      }
    }

    // Try to find a field with "title" in the name
    for (const [key, value] of Object.entries(data)) {
      if (key.toLowerCase().includes("title") && typeof value === "string") {
        return value.trim();
      }
    }

    return tr("promoteFromDataset.postFrom", { name: dataset.name });
  }

  function extractDescription(data: Record<string, any>): string {
    const descFields = ["description", "summary", "overview", "excerpt", "content", "body", "text"];

    for (const field of descFields) {
      if (data[field]) {
        if (typeof data[field] === "string") {
          return data[field].trim();
        }
        if (typeof data[field] === "object" && data[field] !== null) {
          // Handle rich text objects
          return JSON.stringify(data[field]);
        }
      }
    }

    return "";
  }

  function generateContent(
    data: Record<string, any>,
    dataset: Dataset,
    entry: DatasetEntry
  ): string {
    const title = extractTitle(data, dataset);
    const description = extractDescription(data);

    let content = `# ${title}\n\n`;

    if (description) {
      content += `${description}\n\n`;
    }

    // Add metadata section
    const metadataFields = ["category", "genre", "type", "status", "author", "date", "location"];
    const metadata: string[] = [];

    for (const field of metadataFields) {
      if (data[field] !== undefined && data[field] !== null) {
        const value = Array.isArray(data[field]) ? data[field].join(", ") : String(data[field]);
        metadata.push(`**${field.charAt(0).toUpperCase() + field.slice(1)}:** ${value}`);
      }
    }

    if (metadata.length > 0) {
      content += `## Metadata\n\n${metadata.join("\n")}\n\n`;
    }

    // Add other fields as content
    const skipFields = [
      "title",
      "name",
      "description",
      "summary",
      "image",
      "coverImage",
      "featuredImage",
      "tags",
      "category",
      "genre",
    ];
    const otherFields: string[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (!skipFields.includes(key) && value !== undefined && value !== null) {
        let displayValue: string;

        if (typeof value === "object") {
          if (Array.isArray(value)) {
            displayValue = value.join(", ");
          } else {
            continue; // Skip nested objects for now
          }
        } else {
          displayValue = String(value);
        }

        const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1");
        otherFields.push(`**${label}:** ${displayValue}`);
      }
    }

    if (otherFields.length > 0) {
      content += `## Additional Information\n\n${otherFields.join("\n")}\n\n`;
    }

    // Add footer with source attribution
    content += `---\n\n*This content was generated from [${dataset.name}](/datasets/${dataset.id}/entries/${entry.id})*\n`;

    return content;
  }

  function generateExcerpt(description: string): string {
    if (!description) return "";

    // Strip markdown for excerpt
    const plainText = description
      .replace(/#+ /g, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();

    if (plainText.length <= 160) {
      return plainText;
    }

    return plainText.substring(0, 157) + "...";
  }

  function extractTags(data: Record<string, any>): string[] {
    const tags: string[] = [];

    // Try common tag fields
    const tagFields = [
      "tags",
      "tag",
      "categories",
      "category",
      "genre",
      "genres",
      "keywords",
      "labels",
    ];

    for (const field of tagFields) {
      if (data[field]) {
        if (Array.isArray(data[field])) {
          tags.push(...data[field].filter((t): t is string => typeof t === "string"));
        } else if (typeof data[field] === "string") {
          tags.push(data[field]);
        }
      }
    }

    // Remove duplicates and empty strings
    return [...new Set(tags)].filter(Boolean);
  }

  function extractImage(data: Record<string, any>): string | undefined {
    const imageFields = [
      "coverImage",
      "featuredImage",
      "image",
      "thumbnail",
      "photo",
      "picture",
      "mainImage",
    ];

    for (const field of imageFields) {
      if (data[field] && typeof data[field] === "string") {
        return data[field];
      }
    }

    return undefined;
  }

  // ─── Derived State ──────────────────────────────────
  const filteredDatasets = $derived(
    searchQuery
      ? datasets.filter(
          (d) =>
            d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            d.description?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : datasets
  );

  const totalPages = $derived(Math.ceil(totalEntries / entriesPerPage));
  const hasNextPage = $derived(currentPage < totalPages);
  const hasPrevPage = $derived(currentPage > 1);

  // ─── Formatters ─────────────────────────────────────
  function formatDate(dateString: string): string {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString(localeFormat(), {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return dateString;
    }
  }
</script>

<Dialog
  open={isOpen}
  title={step === "datasets"
    ? tr("promoteFromDataset.createPostFromDataset")
    : step === "entries"
      ? tr("promoteFromDataset.selectFrom", { name: selectedDataset?.name })
      : tr("promoteFromDataset.previewContent")}
  onClose={handleClose}
>
  <div class="w-[700px] max-h-[80vh] flex flex-col">
    <!-- Navigation -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-kitsuden-border">
      {#if step !== "datasets"}
        <Button onclick={goBack} variant="ghost" size="sm" disabled={loading}>
          {tr("promoteFromDataset.back")}
        </Button>
      {/if}

      <div class="flex items-center gap-2 text-sm text-kitsuden-subtle">
        <span class={step === "datasets" ? "text-kitsuden-accent font-medium" : ""}
          >{tr("common.datasets")}</span
        >
        <ArrowRight class="w-4 h-4" />
        <span class={step === "entries" ? "text-kitsuden-accent font-medium" : ""}
          >{tr("promoteFromDataset.entries")}</span
        >
        <ArrowRight class="w-4 h-4" />
        <span class={step === "preview" ? "text-kitsuden-accent font-medium" : ""}
          >{tr("common.preview")}</span
        >
      </div>
    </div>

    <!-- Search -->
    <div class="p-4 border-b border-kitsuden-border">
      <div class="relative">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-kitsuden-subtle" />
        <input
          type="text"
          bind:value={searchQuery}
          onkeydown={handleKeyDown}
          placeholder={step === "datasets"
            ? tr("promoteFromDataset.searchDatasets")
            : tr("promoteFromDataset.searchEntries")}
          class="input w-full pl-10"
          disabled={loading}
        />
        {#if searchQuery}
          <button
            onclick={() => {
              searchQuery = "";
              handleSearch();
            }}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-kitsuden-subtle hover:text-kitsuden-text"
          >
            <X class="w-4 h-4" />
          </button>
        {/if}
      </div>
      <div class="flex justify-between mt-2">
        <span class="text-xs text-kitsuden-subtle">
          {#if step === "datasets"}
            {tr("promoteFromDataset.dataset", {
              filteredDatasetsCount: filteredDatasets.length,
            })}{filteredDatasets.length !== 1 ? "s" : ""}
          {:else if step === "entries"}
            {tr("promoteFromDataset.ofEntries", { entriesCount: entries.length, totalEntries })}
          {/if}
        </span>
        {#if step === "entries" && totalPages > 1}
          <span class="text-xs text-kitsuden-subtle">
            {tr("promoteFromDataset.pageOf", { currentPage, totalPages })}
          </span>
        {/if}
      </div>
    </div>

    <!-- Error Alert -->
    {#if error}
      <div
        class="mx-4 mt-4 p-3 rounded-lg bg-kitsuden-accent-2/10 border border-kitsuden-accent-2/20 text-kitsuden-accent-2 text-sm flex items-start gap-2"
      >
        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
        <div class="flex-1">
          <p>{error}</p>
          <button
            onclick={() => {
              error = null;
              handleSearch();
            }}
            class="text-xs underline mt-1 hover:no-underline flex items-center gap-1"
          >
            <RefreshCw class="w-3 h-3" />
            {tr("promoteFromDataset.retry")}
          </button>
        </div>
      </div>
    {/if}

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
      {#if loading}
        <div class="flex flex-col items-center justify-center py-12">
          <Loader2 class="w-8 h-8 text-kitsuden-accent animate-spin mb-3" />
          <p class="text-kitsuden-subtle text-sm">{tr("common.loading")}</p>
        </div>
      {:else if step === "datasets"}
        <!-- Datasets List -->
        <div class="space-y-2">
          {#each filteredDatasets as dataset}
            <button
              onclick={() => selectDataset(dataset)}
              class="w-full p-4 rounded-xl border border-kitsuden-border hover:border-kitsuden-accent/50 hover:bg-kitsuden-accent/5 transition-all text-left group"
              disabled={loading}
            >
              <div class="flex items-start gap-3">
                <div
                  class="w-10 h-10 rounded-lg bg-kitsuden-accent/10 flex items-center justify-center shrink-0 group-hover:bg-kitsuden-accent/20 transition-colors"
                >
                  <Database class="w-5 h-5 text-kitsuden-accent" />
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="font-medium text-kitsuden-text">{dataset.name}</h3>
                  {#if dataset.description}
                    <p class="text-sm text-kitsuden-subtle mt-1 line-clamp-2">
                      {dataset.description}
                    </p>
                  {/if}
                  <div class="flex items-center gap-3 mt-2">
                    <span class="text-xs text-kitsuden-subtle">
                      {tr("promoteFromDataset.entries2", { v: dataset.entryCount || 0 })}
                    </span>
                    <span class="text-xs text-kitsuden-subtle">
                      {tr("promoteFromDataset.updated", { v: formatDate(dataset.updatedAt) })}
                    </span>
                  </div>
                </div>
                <ArrowRight
                  class="w-5 h-5 text-kitsuden-subtle shrink-0 group-hover:text-kitsuden-accent transition-colors"
                />
              </div>
            </button>
          {/each}

          {#if filteredDatasets.length === 0}
            <div class="text-center py-12">
              <Database class="w-12 h-12 text-kitsuden-subtle mx-auto mb-3" />
              <p class="text-kitsuden-subtle">
                {searchQuery
                  ? tr("promoteFromDataset.noDatasetsMatchYourSearch")
                  : tr("promoteFromDataset.noDatasetsAvailable")}
              </p>
            </div>
          {/if}
        </div>
      {:else if step === "entries"}
        <!-- Entries List -->
        <div class="space-y-2">
          {#each entries as entry}
            {@const entryTitle = entry.data?.title || entry.data?.name || "Untitled"}
            {@const entryDesc = entry.data?.description || entry.data?.summary || ""}
            <button
              onclick={() => selectEntry(entry)}
              class="w-full p-4 rounded-xl border border-kitsuden-border hover:border-kitsuden-accent/50 hover:bg-kitsuden-accent/5 transition-all text-left group"
              disabled={loading}
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-10 h-10 rounded-lg bg-kitsuden-purple/10 flex items-center justify-center shrink-0 group-hover:bg-kitsuden-purple/20 transition-colors"
                >
                  <FileText class="w-5 h-5 text-kitsuden-purple" />
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="font-medium text-kitsuden-text truncate">{entryTitle}</h3>
                  {#if entryDesc}
                    <p class="text-sm text-kitsuden-subtle mt-1 line-clamp-2">{entryDesc}</p>
                  {/if}
                  <div class="flex items-center gap-3 mt-2">
                    {#if entry.status}
                      <span
                        class="text-xs px-2 py-0.5 rounded-full bg-kitsuden-border/50 text-kitsuden-subtle capitalize"
                      >
                        {entry.status}
                      </span>
                    {/if}
                    <span class="text-xs text-kitsuden-subtle">
                      {formatDate(entry.updatedAt)}
                    </span>
                  </div>
                </div>
                <ArrowRight
                  class="w-5 h-5 text-kitsuden-subtle shrink-0 group-hover:text-kitsuden-accent transition-colors"
                />
              </div>
            </button>
          {/each}

          {#if entries.length === 0}
            <div class="text-center py-12">
              <FileText class="w-12 h-12 text-kitsuden-subtle mx-auto mb-3" />
              <p class="text-kitsuden-subtle">
                {searchQuery
                  ? tr("promoteFromDataset.noEntriesMatchYourSearch")
                  : tr("promoteFromDataset.noEntriesAvailable")}
              </p>
            </div>
          {/if}
        </div>

        <!-- Pagination -->
        {#if totalPages > 1}
          <div
            class="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-kitsuden-border"
          >
            <Button
              onclick={() => goToPage(currentPage - 1)}
              disabled={!hasPrevPage || loading}
              variant="ghost"
              size="sm"
            >
              {tr("promoteFromDataset.previous")}
            </Button>
            <span class="text-sm text-kitsuden-subtle px-3">
              {tr("promoteFromDataset.pageOf", { currentPage, totalPages })}
            </span>
            <Button
              onclick={() => goToPage(currentPage + 1)}
              disabled={!hasNextPage || loading}
              variant="ghost"
              size="sm"
            >
              {tr("common.next")}
            </Button>
          </div>
        {/if}
      {:else if step === "preview" && selectedEntry}
        {@const preview = transformEntryToPost(selectedEntry, selectedDataset!)}
        <div class="space-y-4">
          <!-- Title -->
          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle">{tr("common.title")}</label>
            <p class="text-lg font-medium text-kitsuden-text">{preview.title}</p>
          </div>

          <!-- Excerpt -->
          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle"
              >{tr("promoteFromDataset.excerpt")}</label
            >
            <p class="text-sm text-kitsuden-text-dim line-clamp-3">{preview.excerpt}</p>
          </div>

          <!-- Tags -->
          {#if preview.tags.length > 0}
            <div>
              <label class="label text-xs uppercase text-kitsuden-subtle flex items-center gap-1">
                <Tag class="w-3 h-3" />
                {tr("promoteFromDataset.tags", { tagsCount: preview.tags.length })}
              </label>
              <div class="flex flex-wrap gap-2 mt-1">
                {#each preview.tags.slice(0, 10) as tag}
                  <span
                    class="px-2 py-1 rounded-full bg-kitsuden-accent/10 text-kitsuden-accent text-xs"
                  >
                    {tag}
                  </span>
                {/each}
                {#if preview.tags.length > 10}
                  <span
                    class="px-2 py-1 rounded-full bg-kitsuden-border/50 text-kitsuden-subtle text-xs"
                  >
                    {tr("common.more", { v: preview.tags.length - 10 })}
                  </span>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Featured Image -->
          {#if preview.featuredImageId}
            <div>
              <label class="label text-xs uppercase text-kitsuden-subtle flex items-center gap-1">
                <Image class="w-3 h-3" />
                {tr("promoteFromDataset.featuredImage")}
              </label>
              <p class="text-xs text-kitsuden-accent font-mono mt-1">{preview.featuredImageId}</p>
            </div>
          {/if}

          <!-- Content Preview -->
          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle"
              >{tr("common.contentPreview")}</label
            >
            <div class="mt-1 p-3 rounded-lg bg-kitsuden-bg border border-kitsuden-border">
              <pre
                class="text-xs text-kitsuden-text-dim whitespace-pre-wrap line-clamp-10 font-mono">{preview.content.substring(
                  0,
                  500
                )}{preview.content.length > 500 ? "..." : ""}</pre>
            </div>
            <p class="text-xs text-kitsuden-subtle mt-1">
              {tr("promoteFromDataset.characters", { contentCount: preview.content.length })}
            </p>
          </div>

          <!-- Source Info -->
          <div class="p-3 rounded-lg bg-kitsuden-accent/5 border border-kitsuden-accent/20">
            <p class="text-xs text-kitsuden-accent flex items-center gap-1">
              <Check class="w-3 h-3" />
              {tr("promoteFromDataset.source", {
                name: selectedDataset?.name,
                v: selectedEntry.id.substring(0, 8),
              })}
            </p>
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer Actions -->
    <div class="flex justify-end gap-2 p-4 border-t border-kitsuden-border">
      <Button onclick={handleClose} variant="ghost" disabled={loading}>
        {tr("common.cancel")}
      </Button>
      {#if step === "preview"}
        <Button onclick={handleConfirm} disabled={loading}>
          {#if loading}
            <Loader2 class="w-4 h-4 animate-spin" />
            {tr("promoteFromDataset.processing")}
          {:else}
            <Check class="w-4 h-4" />
            {tr("promoteFromDataset.createPost")}
          {/if}
        </Button>
      {/if}
    </div>
  </div>
</Dialog>
