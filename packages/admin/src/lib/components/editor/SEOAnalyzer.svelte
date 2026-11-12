<script lang="ts">
  import { t } from "$lib/i18n";
  import { Badge, Button, Input, Label, Textarea } from "$lib/tallao";
  import { Gauge, ImagePlus, X, CheckCircle2, XCircle } from "lucide-svelte";

  export interface SEOData {
    title: string;
    slug: string;
    seoTitle: string;
    seoDescription: string;
    ogImageUrl: string;
  }

  interface Props {
    data: SEOData;
    onUpdate: (data: SEOData) => void;
  }

  const { data, onUpdate }: Props = $props();
  const uid = $props.id();

  let dragOver = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const checks = $derived([
    { label: t("sEOAnalyzer.titlePresent"), pass: !!data.title },
    { label: t("sEOAnalyzer.slugIsSet"), pass: !!data.slug },
    {
      label: t("sEOAnalyzer.seoTitle60Chars", { seoTitleCount: data.seoTitle.length }),
      pass: data.seoTitle.length > 0 && data.seoTitle.length <= 60,
    },
    {
      label: t("sEOAnalyzer.metaDesc160Chars", { seoDescriptionCount: data.seoDescription.length }),
      pass: data.seoDescription.length > 0 && data.seoDescription.length <= 160,
    },
    { label: t("sEOAnalyzer.ogImageUploaded"), pass: !!data.ogImageUrl },
  ]);

  const overallScore = $derived.by(() => {
    const passed = checks.filter((c) => c.pass).length;
    return Math.round((passed / checks.length) * 100);
  });

  function onDrop(e: DragEvent) {
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) previewFile(file);
  }

  function onFileSelect(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) previewFile(file);
  }

  function previewFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => onUpdate({ ...data, ogImageUrl: reader.result as string });
    reader.readAsDataURL(file);
  }
</script>

{#snippet charCounter(count: number, max: number)}
  {@const cls =
    count === 0
      ? "text-kitsuden-subtle"
      : count <= max
        ? "text-kitsuden-green"
        : "text-kitsuden-accent-2"}
  <span class="text-xs font-mono {cls}">{count}/{max}</span>
{/snippet}

<div class="space-y-5">
  <div class="flex items-center gap-2 mb-4">
    <Gauge class="w-4 h-4 text-kitsuden-accent" />
    <h3 class="text-sm font-semibold uppercase tracking-wider text-kitsuden-text-dim">
      {t("sEOAnalyzer.seoGuardian")}
    </h3>
    <Badge
      class="ml-auto"
      variant={overallScore >= 80 ? "success" : overallScore >= 50 ? "warning" : "error"}
    >
      {overallScore}%
    </Badge>
  </div>

  <!-- Slug -->
  <div>
    <Label for="{uid}-slug" class="mb-1.5 block">{t("sEOAnalyzer.urlSlug")}</Label>
    <div class="flex items-center gap-2 min-w-0">
      <span class="text-xs text-kitsuden-subtle font-mono shrink-0">{t("sEOAnalyzer.blog")}</span>
      <Input
        id="{uid}-slug"
        value={data.slug}
        oninput={(e: Event) =>
          onUpdate({ ...data, slug: (e.currentTarget as HTMLInputElement).value })}
        class="flex-1 min-w-0 font-mono"
        placeholder="post-slug"
      />
    </div>
  </div>

  <!-- SEO Title -->
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <Label for="{uid}-title">{t("sEOAnalyzer.seoTitle")}</Label>
      {@render charCounter(data.seoTitle.length, 60)}
    </div>
    <Input
      id="{uid}-title"
      value={data.seoTitle}
      oninput={(e: Event) =>
        onUpdate({ ...data, seoTitle: (e.currentTarget as HTMLInputElement).value })}
      placeholder={t("sEOAnalyzer.seoOptimizedTitle")}
    />
  </div>

  <!-- SEO Description -->
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <Label for="{uid}-description">{t("sEOAnalyzer.metaDescription")}</Label>
      {@render charCounter(data.seoDescription.length, 160)}
    </div>
    <Textarea
      id="{uid}-description"
      value={data.seoDescription}
      oninput={(e: Event) =>
        onUpdate({ ...data, seoDescription: (e.currentTarget as HTMLTextAreaElement).value })}
      rows={3}
      placeholder={t("sEOAnalyzer.compellingDescriptionForSearchResults")}
    />
  </div>

  <!-- OG Image -->
  <div>
    <p class="mb-1.5 text-sm font-medium text-kitsuden-text">
      {t("sEOAnalyzer.ogImageSocialPreview")}
    </p>
    <div
      ondragover={(e) => {
        e.preventDefault();
        dragOver = true;
      }}
      ondragleave={() => (dragOver = false)}
      ondrop={onDrop}
      class="border-2 border-dashed rounded-xl p-6 text-center transition-all cursor-pointer {dragOver
        ? 'border-kitsuden-accent bg-kitsuden-accent/5'
        : 'border-kitsuden-border hover:border-kitsuden-subtle'}"
      onclick={() => fileInput?.click()}
    >
      {#if data.ogImageUrl}
        <div class="relative">
          <img
            src={data.ogImageUrl}
            class="w-full rounded-lg border border-kitsuden-border"
            alt={t("sEOAnalyzer.ogImage")}
          />
          <Button
            variant="secondary"
            size="icon"
            class="absolute top-2 right-2"
            ariaLabel={t("common.remove")}
            title={t("common.remove")}
            onclick={(e: MouseEvent) => {
              e.stopPropagation();
              onUpdate({ ...data, ogImageUrl: "" });
            }}
          >
            <X class="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
      {:else}
        <div class="flex flex-col items-center gap-2 text-kitsuden-subtle">
          <ImagePlus class="w-8 h-8" />
          <p class="text-xs">{t("sEOAnalyzer.dropImageOrClickTo")}</p>
          <p class="text-xs">{t("sEOAnalyzer.recommended1200630px")}</p>
        </div>
      {/if}
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      class="hidden"
      onchange={onFileSelect}
    />
  </div>

  <!-- Google Preview -->
  <div>
    <p class="mb-2 text-sm font-medium text-kitsuden-text">{t("sEOAnalyzer.searchPreview")}</p>
    <div class="rounded-lg bg-white p-4 space-y-1">
      <p class="text-sm text-[#1a0dab] truncate font-medium">
        {data.seoTitle || data.title || t("common.pageTitle")}
      </p>
      <p class="text-xs text-[#006621] font-mono truncate">
        {t("sEOAnalyzer.yoursiteComBlog")}{data.slug || "post-slug"}
      </p>
      <p class="text-xs text-[#545454] line-clamp-2 leading-relaxed">
        {data.seoDescription || t("sEOAnalyzer.addAMetaDescriptionTo")}
      </p>
    </div>
  </div>

  <!-- Checks -->
  <div class="space-y-2">
    <p class="mb-2 text-sm font-medium text-kitsuden-text">{t("sEOAnalyzer.seoChecklist")}</p>
    {#each checks as check}
      <div class="flex items-center gap-2 text-xs">
        {#if check.pass}
          <CheckCircle2 class="w-3.5 h-3.5 text-kitsuden-green shrink-0" />
        {:else}
          <XCircle class="w-3.5 h-3.5 text-kitsuden-accent-2 shrink-0" />
        {/if}
        <span class={check.pass ? "text-kitsuden-text-dim" : "text-kitsuden-accent-2"}
          >{check.label}</span
        >
      </div>
    {/each}
  </div>
</div>
