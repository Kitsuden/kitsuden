/**
 * Kitsuden Shared Types
 * These types mirror the Drizzle schema for frontend use
 */

// ─── Page Block System ("Lego" Architecture) ──────────────────
export interface PageBlock {
  id: string;
  type: string;
  data: Record<string, any>;
  order: number;
  /**
   * Editorial layer (game blocks): what the team edits by hand, e.g.
   * with Inti. `data` belongs to the loaders and is regenerated on every reload; this
   * is not, and reloads keep it by `id`. See `BlockEditorial`.
   */
  editorial?: BlockEditorial;
}

/**
 * What is edited in a block without touching its `data`.
 *
 * Whoever draws uses `editorial.title ?? data.title`,
 * `editorial.description ?? data.description`, skips those with `hidden === true` and
 * sorts by `editorial.order ?? order`. Without `editorial`, everything as before.
 * (Up to 0.8 these keys were `titulo`, `descripcion`, `oculto`, `orden`: see `block-keys.ts`.)
 */
export interface BlockEditorial {
  title?: string;
  description?: string;
  hidden?: boolean;
  order?: number;
}

// ─── Media ────────────────────────────────────────────────────
export interface SEOMeta {
  title?: string;
  description?: string;
  image?: MediaItem;
  canonicalUrl?: string;
  noIndex?: boolean;
}

export interface MediaItem {
  id: string;
  url: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  sizes?: {
    thumbnail?: { url: string; width: number; height: number };
    card?: { url: string; width: number; height: number };
    hero?: { url: string; width: number; height: number };
    og?: { url: string; width: number; height: number };
  };
}

// ─── Core Entities ────────────────────────────────────────────
export interface Platform {
  id: string;
  name: string;
  slug: string;
  shortName?: string;
  manufacturer?: string;
  icon?: MediaItem;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
  color?: string;
  category?: "genre" | "feature" | "topic" | "series";
}

export interface Game {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  description?: unknown; // Lexical JSON
  excerpt?: string;
  releaseDate?: string;
  status: "draft" | "published" | "archived";
  platforms?: Platform[];
  tags?: Tag[];
  developer?: string;
  publisher?: string;
  metacriticScore?: number;
  userRating?: number;
  coverArt?: MediaItem;
  screenshots?: Array<{ image: MediaItem; caption?: string }>;
  externalIds?: {
    igdbId?: number;
    steamAppId?: number;
    twitchGameId?: string;
  };
  trailerUrl?: string;
  streamers?: Streamer[];
  blocks?: PageBlock[];
}

export interface BlogPost {
  id: string;
  title: string;
  slug: string;
  content: unknown; // Lexical JSON
  excerpt?: string;
  status: "draft" | "published" | "scheduled";
  publishedAt?: string;
  /**
   * When the content last changed.
   *
   * The API already sent it —the by-slug route returns the whole row— and it was not
   * declared here, so nobody used it: guides came out with `Article`
   * without `dateModified` even if they had been entirely rewritten that same day.
   */
  updatedAt?: string;
  author: {
    id: string;
    displayName: string;
    avatar?: MediaItem;
  };
  tags?: Tag[];
  relatedGames?: Game[];
  featuredImage?: MediaItem;
  readingTime?: number;
  seoOverrides?: {
    canonicalUrl?: string;
    noIndex?: boolean;
    structuredDataType?: string;
  };
  meta?: SEOMeta;
  blocks?: PageBlock[];
}

/**
 * Defines the structure of a Vertical (App) installed on top of Kitsuden Core.
 * @example
 * export default defineApp({ id: 'kitsuden-cms', name: 'Gaming CMS' ... })
 */
export interface AppManifest {
  /** The app's unique identifier (slug). It will be used to mount routes at /api/apps/:id */
  id: string;

  /**
   * The dynamic schemas this app will inject into the core database.
   * These schemas will be stored inside the JSONB of `data_entries`.
   */
  schemas: SchemaDefinition[];

  /**
   * Visual blocks specific to this vertical that will be exposed to Inti.js.
   * E.g.: 'tournament-bracket', 'twitch-player'.
   */
  blocks?: any[];
}

/**
 * Defines the dynamic structure of a table or collection injected by a Vertical.
 * It tells the AppRegistry how to validate and structure the data in the JSONB.
 */
export interface SchemaDefinition {
  /** The internal name of the field that will be used as the key in the JSONB */
  fieldName: string;
  /** The visual and structural data type (string, number, relation, boolean, etc.) */
  fieldType: string;
  /** Determines whether the field is strict and required when saving */
  required?: boolean;
  /** Extra settings such as option selectors, references to other tables, etc. */
  options?: string;
  /** Default initial value when instantiating a new record */
  defaultValue?: string;
}

export interface DataSet {
  id: string;
  name: string;
  slug: string;
  description?: string;
  game: Game;
  icon?: string;
  schema: SchemaDefinition[];
  displayConfig?: {
    titleField?: string;
    sortField?: string;
    sortDirection?: "asc" | "desc";
  };
}

/**
 * Master Persistence Contract (DataEntry).
 * Represents a dynamic data record coming from a Vertical,
 * serialized and stored globally in JSONB format.
 */
export interface DataEntry {
  /** Unique record ID (UUID) */
  id: string;
  /** Representative record title for the admin panel */
  title: string;
  /** The schema/dataset this entry belongs to, indicating which Vertical controls it */
  dataSet: DataSet;
  /** Dynamic JSONB payload with the actual data of the Vertical's structure */
  data: Record<string, unknown>;
  /** Optional thumbnail image to show in grids/lists */
  thumbnail?: MediaItem;
  /** Relative sort position of the record */
  sortOrder?: number;
  /** Publication status (Draft or Published) */
  status: "draft" | "published";
}

export interface Streamer {
  id: string;
  displayName: string;
  slug: string;
  platform: "twitch" | "youtube" | "kick";
  channelId: string;
  channelUrl?: string;
  isLive?: boolean;
  currentStreamTitle?: string;
  viewerCount?: number;
  followerCount?: number;
  avatar?: MediaItem;
  thumbnailUrl?: string;
  games?: Game[];
  lastSyncedAt?: string;
}

export interface SiteSettings {
  siteName: string;
  siteDescription?: string;
  siteUrl: string;
  branding?: {
    logo?: MediaItem;
    favicon?: MediaItem;
    ogImage?: MediaItem;
    primaryColor?: string;
    accentColor?: string;
  };
  mainNav?: Array<{
    label: string;
    url: string;
    openInNewTab?: boolean;
  }>;
  social?: {
    twitter?: string;
    discord?: string;
    youtube?: string;
    twitch?: string;
    github?: string;
  };
  analytics?: {
    googleAnalyticsId?: string;
    plausibleDomain?: string;
  };
  footerText?: string;
}

// PaginatedResponse is defined and exported from utils.ts
export type { PaginatedResponse } from "./utils";
