/**
 * Kitsuden Shared Constants
 */

export const SITE_CONFIG = {
  name: "Kitsuden",
  description: "High-Performance Gaming CMS",
  defaultLocale: "en",
  postsPerPage: 12,
  gamesPerPage: 24,
} as const;

export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export const NEON_COLORS = {
  cyan: "#00E5FF",
  pink: "#FF2A6D",
  green: "#76FF03",
  yellow: "#FFD600",
  purple: "#E040FB",
  orange: "#FF6D00",
} as const;

export const COLLECTION_SLUGS = {
  users: "users",
  games: "games",
  platforms: "platforms",
  blogPosts: "blog-posts",
  media: "media",
  tags: "tags",
  dataSets: "data-sets",
  dataEntries: "data-entries",
  streamers: "streamers",
} as const;
