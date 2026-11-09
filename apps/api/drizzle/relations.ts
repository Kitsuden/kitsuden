// @ts-nocheck
import { relations } from "drizzle-orm/relations";
import {
  authUsers,
  apiKeys,
  authAccounts,
  authSessions,
  blogPosts,
  media,
  blogPostsToGames,
  games,
  blogPostsToTags,
  tags,
  dataSets,
  dataEntries,
  kitsudenFunctions,
  functionExecutions,
  gameCollections,
  gameCollectionEntries,
  gamesToPlatforms,
  platforms,
  gamesToStreamers,
  streamers,
  gamesToTags,
  users,
  aiMemories,
  aiMemoryChunks,
  rooms,
  reservations,
  documents,
  documentVersions,
  academyCourses,
  academyEnrollments,
  academyQuizzes,
  academyQuestions,
  academyQuizAttempts,
  academySatisfactionSurveys,
  academyTopics,
  academyUserProgress,
  webhooksConfig,
  webhooksLog,
  contentMetadata,
  agentTraces,
  agentTraceSteps,
  agentFeedback,
  roomAmenities,
  amenities,
} from "./schema";

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [apiKeys.createdById],
    references: [authUsers.id],
  }),
}));

export const authUsersRelations = relations(authUsers, ({ many }) => ({
  apiKeys: many(apiKeys),
  authAccounts: many(authAccounts),
  authSessions: many(authSessions),
  blogPosts: many(blogPosts),
  media: many(media),
  dataEntries: many(dataEntries),
  kitsudenFunctions: many(kitsudenFunctions),
  contentMetadata: many(contentMetadata),
  agentFeedbacks: many(agentFeedback),
}));

export const authAccountsRelations = relations(authAccounts, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [authAccounts.userId],
    references: [authUsers.id],
  }),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  authUser: one(authUsers, {
    fields: [authSessions.userId],
    references: [authUsers.id],
  }),
}));

export const blogPostsRelations = relations(blogPosts, ({ one, many }) => ({
  authUser: one(authUsers, {
    fields: [blogPosts.authorId],
    references: [authUsers.id],
  }),
  media: one(media, {
    fields: [blogPosts.featuredImageId],
    references: [media.id],
  }),
  blogPostsToGames: many(blogPostsToGames),
  blogPostsToTags: many(blogPostsToTags),
}));

export const mediaRelations = relations(media, ({ one, many }) => ({
  blogPosts: many(blogPosts),
  authUser: one(authUsers, {
    fields: [media.uploadedById],
    references: [authUsers.id],
  }),
  games: many(games),
  dataEntries: many(dataEntries),
  platforms: many(platforms),
  streamers: many(streamers),
  users: many(users),
  contentMetadata: many(contentMetadata),
}));

export const blogPostsToGamesRelations = relations(blogPostsToGames, ({ one }) => ({
  blogPost: one(blogPosts, {
    fields: [blogPostsToGames.postId],
    references: [blogPosts.id],
  }),
  game: one(games, {
    fields: [blogPostsToGames.gameId],
    references: [games.id],
  }),
}));

export const gamesRelations = relations(games, ({ one, many }) => ({
  blogPostsToGames: many(blogPostsToGames),
  media: one(media, {
    fields: [games.coverArtId],
    references: [media.id],
  }),
  dataSets: many(dataSets),
  gameCollectionEntries: many(gameCollectionEntries),
  gamesToPlatforms: many(gamesToPlatforms),
  gamesToStreamers: many(gamesToStreamers),
  gamesToTags: many(gamesToTags),
}));

export const blogPostsToTagsRelations = relations(blogPostsToTags, ({ one }) => ({
  blogPost: one(blogPosts, {
    fields: [blogPostsToTags.postId],
    references: [blogPosts.id],
  }),
  tag: one(tags, {
    fields: [blogPostsToTags.tagId],
    references: [tags.id],
  }),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  blogPostsToTags: many(blogPostsToTags),
  gamesToTags: many(gamesToTags),
}));

export const dataSetsRelations = relations(dataSets, ({ one, many }) => ({
  game: one(games, {
    fields: [dataSets.gameId],
    references: [games.id],
  }),
  dataEntries: many(dataEntries),
  kitsudenFunctions: many(kitsudenFunctions),
  webhooksConfigs: many(webhooksConfig),
}));

export const dataEntriesRelations = relations(dataEntries, ({ one, many }) => ({
  dataSet: one(dataSets, {
    fields: [dataEntries.dataSetId],
    references: [dataSets.id],
  }),
  authUser: one(authUsers, {
    fields: [dataEntries.ownerId],
    references: [authUsers.id],
  }),
  media: one(media, {
    fields: [dataEntries.thumbnailId],
    references: [media.id],
  }),
  contentMetadata: many(contentMetadata),
}));

export const kitsudenFunctionsRelations = relations(kitsudenFunctions, ({ one, many }) => ({
  dataSet: one(dataSets, {
    fields: [kitsudenFunctions.watchDatasetId],
    references: [dataSets.id],
  }),
  authUser: one(authUsers, {
    fields: [kitsudenFunctions.createdById],
    references: [authUsers.id],
  }),
  functionExecutions: many(functionExecutions),
}));

export const functionExecutionsRelations = relations(functionExecutions, ({ one }) => ({
  kitsudenFunction: one(kitsudenFunctions, {
    fields: [functionExecutions.functionId],
    references: [kitsudenFunctions.id],
  }),
}));

export const gameCollectionEntriesRelations = relations(gameCollectionEntries, ({ one }) => ({
  gameCollection: one(gameCollections, {
    fields: [gameCollectionEntries.collectionId],
    references: [gameCollections.id],
  }),
  game: one(games, {
    fields: [gameCollectionEntries.gameId],
    references: [games.id],
  }),
}));

export const gameCollectionsRelations = relations(gameCollections, ({ many }) => ({
  gameCollectionEntries: many(gameCollectionEntries),
}));

export const gamesToPlatformsRelations = relations(gamesToPlatforms, ({ one }) => ({
  game: one(games, {
    fields: [gamesToPlatforms.gameId],
    references: [games.id],
  }),
  platform: one(platforms, {
    fields: [gamesToPlatforms.platformId],
    references: [platforms.id],
  }),
}));

export const platformsRelations = relations(platforms, ({ one, many }) => ({
  gamesToPlatforms: many(gamesToPlatforms),
  media: one(media, {
    fields: [platforms.iconId],
    references: [media.id],
  }),
}));

export const gamesToStreamersRelations = relations(gamesToStreamers, ({ one }) => ({
  game: one(games, {
    fields: [gamesToStreamers.gameId],
    references: [games.id],
  }),
  streamer: one(streamers, {
    fields: [gamesToStreamers.streamerId],
    references: [streamers.id],
  }),
}));

export const streamersRelations = relations(streamers, ({ one, many }) => ({
  gamesToStreamers: many(gamesToStreamers),
  media: one(media, {
    fields: [streamers.avatarId],
    references: [media.id],
  }),
}));

export const gamesToTagsRelations = relations(gamesToTags, ({ one }) => ({
  game: one(games, {
    fields: [gamesToTags.gameId],
    references: [games.id],
  }),
  tag: one(tags, {
    fields: [gamesToTags.tagId],
    references: [tags.id],
  }),
}));

export const usersRelations = relations(users, ({ one }) => ({
  media: one(media, {
    fields: [users.avatarId],
    references: [media.id],
  }),
}));

export const aiMemoryChunksRelations = relations(aiMemoryChunks, ({ one }) => ({
  aiMemory: one(aiMemories, {
    fields: [aiMemoryChunks.memoryId],
    references: [aiMemories.id],
  }),
}));

export const aiMemoriesRelations = relations(aiMemories, ({ many }) => ({
  aiMemoryChunks: many(aiMemoryChunks),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  room: one(rooms, {
    fields: [reservations.roomId],
    references: [rooms.id],
  }),
}));

export const roomsRelations = relations(rooms, ({ many }) => ({
  reservations: many(reservations),
  roomAmenities: many(roomAmenities),
}));

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}));

export const documentsRelations = relations(documents, ({ many }) => ({
  documentVersions: many(documentVersions),
}));

export const academyEnrollmentsRelations = relations(academyEnrollments, ({ one }) => ({
  academyCourse: one(academyCourses, {
    fields: [academyEnrollments.courseId],
    references: [academyCourses.id],
  }),
}));

export const academyCoursesRelations = relations(academyCourses, ({ many }) => ({
  academyEnrollments: many(academyEnrollments),
  academyQuizzes: many(academyQuizzes),
  academySatisfactionSurveys: many(academySatisfactionSurveys),
  academyTopics: many(academyTopics),
  academyUserProgresses: many(academyUserProgress),
}));

export const academyQuizzesRelations = relations(academyQuizzes, ({ one, many }) => ({
  academyCourse: one(academyCourses, {
    fields: [academyQuizzes.courseId],
    references: [academyCourses.id],
  }),
  academyQuestions: many(academyQuestions),
  academyQuizAttempts: many(academyQuizAttempts),
}));

export const academyQuestionsRelations = relations(academyQuestions, ({ one }) => ({
  academyQuizz: one(academyQuizzes, {
    fields: [academyQuestions.quizId],
    references: [academyQuizzes.id],
  }),
}));

export const academyQuizAttemptsRelations = relations(academyQuizAttempts, ({ one }) => ({
  academyQuizz: one(academyQuizzes, {
    fields: [academyQuizAttempts.quizId],
    references: [academyQuizzes.id],
  }),
}));

export const academySatisfactionSurveysRelations = relations(
  academySatisfactionSurveys,
  ({ one }) => ({
    academyCourse: one(academyCourses, {
      fields: [academySatisfactionSurveys.courseId],
      references: [academyCourses.id],
    }),
  })
);

export const academyTopicsRelations = relations(academyTopics, ({ one, many }) => ({
  academyCourse: one(academyCourses, {
    fields: [academyTopics.courseId],
    references: [academyCourses.id],
  }),
  academyUserProgresses: many(academyUserProgress),
}));

export const academyUserProgressRelations = relations(academyUserProgress, ({ one }) => ({
  academyTopic: one(academyTopics, {
    fields: [academyUserProgress.topicId],
    references: [academyTopics.id],
  }),
  academyCourse: one(academyCourses, {
    fields: [academyUserProgress.courseId],
    references: [academyCourses.id],
  }),
}));

export const webhooksConfigRelations = relations(webhooksConfig, ({ one, many }) => ({
  dataSet: one(dataSets, {
    fields: [webhooksConfig.datasetId],
    references: [dataSets.id],
  }),
  webhooksLogs: many(webhooksLog),
}));

export const webhooksLogRelations = relations(webhooksLog, ({ one }) => ({
  webhooksConfig: one(webhooksConfig, {
    fields: [webhooksLog.webhookId],
    references: [webhooksConfig.id],
  }),
}));

export const contentMetadataRelations = relations(contentMetadata, ({ one }) => ({
  dataEntry: one(dataEntries, {
    fields: [contentMetadata.entryId],
    references: [dataEntries.id],
  }),
  media: one(media, {
    fields: [contentMetadata.featuredImageId],
    references: [media.id],
  }),
  authUser: one(authUsers, {
    fields: [contentMetadata.authorId],
    references: [authUsers.id],
  }),
}));

export const agentTraceStepsRelations = relations(agentTraceSteps, ({ one }) => ({
  agentTrace: one(agentTraces, {
    fields: [agentTraceSteps.traceId],
    references: [agentTraces.id],
  }),
}));

export const agentTracesRelations = relations(agentTraces, ({ many }) => ({
  agentTraceSteps: many(agentTraceSteps),
  agentFeedbacks: many(agentFeedback),
}));

export const agentFeedbackRelations = relations(agentFeedback, ({ one }) => ({
  agentTrace: one(agentTraces, {
    fields: [agentFeedback.traceId],
    references: [agentTraces.id],
  }),
  authUser: one(authUsers, {
    fields: [agentFeedback.providedBy],
    references: [authUsers.id],
  }),
}));

export const roomAmenitiesRelations = relations(roomAmenities, ({ one }) => ({
  room: one(rooms, {
    fields: [roomAmenities.roomId],
    references: [rooms.id],
  }),
  amenity: one(amenities, {
    fields: [roomAmenities.amenityId],
    references: [amenities.id],
  }),
}));

export const amenitiesRelations = relations(amenities, ({ many }) => ({
  roomAmenities: many(roomAmenities),
}));
