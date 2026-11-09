/**
 * IGDB Service - Internet Game Database integration
 * Uses IGDB API v4 (Twitch-authenticated)
 */

const IGDB_API_URL = "https://api.igdb.com/v4";

/** IGDB Platform data */
interface IGDBPlatform {
  name: string;
  abbreviation: string;
}

/** IGDB Genre data */
interface IGDBGenre {
  name: string;
}

/** IGDB Cover data */
interface IGDBCover {
  url: string;
}

/** IGDB Screenshot data */
interface IGDBScreenshot {
  url: string;
}

/** IGDB Video data */
interface IGDBVideo {
  video_id: string;
  name: string;
}

/** IGDB Game data structure */
export interface IGDBGame {
  id: number;
  name: string;
  slug: string;
  summary?: string;
  storyline?: string;
  rating?: number;
  aggregated_rating?: number;
  first_release_date?: number;
  cover?: IGDBCover;
  platforms?: IGDBPlatform[];
  genres?: IGDBGenre[];
  screenshots?: IGDBScreenshot[];
  videos?: IGDBVideo[];
}

/** Transformed game data */
export interface TransformedGameData {
  title: string;
  slug: string;
  excerpt: string | undefined;
  metacriticScore: number | undefined;
  releaseDate: string | undefined;
  externalIds: { igdbId: number };
  trailerUrl: string | undefined;
}

// IGDB Token types
interface IGDBTokenResponse {
  access_token: string;
  expires_in: number;
}

interface IGDBTokenCache {
  access_token: string;
  expires_at: number;
}

let igdbToken: IGDBTokenCache | null = null;

async function getIGDBToken(): Promise<string> {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("IGDB credentials not configured");
  if (igdbToken && igdbToken.expires_at > Date.now()) return igdbToken.access_token;

  const response = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: "POST" }
  );
  const data = (await response.json()) as IGDBTokenResponse;
  igdbToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
  };
  return igdbToken.access_token;
}

async function igdbQuery<T>(endpoint: string, body: string): Promise<T[]> {
  const token = await getIGDBToken();
  const response = await fetch(`${IGDB_API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": process.env.IGDB_CLIENT_ID!,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    },
    body,
  });
  if (!response.ok) throw new Error(`IGDB API error: ${response.status}`);
  return response.json() as Promise<T[]>;
}

export async function searchGames(query: string, limit = 10): Promise<IGDBGame[]> {
  return igdbQuery<IGDBGame>(
    "/games",

    `search "${query}"; fields name,slug,summary,rating,aggregated_rating,first_release_date,cover.url,platforms.name,platforms.abbreviation,genres.name,screenshots.url,videos.video_id,videos.name; limit ${limit};`
  );
}

export async function getGameById(id: number): Promise<IGDBGame | null> {
  const results = await igdbQuery<IGDBGame>(
    "/games",

    `where id = ${id}; fields name,slug,summary,storyline,rating,aggregated_rating,first_release_date,cover.url,platforms.name,platforms.abbreviation,genres.name,screenshots.url,videos.video_id,videos.name;`
  );
  return results[0] || null;
}

export async function getPopularGames(limit = 20): Promise<IGDBGame[]> {
  const sixMonthsAgo = Math.floor(Date.now() / 1000) - 6 * 30 * 24 * 60 * 60;
  return igdbQuery<IGDBGame>(
    "/games",

    `where first_release_date > ${sixMonthsAgo} & rating > 70; fields name,slug,summary,rating,aggregated_rating,first_release_date,cover.url,platforms.name,genres.name; sort rating desc; limit ${limit};`
  );
}

export function transformIGDBGame(igdbGame: IGDBGame): TransformedGameData {
  return {
    title: igdbGame.name,
    slug: igdbGame.slug,
    excerpt: igdbGame.summary?.slice(0, 300),
    metacriticScore: igdbGame.aggregated_rating
      ? Math.round(igdbGame.aggregated_rating)
      : undefined,
    releaseDate: igdbGame.first_release_date
      ? new Date(igdbGame.first_release_date * 1000).toISOString().split("T")[0]
      : undefined,
    externalIds: { igdbId: igdbGame.id },
    trailerUrl: igdbGame.videos?.[0]
      ? `https://www.youtube.com/watch?v=${igdbGame.videos[0].video_id}`
      : undefined,
  };
}

export function isIGDBConfigured(): boolean {
  return Boolean(process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET);
}
