<script lang="ts">
  import { t } from "$lib/i18n";
  /**
   * MediaPicker.svelte — choose (or upload) an image from the library
   * ==========================================================================
   *
   * This used to live inside `BlogPostEditor.svelte`, a 2000-line file.
   * As a consequence, the ONLY admin screen from which an image could be chosen
   * or uploaded was the blog editor: the page builder asked for
   * images as a text box to paste a URL by hand, and the
   * dataset form had its own upload — broken — written separately.
   *
   * By pulling it out, any kon with an image field inherits the library.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHAT THIS COMPONENT DOES NOT DO
   *
   * It does not decide what is done with the chosen image. It notifies with `onSelect` and that is it:
   * one puts it in the text, another sets it as the cover, another saves it in a
   * field. Putting that decision here is what tied it to the blog editor.
   * ─────────────────────────────────────────────────────────────────────────
   */
  import { Plus } from "lucide-svelte";

  import { api } from "$lib/api";
  import { Alert, Button, Dialog, EmptyState, SearchInput, Spinner } from "$lib/tallao";
  import { uploadMedia } from "$lib/media/upload";
  import { mediaUrl } from "$lib/states/media.svelte";

  export interface ChosenMedia {
    id: string;
    url: string;
    filename: string;
    alt?: string;
  }

  interface Props {
    open: boolean;
    title?: string;
    /** Id of the one already chosen, to mark it in the grid. */
    selectedId?: string | null;
    /**
     * Choose SEVERAL at once.
     *
     * ── WHY IT IS NEEDED ────────────────────────────────────────────────────
     *
     * The «Image Gallery» block asked for its images as hand-typed JSON —a
     * text box with `[]` inside— because this picker only knew how to return
     * one. Building a carousel meant going to the library, copying each URL and
     * pasting them to form the array. With the library right next to it.
     *
     * In this mode the modal does NOT close on choosing: they are marked one by one
     * and you leave with «Done». Closing on every click is what turns choosing eight
     * images into opening the picker eight times.
     */
    multiple?: boolean;
    /** Those already chosen, to mark them. Multiple mode only. */
    selectedIds?: string[];
    onSelect: (media: ChosenMedia) => void;
    onClose: () => void;
  }

  const {
    open,
    title = t("mediaPicker.chooseImage"),
    selectedId = null,
    multiple = false,
    selectedIds = [],
    onSelect,
    onClose,
  }: Props = $props();

  /** Is it already chosen? Serves both ways of marking. */
  function chosen(id: string): boolean {
    return multiple ? selectedIds.includes(id) : selectedId === id;
  }

  let mediaValue = $state<ChosenMedia[]>([]);
  let searchValue = $state("");
  let searching = $state(false);
  let uploading = $state(false);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The library loads on OPEN, not on mount.
   *
   * This component is instantiated together with the form that uses it, and many
   * forms never get to open it. Loading on mount would be one
   * request per image field on the screen.
   */
  $effect(() => {
    if (open) void load();
  });

  let fileInput = $state<HTMLInputElement>();

  async function load() {
    searching = true;
    try {
      /**
       * `type: "image"` because the grid renders each item with an `<img>`:
       * a PDF or a video came out as a broken icon taking up space.
       */
      const response = await api.getMedia({
        limit: 50,
        type: "image",
        search: searchValue.trim() || undefined,
      });
      mediaValue = (response.docs || []) as ChosenMedia[];
    } catch (err) {
      error = err instanceof Error ? err.message : t("mediaPicker.couldNotLoadThe");
    } finally {
      searching = false;
    }
  }

  /**
   * Searches ON THE SERVER, with a delay.
   *
   * Filtering on the client would only look at the 50 already loaded, so an old image
   * would never appear no matter how much of its name was typed — and that
   * reads as «that image doesn't exist».
   */
  function search(text: string) {
    searchValue = text;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;

    uploading = true;
    error = null;
    try {
      const { uploaded, errors: errors } = await uploadMedia(files);
      if (errors.length > 0) error = errors.join(" · ");

      if (uploaded.length === 0) return;

      // The newly uploaded ones are chosen directly: whoever has just given some
      // files should not have to look for them again in the grid.
      //
      // In multiple mode ALL of them go in. Keeping the first —as it used to—
      // means you drag eight images to build a carousel and
      // one gets added: the rest do get uploaded to the library, but do not enter the
      // block, and from the outside it looks like the upload half-failed.
      if (multiple) {
        for (const medium of uploaded) onSelect(medium);
      } else {
        onSelect(uploaded[0]);
      }

      // The grid reloads so that what was uploaded also appears there; otherwise,
      // removing an image from the block would leave it with no way to be chosen again
      // until the screen is reloaded.
      await load();
    } catch (err) {
      error = err instanceof Error ? err.message : t("mediaPicker.couldNotUpload");
    } finally {
      uploading = false;
    }
  }
</script>

<Dialog {open} {title} {onClose}>
  <div class="p-4">
    <div class="mb-3 flex items-center gap-2">
      <SearchInput
        class="min-w-0 flex-1"
        value={searchValue}
        oninput={search}
        placeholder={t("mediaPicker.searchByFileName")}
      />
      {#if searching}
        <Spinner size="sm" class="shrink-0 text-kitsuden-subtle" />
      {/if}

      <!--
        Upload from right here. It is what makes the picker useful on
        a new installation: without this the library is empty and the only
        way out is going to another screen and coming back.
      -->
      <Button
        variant="ghost"
        size="sm"
        class="shrink-0"
        loading={uploading}
        onclick={() => fileInput?.click()}
      >
        {#if uploading}
          {t("mediaPicker.uploading")}
        {:else}
          <Plus class="h-4 w-4" aria-hidden="true" />
          {t("mediaPicker.upload")}
        {/if}
      </Button>
      <!-- The native file field: the kit's Button opens it. -->
      <input
        bind:this={fileInput}
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        tabindex="-1"
        aria-hidden="true"
        disabled={uploading}
        onchange={(e) => {
          void upload(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </div>

    {#if error}
      <Alert variant="error" class="mb-3">{error}</Alert>
    {/if}

    {#if mediaValue.length === 0}
      {#if searchValue.trim()}
        <!--
          Telling «there is nothing» from «there is nothing THAT MATCHES» is not
          cosmetic: with the «upload images first» message in front of a
          search with no results, anyone concludes the library is empty and
          goes off to upload something they already have.
        -->
        <EmptyState
          variant="no-results"
          size="sm"
          title={t("mediaPicker.noImageMatches", { search: searchValue })}
          onClearFilters={() => search("")}
          clearFiltersLabel={t("mediaPicker.viewAll")}
        />
      {:else}
        <EmptyState
          size="sm"
          title={t("mediaPicker.noImagesYet")}
          description={t("mediaPicker.useUploadHereNotAbove")}
        />
      {/if}
    {:else}
      <div class="grid max-h-96 grid-cols-3 gap-3 overflow-y-auto">
        {#each mediaValue as media (media.id)}
          <button
            type="button"
            aria-pressed={chosen(media.id)}
            onclick={() => onSelect(media)}
            class="relative aspect-square overflow-hidden rounded-lg border-2 transition-all {chosen(
              media.id
            )
              ? 'border-kitsuden-accent'
              : 'border-transparent hover:border-kitsuden-border'}"
          >
            <img
              src={mediaUrl(media.url)}
              alt={media.alt || media.filename}
              class="h-full w-full object-cover"
            />
            {#if multiple && chosen(media.id)}
              <!--
                The mark matters more in multiple mode: without it, after choosing five there is
                no way to know which ones you have without closing and looking again.
              -->
              <span
                class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-kitsuden-accent text-xs font-bold text-kitsuden-on-accent"
              >
                {selectedIds.indexOf(media.id) + 1}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if multiple}
      <div class="mt-4 flex items-center justify-between border-t border-kitsuden-border pt-3">
        <span class="text-xs text-kitsuden-subtle">
          {selectedIds.length}
          {selectedIds.length === 1 ? t("mediaPicker.chosenImage") : t("mediaPicker.chosenImages")}
        </span>
        <Button size="sm" onclick={onClose}>{t("mediaPicker.ready")}</Button>
      </div>
    {/if}
  </div>
</Dialog>
