<!--
  SocialPreviewABExample.svelte

  Example of how to use the A/B Comparison mode of the SocialPreview component.
  Lets you compare two different versions of OG tags side by side.

  Typical use:
  - Compare different titles
  - Compare different images
  - Compare different descriptions
  - Test which version has better SEO
-->
<script lang="ts">
  import { t } from "$lib/i18n";
  import { GitCompare } from "lucide-svelte";

  import SocialPreview from "./SocialPreview.svelte";

  // Sample data for the comparison
  const variantA = {
    title: t("socialPreviewABExample.n10SeoStrategiesFor2024"),
    metaDescription:
      "Discover the best SEO techniques for this year. Complete guide with practical examples.",
    canonicalUrl: "https://ejemplo.com/blog/seo-2024",
    openGraph: {
      title: t("socialPreviewABExample.n10SeoStrategiesThatWork"),
      description: t("socialPreviewABExample.discoversTheProvenSeoTactics"),
      url: "https://ejemplo.com/blog/seo-2024",
      image: {
        url: "https://ejemplo.com/images/seo-strategy-a.jpg",
        width: 1200,
        height: 630,
        isWhatsAppCompatible: true,
      },
      siteName: "Mi Blog",
    },
    twitterCard: {
      card: "summary_large_image",
      title: t("socialPreviewABExample.n10SeoStrategiesFor20242"),
      description: t("socialPreviewABExample.discoversTheProvenSeoTactics2"),
      image: "https://ejemplo.com/images/seo-strategy-a.jpg",
    },
    whatsAppValidation: {
      isValid: true,
      checks: {
        format: true,
        fileSize: true,
        dimensions: true,
        isAbsoluteUrl: true,
      },
      warnings: [],
      recommendations: [],
    },
  };

  const variantB = {
    title: t("socialPreviewABExample.guideSeo2024HowToRank"),
    metaDescription:
      "Learn to rank your website on Google with our 2024 SEO guide. Updated and effective strategies.",
    canonicalUrl: "https://ejemplo.com/blog/seo-2024",
    openGraph: {
      title: t("socialPreviewABExample.completeGuideSeo2024Master"),
      description: t("socialPreviewABExample.everythingYouNeedToKnow"),
      url: "https://ejemplo.com/blog/seo-2024",
      image: {
        url: "https://ejemplo.com/images/seo-guide-b.jpg",
        width: 1200,
        height: 630,
        isWhatsAppCompatible: false,
      },
      siteName: "Mi Blog",
    },
    twitterCard: {
      card: "summary_large_image",
      title: t("socialPreviewABExample.guideSeo2024MasterGoogle"),
      description: t("socialPreviewABExample.everythingYouNeedToKnow2"),
      image: "https://ejemplo.com/images/seo-guide-b.jpg",
    },
    whatsAppValidation: {
      isValid: false,
      checks: {
        format: true,
        fileSize: false,
        dimensions: true,
        isAbsoluteUrl: true,
      },
      warnings: ["Image file size (450KB) exceeds WhatsApp limit of 300KB"],
      recommendations: ["Compress image to under 300KB using TinyPNG"],
    },
  };

  // Props
  interface Props {
    showComparison?: boolean;
  }

  const { showComparison = true }: Props = $props();
</script>

<div class="ab-example">
  <div class="ab-header">
    <GitCompare size={24} />
    <h2>{t("socialPreviewABExample.openABComparison")}</h2>
  </div>

  <p class="ab-description">
    {t("socialPreviewABExample.comparesTwoDifferentVersionsOf")}
  </p>

  {#if showComparison}
    <div class="comparison-container">
      <SocialPreview
        comparisonMode={true}
        {variantA}
        {variantB}
        labelA="Emotional Title + Emoji"
        labelB="Descriptive Title"
      />
    </div>
  {/if}

  <div class="ab-notes">
    <h3>{t("socialPreviewABExample.howToInterpretResults")}</h3>
    <ul>
      <li>
        <strong>{t("socialPreviewABExample.whatsappIssues")}</strong>
        {t("socialPreviewABExample.showsHowManyProblemsEachHas")}
      </li>
      <li>
        <strong>{t("socialPreviewABExample.validation")}</strong>
        {t("socialPreviewABExample.checksFormatSizeAndDimensions")}
      </li>
      <li>
        <strong>{t("socialPreviewABExample.debugPanel")}</strong>
        {t("socialPreviewABExample.showsTitleLengthsAnd")}
      </li>
      <li>
        <strong>{t("socialPreviewABExample.winner")}</strong>
        {t("socialPreviewABExample.theVariantWithFewestIssues")}
      </li>
    </ul>
  </div>
</div>

<style>
  .ab-example {
    padding: 24px;
    background: #f9fafb;
    border-radius: 12px;
  }

  .ab-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .ab-header h2 {
    margin: 0;
    font-size: 20px;
    color: #111827;
  }

  .ab-description {
    color: #6b7280;
    margin-bottom: 24px;
    line-height: 1.5;
  }

  .comparison-container {
    margin-bottom: 24px;
  }

  .ab-notes {
    background: white;
    padding: 20px;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
  }

  .ab-notes h3 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #374151;
  }

  .ab-notes ul {
    margin: 0;
    padding-left: 20px;
    color: #6b7280;
    font-size: 13px;
    line-height: 1.8;
  }

  .ab-notes li {
    margin: 4px 0;
  }
</style>
