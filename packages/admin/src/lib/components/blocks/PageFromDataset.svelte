<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  /**
   * PageFromDataset.svelte — Production Ready
   *
   * Component to create a Page Builder page based on data from a dataset.
   * Generates visual blocks (Hero, Text, Cards, CTA) from dataset data.
   *
   * @production Ready for production use
   * @version 1.0.0
   */
  import {
    Database,
    Search,
    ArrowRight,
    Layout,
    Check,
    X,
    Loader2,
    AlertCircle,
    RefreshCw,
  } from "lucide-svelte";
  import { onDestroy } from "svelte";

  import { api } from "$lib/api";
  import Modal from "$lib/components/ui/Modal.svelte";

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

  interface BlockContent {
    type: string;
    name?: string;
    content: Record<string, any>;
    columnSpan?: number;
    sortOrder?: number;
  }

  interface PageData {
    title: string;
    slug: string;
    blocks: BlockContent[];
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
    onSelect: (data: PageData) => void;
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
        error = err.message || t("pageFromDataset.failedToLoadDatasetsPlease");
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
        error = err.message || t("pageFromDataset.failedToLoadEntriesPlease");
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
      error = t("pageFromDataset.pleaseSelectADatasetEntry");
      return;
    }

    try {
      const pageData = transformEntryToPage(selectedEntry, selectedDataset);
      onSelect(pageData);
      handleClose();
    } catch (err: any) {
      console.error("Failed to transform entry:", err);
      error = err.message || t("pageFromDataset.failedToProcessEntryData");
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
  function transformEntryToPage(entry: DatasetEntry, dataset: Dataset): PageData {
    const data = entry.data;

    if (!data || typeof data !== "object") {
      throw new Error(t("pageFromDataset.invalidEntryData"));
    }

    const title = extractTitle(data, dataset);
    const slug = generateSlug(title);
    const blocks = generateBlocks(data, dataset);

    return {
      title,
      slug,
      blocks,
      source: {
        type: "dataset",
        datasetId: dataset.id,
        entryId: entry.id,
      },
    };
  }

  function extractTitle(data: Record<string, any>, dataset: Dataset): string {
    const titleFields = ["title", "name", "headline", "subject", "heading"];

    for (const field of titleFields) {
      if (data[field] && typeof data[field] === "string") {
        return data[field].trim();
      }
    }

    for (const [key, value] of Object.entries(data)) {
      if (key.toLowerCase().includes("title") && typeof value === "string") {
        return value.trim();
      }
    }

    return t("pageFromDataset.pageFrom", { name: dataset.name });
  }

  function generateSlug(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function generateBlocks(data: Record<string, any>, dataset: Dataset): BlockContent[] {
    const blocks: BlockContent[] = [];
    let sortOrder = 0;

    const title = extractTitle(data, dataset);
    const description = data.description || data.summary || "";
    const imageId = data.coverImage || data.image || data.featuredImage || data.thumbnail;

    // 1. Hero Block
    blocks.push({
      type: "hero",
      name: t("pageFromDataset.heroSection"),
      sortOrder: sortOrder++,
      columnSpan: 12,
      content: {
        headline: title,
        description,
        mediaId: imageId,
        mediaType: imageId ? "image" : undefined,
        alignment: "center",
        minHeight: "lg",
        ...(data.ctaUrl
          ? {
              primaryButton: {
                label: data.ctaText || t("pageFromDataset.learnMore"),
                url: data.ctaUrl,
                variant: "primary",
              },
            }
          : {}),
      },
    });

    // 2. Main Description Text Block
    if (description) {
      blocks.push({
        type: "text",
        name: "Description",
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          text: `<p>${description}</p>`,
          format: "html",
          alignment: "left",
          textSize: "md",
        },
      });
    }

    // 3. Features/Highlights as Cards
    const features = extractFeatures(data);
    if (features.length > 0) {
      blocks.push({
        type: "cards",
        name: "Features",
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          cards: features.map((feature, index) => ({
            id: `feature-${index}`,
            title: feature.title,
            description: feature.description,
            mediaId: feature.image,
          })),
          columns: Math.min(features.length, 3),
          variant: "default",
        },
      });
    }

    // 4. Additional Details
    const details = extractDetails(data);
    if (details.length > 0) {
      let detailsHtml = "<h2>Details</h2><ul>";
      for (const detail of details) {
        detailsHtml += `<li><strong>${detail.label}:</strong> ${detail.value}</li>`;
      }
      detailsHtml += "</ul>";

      blocks.push({
        type: "text",
        name: "Details",
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          text: detailsHtml,
          format: "html",
          alignment: "left",
        },
      });
    }

    // 5. Image Gallery (if multiple images)
    const images = extractImages(data);
    if (images.length > 1) {
      blocks.push({
        type: "grid",
        name: t("pageFromDataset.imageGallery"),
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          columns: 3,
          gap: "md",
          items: images.slice(0, 6).map((img, index) => ({
            id: `gallery-${index}`,
            columnSpan: 4,
            content: {
              type: "image",
              mediaId: img,
              altText: `${title} - Image ${index + 1}`,
            },
          })),
        },
      });
    } else if (images.length === 1 && !imageId) {
      // Single image that wasn't used in hero
      blocks.push({
        type: "image",
        name: t("pageFromDataset.featuredImage"),
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          mediaId: images[0],
          altText: title,
          alignment: "center",
          caption: data.imageCaption || "",
        },
      });
    }

    // 6. Quote/Testimonial (if available)
    if (data.quote || data.testimonial || data.review) {
      const quoteText = data.quote || data.testimonial || data.review;
      const quoteAuthor = data.quoteAuthor || data.testimonialAuthor || data.reviewer;
      const quoteTitle = data.quoteAuthorTitle || data.reviewerTitle;

      blocks.push({
        type: "quote",
        name: "Testimonial",
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          quote: quoteText,
          author: quoteAuthor,
          authorTitle: quoteTitle,
          authorImageId: data.quoteAuthorImage || data.reviewerImage,
          style: "large",
        },
      });
    }

    // 7. Call to Action
    const ctaTitle = data.ctaTitle || t("pageFromDataset.interestedIn", { title });
    const ctaDescription = data.ctaDescription || t("pageFromDataset.getMoreInformationOrTake");
    const ctaButton = data.ctaText || t("pageFromDataset.getStarted");
    const ctaUrl = data.ctaUrl || data.website || data.url || "#";

    blocks.push({
      type: "cta",
      name: t("pageFromDataset.callToAction"),
      sortOrder: sortOrder++,
      columnSpan: 12,
      content: {
        title: ctaTitle,
        description: ctaDescription,
        buttonLabel: ctaButton,
        buttonUrl: ctaUrl,
        buttonVariant: "primary",
        alignment: "center",
      },
    });

    // 8. Video (if available)
    if (data.videoUrl || data.youtubeUrl || data.vimeoUrl) {
      const videoUrl = data.videoUrl || data.youtubeUrl || data.vimeoUrl;
      const provider = videoUrl.includes("youtube")
        ? "youtube"
        : videoUrl.includes("vimeo")
          ? "vimeo"
          : "self";

      blocks.push({
        type: "video",
        name: "Video",
        sortOrder: sortOrder++,
        columnSpan: 12,
        content: {
          embedUrl: videoUrl,
          provider,
          autoplay: false,
          controls: true,
        },
      });
    }

    return blocks;
  }

  function extractFeatures(
    data: Record<string, any>
  ): Array<{ title: string; description: string; image?: string }> {
    const features: Array<{ title: string; description: string; image?: string }> = [];

    // Try features array
    if (data.features && Array.isArray(data.features)) {
      for (const feature of data.features) {
        if (typeof feature === "string") {
          features.push({ title: feature, description: "" });
        } else if (typeof feature === "object" && feature) {
          features.push({
            title: feature.title || feature.name || t("pageFromDataset.feature"),
            description: feature.description || "",
            image: feature.image || feature.icon,
          });
        }
      }
    }

    // Try specifications
    if (data.specifications && Array.isArray(data.specifications)) {
      for (const spec of data.specifications.slice(0, 6)) {
        if (typeof spec === "object" && spec) {
          features.push({
            title: spec.name || spec.label || t("pageFromDataset.specification"),
            description: spec.value || spec.description || "",
            image: spec.image,
          });
        }
      }
    }

    // Try highlights
    if (data.highlights && Array.isArray(data.highlights)) {
      for (const highlight of data.highlights) {
        if (typeof highlight === "string") {
          features.push({ title: highlight, description: "" });
        }
      }
    }

    return features.slice(0, 6); // Max 6 features
  }

  function extractDetails(data: Record<string, any>): Array<{ label: string; value: string }> {
    const details: Array<{ label: string; value: string }> = [];
    const skipFields = [
      "title",
      "name",
      "description",
      "summary",
      "image",
      "coverImage",
      "featuredImage",
      "thumbnail",
      "tags",
      "features",
      "highlights",
      "specifications",
      "videoUrl",
      "youtubeUrl",
      "vimeoUrl",
      "ctaUrl",
      "ctaText",
      "quote",
      "testimonial",
      "review",
    ];

    const detailFields = [
      { key: "price", label: t("pageFromDataset.price") },
      { key: "category", label: t("common.category") },
      { key: "genre", label: t("pageFromDataset.genre") },
      { key: "platform", label: t("common.platform") },
      { key: "releaseDate", label: t("pageFromDataset.releaseDate") },
      { key: "developer", label: t("pageFromDataset.developer") },
      { key: "publisher", label: t("pageFromDataset.publisher") },
      { key: "rating", label: t("pageFromDataset.rating") },
      { key: "duration", label: t("pageFromDataset.duration") },
      { key: "location", label: t("pageFromDataset.location") },
      { key: "date", label: t("common.date") },
      { key: "time", label: t("pageFromDataset.time") },
      { key: "status", label: t("common.status") },
    ];

    for (const { key, label } of detailFields) {
      if (data[key] !== undefined && data[key] !== null) {
        let value: string;
        if (Array.isArray(data[key])) {
          value = data[key].join(", ");
        } else {
          value = String(data[key]);
        }
        details.push({ label, value });
      }
    }

    // Add any other fields not in skip list
    for (const [key, value] of Object.entries(data)) {
      if (
        !skipFields.includes(key) &&
        !detailFields.find((d) => d.key === key) &&
        value !== undefined &&
        value !== null &&
        typeof value !== "object"
      ) {
        const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1");
        details.push({ label, value: String(value) });
      }
    }

    return details.slice(0, 10); // Max 10 details
  }

  function extractImages(data: Record<string, any>): string[] {
    const images: string[] = [];
    const imageFields = ["images", "gallery", "screenshots", "photos", "pictures"];

    for (const field of imageFields) {
      if (data[field] && Array.isArray(data[field])) {
        for (const img of data[field]) {
          if (typeof img === "string") {
            images.push(img);
          } else if (typeof img === "object" && img && img.url) {
            images.push(img.url);
          }
        }
      }
    }

    return [...new Set(images)].filter(Boolean);
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

  function getBlockIcon(type: string): string {
    const icons: Record<string, string> = {
      hero: "🎯",
      text: "📝",
      cards: "🃏",
      image: "🖼️",
      video: "🎬",
      grid: "⊞",
      quote: "💬",
      cta: "🚀",
      embed: "🔗",
      divider: "—",
      spacer: "↕️",
    };
    return icons[type] || "📦";
  }
</script>

<Modal
  open={isOpen}
  title={step === "datasets"
    ? t("pageFromDataset.createPageFromDataset")
    : step === "entries"
      ? t("pageFromDataset.selectFrom", { name: selectedDataset?.name })
      : t("pageFromDataset.previewBlocks")}
  onClose={handleClose}
>
  <div class="w-[700px] max-h-[80vh] flex flex-col">
    <!-- Navigation -->
    <div class="flex items-center gap-2 px-4 py-3 border-b border-kitsuden-border">
      {#if step !== "datasets"}
        <button onclick={goBack} class="btn-ghost btn-sm" disabled={loading}>
          {t("pageFromDataset.back")}
        </button>
      {/if}

      <div class="flex items-center gap-2 text-sm text-kitsuden-subtle">
        <span class={step === "datasets" ? "text-kitsuden-accent font-medium" : ""}
          >{t("common.datasets")}</span
        >
        <ArrowRight class="w-4 h-4" />
        <span class={step === "entries" ? "text-kitsuden-accent font-medium" : ""}
          >{t("pageFromDataset.entries")}</span
        >
        <ArrowRight class="w-4 h-4" />
        <span class={step === "preview" ? "text-kitsuden-accent font-medium" : ""}
          >{t("common.preview")}</span
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
            ? t("pageFromDataset.searchDatasets")
            : t("pageFromDataset.searchEntries")}
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
            {t("pageFromDataset.dataset", {
              filteredDatasetsCount: filteredDatasets.length,
            })}{filteredDatasets.length !== 1 ? "s" : ""}
          {:else if step === "entries"}
            {t("pageFromDataset.ofEntries", { entriesCount: entries.length, totalEntries })}
          {/if}
        </span>
        {#if step === "entries" && totalPages > 1}
          <span class="text-xs text-kitsuden-subtle">
            {t("pageFromDataset.pageOf", { currentPage, totalPages })}
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
            {t("pageFromDataset.retry")}
          </button>
        </div>
      </div>
    {/if}

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
      {#if loading}
        <div class="flex flex-col items-center justify-center py-12">
          <Loader2 class="w-8 h-8 text-kitsuden-accent animate-spin mb-3" />
          <p class="text-kitsuden-subtle text-sm">{t("common.loading")}</p>
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
                      {t("pageFromDataset.entries2", { v: dataset.entryCount || 0 })}
                    </span>
                    <span class="text-xs text-kitsuden-subtle">
                      {t("pageFromDataset.updated", { v: formatDate(dataset.updatedAt) })}
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
                  ? t("pageFromDataset.noDatasetsMatchYourSearch")
                  : t("pageFromDataset.noDatasetsAvailable")}
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
                  <Layout class="w-5 h-5 text-kitsuden-purple" />
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
              <Layout class="w-12 h-12 text-kitsuden-subtle mx-auto mb-3" />
              <p class="text-kitsuden-subtle">
                {searchQuery
                  ? t("pageFromDataset.noEntriesMatchYourSearch")
                  : t("pageFromDataset.noEntriesAvailable")}
              </p>
            </div>
          {/if}
        </div>

        <!-- Pagination -->
        {#if totalPages > 1}
          <div
            class="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-kitsuden-border"
          >
            <button
              onclick={() => goToPage(currentPage - 1)}
              disabled={!hasPrevPage || loading}
              class="btn-ghost btn-sm disabled:opacity-50"
            >
              {t("pageFromDataset.previous")}
            </button>
            <span class="text-sm text-kitsuden-subtle px-3">
              {t("pageFromDataset.pageOf", { currentPage, totalPages })}
            </span>
            <button
              onclick={() => goToPage(currentPage + 1)}
              disabled={!hasNextPage || loading}
              class="btn-ghost btn-sm disabled:opacity-50"
            >
              {t("common.next")}
            </button>
          </div>
        {/if}
      {:else if step === "preview" && selectedEntry}
        {@const preview = transformEntryToPage(selectedEntry, selectedDataset!)}
        <div class="space-y-4">
          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle"
              >{t("common.pageTitle")}</label
            >
            <p class="text-lg font-medium text-kitsuden-text">{preview.title}</p>
          </div>

          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle">{t("common.slug")}</label>
            <p class="text-sm text-kitsuden-accent font-mono">/{preview.slug}</p>
          </div>

          <div>
            <label class="label text-xs uppercase text-kitsuden-subtle flex items-center gap-1">
              <Layout class="w-3 h-3" />
              {t("pageFromDataset.generatedBlocks", { blocksCount: preview.blocks.length })}
            </label>
            <div class="mt-2 space-y-2">
              {#each preview.blocks as block, index}
                <div
                  class="flex items-center gap-2 p-2 rounded-lg bg-kitsuden-bg border border-kitsuden-border hover:border-kitsuden-accent/30 transition-colors"
                >
                  <span class="text-xs text-kitsuden-subtle w-6">{index + 1}.</span>
                  <span class="text-base">{getBlockIcon(block.type)}</span>
                  <span class="text-sm text-kitsuden-text capitalize">{block.type}</span>
                  <span class="text-xs text-kitsuden-subtle ml-auto truncate max-w-[200px]">
                    {block.name ||
                      block.content.headline ||
                      block.content.title ||
                      block.content.text?.substring(0, 30) ||
                      "..."}
                  </span>
                </div>
              {/each}
            </div>
          </div>

          <div class="p-3 rounded-lg bg-kitsuden-accent/5 border border-kitsuden-accent/20">
            <p class="text-xs text-kitsuden-accent flex items-center gap-1">
              <Check class="w-3 h-3" />
              {t("pageFromDataset.source", {
                name: selectedDataset?.name,
                v: selectedEntry.id.substring(0, 8),
              })}
            </p>
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="flex justify-end gap-2 p-4 border-t border-kitsuden-border">
      <button onclick={handleClose} class="btn-ghost" disabled={loading}>
        {t("common.cancel")}
      </button>
      {#if step === "preview"}
        <button onclick={handleConfirm} class="btn-primary gap-1.5" disabled={loading}>
          {#if loading}
            <Loader2 class="w-4 h-4 animate-spin" />
            {t("pageFromDataset.processing")}
          {:else}
            <Check class="w-4 h-4" />
            {t("pageFromDataset.createPage")}
          {/if}
        </button>
      {/if}
    </div>
  </div>
</Modal>
