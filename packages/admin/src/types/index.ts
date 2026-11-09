// ── Core Entity Types ──

export interface Game {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  description?: any;
  excerpt?: string;
  releaseDate?: string;
  status: "draft" | "published" | "archived";
  developer?: string;
  publisher?: string;
  metacriticScore?: number;
  userRating?: number;
  coverArtId?: string;
  coverArt?: Media;
  trailerUrl?: string;
  externalIds?: { igdbId?: number; steamAppId?: number };
  specs?: any;
  screenshots?: any;
  platforms?: Platform[];
  tags?: Tag[];
  streamers?: Streamer[];
  createdAt: string;
  updatedAt: string;
}

export interface BlogPost {
  id: string;
  title: string;
  slug: string;
  content?: any;
  excerpt?: string;
  status: "draft" | "published" | "scheduled";
  publishedAt?: string;
  authorId: string;
  author?: User;
  featuredImageId?: string;
  featuredImage?: Media;
  readingTime?: number;
  seoOverrides?: SEOData;
  tags?: Tag[];
  relatedGames?: Game[];

  /** Is the thread open? Absent on posts predating the column: that means open. */
  commentsEnabled?: boolean;

  /**
   * What this article's thread hangs from, already resolved by the API.
   *
   * It travels here so that whoever renders the post does not compose the string on
   * their own: `post`, `blog_post` and `blogpost` would open three different threads
   * on the same article without giving any error.
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

export interface SEOData {
  title?: string;
  description?: string;
  ogImage?: string;
  canonicalUrl?: string;
  noIndex?: boolean;
  structuredData?: "game-review" | "article" | "faq";
}

export interface Platform {
  id: string;
  name: string;
  slug: string;
  shortName?: string;
  manufacturer?: string;
  iconId?: string;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
  color?: string;
  category?: "genre" | "feature" | "topic" | "series";
  createdAt: string;
}

export interface Media {
  id: string;
  filename: string;
  mimeType: string;
  s3Key: string;
  url: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
  size?: number;
  uploadedById?: string;
  createdAt: string;
}

export interface Streamer {
  id: string;
  displayName: string;
  slug: string;
  platform: "twitch" | "youtube" | "kick";
  channelId: string;
  channelUrl?: string;
  isLive: boolean;
  currentStreamTitle?: string;
  viewerCount: number;
  followerCount: number;
  avatarId?: string;
  thumbnailUrl?: string;
  lastSyncedAt?: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "editor" | "viewer";
  avatarId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataSet {
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  schema: DataSetColumn[];
  displayConfig?: any;
  createdAt: string;
}

export interface DataSetColumn {
  key: string;
  label: string;
  type: "text" | "number" | "image" | "url" | "boolean" | "select" | "relation";
  options?: string[];
  required?: boolean;
}

export interface DataEntry {
  id: string;
  title: string;
  dataSetId: string;
  data: Record<string, any>;
  thumbnailId?: string;
  sortOrder: number;
  status: "draft" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface SiteSettings {
  id: string;
  siteName: string;
  siteDescription?: string;
  siteUrl: string;
  branding?: any;
  mainNav?: any;
  social?: any;
  analytics?: any;
  footerText?: string;
  updatedAt: string;
}

// ── API Response Types ──

export interface PaginatedResponse<T> {
  docs: T[];
  totalDocs: number;
  totalPages?: number;
  page?: number;
  limit?: number;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
}

export interface AuthResponse {
  token: string;
  user: User;
}
