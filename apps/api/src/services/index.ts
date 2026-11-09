// Re-exported from existing services — pure fetch, no Payload dependencies
export {
  searchGames,
  getGameById,
  getPopularGames,
  transformIGDBGame,
  isIGDBConfigured,
  type IGDBGame,
  type TransformedGameData,
} from "./igdb";
export {
  getStreamStatus,
  getUserInfo,
  isTwitchConfigured,
  type TwitchStreamData,
  type TwitchUserData,
} from "./twitch";
export { searchTrailers, getLatestVideos, isYouTubeConfigured, type YouTubeVideo } from "./youtube";
export { uploadFile, deleteFile, fileExists, getFile } from "../lib/storage";
