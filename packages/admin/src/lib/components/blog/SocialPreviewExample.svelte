<script lang="ts" context="module">
  import { t } from "$lib/i18n";
  import { fade } from "svelte/transition";
</script>

<!--
  SocialPreviewExample.svelte

  Example of how to use the SocialPreview component in the blog editor.
  This is a complete example that includes:
  - Fetching SEO data from the API
  - Integration with the editor
  - Toggle button to show/hide the preview
-->
<script lang="ts">
  import { Eye, EyeOff, Loader2 } from "lucide-svelte";

  import SocialPreview from "./SocialPreview.svelte";

  // Post props
  interface Props {
    postId?: string;
    postSlug?: string;
    postTitle?: string;
    postExcerpt?: string;
    featuredImageUrl?: string;
    siteName?: string;
    siteUrl?: string;
  }

  const {
    postId = "",
    postSlug = "",
    postTitle = "Untitled",
    postExcerpt = "",
    featuredImageUrl = "",
    siteName = "Mi Blog",
    siteUrl = "https://ejemplo.com",
  }: Props = $props();

  // State
  let showPreview = $state(false);
  let isLoading = $state(false);
  let seoData = $state<any>(null);
  let error = $state("");

  // Load SEO data
  async function loadSEOPreview() {
    if (!postSlug) {
      // If there is no slug, use local data
      seoData = generateLocalSEOData();
      return;
    }

    isLoading = true;
    error = "";

    try {
      const response = await fetch(
        `/api/blog/seo/${postSlug}?` +
          new URLSearchParams({
            siteName,
            baseUrl: siteUrl,
            preview: "true",
          })
      );

      if (!response.ok) {
        throw new Error("Failed to load SEO data");
      }

      const data = await response.json();
      seoData = data.seo;
    } catch (err: any) {
      error = err.message;
      console.error("Error loading SEO preview:", err);
    } finally {
      isLoading = false;
    }
  }

  // Generate local SEO data if there is no slug
  function generateLocalSEOData() {
    return {
      title: `${postTitle} | ${siteName}`,
      metaDescription: postExcerpt?.substring(0, 160) || "",
      canonicalUrl: `${siteUrl}/blog/preview`,
      openGraph: {
        title: postTitle,
        description: postExcerpt?.substring(0, 200) || "",
        url: `${siteUrl}/blog/preview`,
        image: featuredImageUrl
          ? {
              url: featuredImageUrl,
              width: 1200,
              height: 630,
            }
          : undefined,
        siteName,
      },
      twitterCard: {
        card: "summary_large_image",
        title: postTitle,
        description: postExcerpt?.substring(0, 200) || "",
        image: featuredImageUrl,
      },
    };
  }

  // Toggle preview
  async function togglePreview() {
    if (!showPreview) {
      await loadSEOPreview();
    }
    showPreview = !showPreview;
  }

  // Refresh when important data changes
  $effect(() => {
    if (showPreview && postSlug) {
      // Debounce to avoid many calls
      const timeout = setTimeout(() => {
        loadSEOPreview();
      }, 500);
      return () => clearTimeout(timeout);
    }
  });
</script>

<div class="social-preview-wrapper">
  <!-- Toggle button -->
  <button class="preview-toggle-btn" onclick={togglePreview} disabled={isLoading}>
    {#if isLoading}
      <Loader2 size={18} class="animate-spin" />
      <span>{t("socialPreviewExample.loadingPreview")}</span>
    {:else if showPreview}
      <EyeOff size={18} />
      <span>{t("socialPreviewExample.hideSocialPreview")}</span>
    {:else}
      <Eye size={18} />
      <span>{t("socialPreviewExample.viewPreviewOnSocialNetworks")}</span>
    {/if}
  </button>

  <!-- Preview -->
  {#if showPreview}
    <div class="preview-container" transition:fade={{ duration: 200 }}>
      {#if error}
        <div class="preview-error">
          <p>{t("socialPreviewExample.errorLoadingPreview")} {error}</p>
          <button onclick={loadSEOPreview}>{t("socialPreviewExample.reintentar")}</button>
        </div>
      {:else}
        <SocialPreview {seoData} {postTitle} postUrl={`${siteUrl}/blog/${postSlug}`} {postSlug} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .social-preview-wrapper {
    margin: 20px 0;
  }

  .preview-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 12px 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .preview-toggle-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .preview-toggle-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .animate-spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .preview-container {
    margin-top: 16px;
  }

  .preview-error {
    padding: 20px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    color: #dc2626;
    text-align: center;
  }

  .preview-error button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }

  .preview-error button:hover {
    background: #b91c1c;
  }
</style>
