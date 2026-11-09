<script lang="ts">
  import { t, localeFormat } from "$lib/i18n";
  import { Monitor, Tablet, Smartphone } from "lucide-svelte";
  import { renderBlocks } from "@kitsuden/shared";

  interface Props {
    title?: string;
    content?: string;
    excerpt?: string;
    featuredImageUrl?: string;
    slug?: string;
    authorName?: string;
    publishedAt?: string;
    status?: string;
    /**
     * Post blocks, if any.
     *
     * ── WHY THEY ARE RENDERED AS A SCHEMA AND NOT AS A RESULT ───────────────
     *
     * This preview only knew `content`, so a post with blocks looked EXACTLY THE SAME as one without them: a gallery was
     * added, the preview was checked and there was no trace of it. That is not read as «the
     * preview does not support them», it is read as «it was not saved».
     *
     * But neither are they truly rendered, and that is on purpose: this repo has NO
     * block renderer outside the builder itself —`PageBlock` was
     * searched for across the whole tree and appears only in the admin—, so
     * any HTML invented here would be a preview of something
     * nobody produces. A preview that lies is worse than an
     * incomplete one: layout decisions get made on a false result.
     *
     * It shows WHICH blocks there are and in what order, marked as a schema.
     */
    blocks?: Array<{ id: string; type: string; data?: Record<string, unknown>; order?: number }>;
  }

  const {
    title = "",
    content = "",
    excerpt = "",
    featuredImageUrl = "",
    slug = "",
    authorName = "",
    publishedAt = "",
    status = "",
    blocks = [],
  }: Props = $props();

  /**
   * The blocks, rendered with THE SAME renderer the API uses.
   *
   * Before, this was a schema —a list of the types present— because no
   * renderer existed anywhere. Now it exists and lives in
   * `@kitsuden/shared`, so the preview shows what will be
   * published instead of an approximation.
   *
   * That it is LITERALLY the same function is the point: two different
   * renderers turn the preview into a preview of something else.
   *
   * `blocksInteractivos` are those that need the site's JavaScript —maps,
   * grids over datasets, filters—. Here they are marked as such instead of
   * pretending to be shown: they are slots to hydrate, and saying so avoids laying out
   * on a result that is not the final one.
   */
  const blocksRender = $derived(renderBlocks(blocks as never));

  type Viewport = "desktop" | "tablet" | "mobile";
  let viewport = $state<Viewport>("desktop");

  const viewportWidths = {
    desktop: "100%",
    tablet: "768px",
    mobile: "375px",
  };

  const htmlContent = $derived.by(() => {
    const dateText = publishedAt ? new Date(publishedAt).toLocaleDateString(localeFormat()) : "";
    const metaParts = [
      authorName ? `By ${authorName}` : "",
      dateText,
      status ? status.charAt(0).toUpperCase() + status.slice(1) : "",
    ].filter(Boolean);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: #1f2937;
    background: #ffffff;
    padding: 2rem 1rem;
  }
  .container { max-width: 720px; margin: 0 auto; }
  .featured-image {
    width: 100%;
    height: 300px;
    object-fit: cover;
    border-radius: 12px;
    margin-bottom: 1.5rem;
  }
  h1 {
    font-size: 2rem;
    font-weight: 800;
    line-height: 1.2;
    margin-bottom: 0.75rem;
    color: #111827;
  }
  .meta {
    font-size: 0.875rem;
    color: #6b7280;
    margin-bottom: 1.5rem;
  }
  .excerpt {
    font-size: 1.125rem;
    color: #4b5563;
    font-style: italic;
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid #e5e7eb;
  }
  .content {
    font-size: 1.125rem;
    color: #374151;
    white-space: pre-wrap;
  }
  .content p { margin-bottom: 1rem; }
  .blocks-render { margin-top: 2rem; display: flex; flex-direction: column; gap: 1.5rem; }
  .blocks-note {
    margin: 1rem 0 0;
    font-size: .75rem;
    color: #6b6b7b;
    border-left: 3px solid #b9b9c6;
    padding-left: .6rem;
  }

  /* The rendered blocks. Minimal and neutral: the site will bring its own stylesheet,
     and nailing down a different layout here would make the preview
     show something that is not the real thing again. */
  .ks-hero {
    padding: 2.5rem 1.5rem;
    border-radius: 10px;
    background-size: cover;
    background-position: center;
    color: #fff;
    background-color: #2a2a35;
  }
  .ks-hero h2 { margin: 0 0 .4rem; font-size: 1.6rem; }
  .ks-hero p { margin: 0; opacity: .9; }
  .ks-hero--dark { box-shadow: inset 0 0 0 9999px rgba(0,0,0,.45); }
  .ks-hero--gradient { box-shadow: inset 0 -120px 120px -60px rgba(0,0,0,.75); }
  .ks-hero-ctas { margin-top: 1rem; display: flex; gap: .5rem; }
  .ks-cta {
    display: inline-block;
    padding: .5rem .9rem;
    border-radius: 6px;
    background: #fff;
    color: #111;
    text-decoration: none;
    font-weight: 600;
    font-size: .9rem;
  }
  .ks-cta--sec { background: transparent; color: #fff; box-shadow: inset 0 0 0 1px #fff; }

  .ks-gallery { display: grid; grid-template-columns: repeat(var(--ks-cols, 3), 1fr); gap: .6rem; }
  .ks-gallery figure { margin: 0; }
  .ks-gallery img { width: 100%; height: auto; border-radius: 6px; display: block; }
  .ks-gallery figcaption { font-size: .75rem; color: #6b6b7b; margin-top: .3rem; }

  .ks-callout { padding: .9rem 1rem; border-radius: 8px; border-left: 4px solid #8a8a9c; background: #f4f4f8; }
  .ks-callout p { margin: 0; }
  .ks-callout-titulo { font-weight: 700; margin-bottom: .25rem !important; }
  .ks-callout--warning { border-left-color: #d9900a; background: #fdf6e8; }
  .ks-callout--danger { border-left-color: #c8342f; background: #fdeceb; }
  .ks-callout--success { border-left-color: #2e9b57; background: #eaf7ef; }
  .ks-callout--tip { border-left-color: #6b5bd2; background: #f0eefb; }

  .ks-divider { border: 0; border-top: 1px solid #d6d6de; }
  .ks-divider--dots { border-top-style: dotted; border-top-width: 3px; }
  .ks-divider--gradient {
    height: 2px;
    border: 0;
    background: linear-gradient(90deg, transparent, #8a8a9c, transparent);
  }
  .ks-espacio { height: 2rem; }

  .ks-embed figcaption { font-size: .75rem; color: #6b6b7b; margin-top: .3rem; }

  /* Slot to hydrate: marked so it is not mistaken for the result. */
  .ks-block { border: 1px dashed #b9b9c6; border-radius: 8px; padding: 1rem; background: #f6f6f9; }
  .ks-block--comparison-slider { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
  .ks-block--comparison-slider img { width: 100%; height: auto; border-radius: 6px; display: block; }
  .ks-block figure { margin: 0; }
  .ks-block figcaption { font-size: .75rem; color: #6b6b7b; margin-top: .3rem; }
  .ks-reserva { margin: 0; font-size: .8rem; color: #4a4a58; }
  .ks-vacio { color: #6b6b7b; font-size: .8rem; }
</style>
</head>
<body>
  <div class="container">${featuredImageUrl ? `<img src="${featuredImageUrl}" class="featured-image" alt="" />` : ""}
    <h1>${title || t("livePreview.untitledPost")}</h1>
    ${metaParts.length ? `<div class="meta">${metaParts.join(" &bull; ")}</div>` : ""}
    ${excerpt ? `<div class="excerpt">${excerpt}</div>` : ""}
    <div class="content">${(content || "").replace(/\n/g, "<br/>")}</div>
    ${blocksRender.html ? `<div class="blocks-render">${blocksRender.html}</div>` : ""}
    ${
      blocksRender.interactive.length === 0
        ? ""
        : `<p class="blocks-note">${blocksRender.interactive.length} block${
            blocksRender.interactive.length === 1 ? "" : "s"
          } is hydrated${
            blocksRender.interactive.length === 1 ? "" : "n"
          } on the site (${blocksRender.interactive.join(", ")}): here you see the placeholder, not the result.</p>`
    }
  </div>
</body>
</html>
    `.trim();
  });
</script>

<div class="flex flex-col h-full bg-kitsuden-bg">
  <!-- Toolbar -->
  <div
    class="flex items-center justify-between px-4 py-2 border-b border-kitsuden-border bg-kitsuden-card/50 shrink-0"
  >
    <!--
      ── WHY «CONTENT PREVIEW» AND NOT «LIVE PREVIEW» ─────────────────────────

      Because this is NOT the published page, and calling it that promises too much, in the
      same way «All Posts» promised all the posts when it only brought the
      published ones.

      What it is: the HTML the API returns, exactly. The same function, with no
      options on either side, checked byte for byte against the real
      installation (512 identical characters).

      What it is not:
        · it does not carry the site's styles — it paints neutral ones from this file;
        · six of the thirteen blocks come out as a placeholder, because they need
          the site's JavaScript to hydrate;
        · and there is no site: the repo only contains `apps/api`.

      Faithful in substance, approximate in form. The day a frontend exists
      consuming the API with its styles, this becomes a preview of the
      page — and then, and not before, the label can promise it again.
    -->
    <span class="text-xs font-medium text-kitsuden-subtle uppercase tracking-wider"
      >{t("common.contentPreview")}</span
    >
    <div class="flex items-center gap-1">
      <button
        class="p-1.5 rounded-md transition-colors {viewport === 'desktop'
          ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
          : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-border/30'}"
        onclick={() => (viewport = "desktop")}
        aria-label={t("livePreview.desktopView")}
      >
        <Monitor class="w-4 h-4" />
      </button>
      <button
        class="p-1.5 rounded-md transition-colors {viewport === 'tablet'
          ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
          : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-border/30'}"
        onclick={() => (viewport = "tablet")}
        aria-label={t("livePreview.tabletView")}
      >
        <Tablet class="w-4 h-4" />
      </button>
      <button
        class="p-1.5 rounded-md transition-colors {viewport === 'mobile'
          ? 'bg-kitsuden-accent/10 text-kitsuden-accent'
          : 'text-kitsuden-subtle hover:text-kitsuden-text hover:bg-kitsuden-border/30'}"
        onclick={() => (viewport = "mobile")}
        aria-label={t("livePreview.mobileView")}
      >
        <Smartphone class="w-4 h-4" />
      </button>
    </div>
  </div>

  <!-- Preview Canvas -->
  <div class="flex-1 overflow-auto p-4 flex justify-center bg-kitsuden-bg/50">
    <div
      class="h-full bg-white rounded-lg shadow-lg overflow-hidden transition-all duration-300 border border-kitsuden-border"
      style="width: {viewportWidths[viewport]};"
    >
      <iframe
        title={t("livePreview.postPreview")}
        srcdoc={htmlContent}
        class="w-full h-full border-0"
        sandbox="allow-scripts"
      ></iframe>
    </div>
  </div>
</div>
