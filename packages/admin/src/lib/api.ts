// Inline types to avoid $types dependency
interface PaginatedResponse<T> {
  docs: T[];
  totalDocs: number;
  limit: number;
  totalPages: number;
  page: number;
  pagingCounter: number;
  hasPrevPage: boolean;
  hasNextPage: boolean;
  prevPage: number | null;
  nextPage: number | null;
}

interface Game {
  id: string;
  title: string;
  slug: string;
  description?: string;
  content?: string;
  status: "draft" | "published" | "archived";
  coverImage?: string;
  platform?: string[];
  tags?: string[];
  releaseDate?: string;
  createdAt: string;
  updatedAt: string;
}

interface BlogPost {
  id: string;
  title: string;
  slug: string;
  content?: string;
  excerpt?: string;
  status: "draft" | "published" | "scheduled" | "archived";
  coverImage?: string;
  featuredImageId?: string;
  featuredImage?: {
    id: string;
    url: string;
    alt?: string;
  };
  tags?: Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  authorId?: string;
  author?: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
  publishedAt?: string;
  seoOverrides?: {
    metaTitle?: string;
    metaDescription?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImageId?: string;
    canonicalUrl?: string;
    robotsIndex?: boolean;
    robotsFollow?: boolean;
    structuredData?: any;
    /** Groups announced by this entry; null = the site's */
    facebookGroupUrl?: string | null;
    whatsappGroupUrl?: string | null;
  };

  /** Is the thread open? Absent on posts predating the column: that means open. */
  commentsEnabled?: boolean;

  /** Template it is rendered with. Absent on earlier posts: that means `article`. */
  layout?: "article" | "tips";

  /**
   * Where the thread hangs from, already resolved by the API.
   *
   * It travels here so that whoever renders the post does not compose the string on
   * their own: `post`, `blog_post` and `blogpost` would open three different threads
   * on the same article without any error.
   */
  comments?: {
    subjectType: string;
    subjectId: string;
    /** Already-assembled thread route. */
    endpoint: string;
    enabled: boolean;
    /** `null` = kon-comments is not installed (different from «there are none»). */
    count: number | null;
  };

  createdAt: string;
  updatedAt: string;
}

interface Platform {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

interface Tag {
  id: string;
  name: string;
  slug: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

interface Streamer {
  id: string;
  name: string;
  slug: string;
  platform: string;
  channelUrl?: string;
  isLive?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Media {
  id: string;
  filename: string;
  url: string;
  alt?: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
  updatedAt: string;
}

interface SiteSettings {
  id: string;
  siteName: string;
  siteDescription?: string;
  logo?: string;
  favicon?: string;
  primaryColor?: string;
  socialLinks?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface AuthResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  };
  token: string;
}

// In production (Docker): VITE_API_URL is "" — relative URLs, proxied by nginx.
// In development: VITE_API_URL is "http://localhost:3001" (set in packages/admin/.env)
const API = import.meta.env.VITE_API_URL ?? "";

/**
 * API error with the HTTP code and the body intact.
 *
 * `message` is still the usual string; `status` and `body` are what
 * allows reacting differently to a 409 than to a 500.
 */
export interface BlogCategory {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  parentId?: string | null;
  displayOrder: number;
  /** How many posts hang from it. The API computes it to avoid doing N queries. */
  postCount?: number;
}

export interface ApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

class ApiClient {
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
    localStorage.setItem("kitsuden_token", token);
  }

  getToken(): string | null {
    if (!this.token) this.token = localStorage.getItem("kitsuden_token");
    return this.token;
  }

  clearToken() {
    this.token = null;
    localStorage.removeItem("kitsuden_token");
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) || {}),
    };

    if (!(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // The `/api` prefix is added by this client, but HALF of the admin passes
    // routes that already carry it: the explorer builds `/api/blog`,
    // `/api/explorer/games`... and each kon's configuration also
    // includes it. The result was `/api/api/blog`, a 404 that in the interface showed
    // up as «Failed to Load» with no further clue.
    //
    // It is normalized here, at the single point all
    // requests pass through, instead of going over each caller: there are dozens, some with
    // the prefix and some without, and several read the route from data —the kons'
    // manifests— where a typecheck does not reach.
    const route = path.startsWith("/api/") || path === "/api" ? path : `/api${path}`;

    const res = await fetch(`${API}${route}`, { ...options, headers, credentials: "include" });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));

      /**
       * The code and the body travel with the error.
       *
       * Before, only `err.error` survived, so the caller could not
       * tell a 404 from a 409 or read the explanatory `message` that the API
       * does send. And there are responses where that difference is ALL the content:
       * a 409 for simultaneous editing carries the current version's mark and an
       * explanation that nothing was written — reducing it to a string
       * turns «someone else saved before you» into «error».
       *
       * `message` is left intact so as not to break the dozens of callers
       * that do `err.message`.
       */
      const failure = new Error(err.error || err.detail || `HTTP ${res.status}`) as ApiError;
      failure.status = res.status;
      failure.body = err;
      throw failure;
    }

    return res.json();
  }

  // ── Generic HTTP Methods ──
  async get<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  async post<T>(path: string, body?: any, options?: RequestInit): Promise<T> {
    // Don't stringify if body is FormData
    const requestBody = body instanceof FormData ? body : body ? JSON.stringify(body) : undefined;
    return this.request<T>(path, { ...options, method: "POST", body: requestBody });
  }

  async patch<T>(path: string, body?: any, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async put<T>(path: string, body?: any, options?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }

  // ── Auth ──
  login(email: string, password: string) {
    return this.request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }

  register(email: string, password: string, displayName: string) {
    return this.request<any>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    });
  }

  // ── Games ──
  getGames(params?: { limit?: number; page?: number; search?: string; status?: string }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    if (params?.search) q.set("search", params.search);
    if (params?.status) q.set("status", params.status);
    return this.request<PaginatedResponse<Game>>(`/games?${q}`);
  }

  getGame(id: string) {
    return this.request<Game>(`/games/${id}`);
  }
  getGameBySlug(slug: string) {
    return this.request<Game>(`/games/slug/${slug}`);
  }
  createGame(data: Partial<Game>) {
    return this.request<Game>("/games", { method: "POST", body: JSON.stringify(data) });
  }
  updateGame(id: string, data: Partial<Game>) {
    return this.request<Game>(`/games/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  deleteGame(id: string) {
    return this.request<{ deleted: boolean }>(`/games/${id}`, { method: "DELETE" });
  }
  getGameCollections() {
    return this.request<PaginatedResponse<any>>("/games/collections");
  }
  createGameCollection(data: Partial<any>) {
    return this.request<any>("/games/collections", { method: "POST", body: JSON.stringify(data) });
  }
  updateGameCollection(id: string, data: Partial<any>) {
    return this.request<any>(`/games/collections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteGameCollection(id: string) {
    return this.request<{ success: boolean }>(`/games/collections/${id}`, { method: "DELETE" });
  }

  // ── Blog Posts ──
  getPosts(params?: { limit?: number; page?: number; status?: string }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    if (params?.status) q.set("status", params.status);
    return this.request<PaginatedResponse<BlogPost>>(`/blog?${q}`);
  }

  getPost(id: string) {
    return this.request<BlogPost>(`/blog/${id}`);
  }
  getPostBySlug(slug: string) {
    return this.request<BlogPost>(`/blog/slug/${slug}`);
  }
  createPost(data: Partial<BlogPost>) {
    return this.request<BlogPost>("/blog", { method: "POST", body: JSON.stringify(data) });
  }
  updatePost(id: string, data: Partial<BlogPost>) {
    return this.request<BlogPost>(`/blog/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  deletePost(id: string) {
    return this.request<{ deleted: boolean }>(`/blog/${id}`, { method: "DELETE" });
  }

  // ── Blog categories ──
  //
  // The blog's hierarchical taxonomy. TAGS are something else and live at
  // `/tags`, which belongs to kon-games: flat and open-vocabulary.
  getBlogCategories() {
    return this.request<{ docs: BlogCategory[]; total: number }>("/blog/categories");
  }
  createBlogCategory(data: Partial<BlogCategory>) {
    return this.request<BlogCategory>("/blog/categories", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  updateBlogCategory(id: string, data: Partial<BlogCategory>) {
    return this.request<BlogCategory>(`/blog/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteBlogCategory(id: string) {
    return this.request<{ success: boolean; id: string }>(`/blog/categories/${id}`, {
      method: "DELETE",
    });
  }

  // ── Academy LMS ──
  // Courses
  getAcademyCourses(params?: { limit?: number }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    return this.request<{ courses: any[] }>(`/academy/courses?${q}`);
  }
  getAcademyCourse(id: string) {
    return this.request<any>(`/academy/courses/${id}`);
  }
  createAcademyCourse(data: Partial<any>) {
    return this.request<any>("/academy/courses", { method: "POST", body: JSON.stringify(data) });
  }
  updateAcademyCourse(id: string, data: Partial<any>) {
    return this.request<any>(`/academy/courses/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteAcademyCourse(id: string) {
    return this.request<{ deleted: boolean }>(`/academy/courses/${id}`, { method: "DELETE" });
  }

  // Modules
  getAcademyModulesByCourse(courseId: string) {
    return this.request<{ modules: any[] }>(`/academy/courses/${courseId}/modules`);
  }
  getAcademyModulo(id: string) {
    return this.request<any>(`/academy/modules/${id}`);
  }
  createAcademyModulo(data: Partial<any>) {
    return this.request<any>("/academy/modules", { method: "POST", body: JSON.stringify(data) });
  }
  deleteAcademyModulo(id: string) {
    return this.request<{ deleted: boolean }>(`/academy/modules/${id}`, { method: "DELETE" });
  }
  updateAcademyModulo(id: string, data: any) {
    return this.request<any>(`/academy/modules/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
  deleteAcademyLearningPath(id: string) {
    return this.request<{ deleted: boolean }>(`/academy/learning-paths/${id}`, {
      method: "DELETE",
    });
  }
  deleteAcademyGroup(id: string) {
    return this.request<{ deleted: boolean }>(`/academy/groups/${id}`, { method: "DELETE" });
  }

  // Topics
  getAcademyTopic(id: string) {
    return this.request<any>(`/academy/topics/${id}`);
  }
  createAcademyTopic(data: Partial<any>) {
    return this.request<any>("/academy/topics", { method: "POST", body: JSON.stringify(data) });
  }
  updateAcademyTopic(id: string, data: Partial<any>) {
    return this.request<any>(`/academy/topics/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
  deleteAcademyTopic(id: string) {
    return this.request<{ deleted: boolean }>(`/academy/topics/${id}`, { method: "DELETE" });
  }
  completeTheme(id: string) {
    return this.request<any>(`/academy/topics/${id}/complete`, { method: "POST" });
  }

  // YouTube/Media
  getYouTubeInfo(url: string) {
    return this.request<any>("/academy/media/youtube-info", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  // Quizzes
  getAcademyQuiz(id: string) {
    return this.request<any>(`/academy/quizzes/${id}`);
  }
  answerQuiz(id: string, responses: any[]) {
    return this.request<any>(`/academy/quizzes/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answers: responses }),
    });
  }

  // Learning Paths
  getAcademyLearningPaths() {
    return this.request<{ learningPaths: any[] }>("/academy/learning-paths");
  }
  getAcademyLearningPath(id: string) {
    return this.request<any>(`/academy/learning-paths/${id}`);
  }
  createAcademyLearningPath(data: Partial<any>) {
    return this.request<any>("/academy/learning-paths", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Groups
  getAcademyGroups() {
    return this.request<{ groups: any[] }>("/academy/groups");
  }
  getAcademyGroup(id: string) {
    return this.request<any>(`/academy/groups/${id}`);
  }
  createAcademyGroup(data: Partial<any>) {
    return this.request<any>("/academy/groups", { method: "POST", body: JSON.stringify(data) });
  }

  // Assignments
  getAcademyAssignments() {
    return this.request<{ assignments: any[] }>("/academy/assignments");
  }
  createAcademyAssignment(data: Partial<any>) {
    return this.request<any>("/academy/assignments", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Dashboard
  getAcademyDashboard() {
    return this.request<{ metrics: any }>("/academy/dashboard/my-progress");
  }
  getAcademyDashboardAdmin() {
    return this.request<{ metrics: any; alerts: any[] }>("/academy/dashboard");
  }
  getAcademyCourseReports() {
    return this.request<{ reports: any[]; total: number }>("/academy/reports/courses");
  }
  getAcademyCourseStatistics(id: string) {
    return this.request<{ stats: any }>(`/academy/courses/${id}/stats`);
  }
  createAcademyAssignmentBulk(data: any) {
    return this.request<any>("/academy/assignments/multiple", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Certificates
  getAcademyCertificate(courseId: string) {
    return this.request<any>(`/academy/certificates/${courseId}`);
  }
  getAcademyCertificatePDF(courseId: string) {
    return this.request<Blob>(`/academy/certificates/${courseId}/pdf`);
  }
  verifyCertificate(code: string) {
    return this.request<any>(`/academy/certificates/verify/${code}`);
  }

  // ── Page Builder (Blocks) ──
  // The API responds { docs, totalDocs } (packages/core/blocks/blocks.routes.ts).
  getPages() {
    return this.request<{ docs: any[]; totalDocs: number }>("/page-builder/pages");
  }
  getPage(id: string) {
    return this.request<any>(`/page-builder/pages/${id}`);
  }
  createPage(data: Partial<any>) {
    return this.request<any>("/page-builder/pages", { method: "POST", body: JSON.stringify(data) });
  }
  updatePage(id: string, data: Partial<any>) {
    return this.request<any>(`/page-builder/pages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deletePage(id: string) {
    return this.request<{ deleted: boolean }>(`/page-builder/pages/${id}`, { method: "DELETE" });
  }
  clonePage(id: string, data: Partial<any>) {
    return this.request<any>(`/page-builder/pages/${id}/clone`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  getBlocks(pageId: string) {
    return this.request<{ blocks: any[] }>(`/page-builder/pages/${pageId}/blocks`);
  }
  createBlock(pageId: string, data: Partial<any>) {
    return this.request<any>(`/page-builder/pages/${pageId}/blocks`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  // Blocks are edited and deleted by their id, without the page: PATCH/DELETE
  // /page-builder/blocks/:id. The route with the page in front does not exist (404).
  updateBlock(_pageId: string, blockId: string, data: Partial<any>) {
    return this.request<any>(`/page-builder/blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteBlock(_pageId: string, blockId: string) {
    return this.request<{ deleted: boolean }>(`/page-builder/blocks/${blockId}`, {
      method: "DELETE",
    });
  }
  renderPage(slug: string) {
    return this.request<any>(`/page-builder/render/${slug}`);
  }

  // ── Datasets ──
  getDatasets(params?: { limit?: number; page?: number; search?: string }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    if (params?.search) q.set("search", params.search);
    return this.request<
      PaginatedResponse<{
        id: string;
        name: string;
        slug: string;
        description?: string;
        icon?: string;
        schema?: any;
        entryCount?: number;
        createdAt: string;
        updatedAt: string;
      }>
    >(`/data-sets?${q}`);
  }

  getDataset(id: string) {
    return this.request<{
      id: string;
      name: string;
      slug: string;
      description?: string;
      icon?: string;
      schema?: any;
      policyJson?: any;
      workflowJson?: any;
      createdAt: string;
      updatedAt: string;
    }>(`/data-sets/${id}`);
  }

  getDatasetEntries(
    datasetId: string,
    params?: {
      limit?: number;
      page?: number;
      search?: string;
      status?: string;
    }
  ) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    if (params?.search) q.set("search", params.search);
    if (params?.status) q.set("status", params.status);
    return this.request<
      PaginatedResponse<{
        id: string;
        datasetId: string;
        data: Record<string, any>;
        status?: string;
        publishedAt?: string;
        createdAt: string;
        updatedAt: string;
      }>
    >(`/data-sets/${datasetId}/entries?${q}`);
  }

  getDatasetEntry(datasetId: string, entryId: string) {
    return this.request<{
      id: string;
      datasetId: string;
      data: Record<string, any>;
      status?: string;
      publishedAt?: string;
      createdAt: string;
      updatedAt: string;
    }>(`/data-sets/${datasetId}/entries/${entryId}`);
  }

  // ── Platforms / Tags ──
  // They belong to kon-games and hang from `/api/games/…`. They were at `/api/platforms` and
  // `/api/tags`, which do not exist: the entry editor requested the tags, took
  // a 404 that only appeared in the console, and creating one failed the same way.
  // Result: no blog entry had tags.
  getPlatforms() {
    return this.request<PaginatedResponse<Platform>>("/games/platforms");
  }
  createPlatform(data: Partial<Platform>) {
    return this.request<Platform>("/games/platforms", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  getTags() {
    return this.request<PaginatedResponse<Tag>>("/games/tags");
  }
  createTag(data: Partial<Tag>) {
    return this.request<Tag>("/games/tags", { method: "POST", body: JSON.stringify(data) });
  }

  // ── Streamers ──
  getStreamers(params?: {
    limit?: number;
    page?: number;
    platform?: string;
    live?: boolean;
    sort?: string;
  }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    if (params?.platform) q.set("platform", params.platform);
    if (params?.live) q.set("live", "true");
    if (params?.sort) q.set("sort", params.sort);
    return this.request<PaginatedResponse<Streamer>>(`/streamers?${q}`);
  }
  getStreamer(id: string) {
    return this.request<Streamer>(`/streamers/${id}`);
  }
  createStreamer(data: Partial<Streamer>) {
    return this.request<Streamer>("/streamers", { method: "POST", body: JSON.stringify(data) });
  }
  updateStreamer(id: string, data: Partial<Streamer>) {
    return this.request<Streamer>(`/streamers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteStreamer(id: string) {
    return this.request<{ deleted: boolean }>(`/streamers/${id}`, { method: "DELETE" });
  }

  // ── Media ──
  /**
   * ── TWO THINGS THAT WERE SILENTLY BROKEN ─────────────────────────────────
   *
   * 1. `page` was sent. The endpoint reads `offset` and nothing else
   *    (`Number(c.req.query("offset")) || 0`), so EVERY request returned
   *    the first page. It did not fail: it returned 200 with the same results
   *    over and over, which is the hardest way to notice.
   *
   * 2. `search` and `type` have always existed on the endpoint —it filters by
   *    file name and by image/video/document— and this client never
   *    sent them. The whole library with no way to filter it.
   *
   * `page` is still accepted and translated, so as not to break anyone who uses it.
   */
  getMedia(params?: {
    limit?: number;
    page?: number;
    offset?: number;
    search?: string;
    type?: "image" | "video" | "document";
  }) {
    const q = new URLSearchParams();
    const limit = params?.limit ?? 50;
    q.set("limit", String(limit));

    const offset = params?.offset ?? (params?.page ? (params.page - 1) * limit : 0);
    if (offset > 0) q.set("offset", String(offset));

    if (params?.search) q.set("search", params.search);
    if (params?.type) q.set("type", params.type);

    return this.request<PaginatedResponse<Media>>(`/media?${q}`);
  }

  /**
   * ── THIS FUNCTION HAS NEVER UPLOADED ANYTHING ────────────────────────────
   *
   * It sent the file in a field called `file`. The endpoint reads
   * `body.files` —plural— and with any other name it finds nothing:
   *
   *     if (!files) return c.json({ error: "No files provided" }, 400);
   *
   * That is: 400 on EVERY upload, always. The test that covered it
   * mocked `fetch` and only checked that «a FormData» was sent, without looking at
   * what was inside — it passed green on a function that did not work.
   *
   * The response is `{ success, files: [...] }` and does NOT carry the public URL,
   * so whoever uploads has to reload the list to use it.
   */
  uploadMedia(file: File | File[], alt?: string) {
    const form = new FormData();
    for (const f of Array.isArray(file) ? file : [file]) form.append("files", f);
    if (alt) form.append("alt", alt);

    return this.request<{
      success: boolean;
      files: Array<{
        id?: string;
        filename: string;
        mimeType?: string;
        size?: number;
        /** Public URL of what was just uploaded. Avoids rereading the library. */
        url?: string;
        width?: number;
        height?: number;
        success: boolean;
        error?: string;
      }>;
    }>("/media/upload", { method: "POST", body: form });
  }

  deleteMedia(id: string) {
    return this.request<{ deleted: boolean }>(`/media/${id}`, { method: "DELETE" });
  }

  // ── Settings ──
  getSettings() {
    return this.request<SiteSettings>("/settings");
  }
  updateSettings(data: Partial<SiteSettings>) {
    return this.request<SiteSettings>("/settings", { method: "PATCH", body: JSON.stringify(data) });
  }

  // ── Conta (General Ledger) ──
  getContaJournals(params?: { status?: string; type?: string; limit?: number; page?: number }) {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.type) q.set("type", params.type);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    return this.request<{
      data: any[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/conta/journals?${q}`);
  }
  getContaJournal(id: string) {
    return this.request<{ data: any }>(`/conta/journals/${id}`);
  }
  createContaJournal(data: any) {
    return this.request<any>("/conta/journals", { method: "POST", body: JSON.stringify(data) });
  }
  updateContaJournal(id: string, data: any) {
    return this.request<any>(`/conta/journals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteContaJournal(id: string) {
    return this.request<{ success: boolean }>(`/conta/journals/${id}`, { method: "DELETE" });
  }
  postContaJournal(id: string) {
    return this.request<any>(`/conta/journals/${id}/post`, { method: "POST" });
  }
  reverseContaJournal(id: string, date?: string) {
    return this.request<any>(`/conta/journals/${id}/reverse`, {
      method: "POST",
      body: JSON.stringify({ date }),
    });
  }

  getContaAccounts(params?: { type?: string; isTrust?: string; limit?: number }) {
    const q = new URLSearchParams();
    if (params?.type) q.set("type", params.type);
    if (params?.isTrust) q.set("isTrust", params.isTrust);
    if (params?.limit) q.set("limit", String(params.limit));
    return this.request<{ data: any[] }>(`/conta/accounts?${q}`);
  }
  getContaAccount(id: string) {
    return this.request<{ data: any }>(`/conta/accounts/${id}`);
  }
  createContaAccount(data: any) {
    return this.request<any>("/conta/accounts", { method: "POST", body: JSON.stringify(data) });
  }
  updateContaAccount(id: string, data: any) {
    return this.request<any>(`/conta/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteContaAccount(id: string) {
    return this.request<{ success: boolean }>(`/conta/accounts/${id}`, { method: "DELETE" });
  }

  getContaTrialBalance(params?: { dateFrom?: string; dateTo?: string }) {
    const q = new URLSearchParams();
    if (params?.dateFrom) q.set("dateFrom", params.dateFrom);
    if (params?.dateTo) q.set("dateTo", params.dateTo);
    return this.request<{ data: any[] }>(`/conta/reports/trial-balance?${q}`);
  }
  getContaBalanceSheet(asOf?: string) {
    const q = new URLSearchParams();
    if (asOf) q.set("asOf", asOf);
    return this.request<{ data: any }>(`/conta/reports/balance-sheet?${q}`);
  }
  getContaProfitLoss(params?: { dateFrom?: string; dateTo?: string }) {
    const q = new URLSearchParams();
    if (params?.dateFrom) q.set("dateFrom", params.dateFrom);
    if (params?.dateTo) q.set("dateTo", params.dateTo);
    return this.request<{ data: any }>(`/conta/reports/profit-loss?${q}`);
  }

  getContaCurrencies() {
    return this.request<{ data: any[] }>("/conta/currencies");
  }
  getContaCounterparties() {
    return this.request<{ data: any[] }>("/conta/counterparties");
  }
  getContaMatters() {
    return this.request<{ data: any[] }>("/conta/matters");
  }
  getContaTAccount(accountId: string, params?: { dateFrom?: string; dateTo?: string }) {
    const q = new URLSearchParams();
    if (params?.dateFrom) q.set("dateFrom", params.dateFrom);
    if (params?.dateTo) q.set("dateTo", params.dateTo);
    return this.request<{ data: any }>(`/conta/t-account/${accountId}?${q}`);
  }

  // ── Disbursements ──
  getContaDisbursements(params?: { matterId?: string; status?: string; limit?: number }) {
    const q = new URLSearchParams();
    if (params?.matterId) q.set("matterId", params.matterId);
    if (params?.status) q.set("status", params.status);
    if (params?.limit) q.set("limit", String(params.limit));
    return this.request<{ data: any[] }>(`/conta/disbursements?${q}`);
  }
  getContaDisbursement(id: string) {
    return this.request<{ data: any }>(`/conta/disbursements/${id}`);
  }
  createContaDisbursement(data: any) {
    return this.request<any>("/conta/disbursements", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  billContaDisbursement(id: string) {
    return this.request<any>(`/conta/disbursements/${id}/bill`, { method: "POST" });
  }
  payContaDisbursement(id: string) {
    return this.request<any>(`/conta/disbursements/${id}/pay`, { method: "POST" });
  }
  deleteContaDisbursement(id: string) {
    return this.request<{ success: boolean }>(`/conta/disbursements/${id}`, { method: "DELETE" });
  }

  // ── Templates ──
  getContaTemplates(type?: string) {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    return this.request<{ data: any[] }>(`/conta/templates?${q}`);
  }
  getContaTemplate(id: string) {
    return this.request<{ data: any }>(`/conta/templates/${id}`);
  }
  createContaTemplate(data: any) {
    return this.request<any>("/conta/templates", { method: "POST", body: JSON.stringify(data) });
  }
  updateContaTemplate(id: string, data: any) {
    return this.request<any>(`/conta/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteContaTemplate(id: string) {
    return this.request<{ success: boolean }>(`/conta/templates/${id}`, { method: "DELETE" });
  }
  applyContaTemplate(id: string, variables: Record<string, any>, metadata?: Record<string, any>) {
    return this.request<any>(`/conta/templates/${id}/apply`, {
      method: "POST",
      body: JSON.stringify({ variables, metadata }),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // CRM
  // ═══════════════════════════════════════════════════════════

  // ── Stats ──
  getCrmStats() {
    return this.request<{ data: any }>("/crm/stats");
  }

  // ── Companies ──
  getCrmCompanies(params?: {
    industry?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const q = new URLSearchParams();
    if (params?.industry) q.set("industry", params.industry);
    if (params?.search) q.set("search", params.search);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return this.request<{ data: any[]; pagination?: any }>(`/crm/companies?${q}`);
  }
  getCrmCompany(id: string) {
    return this.request<{ data: any }>(`/crm/companies/${id}`);
  }
  createCrmCompany(data: any) {
    return this.request<any>("/crm/companies", { method: "POST", body: JSON.stringify(data) });
  }
  updateCrmCompany(id: string, data: any) {
    return this.request<any>(`/crm/companies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteCrmCompany(id: string) {
    return this.request<{ success: boolean }>(`/crm/companies/${id}`, { method: "DELETE" });
  }

  // ── Contacts ──
  getCrmContacts(params?: {
    companyId?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const q = new URLSearchParams();
    if (params?.companyId) q.set("companyId", params.companyId);
    if (params?.status) q.set("status", params.status);
    if (params?.search) q.set("search", params.search);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return this.request<{ data: any[]; pagination?: any }>(`/crm/contacts?${q}`);
  }
  getCrmContact(id: string) {
    return this.request<{ data: any }>(`/crm/contacts/${id}`);
  }
  createCrmContact(data: any) {
    return this.request<any>("/crm/contacts", { method: "POST", body: JSON.stringify(data) });
  }
  updateCrmContact(id: string, data: any) {
    return this.request<any>(`/crm/contacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteCrmContact(id: string) {
    return this.request<{ success: boolean }>(`/crm/contacts/${id}`, { method: "DELETE" });
  }

  // ── Pipelines ──
  getCrmPipelines() {
    return this.request<{ data: any[] }>("/crm/pipelines");
  }
  getCrmPipeline(id: string) {
    return this.request<{ data: any }>(`/crm/pipelines/${id}`);
  }
  createCrmPipeline(data: any) {
    return this.request<any>("/crm/pipelines", { method: "POST", body: JSON.stringify(data) });
  }
  updateCrmPipeline(id: string, data: any) {
    return this.request<any>(`/crm/pipelines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteCrmPipeline(id: string) {
    return this.request<{ success: boolean }>(`/crm/pipelines/${id}`, { method: "DELETE" });
  }

  // ── Pipeline Stages ──
  createCrmStage(pipelineId: string, data: any) {
    return this.request<any>(`/crm/pipelines/${pipelineId}/stages`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  updateCrmStage(id: string, data: any) {
    return this.request<any>(`/crm/stages/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  deleteCrmStage(id: string) {
    return this.request<{ success: boolean }>(`/crm/stages/${id}`, { method: "DELETE" });
  }

  // ── Deals ──
  getCrmDeals(params?: {
    pipelineId?: string;
    stageId?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const q = new URLSearchParams();
    if (params?.pipelineId) q.set("pipelineId", params.pipelineId);
    if (params?.stageId) q.set("stageId", params.stageId);
    if (params?.status) q.set("status", params.status);
    if (params?.search) q.set("search", params.search);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return this.request<{ data: any[]; pagination?: any }>(`/crm/deals?${q}`);
  }
  getCrmDeal(id: string) {
    return this.request<{ data: any }>(`/crm/deals/${id}`);
  }
  createCrmDeal(data: any) {
    return this.request<any>("/crm/deals", { method: "POST", body: JSON.stringify(data) });
  }
  updateCrmDeal(id: string, data: any) {
    return this.request<any>(`/crm/deals/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }
  deleteCrmDeal(id: string) {
    return this.request<{ success: boolean }>(`/crm/deals/${id}`, { method: "DELETE" });
  }
  moveCrmDeal(id: string, targetStageId: string) {
    return this.request<any>(`/crm/deals/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ targetStageId }),
    });
  }

  // ── Activities ──
  getCrmActivities(params?: {
    contactId?: string;
    companyId?: string;
    dealId?: string;
    type?: string;
    completed?: string;
    limit?: number;
    offset?: number;
  }) {
    const q = new URLSearchParams();
    if (params?.contactId) q.set("contactId", params.contactId);
    if (params?.companyId) q.set("companyId", params.companyId);
    if (params?.dealId) q.set("dealId", params.dealId);
    if (params?.type) q.set("type", params.type);
    if (params?.completed) q.set("completed", params.completed);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    return this.request<{ data: any[]; pagination?: any }>(`/crm/activities?${q}`);
  }
  getCrmActivity(id: string) {
    return this.request<{ data: any }>(`/crm/activities/${id}`);
  }
  createCrmActivity(data: any) {
    return this.request<any>("/crm/activities", { method: "POST", body: JSON.stringify(data) });
  }
  updateCrmActivity(id: string, data: any) {
    return this.request<any>(`/crm/activities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  completeCrmActivity(id: string, data?: { outcome?: string; notes?: string }) {
    return this.request<any>(`/crm/activities/${id}/complete`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    });
  }
  deleteCrmActivity(id: string) {
    return this.request<{ success: boolean }>(`/crm/activities/${id}`, { method: "DELETE" });
  }

  // ── Health ──
  // ── Directory ──
  getDirectoryOrganizations() {
    return this.request<{ docs: any[] }>("/directory/organizations");
  }
  getDirectoryDepartments() {
    return this.request<{ docs: any[] }>("/directory/departments");
  }
  getDirectoryPositions() {
    return this.request<{ docs: any[] }>("/directory/positions");
  }
  getDirectoryEmployees(params?: { limit?: number }) {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    return this.request<{ docs: any[] }>(`/directory/employees?${q}`);
  }
  createDirectoryOrganization(data: { name: string }) {
    return this.request<any>("/directory/organizations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  createDirectoryEmployee(data: any) {
    return this.request<any>("/directory/employees", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  getDirectoryOrgChart(organizationId: string) {
    return this.request<{ roots: any[] }>(`/directory/org-chart?organizationId=${organizationId}`);
  }

  // ── Booking ──
  getBookingRooms() {
    return this.request<{ docs: any[] }>("/booking/rooms");
  }
  getBookingRoomSlots(roomId: string, date: string, duration: number) {
    return this.request<{ slots: any[] }>(
      `/booking/rooms/${roomId}/slots?date=${date}&duration=${duration}`
    );
  }
  createBookingRoom(data: any) {
    return this.request<any>("/booking/rooms", { method: "POST", body: JSON.stringify(data) });
  }
  getBookingBookings(params?: {
    startAfter?: string;
    startBefore?: string;
    limit?: number;
    page?: number;
  }) {
    const q = new URLSearchParams();
    if (params?.startAfter) q.set("startAfter", params.startAfter);
    if (params?.startBefore) q.set("startBefore", params.startBefore);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.page) q.set("page", String(params.page));
    return this.request<{ docs: any[]; totalDocs: number }>(`/booking/bookings?${q}`);
  }
  getBookingBooking(id: string) {
    return this.request<any>(`/booking/bookings/${id}`);
  }
  createBooking(data: any) {
    return this.request<any>("/booking/bookings", { method: "POST", body: JSON.stringify(data) });
  }
  patchBookingBooking(id: string, data: any) {
    return this.request<any>(`/booking/bookings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  createBookingNote(id: string, note: string, isInternal: boolean) {
    return this.request<any>(`/booking/bookings/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ note, isInternal }),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // DMS (Document Management System)
  // ═══════════════════════════════════════════════════════════

  // ── Categories ──
  getDmsCategories() {
    return this.request<{ docs: any[] }>("/dms/categories");
  }
  getDmsCategoryTree() {
    return this.request<{ docs: any[] }>("/dms/categories/tree");
  }
  createDmsCategory(data: any) {
    return this.request<any>("/dms/categories", { method: "POST", body: JSON.stringify(data) });
  }

  // ── Documents ──
  getDmsDocuments(params?: {
    page?: number;
    limit?: number;
    categoryId?: string;
    status?: string;
    type?: string;
    search?: string;
  }) {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", String(params.page));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.categoryId) q.set("categoryId", params.categoryId);
    if (params?.status) q.set("status", params.status);
    if (params?.type) q.set("type", params.type);
    if (params?.search) q.set("search", params.search);
    return this.request<{ docs: any[]; pagination?: any }>(`/dms/documents?${q}`);
  }
  getDmsDocument(id: string, opts?: { versions?: boolean; relations?: boolean }) {
    const q = new URLSearchParams();
    if (opts?.versions) q.set("versions", "true");
    if (opts?.relations) q.set("relations", "true");
    return this.request<any>(`/dms/documents/${id}?${q}`);
  }
  createDmsDocument(data: any) {
    return this.request<any>("/dms/documents", { method: "POST", body: JSON.stringify(data) });
  }
  updateDmsDocument(id: string, data: any) {
    return this.request<any>(`/dms/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteDmsDocument(id: string) {
    return this.request<any>(`/dms/documents/${id}`, { method: "DELETE" });
  }
  cloneDmsDocumentFromTemplate(templateId: string) {
    return this.request<any>(`/dms/documents/from-template/${templateId}`, { method: "POST" });
  }
  getDmsDocumentBacklinks(id: string) {
    return this.request<{ docs: any[] }>(`/dms/documents/${id}/backlinks`);
  }

  // ── Versions ──
  getDmsVersions(documentId: string) {
    return this.request<{ docs: any[] }>(`/dms/documents/${documentId}/versions`);
  }
  createDmsVersion(documentId: string, data: any) {
    return this.request<any>(`/dms/documents/${documentId}/versions`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  updateDmsVersion(versionId: string, data: any) {
    return this.request<any>(`/dms/versions/${versionId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  submitDmsVersion(versionId: string) {
    return this.request<any>(`/dms/versions/${versionId}/submit`, { method: "POST" });
  }
  reviewDmsVersion(versionId: string, decision: "approved" | "changes_requested", notes?: string) {
    return this.request<any>(`/dms/versions/${versionId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, notes }),
    });
  }
  publishDmsVersion(versionId: string) {
    return this.request<any>(`/dms/versions/${versionId}/publish`, { method: "POST" });
  }

  // ── Comments ──
  getDmsComments(documentId: string) {
    return this.request<{ docs: any[] }>(`/dms/documents/${documentId}/comments`);
  }
  createDmsComment(documentId: string, data: any) {
    return this.request<any>(`/dms/documents/${documentId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  resolveDmsComment(commentId: string) {
    return this.request<any>(`/dms/comments/${commentId}/resolve`, { method: "POST" });
  }
  deleteDmsComment(commentId: string) {
    return this.request<any>(`/dms/comments/${commentId}`, { method: "DELETE" });
  }

  // ── Diagrams ──
  getDmsDiagrams(versionId: string) {
    return this.request<{ docs: any[] }>(`/dms/versions/${versionId}/diagrams`);
  }
  createDmsDiagram(versionId: string, data: any) {
    return this.request<any>(`/dms/versions/${versionId}/diagrams`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
  updateDmsDiagram(diagramId: string, data: any) {
    return this.request<any>(`/dms/diagrams/${diagramId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
  deleteDmsDiagram(diagramId: string) {
    return this.request<any>(`/dms/diagrams/${diagramId}`, { method: "DELETE" });
  }

  // ── Render / Search / Export ──
  renderDmsDocument(slug: string) {
    return this.request<any>(`/dms/render/${slug}`);
  }
  searchDms(q: string) {
    return this.request<{ docs: any[] }>(`/dms/search?q=${encodeURIComponent(q)}`);
  }
  exportDmsVersion(versionId: string, format: "html" | "md") {
    return this.request<string>(`/dms/versions/${versionId}/export/${format}`);
  }
  exportDmsCategoryZip(categoryId: string) {
    return this.request<Blob>(`/dms/categories/${categoryId}/export/zip`);
  }

  // ── Audit / Stats / Notifications ──
  getDmsAuditLog(documentId: string, limit?: number) {
    const q = new URLSearchParams();
    q.set("documentId", documentId);
    if (limit) q.set("limit", String(limit));
    return this.request<{ docs: any[] }>(`/dms/audit-log?${q}`);
  }
  getDmsStats() {
    return this.request<any>("/dms/stats");
  }
  getDmsNotifications(unreadOnly?: boolean) {
    const q = new URLSearchParams();
    if (unreadOnly) q.set("unreadOnly", "true");
    return this.request<{ docs: any[]; pagination?: any }>(`/dms/notifications?${q}`);
  }
  markDmsNotificationRead(id: string) {
    return this.request<any>(`/dms/notifications/${id}/read`, { method: "POST" });
  }
  markAllDmsNotificationsRead() {
    return this.request<any>("/dms/notifications/read-all", { method: "POST" });
  }

  health() {
    return this.request<{ status: string }>("/health");
  }
}

export const api = new ApiClient();
