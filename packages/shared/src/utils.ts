/**
 * Kitsuden Shared Utilities
 */

/**
 * Format a date string for display
 */
export function formatDate(
  dateStr: string | undefined,
  locale = "en-US",
  options?: Intl.DateTimeFormatOptions
): string {
  if (!dateStr) return "";
  const defaults: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...options,
  };
  return new Date(dateStr).toLocaleDateString(locale, defaults);
}

/**
 * Truncate text to a max length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "…";
}

/**
 * Build CMS API URL for a collection
 */
export function buildCmsUrl(
  baseUrl: string,
  collection: string,
  params?: Record<string, string | number | boolean>
): string {
  const url = new URL(`/api/${collection}`, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Build full API URL
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  return new URL(`/api${path}`, baseUrl).toString();
}

/**
 * Generate JSON-LD structured data for a Video Game
 */
export function gameJsonLd(game: {
  title: string;
  description?: string;
  releaseDate?: string;
  developer?: string;
  publisher?: string;
  metacriticScore?: number;
  coverArt?: { url: string };
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.title,
    description: game.description,
    datePublished: game.releaseDate,
    author: game.developer ? { "@type": "Organization", name: game.developer } : undefined,
    publisher: game.publisher ? { "@type": "Organization", name: game.publisher } : undefined,
    aggregateRating: game.metacriticScore
      ? {
          "@type": "AggregateRating",
          ratingValue: game.metacriticScore,
          bestRating: 100,
          worstRating: 0,
          ratingCount: 1,
        }
      : undefined,
    image: game.coverArt?.url,
  };
}

/**
 * Generate JSON-LD structured data for an Article
 */
export function articleJsonLd(post: {
  title: string;
  excerpt?: string;
  publishedAt?: string;
  author?: { displayName: string };
  featuredImage?: { url: string };
  siteUrl: string;
  slug: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.publishedAt,
    author: post.author ? { "@type": "Person", name: post.author.displayName } : undefined,
    image: post.featuredImage?.url,
    url: `${post.siteUrl}/blog/${post.slug}`,
    publisher: {
      "@type": "Organization",
      name: "Kitsuden",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGINATION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Standard paginated response
 */
export interface PaginatedResponse<T> {
  docs: T[];
  totalDocs: number;
  totalPages: number;
  page: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/**
 * Helper to create a paginated response
 */
export function createPaginatedResponse<T>(
  docs: T[],
  totalDocs: number,
  page: number,
  limit: number
): PaginatedResponse<T> {
  const totalPages = Math.ceil(totalDocs / limit);
  return {
    docs,
    totalDocs,
    totalPages,
    page,
    limit,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}
