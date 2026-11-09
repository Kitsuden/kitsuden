/**
 * A small typed client for the public Kitsuden API
 * ============================================================================
 *
 * Only the read routes this site needs, all public (no session, no key):
 *
 *   GET /api/page-builder/pages           published pages (list)
 *   GET /api/page-builder/pages/:slug     one page with its visible blocks
 *   GET /api/blog                         published posts (paginated)
 *   GET /api/blog/slug/:slug              one post
 *
 * `@kitsuden/sdk` is not used on purpose: it talks to the data explorer and
 * the graph API, it has no page-builder or blog helpers, and it cannot send
 * the per-visitor headers described below.
 *
 * ── Errors ─────────────────────────────────────────────────────────────────
 *
 * A 404 is "this does not exist" and returns `null`. A 429, a 5xx or a
 * network error is "the API cannot answer right now" and throws
 * `ApiUnavailableError`, which the middleware turns into a 503. Mixing the
 * two would make a search engine drop a page from its index just because the
 * API was busy for a minute.
 *
 * ── Rate limit and KITSUDEN_SITE_KEY ───────────────────────────────────────
 *
 * The API limits requests per route and per client, and the client is the
 * IP. Every visitor of this site reaches the API through THIS server, so they
 * would all share one bucket. With `KITSUDEN_SITE_KEY` equal to the API's
 * `SITE_API_KEY`, each request carries the key (`x-kitsuden-site`) and the
 * visitor IP (`x-kitsuden-client`), and the API counts per visitor. Without
 * the key the IP header is ignored by the API, so it is not sent at all.
 */

export interface PageSummary {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  isHomepage?: boolean;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

export interface BlockRow {
  id: string;
  type: string;
  name?: string | null;
  sortOrder?: number;
  columnSpan?: number;
  content: Record<string, unknown>;
  cssClass?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  padding?: string | null;
}

export interface Page extends PageSummary {
  status?: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  ogImageId?: string | null;
  layout?: string;
  cssClass?: string | null;
  customCss?: string | null;
  requireAuth?: boolean;
  blocks: BlockRow[];
}

export interface Post {
  id: string;
  title: string;
  slug: string;
  excerpt?: string | null;
  /** Sanitized HTML (the API sanitizes it again when serving) */
  content?: unknown;
  /** Post blocks already rendered to HTML by the API */
  blocksHtml?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  featuredImageId?: string | null;
  ogImageId?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  readingTime?: number | null;
  locale?: string | null;
  author?: { id: string; displayName?: string | null } | null;
  translations?: { locale: string; slug: string; title: string }[];
}

export interface PostList {
  docs: Post[];
  totalDocs: number;
  totalPages: number;
  page: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export class ApiUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export interface ClientOptions {
  /** API origin as THIS server sees it, e.g. http://localhost:3000 */
  apiUrl: string;
  /** = SITE_API_KEY of the API. Optional */
  siteKey?: string;
  /** Visitor IP, sent only together with the site key */
  clientIp?: string;
  /** Injectable for tests */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Page and post slugs are lowercase words joined by hyphens: nothing else is asked for */
export const isSlug = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && SLUG.test(value);

export function createKitsuden(options: ClientOptions) {
  const base = options.apiUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  /**
   * One client lives for one request (see middleware.ts), so the same path
   * asked twice in a request (the layout's menu and the home page both list
   * the pages) is fetched once. Fewer parallel reads also matter to the API:
   * its connection pool is small and a burst of reads can exhaust it.
   */
  const memo = new Map<string, Promise<unknown>>();
  function get<T>(path: string): Promise<T | null> {
    let pending = memo.get(path) as Promise<T | null> | undefined;
    if (!pending) {
      pending = request<T>(path);
      memo.set(path, pending);
    }
    return pending;
  }

  async function request<T>(path: string): Promise<T | null> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.siteKey) {
      headers["x-kitsuden-site"] = options.siteKey;
      if (options.clientIp) headers["x-kitsuden-client"] = options.clientIp.slice(0, 64);
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ApiUnavailableError(
        `Kitsuden API did not answer (${path}): ${(error as Error).message}`
      );
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      throw new ApiUnavailableError(`Kitsuden API answered ${res.status} (${path})`, res.status);
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  return {
    /** The API origin as the server sees it (for the media proxy) */
    apiUrl: base,

    pages: {
      async list(limit = 100): Promise<PageSummary[]> {
        const data = await get<{ docs?: PageSummary[] }>(`/api/page-builder/pages?limit=${limit}`);
        return Array.isArray(data?.docs) ? data.docs : [];
      },

      /**
       * A published page with its visible blocks, ordered as the API orders
       * them (`sortOrder`). This is the same read `@intijs/adapter-kitsuden`
       * does, so block positions match when Inti is on.
       */
      async get(slug: string): Promise<Page | null> {
        if (!isSlug(slug)) return null;
        const page = await get<Page>(`/api/page-builder/pages/${slug}`);
        if (!page || typeof page.id !== "string") return null;
        const blocks = Array.isArray(page.blocks) ? page.blocks : [];
        return {
          ...page,
          blocks: [...blocks].sort((a, b) => (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0)),
        };
      },

      /** The page marked as homepage, or the one with slug `home` */
      async home(): Promise<Page | null> {
        const list = await this.list();
        const marked = list.find((p) => p.isHomepage);
        return this.get(marked?.slug ?? "home");
      },
    },

    posts: {
      /** `null` when the API has no blog (kon-blog not active) */
      async list(
        opts: { page?: number; limit?: number; locale?: string } = {}
      ): Promise<PostList | null> {
        const params = new URLSearchParams({
          page: String(Math.max(1, Math.floor(opts.page ?? 1))),
          limit: String(Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)))),
        });
        if (opts.locale && /^[a-z]{2}$/.test(opts.locale)) params.set("locale", opts.locale);
        const data = await get<PostList>(`/api/blog?${params}`);
        if (!data || !Array.isArray(data.docs)) return null;
        return data;
      },

      async get(slug: string): Promise<Post | null> {
        if (!isSlug(slug)) return null;
        const post = await get<Post>(`/api/blog/slug/${slug}`);
        return post && typeof post.id === "string" ? post : null;
      },
    },
  };
}

export type KitsudenClient = ReturnType<typeof createKitsuden>;
