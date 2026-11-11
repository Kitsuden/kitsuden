<!--
  SocialPreview.svelte

  Component to preview how a post will look on social networks.
  Supports: WhatsApp, Telegram, Facebook, Twitter/X, LinkedIn

  Features:
  - Real-time preview of multiple platforms
  - WhatsApp-specific validation (<300KB, dimensions, format)
  - A/B comparison mode to test different versions
  - Export preview as a PNG image

  Usage:
  <SocialPreview
    seoData={seoData}
    postTitle={post.title}
    postUrl="https://example.com/blog/my-post"
  />

  Usage with A/B comparison:
  <SocialPreview
    variantA={seoDataVersionA}
    variantB={seoDataVersionB}
    comparisonMode={true}
  />
-->
<script lang="ts">
  import { toast } from "$lib/tallao";
  import { t, localeFormat } from "$lib/i18n";
  import {
    MessageCircle,
    Facebook,
    Twitter,
    Linkedin,
    Send,
    AlertCircle,
    CheckCircle,
    Image as ImageIcon,
    RefreshCw,
    ExternalLink,
    Camera,
  } from "lucide-svelte";

  // Types
  interface SEOData {
    title?: string;
    metaDescription?: string;
    canonicalUrl?: string;
    openGraph?: {
      title?: string;
      description?: string;
      url?: string;
      image?: {
        url?: string;
        alt?: string;
        width?: number;
        height?: number;
        isWhatsAppCompatible?: boolean;
      };
      siteName?: string;
    };
    twitterCard?: {
      card?: string;
      title?: string;
      description?: string;
      image?: string;
    };
    whatsAppValidation?: {
      isValid: boolean;
      checks: {
        format: boolean;
        fileSize: boolean;
        dimensions: boolean;
        isAbsoluteUrl: boolean;
      };
      warnings: string[];
      recommendations: string[];
    } | null;
  }

  // Props
  interface Props {
    /** SEO data from the /api/blog/seo/:slug endpoint */
    seoData?: SEOData | null;
    /** Post title (fallback) */
    postTitle?: string;
    /** Post URL (for display) */
    postUrl?: string;
    /** Post slug to refresh */
    postSlug?: string;

    // A/B comparison mode
    /** Enable A/B comparison mode */
    comparisonMode?: boolean;
    /** Variant A data */
    variantA?: SEOData | null;
    /** Variant B data */
    variantB?: SEOData | null;
    /** Variant A name */
    labelA?: string;
    /** Variant B name */
    labelB?: string;
  }

  let {
    seoData = null,
    postTitle = t("socialPreview.withoutTitle"),
    postUrl = "https://ejemplo.com/blog/post",
    postSlug = "",
    comparisonMode = false,
    variantA = null,
    variantB = null,
    labelA = t("socialPreview.versionA"),
    labelB = t("socialPreview.versionB"),
  }: Props = $props();

  // State
  type TabType = "whatsapp" | "telegram" | "facebook" | "twitter" | "linkedin";
  let activeTab = $state<TabType>("whatsapp");
  let isRefreshing = $state(false);
  let showDebug = $state(false);
  let copied = $state(false);
  let isExporting = $state(false);
  const comparisonView = $state<"split" | "overlay">("split");
  let activeVariant = $state<"A" | "B">("A");

  // Refs for export
  let previewContainer: HTMLDivElement;

  // Derived values - handle normal vs comparison mode
  const currentData = $derived(
    comparisonMode ? (activeVariant === "A" ? variantA : variantB) : seoData
  );

  const ogTitle = $derived(currentData?.openGraph?.title || postTitle);
  const ogDescription = $derived(
    currentData?.openGraph?.description || currentData?.metaDescription || ""
  );
  const ogImage = $derived(currentData?.openGraph?.image?.url || "");
  const ogSiteName = $derived(currentData?.openGraph?.siteName || t("socialPreview.mySite"));
  const canonicalUrl = $derived(currentData?.canonicalUrl || postUrl);
  const domain = $derived.by(() => {
    try {
      return new URL(canonicalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "ejemplo.com";
    }
  });

  // WhatsApp validation status
  const whatsAppStatus = $derived(currentData?.whatsAppValidation);
  const hasWhatsAppIssues = $derived(whatsAppStatus && !whatsAppStatus.isValid);

  // Count issues per variant
  const issuesA = $derived(variantA?.whatsAppValidation?.warnings?.length || 0);
  const issuesB = $derived(variantB?.whatsAppValidation?.warnings?.length || 0);

  // Format URL for display (truncate if too long)
  function formatUrl(url: string, maxLength: number = 40): string {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + "...";
  }

  // Copy URL to clipboard
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(canonicalUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

  // Refresh SEO data
  async function refreshPreview() {
    if (!postSlug) return;

    isRefreshing = true;
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL ?? ""}/api/blog/seo/${postSlug}?preview=true&t=${Date.now()}`
      );
      if (response.ok) {
        const data = await response.json();
        seoData = data.seo;
      }
    } catch (err) {
      console.error("Failed to refresh preview:", err);
    } finally {
      isRefreshing = false;
    }
  }

  // Export as image
  async function exportAsImage() {
    isExporting = true;
    try {
      // Use html2canvas if available
      const html2canvas = (await import("html2canvas" as any)).default;

      if (previewContainer) {
        const canvas = await html2canvas(previewContainer, {
          backgroundColor: "#f3f4f6",
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
        });

        // Download
        const link = document.createElement("a");
        const timestamp = new Date().toISOString().split("T")[0];
        const platform = activeTab;
        const variant = comparisonMode ? `-${activeVariant}` : "";
        link.download = `social-preview-${platform}${variant}-${timestamp}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      }
    } catch (err) {
      console.error("Failed to export image:", err);
      toast.error(t("socialPreview.errorExportingMakeSure"));
    } finally {
      isExporting = false;
    }
  }

  // Open external tools
  function openFacebookDebugger() {
    window.open(
      `https://developers.facebook.com/tools/debug/?q=${encodeURIComponent(canonicalUrl)}`,
      "_blank"
    );
  }

  function openTwitterValidator() {
    window.open(
      `https://cards-dev.twitter.com/validator?url=${encodeURIComponent(canonicalUrl)}`,
      "_blank"
    );
  }

  function openLinkedInInspector() {
    window.open(
      `https://www.linkedin.com/post-inspector/inspect/${encodeURIComponent(canonicalUrl)}`,
      "_blank"
    );
  }
</script>

<div class="social-preview-container" bind:this={previewContainer}>
  <!-- Header -->
  <div class="preview-header">
    <div class="preview-title">
      <ImageIcon size={20} />
      <span>
        {#if comparisonMode}
          {t("socialPreview.socialPreviewABComparison")}
        {:else}
          {t("socialPreview.socialMediaPreview")}
        {/if}
      </span>
    </div>

    <div class="preview-actions">
      <!-- A/B comparison button -->
      {#if comparisonMode}
        <div class="variant-toggle">
          <button
            class="variant-btn"
            class:active={activeVariant === "A"}
            onclick={() => (activeVariant = "A")}
          >
            {labelA}
            {#if issuesA > 0}
              <span class="variant-badge warning">{issuesA}</span>
            {:else}
              <span class="variant-badge success">✓</span>
            {/if}
          </button>
          <button
            class="variant-btn"
            class:active={activeVariant === "B"}
            onclick={() => (activeVariant = "B")}
          >
            {labelB}
            {#if issuesB > 0}
              <span class="variant-badge warning">{issuesB}</span>
            {:else}
              <span class="variant-badge success">✓</span>
            {/if}
          </button>
        </div>
      {/if}

      <!-- Export image -->
      <button
        class="action-btn"
        onclick={exportAsImage}
        disabled={isExporting}
        title={t("socialPreview.exportAsImage")}
      >
        {#if isExporting}
          <RefreshCw size={16} class="spin" />
        {:else}
          <Camera size={16} />
        {/if}
      </button>

      {#if postSlug}
        <button
          class="action-btn"
          onclick={refreshPreview}
          disabled={isRefreshing}
          title={t("socialPreview.refreshPreview")}
        >
          <RefreshCw size={16} class={isRefreshing ? "spin" : ""} />
        </button>
      {/if}

      <button
        class="action-btn"
        onclick={() => (showDebug = !showDebug)}
        class:active={showDebug}
        title={t("socialPreview.viewDiagnostic")}
      >
        <AlertCircle size={16} />
      </button>

      <button class="action-btn copy-btn" onclick={copyUrl} title={t("socialPreview.copyUrl")}>
        {copied ? "✓" : t("socialPreview.copy")}
      </button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="preview-tabs">
    <button
      class="tab"
      class:active={activeTab === "whatsapp"}
      onclick={() => (activeTab = "whatsapp")}
    >
      <MessageCircle size={16} />
      <span>{t("socialPreview.whatsapp")}</span>
      {#if hasWhatsAppIssues}
        <span class="tab-warning">!</span>
      {/if}
    </button>

    <button
      class="tab"
      class:active={activeTab === "telegram"}
      onclick={() => (activeTab = "telegram")}
    >
      <Send size={16} />
      <span>{t("socialPreview.telegram")}</span>
    </button>

    <button
      class="tab"
      class:active={activeTab === "facebook"}
      onclick={() => (activeTab = "facebook")}
    >
      <Facebook size={16} />
      <span>{t("socialPreview.facebook")}</span>
    </button>

    <button
      class="tab"
      class:active={activeTab === "twitter"}
      onclick={() => (activeTab = "twitter")}
    >
      <Twitter size={16} />
      <span>{t("socialPreview.xTwitter")}</span>
    </button>

    <button
      class="tab"
      class:active={activeTab === "linkedin"}
      onclick={() => (activeTab = "linkedin")}
    >
      <Linkedin size={16} />
      <span>{t("socialPreview.linkedin")}</span>
    </button>
  </div>

  <!-- Content -->
  <div class="preview-content">
    <!-- WhatsApp Preview -->
    {#if activeTab === "whatsapp"}
      <div class="whatsapp-preview">
        <div class="whatsapp-chat">
          <div class="whatsapp-header">
            <div class="whatsapp-avatar">
              <MessageCircle size={20} />
            </div>
            <div class="whatsapp-contact">
              <div class="whatsapp-name">{t("socialPreview.tu")}</div>
              <div class="whatsapp-status">{t("socialPreview.online")}</div>
            </div>
          </div>

          <div class="whatsapp-messages">
            <div class="whatsapp-bubble whatsapp-green">
              <div class="whatsapp-link-preview">
                {#if ogImage}
                  <div class="whatsapp-image-container">
                    <img
                      src={ogImage}
                      alt={currentData?.openGraph?.image?.alt || ""}
                      class="whatsapp-image"
                      crossorigin="anonymous"
                      onerror={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                {:else}
                  <div class="whatsapp-no-image">
                    <ImageIcon size={32} />
                    <span>{t("socialPreview.withoutImage")}</span>
                  </div>
                {/if}

                <div class="whatsapp-text-content">
                  <div class="whatsapp-site">{ogSiteName}</div>
                  <div class="whatsapp-title">{ogTitle}</div>
                  <div class="whatsapp-desc">{ogDescription}</div>
                  <div class="whatsapp-domain">{domain}</div>
                </div>
              </div>

              <div class="whatsapp-time">
                {new Date().toLocaleTimeString(localeFormat(), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                <span class="whatsapp-checks">✓✓</span>
              </div>
            </div>
          </div>
        </div>

        {#if whatsAppStatus}
          <div class="validation-panel" class:valid={whatsAppStatus.isValid}>
            <div class="validation-header">
              {#if whatsAppStatus.isValid}
                <CheckCircle size={18} class="icon-success" />
                <span>{t("socialPreview.whatsappCompatible")}</span>
              {:else}
                <AlertCircle size={18} class="icon-warning" />
                <span>{t("socialPreview.detectedProblems")}</span>
              {/if}
            </div>

            <div class="validation-checks">
              <div class="check-item" class:pass={whatsAppStatus.checks.format}>
                <span class="check-icon">{whatsAppStatus.checks.format ? "✓" : "✗"}</span>
                <span>{t("socialPreview.formatJpgPng")}</span>
              </div>
              <div class="check-item" class:pass={whatsAppStatus.checks.fileSize}>
                <span class="check-icon">{whatsAppStatus.checks.fileSize ? "✓" : "✗"}</span>
                <span>{t("socialPreview.tamano300kb")}</span>
              </div>
              <div class="check-item" class:pass={whatsAppStatus.checks.dimensions}>
                <span class="check-icon">{whatsAppStatus.checks.dimensions ? "✓" : "✗"}</span>
                <span>{t("socialPreview.dimensions")}</span>
              </div>
              <div class="check-item" class:pass={whatsAppStatus.checks.isAbsoluteUrl}>
                <span class="check-icon">{whatsAppStatus.checks.isAbsoluteUrl ? "✓" : "✗"}</span>
                <span>{t("socialPreview.absoluteUrl")}</span>
              </div>
            </div>

            {#if whatsAppStatus.warnings.length > 0}
              <div class="validation-warnings">
                {#each whatsAppStatus.warnings as warning}
                  <div class="warning-item">⚠️ {warning}</div>
                {/each}
              </div>
            {/if}

            {#if whatsAppStatus.recommendations.length > 0}
              <div class="validation-recommendations">
                <strong>{t("socialPreview.recommendations")}</strong>
                <ul>
                  {#each whatsAppStatus.recommendations as rec}
                    <li>{rec}</li>
                  {/each}
                </ul>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Telegram Preview -->
    {#if activeTab === "telegram"}
      <div class="telegram-preview">
        <div class="telegram-chat">
          <div class="telegram-header">
            <div class="telegram-back">←</div>
            <div class="telegram-info">
              <div class="telegram-name">{t("socialPreview.saved")}</div>
              <div class="telegram-status">{t("socialPreview.online")}</div>
            </div>
            <div class="telegram-menu">⋮</div>
          </div>

          <div class="telegram-messages">
            <div class="telegram-bubble">
              <div class="telegram-link-card">
                {#if ogImage}
                  <div class="telegram-image-container">
                    <img
                      src={ogImage}
                      alt=""
                      class="telegram-image"
                      crossorigin="anonymous"
                      onerror={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>
                {/if}

                <div class="telegram-content">
                  <div class="telegram-title">{ogTitle}</div>
                  <div class="telegram-desc">{ogDescription}</div>
                  <div class="telegram-url">{domain}</div>
                </div>
              </div>

              <div class="telegram-time">
                {new Date().toLocaleTimeString(localeFormat(), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                <span class="telegram-checks">✓✓</span>
              </div>
            </div>
          </div>
        </div>

        <div class="telegram-info-panel">
          <h4>{t("socialPreview.aboutTelegram")}</h4>
          <p>
            {t("socialPreview.telegramUses")} <strong>{t("socialPreview.openGraph")}</strong>
            {t("socialPreview.likeWhatsappButIsMore")}
          </p>
          <ul>
            <li>{t("socialPreview.acceptsWebpWithoutProblems")}</li>
            <li>{t("socialPreview.hasNoStrictLimitOf")}</li>
            <li>{t("socialPreview.moreFlexibleDimensions")}</li>
            <li>{t("socialPreview.supportsHighResolutionImages")}</li>
          </ul>
          <p class="telegram-note">
            {t("socialPreview.howeverFollowingIsRecommended")}
          </p>
        </div>
      </div>
    {/if}

    <!-- Facebook Preview -->
    {#if activeTab === "facebook"}
      <div class="facebook-preview">
        <div class="facebook-card">
          {#if ogImage}
            <div class="facebook-image-container">
              <img
                src={ogImage}
                alt={currentData?.openGraph?.image?.alt || ""}
                class="facebook-image"
                crossorigin="anonymous"
                onerror={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          {:else}
            <div class="facebook-no-image">
              <ImageIcon size={48} />
            </div>
          {/if}

          <div class="facebook-content">
            <div class="facebook-domain">{domain.toUpperCase()}</div>
            <div class="facebook-title">{ogTitle}</div>
            <div class="facebook-desc">{ogDescription}</div>
          </div>
        </div>

        <div class="external-tools">
          <button class="tool-link" onclick={openFacebookDebugger}>
            <ExternalLink size={14} />
            {t("socialPreview.openFacebookDebugger")}
          </button>
        </div>
      </div>
    {/if}

    <!-- Twitter/X Preview -->
    {#if activeTab === "twitter"}
      <div class="twitter-preview">
        <div class="twitter-card">
          <div class="twitter-header">
            <div class="twitter-avatar">
              <Twitter size={20} />
            </div>
            <div class="twitter-user">
              <div class="twitter-name">{t("socialPreview.yourAccount")}</div>
              <div class="twitter-handle">{t("socialPreview.user")}</div>
            </div>
          </div>

          <div class="twitter-text">{t("socialPreview.lookAtThisInterestingArticle")}</div>

          <div class="twitter-link-card">
            {#if currentData?.twitterCard?.image || ogImage}
              <div class="twitter-image-container">
                <img
                  src={currentData?.twitterCard?.image || ogImage}
                  alt=""
                  class="twitter-image"
                  crossorigin="anonymous"
                  onerror={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            {/if}

            <div class="twitter-link-content">
              <div class="twitter-link-title">
                {currentData?.twitterCard?.title || ogTitle}
              </div>
              <div class="twitter-link-desc">
                {currentData?.twitterCard?.description || ogDescription}
              </div>
              <div class="twitter-link-domain">
                <span class="twitter-link-icon">🔗</span>
                {domain}
              </div>
            </div>
          </div>

          <div class="twitter-actions">
            <span class="twitter-action">💬 0</span>
            <span class="twitter-action">🔄 0</span>
            <span class="twitter-action">❤️ 0</span>
            <span class="twitter-action">📤</span>
          </div>
        </div>

        <div class="external-tools">
          <button class="tool-link" onclick={openTwitterValidator}>
            <ExternalLink size={14} />
            {t("socialPreview.openTwitterCardValidator")}
          </button>
        </div>
      </div>
    {/if}

    <!-- LinkedIn Preview -->
    {#if activeTab === "linkedin"}
      <div class="linkedin-preview">
        <div class="linkedin-card">
          {#if ogImage}
            <div class="linkedin-image-container">
              <img
                src={ogImage}
                alt=""
                class="linkedin-image"
                crossorigin="anonymous"
                onerror={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          {/if}

          <div class="linkedin-content">
            <div class="linkedin-title">{ogTitle}</div>
            <div class="linkedin-desc">{ogDescription}</div>
            <div class="linkedin-meta">
              <span class="linkedin-domain">{domain}</span>
              <span class="linkedin-separator">•</span>
              <span class="linkedin-readtime">{t("socialPreview.n3MinRead")}</span>
            </div>
          </div>
        </div>

        <div class="external-tools">
          <button class="tool-link" onclick={openLinkedInInspector}>
            <ExternalLink size={14} />
            {t("socialPreview.openLinkedinPostInspector")}
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Debug Panel -->
  {#if showDebug && currentData}
    <div class="debug-panel">
      <div class="debug-title">
        {t("socialPreview.technicalDiagnosis")}
        {#if comparisonMode}
          <span class="debug-variant">({activeVariant === "A" ? labelA : labelB})</span>
        {/if}
      </div>

      <div class="debug-grid">
        <div class="debug-section">
          <div class="debug-label">{t("socialPreview.seoTitle")}</div>
          <div class="debug-value" class:ok={(currentData.title?.length || 0) <= 60}>
            {t("socialPreview.n60Characters", { v: currentData.title?.length || 0 })}
          </div>
        </div>

        <div class="debug-section">
          <div class="debug-label">{t("socialPreview.description")}</div>
          <div class="debug-value" class:ok={(currentData.metaDescription?.length || 0) <= 160}>
            {t("socialPreview.n160Characters", { v: currentData.metaDescription?.length || 0 })}
          </div>
        </div>

        <div class="debug-section">
          <div class="debug-label">{t("socialPreview.ogTitle")}</div>
          <div class="debug-value" class:ok={(currentData.openGraph?.title?.length || 0) <= 88}>
            {t("socialPreview.n88Characters", { v: currentData.openGraph?.title?.length || 0 })}
          </div>
        </div>

        <div class="debug-section">
          <div class="debug-label">{t("socialPreview.ogDesc")}</div>
          <div
            class="debug-value"
            class:ok={(currentData.openGraph?.description?.length || 0) <= 200}
          >
            {t("socialPreview.n200Characters", {
              v: currentData.openGraph?.description?.length || 0,
            })}
          </div>
        </div>

        <div class="debug-section">
          <div class="debug-label">{t("socialPreview.ogImage")}</div>
          <div class="debug-value" class:ok={!!ogImage}>
            {ogImage ? t("socialPreview.present") : t("socialPreview.absent")}
          </div>
        </div>

        {#if currentData.openGraph?.image}
          <div class="debug-section">
            <div class="debug-label">{t("socialPreview.dimensiones2")}</div>
            <div class="debug-value" class:ok={currentData.openGraph.image.width === 1200}>
              {currentData.openGraph.image.width || "?"} x {currentData.openGraph.image.height ||
                "?"}
              {t("socialPreview.px")}
            </div>
          </div>
        {/if}

        <div class="debug-section">
          <div class="debug-label">{t("common.url")}</div>
          <div class="debug-value truncate" title={canonicalUrl}>
            {formatUrl(canonicalUrl, 50)}
          </div>
        </div>

        {#if currentData.whatsAppValidation}
          <div class="debug-section">
            <div class="debug-label">{t("socialPreview.whatsapp2")}</div>
            <div class="debug-value" class:ok={currentData.whatsAppValidation.isValid}>
              {currentData.whatsAppValidation.isValid
                ? t("socialPreview.compatible")
                : t("socialPreview.withProblems")}
            </div>
          </div>
        {/if}
      </div>

      {#if comparisonMode && variantA && variantB}
        <div class="comparison-summary">
          <div class="comparison-title">{t("socialPreview.comparisonSummary")}</div>
          <div class="comparison-stats">
            <div class="stat-item">
              <span class="stat-label">{labelA}:</span>
              <span class="stat-value" class:warning={issuesA > 0} class:success={issuesA === 0}>
                {t("socialPreview.issues", { issuesA })}
              </span>
            </div>
            <div class="stat-item">
              <span class="stat-label">{labelB}:</span>
              <span class="stat-value" class:warning={issuesB > 0} class:success={issuesB === 0}>
                {t("socialPreview.issues2", { issuesB })}
              </span>
            </div>
            <div class="stat-item winner">
              <span class="stat-label">{t("socialPreview.winner")}</span>
              <span class="stat-value">
                {#if issuesA < issuesB}
                  {labelA}
                {:else if issuesB < issuesA}
                  {labelB}
                {:else}
                  {t("socialPreview.tie")}
                {/if}
              </span>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .social-preview-container {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Header */
  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    flex-wrap: wrap;
    gap: 12px;
  }

  .preview-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
  }

  .preview-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Variant Toggle (A/B) */
  .variant-toggle {
    display: flex;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    padding: 2px;
    margin-right: 8px;
  }

  .variant-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .variant-btn.active {
    background: rgba(255, 255, 255, 0.9);
    color: #667eea;
  }

  .variant-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 10px;
    font-weight: bold;
  }

  .variant-badge.warning {
    background: #fbbf24;
    color: #92400e;
  }

  .variant-badge.success {
    background: #10b981;
    color: white;
    font-size: 8px;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: rgba(255, 255, 255, 0.2);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    transition: all 0.2s;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.active {
    background: rgba(255, 255, 255, 0.4);
  }

  .copy-btn {
    width: auto;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 500;
  }

  .spin {
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

  /* Tabs */
  .preview-tabs {
    display: flex;
    border-bottom: 1px solid #e5e7eb;
    background: #f9fafb;
    overflow-x: auto;
  }

  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 12px 8px;
    background: none;
    border: none;
    font-size: 13px;
    font-weight: 500;
    color: #6b7280;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
    white-space: nowrap;
    min-width: 100px;
  }

  .tab:hover {
    color: #374151;
    background: #f3f4f6;
  }

  .tab.active {
    color: #667eea;
    background: white;
    border-bottom: 2px solid #667eea;
    margin-bottom: -1px;
  }

  .tab-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: #ef4444;
    color: white;
    border-radius: 50%;
    font-size: 10px;
    font-weight: bold;
  }

  /* Content */
  .preview-content {
    padding: 20px;
    min-height: 300px;
    background: #f3f4f6;
  }

  /* WhatsApp Preview */
  .whatsapp-preview {
    max-width: 400px;
    margin: 0 auto;
  }

  .whatsapp-chat {
    background: #e5ddd5;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .whatsapp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #075e54;
    color: white;
  }

  .whatsapp-avatar {
    width: 40px;
    height: 40px;
    background: #128c7e;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .whatsapp-contact {
    flex: 1;
  }

  .whatsapp-name {
    font-weight: 600;
    font-size: 14px;
  }

  .whatsapp-status {
    font-size: 12px;
    opacity: 0.8;
  }

  .whatsapp-messages {
    padding: 16px;
    min-height: 200px;
  }

  .whatsapp-bubble {
    max-width: 85%;
    background: #dcf8c6;
    border-radius: 8px;
    padding: 8px;
    margin-left: auto;
    position: relative;
  }

  .whatsapp-bubble.whatsapp-green {
    background: #dcf8c6;
  }

  .whatsapp-link-preview {
    background: white;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 4px;
  }

  .whatsapp-image-container {
    width: 100%;
    height: 160px;
    background: #f3f4f6;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .whatsapp-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .whatsapp-no-image {
    width: 100%;
    height: 160px;
    background: #f3f4f6;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #9ca3af;
    gap: 8px;
  }

  .whatsapp-text-content {
    padding: 10px 12px;
  }

  .whatsapp-site {
    font-size: 12px;
    color: #9ca3af;
    margin-bottom: 4px;
  }

  .whatsapp-title {
    font-size: 14px;
    font-weight: 600;
    color: #111827;
    line-height: 1.4;
    margin-bottom: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .whatsapp-desc {
    font-size: 13px;
    color: #6b7280;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .whatsapp-domain {
    font-size: 12px;
    color: #9ca3af;
    margin-top: 6px;
  }

  .whatsapp-time {
    font-size: 11px;
    color: #9ca3af;
    text-align: right;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }

  .whatsapp-checks {
    color: #53bdeb;
    font-size: 12px;
  }

  /* Telegram Preview */
  .telegram-preview {
    max-width: 400px;
    margin: 0 auto;
  }

  .telegram-chat {
    background: #ffffff;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .telegram-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
  }

  .telegram-back {
    font-size: 20px;
    color: #8e8e93;
  }

  .telegram-info {
    flex: 1;
  }

  .telegram-name {
    font-weight: 600;
    font-size: 14px;
    color: #000;
  }

  .telegram-status {
    font-size: 12px;
    color: #8e8e93;
  }

  .telegram-menu {
    font-size: 20px;
    color: #8e8e93;
  }

  .telegram-messages {
    padding: 16px;
    background: #f5f5f5;
    min-height: 200px;
  }

  .telegram-bubble {
    max-width: 85%;
    background: #ffffff;
    border-radius: 12px 12px 12px 0;
    padding: 0;
    margin-right: auto;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    overflow: hidden;
  }

  .telegram-link-card {
    background: white;
  }

  .telegram-image-container {
    width: 100%;
    height: 180px;
    background: #e7e7e7;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .telegram-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .telegram-content {
    padding: 12px;
  }

  .telegram-title {
    font-size: 14px;
    font-weight: 600;
    color: #000;
    margin-bottom: 6px;
    line-height: 1.4;
  }

  .telegram-desc {
    font-size: 13px;
    color: #666;
    line-height: 1.4;
    margin-bottom: 8px;
  }

  .telegram-url {
    font-size: 12px;
    color: #999;
  }

  .telegram-time {
    font-size: 11px;
    color: #8e8e93;
    text-align: right;
    padding: 8px 12px;
    background: white;
  }

  .telegram-checks {
    color: #4fc3f7;
  }

  .telegram-info-panel {
    margin-top: 16px;
    padding: 16px;
    background: #e3f2fd;
    border-radius: 8px;
    font-size: 13px;
    color: #1565c0;
  }

  .telegram-info-panel h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
  }

  .telegram-info-panel ul {
    margin: 8px 0;
    padding-left: 20px;
  }

  .telegram-info-panel li {
    margin: 4px 0;
  }

  .telegram-note {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #bbdefb;
    font-style: italic;
  }

  /* Validation Panel */
  .validation-panel {
    margin-top: 16px;
    padding: 16px;
    background: #fef3c7;
    border: 1px solid #fbbf24;
    border-radius: 8px;
  }

  .validation-panel.valid {
    background: #d1fae5;
    border-color: #10b981;
  }

  .validation-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 12px;
  }

  .icon-success {
    color: #10b981;
  }

  .icon-warning {
    color: #f59e0b;
  }

  .validation-checks {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #ef4444;
  }

  .check-item.pass {
    color: #10b981;
  }

  .check-icon {
    font-weight: bold;
  }

  .validation-warnings {
    margin-bottom: 12px;
  }

  .warning-item {
    font-size: 12px;
    color: #92400e;
    padding: 4px 0;
  }

  .validation-recommendations {
    font-size: 12px;
    color: #92400e;
  }

  .validation-recommendations ul {
    margin: 4px 0 0 16px;
    padding: 0;
  }

  .validation-recommendations li {
    margin: 2px 0;
  }

  /* Facebook Preview */
  .facebook-preview {
    max-width: 500px;
    margin: 0 auto;
  }

  .facebook-card {
    background: white;
    border: 1px solid #dadde1;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }

  .facebook-image-container {
    width: 100%;
    height: 261px;
    background: #f0f2f5;
  }

  .facebook-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .facebook-no-image {
    width: 100%;
    height: 261px;
    background: #f0f2f5;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bec3c9;
  }

  .facebook-content {
    padding: 12px 16px;
  }

  .facebook-domain {
    font-size: 12px;
    color: #65676b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .facebook-title {
    font-size: 16px;
    font-weight: 600;
    color: #1c1e21;
    line-height: 1.4;
    margin-bottom: 4px;
  }

  .facebook-desc {
    font-size: 14px;
    color: #65676b;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Twitter Preview */
  .twitter-preview {
    max-width: 500px;
    margin: 0 auto;
  }

  .twitter-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .twitter-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .twitter-avatar {
    width: 48px;
    height: 48px;
    background: #1d9bf0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
  }

  .twitter-name {
    font-weight: 700;
    color: #0f1419;
  }

  .twitter-handle {
    font-size: 14px;
    color: #536471;
  }

  .twitter-text {
    font-size: 15px;
    color: #0f1419;
    line-height: 1.5;
    margin-bottom: 12px;
  }

  .twitter-link-card {
    border: 1px solid #cfd9de;
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: 12px;
  }

  .twitter-image-container {
    width: 100%;
    height: 265px;
    background: #e7e9ea;
  }

  .twitter-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .twitter-link-content {
    padding: 12px;
  }

  .twitter-link-title {
    font-weight: 600;
    color: #0f1419;
    margin-bottom: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .twitter-link-desc {
    font-size: 14px;
    color: #536471;
    margin-bottom: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .twitter-link-domain {
    font-size: 13px;
    color: #536471;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .twitter-link-icon {
    font-size: 11px;
  }

  .twitter-actions {
    display: flex;
    gap: 48px;
    padding-top: 12px;
    border-top: 1px solid #eff3f4;
  }

  .twitter-action {
    font-size: 13px;
    color: #536471;
  }

  /* LinkedIn Preview */
  .linkedin-preview {
    max-width: 550px;
    margin: 0 auto;
  }

  .linkedin-card {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.05);
  }

  .linkedin-image-container {
    width: 100%;
    height: 273px;
    background: #f3f6f8;
  }

  .linkedin-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .linkedin-content {
    padding: 16px;
  }

  .linkedin-title {
    font-size: 16px;
    font-weight: 600;
    color: #000000;
    line-height: 1.4;
    margin-bottom: 8px;
  }

  .linkedin-desc {
    font-size: 14px;
    color: #000000;
    line-height: 1.4;
    margin-bottom: 8px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .linkedin-meta {
    font-size: 12px;
    color: #666666;
  }

  .linkedin-domain {
    color: #666666;
  }

  .linkedin-separator {
    margin: 0 4px;
  }

  .linkedin-readtime {
    color: #666666;
  }

  /* External Tools */
  .external-tools {
    margin-top: 16px;
    text-align: center;
  }

  .tool-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 13px;
    color: #374151;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tool-link:hover {
    background: #f9fafb;
    border-color: #9ca3af;
  }

  /* Debug Panel */
  .debug-panel {
    padding: 16px;
    background: #1f2937;
    color: #e5e7eb;
    font-family: "Monaco", "Menlo", monospace;
    font-size: 12px;
  }

  .debug-title {
    font-weight: 600;
    margin-bottom: 12px;
    color: #f3f4f6;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .debug-variant {
    color: #9ca3af;
    font-weight: normal;
  }

  .debug-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 8px;
  }

  .debug-section {
    display: flex;
    gap: 8px;
  }

  .debug-label {
    color: #9ca3af;
    min-width: 100px;
  }

  .debug-value {
    color: #ef4444;
  }

  .debug-value.ok {
    color: #10b981;
  }

  .debug-value.truncate {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .debug-value.warning {
    color: #fbbf24;
  }

  .debug-value.success {
    color: #10b981;
  }

  /* Comparison Summary */
  .comparison-summary {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid #374151;
  }

  .comparison-title {
    font-weight: 600;
    margin-bottom: 12px;
    color: #f3f4f6;
  }

  .comparison-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  }

  .stat-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .stat-label {
    color: #9ca3af;
  }

  .stat-value {
    font-weight: 600;
  }

  .stat-value.warning {
    color: #fbbf24;
  }

  .stat-value.success {
    color: #10b981;
  }

  .stat-item.winner {
    margin-left: auto;
    padding: 4px 12px;
    background: #059669;
    border-radius: 4px;
  }

  .stat-item.winner .stat-label,
  .stat-item.winner .stat-value {
    color: white;
  }
</style>
