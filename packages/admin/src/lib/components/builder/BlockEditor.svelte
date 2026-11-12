<script lang="ts">
  import { Switch, Button, Field, Input, Label, NumberInput, Select, Textarea } from "$lib/tallao";
  import { t } from "$lib/i18n";
  /**
   * BlockEditor.svelte — Edit form for a single block's data
   */
  import {
    X,
    Trash2,
    Check,
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
    Clapperboard,
    SlidersHorizontal,
    Columns,
    Table2,
    Image as ImageIcon,
  } from "lucide-svelte";

  import MediaPicker from "$lib/components/media/MediaPicker.svelte";

  import { untrack } from "svelte";

  import { getBlockDef, type BlockFieldDef, type PageBlock } from "../../../types/blocks";

  interface Props {
    block: PageBlock;
    onUpdate?: (block: PageBlock) => void;
    onDelete?: () => void;
    onClose?: () => void;
  }

  const { block, onUpdate, onDelete, onClose }: Props = $props();

  const uid = $props.id();
  /** The text of the control an event came from. */
  const valueOf = (e: Event) =>
    (e.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;

  /**
   * Which field is waiting for an image. `null` = the picker is closed.
   *
   * The KEY is stored and not a boolean because a block can have several
   * image fields (background, logo, cover); with a boolean, the chosen one would go
   * always to the first.
   */
  let fieldChoosing = $state<string | null>(null);

  /**
   * Options of the `remote-select` fields, by field key.
   *
   * `undefined` = not requested yet; `[]` = requested and there are none.
   * The distinction matters: with both as an empty list, «loading» and «no
   * tier list created» look the same, and the second case sends you looking
   * for a fault instead of to create the first one.
   */
  let remoteOptions = $state<Record<string, { value: string; label: string }[]>>({});
  let remoteFailures = $state<Record<string, string>>({});

  /**
   * Requests a remote field's options ONCE.
   *
   * It is launched from the markup (`{#await}` does not fit: the field is repainted on
   * every keystroke in another field and would request them again). The
   * `remoteOptions` sentinel is what prevents the request storm.
   */
  /**
   * Requests the remote fields' options for the open block.
   *
   * ── WHY `untrack` ────────────────────────────────────────────────────────
   *
   * In Svelte 5 everything READ inside an effect becomes its dependency,
   * including what the functions it calls read. `loadOptions` reads
   * `remoteOptions` to avoid repeating the request… and also WRITES it. Without
   * isolating the call, loading would cause loading.
   *
   * It is the same bug that has already appeared four times in this panel, and it has a
   * guardian: `self-feeding-effects.test.ts`.
   */
  $effect(() => {
    const fields = blockDef?.fields ?? [];
    untrack(() => {
      for (const field of fields) {
        if (field.type === "remote-select" && field.source) {
          void loadOptions(field.key, field.source);
        }
      }
    });
  });

  async function loadOptions(keyValue: string, source: NonNullable<BlockFieldDef["source"]>) {
    if (remoteOptions[keyValue] !== undefined) return;
    // It is marked BEFORE waiting: without this, two consecutive repaints launch two
    // requests because neither has finished when the second arrives.
    remoteOptions = { ...remoteOptions, [keyValue]: [] };

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api${source.endpoint}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = await res.json();
      const list = (body?.[source.listKey] ?? []) as Record<string, unknown>[];

      remoteOptions = {
        ...remoteOptions,
        [keyValue]: list.map((x) => ({
          value: String(x[source.valueKey] ?? ""),
          label: String(x[source.labelKey] ?? x[source.valueKey] ?? ""),
        })),
      };
    } catch (err) {
      /**
       * The kon that provides the options being turned off is a valid
       * configuration, not a fault. It is stated in the field itself instead of leaving an
       * empty dropdown with no explanation.
       */
      remoteFailures = {
        ...remoteFailures,
        [keyValue]: err instanceof Error ? err.message : "could not be loaded",
      };
    }
  }

  /**
   * Gallery field that has the multiple picker open.
   *
   * It is kept separate from `fieldChoosing` because both open the SAME component
   * with different contracts: one returns an image and closes, the other keeps adding
   * and does not close. With a single variable the field's type would have to be asked about
   * in every handler, and that is the kind of branching that ends up
   * getting one of the two cases wrong.
   */
  let galleryChoosing = $state<string | null>(null);

  interface GalleryImage {
    url: string;
    alt?: string;
    caption?: string;
    /** Id in the library, if it came from there. Used to mark it in the picker. */
    mediaId?: string;
  }

  /** The images of a gallery field, tolerating whatever has been saved. */
  function imagesOf(key: string): GalleryImage[] {
    const v = block.data[key];
    return Array.isArray(v) ? (v as GalleryImage[]) : [];
  }

  function updateImages(key: string, images: GalleryImage[]) {
    updateField(key, images);
  }

  function removeImage(key: string, i: number) {
    updateImages(
      key,
      imagesOf(key).filter((_, j) => j !== i)
    );
  }

  /** Moves an image one position. In a carousel the order IS the content. */
  function moveImage(key: string, i: number, delta: number) {
    const images = [...imagesOf(key)];
    const target = i + delta;
    if (target < 0 || target >= images.length) return;
    [images[i], images[target]] = [images[target], images[i]];
    updateImages(key, images);
  }

  function editImage(key: string, i: number, field: "alt" | "caption", newValue: string) {
    const images = [...imagesOf(key)];
    images[i] = { ...images[i], [field]: newValue };
    updateImages(key, images);
  }

  /**
   * Toggles a library image in the gallery.
   *
   * Toggle and not just add: in the multiple picker the chosen ones are marked, and
   * if pressing again did not remove it, one extra click would force closing and
   * looking for the thumbnail to delete it.
   */
  function toggleInGallery(key: string, media: { id: string; url: string; alt?: string }) {
    const images = imagesOf(key);
    const i = images.findIndex((img) => img.mediaId === media.id || img.url === media.url);

    if (i >= 0) {
      removeImage(key, i);
      return;
    }

    updateImages(key, [...images, { url: media.url, alt: media.alt ?? "", mediaId: media.id }]);
  }

  const iconMap: Record<string, typeof Sparkles> = {
    Sparkles,
    FileText,
    Images,
    Map,
    Tv,
    Code2,
    AlertTriangle,
    Minus,
    Clapperboard,
    SlidersHorizontal,
    Columns,
    Table2,
  };

  const blockDef = $derived(getBlockDef(block.type));
  const jsonErrors: Record<string, string> = $state({});

  function updateField(key: string, value: any) {
    const updated = { ...block, data: { ...block.data, [key]: value } };
    onUpdate?.(updated);
  }

  function updateJsonField(key: string, raw: string) {
    try {
      const parsed = JSON.parse(raw);
      updateField(key, parsed);
      delete jsonErrors[key];
    } catch {
      jsonErrors[key] = t("blockEditor.invalidJson");
    }
  }

  function jsonStringify(val: any): string {
    if (val === undefined || val === null) return "";
    if (typeof val === "string") return val;
    return JSON.stringify(val, null, 2);
  }

  function getIcon(iconName: string): typeof Sparkles {
    return iconMap[iconName] || FileText;
  }
</script>

<div class="h-full flex flex-col">
  <!-- Header -->
  <div class="p-4 border-b border-kitsuden-border shrink-0">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        {#if blockDef}
          {@const BI = getIcon(blockDef.icon)}
          <div
            class="w-8 h-8 rounded-lg flex items-center justify-center"
            style="background: {blockDef.color}15; border: 1px solid {blockDef.color}25"
          >
            <BI class="w-4 h-4" style="color: {blockDef.color}" />
          </div>
        {/if}
        <div>
          <h3 class="text-sm font-semibold text-kitsuden-text">
            {blockDef?.label || t("blockEditor.block")}
          </h3>
          <p class="text-xs text-kitsuden-subtle font-mono">{block.type}</p>
        </div>
      </div>
      <Button onclick={onClose} variant="ghost" size="icon" ariaLabel={t("blockEditor.close")}
        ><X class="w-4 h-4" /></Button
      >
    </div>
  </div>

  <!-- Fields -->
  <div class="flex-1 overflow-y-auto p-4 space-y-4">
    {#each blockDef?.fields || [] as field}
      <div class="space-y-1.5">
        <!-- Text -->
        {#if field.type === "text"}
          <Field label={field.label} required={field.required}>
            <Input
              value={block.data[field.key] || ""}
              oninput={(e: Event) => updateField(field.key, valueOf(e))}
              placeholder={field.placeholder}
            />
          </Field>
        {/if}

        <!-- Textarea -->
        {#if field.type === "textarea"}
          <Field label={field.label} required={field.required}>
            <Textarea
              value={block.data[field.key] || ""}
              oninput={(e: Event) => updateField(field.key, valueOf(e))}
              placeholder={field.placeholder}
              rows={4}
            />
          </Field>
        {/if}

        <!-- URL / Image -->
        {#if field.type === "url" || field.type === "image"}
          <Label for="{uid}-{field.key}" required={field.required}>{field.label}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="{uid}-{field.key}"
              value={block.data[field.key] || ""}
              oninput={(e: Event) => updateField(field.key, valueOf(e))}
              type="url"
              placeholder={field.placeholder || "https://"}
              class="flex-1 min-w-0"
            />
            <!--
              ── THE BUTTON THAT WAS MISSING ─────────────────────────────────

              An image field was a text box where you pasted a URL by hand. To put
              your own image in a block you had to go to the library, copy the URL,
              come back and paste it — and half the time you ended up linking
              an image from another site.

              The text field is kept: linking an external image is still
              legitimate, and removing it would have broken already saved blocks.
            -->
            {#if field.type === "image"}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="shrink-0"
                onclick={() => (fieldChoosing = field.key)}
                title={t("blockEditor.chooseFromLibraryOr")}
              >
                <ImageIcon class="h-4 w-4" />
                {t("blockEditor.library")}
              </Button>
            {/if}
          </div>
          {#if field.type === "image" && block.data[field.key]}
            <div class="mt-2 rounded-lg border border-kitsuden-border overflow-hidden">
              <img src={block.data[field.key]} class="w-full h-32 object-cover" alt="" />
            </div>
          {/if}
        {/if}

        <!-- Select -->
        {#if field.type === "select"}
          <Field label={field.label} required={field.required}>
            <Select
              value={block.data[field.key] || ""}
              onchange={(e: Event) => updateField(field.key, valueOf(e))}
            >
              {#each field.options || [] as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </Select>
          </Field>
        {/if}

        <!-- Number -->
        <!--
          ── Dropdown with options from the API ──────────────────────────────

          The field asked for the slug by hand (`placeholder: "meta-5-4"`). Typing it
          wrong gives no error: the page is saved and comes out without the tier list.
        -->
        {#if field.type === "remote-select"}
          {#if field.source}
            <Field label={field.label} required={field.required}>
              <Select
                value={block.data[field.key] || ""}
                onchange={(e: Event) => updateField(field.key, valueOf(e))}
              >
                <option value="">{t("blockEditor.chooses")}</option>
                {#each remoteOptions[field.key] || [] as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </Select>
            </Field>

            {#if remoteFailures[field.key]}
              <p class="text-xs text-kitsuden-accent-2 mt-1">
                {t("blockEditor.couldNotLoadThe", { v: remoteFailures[field.key] })}
              </p>
            {:else if remoteOptions[field.key]?.length === 0}
              <p class="text-xs text-kitsuden-text-dim mt-1">
                {t("blockEditor.noneCreatedYet")}
              </p>
            {/if}
          {:else}
            <span class="block text-xs font-medium text-kitsuden-text-dim">{field.label}</span>
          {/if}
        {/if}

        <!-- Number -->
        {#if field.type === "number"}
          <Field label={field.label} required={field.required}>
            <NumberInput
              value={typeof block.data[field.key] === "number" ? block.data[field.key] : null}
              onchange={(n) => updateField(field.key, n ?? 0)}
            />
          </Field>
        {/if}

        <!-- Boolean -->
        {#if field.type === "boolean"}
          <div class="flex items-center justify-between py-1">
            <span class="text-sm text-kitsuden-text" aria-hidden="true">{field.label}</span>
            <Switch
              checked={!!block.data[field.key]}
              ariaLabel={field.label}
              onchange={() => updateField(field.key, !block.data[field.key])}
            />
          </div>
        {/if}

        <!--
          ── GALLERY ────────────────────────────────────────────────────────

          Before this was the `json` field: a text box with `[]` inside where
          you had to type the images array by hand, with the media
          library one click away. Building a carousel
          meant going to the library, copying each URL and composing the JSON.

          Now they are chosen (or uploaded) from the same picker as the rest of the
          panel, so everything that comes in ALSO ends up in the library and can
          be reused in another block.
        -->
        {#if field.type === "gallery"}
          {@const images = imagesOf(field.key)}
          <!--
            `span` and not `label`: a gallery has no ONE control to point at
            —it has an alt and a caption per image, plus the order buttons—, so
            a `label` here associates nothing and only misleads the screen reader.
          -->
          <span class="block text-xs font-medium text-kitsuden-text-dim">
            {field.label}
            {#if field.required}<span class="text-kitsuden-accent-2">*</span>{/if}
          </span>

          {#if images.length === 0}
            <p class="text-xs text-kitsuden-subtle italic">{t("blockEditor.withoutImagesYet")}</p>
          {:else}
            <div class="space-y-2">
              {#each images as img, i (img.mediaId ?? img.url ?? i)}
                <div
                  class="flex gap-2 rounded-lg border border-kitsuden-border bg-kitsuden-bg/40 p-2"
                >
                  <img
                    src={img.url}
                    alt={img.alt || ""}
                    class="h-16 w-16 shrink-0 rounded-sm object-cover"
                  />
                  <div class="min-w-0 flex-1 space-y-1">
                    <Input
                      value={img.alt ?? ""}
                      oninput={(e: Event) => editImage(field.key, i, "alt", valueOf(e))}
                      placeholder={t("blockEditor.altTextAccessibilityAndSeo")}
                      aria-label={t("blockEditor.altTextAccessibilityAndSeo")}
                      class="text-xs"
                    />
                    <Input
                      value={img.caption ?? ""}
                      oninput={(e: Event) => editImage(field.key, i, "caption", valueOf(e))}
                      placeholder={t("blockEditor.optionalCaption")}
                      aria-label={t("blockEditor.optionalCaption")}
                      class="text-xs"
                    />
                  </div>
                  <div class="flex shrink-0 flex-col gap-1">
                    <!-- The order IS the content in a carousel. -->
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === 0}
                      onclick={() => moveImage(field.key, i, -1)}
                      title={t("blockEditor.upload")}
                      ariaLabel={t("blockEditor.upload")}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={i === images.length - 1}
                      onclick={() => moveImage(field.key, i, 1)}
                      title={t("blockEditor.lower")}
                      ariaLabel={t("blockEditor.lower")}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      onclick={() => removeImage(field.key, i)}
                      title={t("blockEditor.remove")}
                      ariaLabel={t("blockEditor.remove")}
                    >
                      <Trash2 class="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="mt-2 w-full"
            onclick={() => (galleryChoosing = field.key)}
          >
            <ImageIcon class="h-3.5 w-3.5" />
            {images.length === 0 ? t("blockEditor.chooseOrUploadImages") : t("blockEditor.addMore")}
          </Button>
        {/if}

        <!-- JSON -->
        {#if field.type === "json"}
          <Field label={field.label} required={field.required} error={jsonErrors[field.key]}>
            <Textarea
              value={jsonStringify(block.data[field.key])}
              oninput={(e: Event) => updateJsonField(field.key, valueOf(e))}
              rows={5}
              mono
              placeholder={field.helpText}
              class="text-xs"
            />
          </Field>
        {/if}

        <!-- Help text -->
        {#if field.helpText && field.type !== "json"}
          <p class="text-xs text-kitsuden-subtle">{field.helpText}</p>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Footer -->
  <div class="p-4 border-t border-kitsuden-border shrink-0 flex items-center justify-between">
    <Button onclick={onDelete} variant="danger-ghost" size="sm"
      ><Trash2 class="w-3.5 h-3.5" /> {t("blockEditor.remove")}</Button
    >
    <Button onclick={onClose} size="sm"
      ><Check class="w-3.5 h-3.5" /> {t("blockEditor.done")}</Button
    >
  </div>
</div>

<MediaPicker
  open={fieldChoosing !== null}
  title={t("blockEditor.chooseBlockImage")}
  onSelect={(media) => {
    if (fieldChoosing) updateField(fieldChoosing, media.url);
    fieldChoosing = null;
  }}
  onClose={() => (fieldChoosing = null)}
/>

<!--
  The SAME component in multiple mode. It uploads to the library the same way, so
  whatever is dragged here becomes available to any other block or post — which
  is what sets this apart from pasting loose URLs.
-->
<MediaPicker
  open={galleryChoosing !== null}
  multiple
  title={t("blockEditor.galleryImages")}
  selectedIds={galleryChoosing
    ? imagesOf(galleryChoosing)
        .map((img) => img.mediaId)
        .filter((id): id is string => !!id)
    : []}
  onSelect={(media) => {
    if (galleryChoosing) toggleInGallery(galleryChoosing, media);
  }}
  onClose={() => (galleryChoosing = null)}
/>
