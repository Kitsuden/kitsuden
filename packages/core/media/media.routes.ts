/**
 * Media Library — its operations (kon SDK)
 *
 * Uploads and management of the media library. Each route is a DECLARED operation
 * (`defineOperation`): the REST route, its OpenAPI and its MCP
 * tool come from it (docs/kons/README.md); the schemas are in `media.wire-schemas.ts`. The
 * permission of each one (the `media` policy) is declared in `permission` instead
 * of being mounted with `requireMedia`.
 *
 * ⚠️ CRITICAL: Route order matters in Hono!
 * Specific routes must be registered BEFORE parameterized routes.
 * Example: `/folders` must come before `/:id`
 */

import { randomBytes } from "node:crypto";

import {
  can,
  withSavepoint,
  defineOperation,
  isUuid,
  messageOf,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, desc, ilike, like, sql } from "drizzle-orm";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { StorageConfig } from "./config.schema";
import { MediaKonConfig, defaultMediaConfig, validateMediaConfig } from "./config.schema";
import { measureImage } from "./image-metadata";
import { media, mediaFolders } from "./media.schema";
import {
  Dir,
  InputDir,
  InputConfig,
  Configuration,
  SavedConfiguration,
  Success,
  DirsList,
  MediaList,
  Media,
  MediaChanges,
  MediaWithUrl,
  ParamId,
  StoreTest,
  ListQuery,
  UploadQuery,
  TestResult,
  UploadResult,
  Upload,
} from "./media.wire-schemas";
import "./media.policy";
import { detectRealType, safeName } from "./real-type";
import { testStorageConnection } from "./storage.adapter";

/** Maximum size of ONE file. */
export const MAX_BYTES_PER_FILE = 10 * 1024 * 1024;
/** Files per upload request. */
export const MAX_FILES_PER_UPLOAD = 20;

const userOf = (c: Context): AuthzUser | null =>
  ((c as unknown as { get(k: string): unknown }).get("user") ?? null) as AuthzUser | null;

/**
 * Middleware: requires the `action` action of the "media" policy.
 *
 * The kon authorizes itself. Before it only asked for a session (`requireAuth`), and
 * sign-up is public: the only thing stopping any account was the prefix
 * rule in `auth-guard.ts`, and nobody stopped the READS (listing, detail, folders,
 * configuration with credentials).
 */
export function requireMedia(action: "view" | "create" | "update" | "delete" | "configure") {
  return async (c: Context, next: Next) => {
    const user = userOf(c);
    if (await can(user, action, {}, "media")) return next();
    return user ? c.json({ error: "Forbidden" }, 403) : c.json({ error: "Unauthorized" }, 401);
  };
}

/** The kon's id: part of each operation's fine-grained scope (`kon:media:<op>`). */
export const KON_ID = "kon-media";

/**
 * The media library operations, with the kon context injected.
 */
export function mediaOperations(ctx: KonContext): AnyOperation[] {
  const ops: AnyOperation[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST & BROWSE (specific routes first)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET / - List all media files
   */
  ops.push(
    defineOperation({
      id: "list-media",
      method: "GET",
      route: "/",
      summary: "List media files",
      description:
        "The media library (staff only): newest first, filterable by folder, MIME prefix and file name. Each item carries its public URL.",
      access: "public",
      permission: { policy: { resource: "media", action: "view" } },
      input: { query: ListQuery },
      output: { schema: MediaList },
      handle: async (_input, { c }) => {
        const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
        const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
        const folderId = c.req.query("folderId");
        const search = c.req.query("search");
        const type = c.req.query("type"); // image, video, document

        // The three conditions accumulate and `.where()` is called ONCE.
        //
        // Before they were three chained `.where()` calls on the same builder, and in
        // Drizzle that does not add up: each one replaces the previous. With
        // `?folderId=X&type=image` the folder was ignored and the library returned
        // images from ALL of them — the filter that got lost was the one that organizes.
        const conditions = [];
        if (folderId) conditions.push(eq(media.folderId, folderId));
        if (type) conditions.push(like(media.mimeType, `${type}/%`));
        // `ilike` and not `like`: in Postgres `like` is case-SENSITIVE, so
        // searching "Logo" did not find `logo.png` and searching "PNG" did not find
        // `.png`. Search looked broken exactly when typed the way
        // anyone types it. The `type` filter can stay with `like`: it is composed
        // by the server, not by a person.
        if (search) conditions.push(ilike(media.filename, `%${search.slice(0, 200)}%`));

        const docs = await ctx.db.instance
          .select()
          .from(media)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(media.createdAt))
          .limit(limit)
          .offset(offset);

        // Generate signed URLs for private files
        const docsWithUrls = await Promise.all(
          docs.map(async (doc: any) => {
            let url = doc.publicUrl;

            // If no public URL, generate signed URL
            if (!url) {
              try {
                url = await ctx.storage.getSignedDownloadUrl(doc.key, 3600);
              } catch {
                url = null;
              }
            }

            return {
              ...doc,
              url,
            };
          })
        );

        return c.json({ docs: docsWithUrls, totalDocs: docs.length });
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // UPLOAD (specific route before /:id)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /upload - Upload file(s)
   */
  ops.push(
    defineOperation({
      id: "upload-media",
      method: "POST",
      route: "/upload",
      summary: "Upload files",
      description:
        "Uploads up to 20 files (10 MB each) in the multipart field `files`. The type is detected from the bytes (JPEG, PNG, GIF, WebP, AVIF, MP4, WebM or PDF); anything else is refused per file. 201 when all were stored, 207 when some failed.",
      access: "session",
      permission: { policy: { resource: "media", action: "create" } },
      // The whole body is read into memory when parsing: it is cut off BEFORE reading it
      // (Bun accepts 128 MB per request by default).
      before: [
        bodyLimit({
          maxSize: MAX_FILES_PER_UPLOAD * MAX_BYTES_PER_FILE + 1024 * 1024,
          onError: (c) => c.json({ error: "Upload too large" }, 413),
        }),
      ],
      input: { query: UploadQuery, body: Upload, format: "multipart" },
      output: { status: 201, schema: UploadResult },
      errors: ["KITSUDEN_E_PAYLOAD_TOO_LARGE"],
      mcp: { exclude: "multipart file upload: MCP tool arguments are JSON, not file streams" },
      handle: async (_input, { c }) => {
        const folderId = c.req.query("folderId");
        const generateThumbnails = c.req.query("thumbnails") !== "false";
        if (folderId && !isUuid(folderId)) return c.json({ error: "folderId is not valid" }, 400);

        try {
          const body = await c.req.parseBody({ all: true });
          const files = body.files;

          if (!files) {
            return c.json({ error: "No files provided" }, 400);
          }

          const uploadedFiles = Array.isArray(files) ? files : [files];
          if (uploadedFiles.length > MAX_FILES_PER_UPLOAD) {
            return c.json({ error: `At most ${MAX_FILES_PER_UPLOAD} files per upload` }, 400);
          }
          const user = userOf(c);
          /**
           * Who uploaded it. `created_by_id` points to `auth_users`, and an AGENT
           * is not an account: storing its id broke the INSERT (foreign key) and
           * no agent upload ever reached the media library (uncovered by
           * image approval). For an agent: its human SIGNER
           * if it has one and is valid (docs/agents/approvals.md, "Human
           * signer"), otherwise nobody; and the agent is kept in `metadata.agentId`.
           */
          const isAgent = (user as { role?: unknown } | null)?.role === "agent";
          const signer = (user as { sponsor?: { userId?: unknown; valid?: unknown } | null } | null)
            ?.sponsor;
          const uploadAuthor = isAgent
            ? signer?.valid === true && typeof signer.userId === "string"
              ? signer.userId
              : null
            : user?.id
              ? String(user.id)
              : null;

          /**
           * ── TWO PHASES: first the store, then the database ─────────────────
           *
           * Uploading to S3 and measuring the image are long calls that do not need the
           * database, and the request runs in ONE transaction (RLS): doing them between one
           * insert and the next kept the connection busy waiting on the network.
           * Now all the files are saved and AFTER that the rows are inserted
           * (kon SDK rule 3: external things go outside the transaction).
           *
           * And each insert goes in its own SAVEPOINT (`withSavepoint`): before, the
           * `catch` of a failed insert swallowed the SQL error with the
           * transaction already aborted, and ALL the following inserts failed
           * too (rule 2: do not swallow an SQL error in the transaction).
           */
          type Result = Record<string, unknown> & { filename: string; success: boolean };
          const results: Result[] = [];
          const pendingItems: {
            index: number;
            name: string;
            safeName: string;
            type: string;
            saved: { key: string; url: string; bytes: number };
            width?: number;
            height?: number;
          }[] = [];

          for (const file of uploadedFiles) {
            if (!(file instanceof File)) continue;

            // Validate file size (10MB limit)
            if (file.size > MAX_BYTES_PER_FILE) {
              results.push({
                filename: file.name,
                success: false,
                error: "File too large (max 10MB)",
              });
              continue;
            }

            try {
              const content = Buffer.from(await file.arrayBuffer());

              // The type comes from the CONTENT, not from the `Content-Type` or the name the
              // client sends (see real-type.ts). SVG, HTML and the like: out.
              const type = detectRealType(content);
              if (!type) {
                results.push({
                  filename: file.name,
                  success: false,
                  error: "File type not allowed (JPEG, PNG, GIF, WebP, AVIF, MP4, WebM or PDF)",
                });
                continue;
              }

              // Unique key: the time alone let two uploads with the same name
              // in the same millisecond overwrite each other. The `uploads/<ms>_` prefix is
              // kept (`mediaCache` uses it to mark it immutable).
              const storedName = safeName(file.name, type);
              const key = `uploads/${Date.now()}_${randomBytes(6).toString("hex")}_${storedName}`;

              // Save directly with `put` (same on local disk as on S3).
              // The buffer is reused for measuring: `file.arrayBuffer()` would read the
              // whole file again.
              const saved = await ctx.storage.put(key, content, type.mime);

              /**
               * Dimensions. They are measured AFTER saving, on purpose: saving
               * is what cannot be lost; measuring is an improvement.
               */
              const measures = await measureImage(content, type.mime);

              results.push({ filename: file.name, success: false });
              pendingItems.push({
                index: results.length - 1,
                name: file.name,
                safeName: storedName,
                type: type.mime,
                saved,
                width: measures?.width,
                height: measures?.height,
              });
            } catch (err: unknown) {
              results.push({
                filename: file.name,
                success: false,
                error: messageOf(err),
              });
            }
          }

          for (const p of pendingItems) {
            try {
              const [doc]: (typeof media.$inferSelect)[] = await withSavepoint(async () =>
                ctx.db.instance
                  .insert(media)
                  .values({
                    filename: p.safeName,
                    originalName: String(p.name).normalize("NFKC").slice(0, 500),
                    mimeType: p.type,
                    size: p.saved.bytes,
                    key: p.saved.key,
                    // `public_url` is NOT NULL: it is saved on insert.
                    publicUrl: p.saved.url,
                    bucket: ctx.config.siteName || "kitsuden",
                    folderId: folderId || null,
                    width: p.width,
                    height: p.height,
                    status: "active",
                    createdById: uploadAuthor,
                    ...(isAgent && user?.id ? { metadata: { agentId: String(user.id) } } : {}),
                  })
                  .returning()
              );

              // Generate thumbnails for images (async)
              if (generateThumbnails && p.type.startsWith("image/")) {
                // This would trigger a background job in production
                ctx.logger.info(`Thumbnail generation queued for ${doc.id}`);
              }

              results[p.index] = {
                id: doc.id,
                filename: doc.filename,
                mimeType: doc.mimeType,
                size: doc.size,
                // The public URL and the measurements, in the response (additive: the
                // blog editor and the datasets form use them).
                url: doc.publicUrl,
                width: doc.width ?? undefined,
                height: doc.height ?? undefined,
                success: true,
              };
            } catch (err: unknown) {
              results[p.index] = { filename: p.name, success: false, error: messageOf(err) };
            }
          }

          const allSuccess = results.every((r) => r.success);

          return c.json(
            {
              success: allSuccess,
              files: results,
            },
            allSuccess ? 201 : 207 // 207 Multi-Status if partial failures
          );
        } catch (err: unknown) {
          ctx.logger.error("Upload failed:", { error: messageOf(err) });
          return c.json({ error: messageOf(err) }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // FOLDERS (specific routes before /:id)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /folders - List folders
   */
  ops.push(
    defineOperation({
      id: "list-folders",
      method: "GET",
      route: "/folders",
      summary: "List media folders",
      description: "All media folders ordered by path (staff only).",
      access: "public",
      permission: { policy: { resource: "media", action: "view" } },
      output: { schema: DirsList },
      handle: async (_input, { c }) => {
        const docs = await ctx.db.instance.select().from(mediaFolders).orderBy(mediaFolders.path);

        return c.json({ docs });
      },
    })
  );

  /**
   * POST /folders - Create folder
   */
  ops.push(
    defineOperation({
      id: "create-folder",
      method: "POST",
      route: "/folders",
      summary: "Create a media folder",
      description:
        "Creates a folder, optionally inside another one (its path is taken from the parent, not from the request).",
      access: "session",
      permission: { policy: { resource: "media", action: "create" } },
      input: { body: InputDir },
      output: { status: 201, schema: Dir },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const body = input.body ?? {};

        if (!body.name || typeof body.name !== "string" || body.name.length > 200) {
          return c.json({ error: "Name is required" }, 400);
        }
        if (body.parentId && !isUuid(String(body.parentId))) {
          return c.json({ error: "parentId is not valid" }, 400);
        }

        const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        // The parent's path comes from the DATABASE, not the body: `parentPath` was
        // sent by the client and could have nothing to do with `parentId`.
        let path = `/${slug}`;
        if (body.parentId) {
          const [parent] = await ctx.db.instance
            .select({ path: mediaFolders.path })
            .from(mediaFolders)
            .where(eq(mediaFolders.id, body.parentId))
            .limit(1);
          if (!parent) return c.json({ error: "Parent folder not found" }, 404);
          path = `${parent.path}/${slug}`;
        }

        const [doc] = await ctx.db.instance
          .insert(mediaFolders)
          .values({
            name: body.name,
            slug,
            parentId: body.parentId || null,
            path,
            description:
              typeof body.description === "string" ? body.description.slice(0, 2000) : null,
          })
          .returning();

        return c.json(doc, 201);
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION (specific routes before /:id)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /config - Get kon configuration
   */
  ops.push(
    defineOperation({
      id: "read-configuration",
      method: "GET",
      route: "/config",
      summary: "Read the media configuration",
      description:
        "The media kon configuration (storage provider and its settings, features, limits). Admin only: it can hold storage credentials.",
      access: "session",
      permission: { policy: { resource: "media", action: "configure" } },
      output: { schema: Configuration },
      mcp: { exclude: "returns storage credentials; not for agents" },
      handle: async (_input, { c }) => {
        try {
          // Load from database or return default
          const config = (await loadConfig(ctx)) || defaultMediaConfig;
          return c.json({ config });
        } catch (err: unknown) {
          ctx.logger.error("Failed to load config:", { error: messageOf(err) });
          return c.json({ config: defaultMediaConfig });
        }
      },
    })
  );

  /**
   * POST /config - Save kon configuration
   */
  ops.push(
    defineOperation({
      id: "save-configuration",
      method: "POST",
      route: "/config",
      summary: "Save the media configuration",
      description: "Validates and stores the media kon configuration (admin only).",
      access: "session",
      permission: { policy: { resource: "media", action: "configure" } },
      sensitive: true,
      idempotent: true,
      input: { body: InputConfig },
      output: { schema: SavedConfiguration },
      mcp: { exclude: "carries storage credentials; configuration stays a human task" },
      handle: async (input, { c }) => {
        try {
          const body = input.body ?? { config: undefined };
          const config = body.config as MediaKonConfig;

          // Validate config
          const validation = validateMediaConfig(config);
          if (!validation.valid) {
            return c.json({ error: validation.error }, 400);
          }

          // Save to database
          await saveConfig(ctx, config);

          ctx.logger.info("[Media] Configuration updated");
          return c.json({ success: true, config });
        } catch (err: unknown) {
          ctx.logger.error("Failed to save config:", { error: messageOf(err) });
          return c.json({ error: messageOf(err) }, 500);
        }
      },
    })
  );

  /**
   * POST /config/test-storage - Test storage connection
   */
  ops.push(
    defineOperation({
      id: "test-storage",
      method: "POST",
      route: "/config/test-storage",
      summary: "Test a storage configuration",
      description:
        "Tries to connect with the given storage settings (writes a probe on disk or calls the endpoint). Admin only.",
      access: "session",
      permission: { policy: { resource: "media", action: "configure" } },
      idempotent: true,
      input: { body: StoreTest },
      output: { schema: TestResult },
      errors: ["KITSUDEN_E_BAD_GATEWAY"],
      mcp: { exclude: "takes storage credentials and reaches arbitrary endpoints" },
      handle: async (input, { c }) => {
        try {
          const body = input.body ?? { storage: undefined };
          const storage = body.storage as StorageConfig;

          const result = await testStorageConnection(storage);

          return c.json(result);
        } catch (err: unknown) {
          ctx.logger.error("Storage test failed:", { error: messageOf(err) });
          return c.json(
            {
              success: false,
              message: messageOf(err) || "Connection test failed",
            },
            500
          );
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PARAMETERIZED ROUTES (must come AFTER all specific routes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /:id - Get single media file
   */
  ops.push(
    defineOperation({
      id: "get-media",
      method: "GET",
      route: "/:id",
      summary: "Get a media file",
      description: "One media record (staff only) with its URL and thumbnail URLs.",
      access: "public",
      permission: { policy: { resource: "media", action: "view" } },
      input: { params: ParamId },
      output: { schema: MediaWithUrl },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const id = c.req.param("id") as string;

        // An id that is not a UUID cannot exist, and passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid` — which comes out as a 500.
        // `GET /api/media/upload` matched here with id="upload" and returned a
        // server error for a mistyped URL. 404 is correct: it does not exist.
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

        const [doc] = await ctx.db.instance.select().from(media).where(eq(media.id, id)).limit(1);

        if (!doc) {
          return c.json({ error: "Media not found" }, 404);
        }

        // Generate signed URL
        let url = doc.publicUrl;
        if (!url) {
          try {
            url = await ctx.storage.getSignedDownloadUrl(doc.key, 3600);
          } catch {
            url = null;
          }
        }

        // Generate thumbnail URLs
        const thumbnails: Record<string, string> = {};
        if (doc.thumbnails) {
          for (const [size, info] of Object.entries(
            doc.thumbnails as Record<string, { key: string }>
          )) {
            try {
              thumbnails[size] = await ctx.storage.getSignedDownloadUrl(info.key, 3600);
            } catch {
              // Thumbnail not available
            }
          }
        }

        return c.json({
          ...doc,
          url,
          thumbnails,
        });
      },
    })
  );

  /**
   * PATCH /:id - Update media metadata
   */
  ops.push(
    defineOperation({
      id: "update-media",
      method: "PATCH",
      route: "/:id",
      summary: "Update media metadata",
      description:
        "Changes the editable fields only: altText, caption, filename and folderId (never the storage key or URL).",
      access: "session",
      permission: { policy: { resource: "media", action: "update" } },
      input: { params: ParamId, body: MediaChanges },
      output: { schema: Media },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const id = c.req.param("id") as string;

        // An id that is not a UUID cannot exist, and passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid` — which comes out as a 500.
        // `GET /api/media/upload` matched here with id="upload" and returned a
        // server error for a mistyped URL. 404 is correct: it does not exist.
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);
        const body = input.body ?? {};

        const [existing] = await ctx.db.instance
          .select()
          .from(media)
          .where(eq(media.id, id))
          .limit(1);

        if (!existing) {
          return c.json({ error: "Media not found" }, 404);
        }

        // Only what is editable. It did `set({...body})`: the `key` could be changed
        // (and a later DELETE removed THAT other file from the store), the public
        // URL, the type or the author.
        const changes: Record<string, unknown> = {};
        const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
        if (body.altText !== undefined) changes.altText = text(body.altText, 2000);
        if (body.caption !== undefined) changes.caption = text(body.caption, 2000);
        if (body.filename !== undefined) {
          const name = text(body.filename, 500);
          if (!name) return c.json({ error: "filename is not valid" }, 400);
          changes.filename = name.normalize("NFKC").replace(/[\\/]/g, "_");
        }
        if (body.folderId !== undefined) {
          if (body.folderId !== null && !isUuid(String(body.folderId))) {
            return c.json({ error: "folderId is not valid" }, 400);
          }
          changes.folderId = body.folderId;
        }

        const [updated] = await ctx.db.instance
          .update(media)
          .set({
            ...changes,
            updatedAt: new Date(),
          })
          .where(eq(media.id, id))
          .returning();

        return c.json(updated);
      },
    })
  );

  /**
   * DELETE /:id - Delete media file
   */
  ops.push(
    defineOperation({
      id: "delete-media",
      method: "DELETE",
      route: "/:id",
      summary: "Delete a media file",
      description:
        "Deletes the record and its stored file and thumbnails. Cannot be undone; pages that use it will show a broken image.",
      access: "session",
      permission: { policy: { resource: "media", action: "delete" } },
      input: { params: ParamId },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const id = c.req.param("id") as string;

        // An id that is not a UUID cannot exist, and passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid` — which comes out as a 500.
        // `GET /api/media/upload` matched here with id="upload" and returned a
        // server error for a mistyped URL. 404 is correct: it does not exist.
        if (!isUuid(id)) return c.json({ error: "Media not found" }, 404);

        const [existing] = await ctx.db.instance
          .select()
          .from(media)
          .where(eq(media.id, id))
          .limit(1);

        if (!existing) {
          return c.json({ error: "Media not found" }, 404);
        }

        // Delete from storage
        try {
          await ctx.storage.delete(existing.key);

          // Delete thumbnails
          if (existing.thumbnails) {
            for (const [_size, info] of Object.entries(
              existing.thumbnails as Record<string, { key: string }>
            )) {
              try {
                await ctx.storage.delete(info.key);
              } catch {
                // Thumbnail might not exist
              }
            }
          }
        } catch (err: unknown) {
          ctx.logger.error("Failed to delete from storage:", { error: messageOf(err) });
          // Continue to delete from DB anyway
        }

        // Delete from database
        await ctx.db.instance.delete(media).where(eq(media.id, id));

        return c.json({ success: true });
      },
    })
  );

  return ops;
}

/** The media library REST router, generated from its operations. */
export function createMediaRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, mediaOperations(ctx), ctx);
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG PERSISTENCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The kon's configuration: saved in `modules.settings`, like everyone else's
 * ============================================================================
 *
 * ── WHY IT WAS MOVED ───────────────────────────────────────────────────────
 *
 * This used its own table, `kitsuden_config`, which was a SECOND store of
 * kon settings in parallel to the one that already existed: the `settings` column of
 * `modules`, which is where the panel writes and where
 * `PATCH /api/modules/:key` reads from.
 *
 * Two stores for the same thing drift apart as soon as someone edits one. Here the
 * risk was concrete: the panel could save kon-media settings in
 * `modules.settings` and this code would never see them, because it looked at another table.
 *
 * The fact that the old table never worked on a server (it was created
 * on the fly with a role lacking the CREATE privilege) made the unification free: there
 * was no data to migrate. `kitsuden_config` is dropped in migration 0040.
 *
 * ── WHY THE UPSERT ONLY WRITES `settings` ──────────────────────────────────
 *
 * Because saving settings must not activate a kon as a side effect. If the row does not
 * exist it is created with the kon ACTIVE (kon-media is core and is always
 * active), but if it already exists only `settings` is written.
 *
 * And `updated_at` is NOT touched: `modules` has no such column. The first version
 * of this upsert included it out of habit and would have failed on the first
 * save.
 */
async function loadConfig(ctx: KonContext): Promise<MediaKonConfig | null> {
  try {
    // In a SAVEPOINT: the `catch` below swallows the error (by design:
    // without configuration the defaults are used), and without a savepoint an
    // SQL error would leave the whole request's transaction aborted.
    const result: { rows?: unknown[] } = await withSavepoint(async () =>
      ctx.db.instance.execute(sql`
        SELECT settings FROM modules
        WHERE key = 'kon-media'
        LIMIT 1
      `)
    );

    const row = result.rows?.[0] as { settings?: unknown } | undefined;
    const settings = row?.settings;
    if (!settings) return null;

    // `settings` is jsonb: the driver already delivers it as an object. Text is accepted
    // in case some old row stored a string.
    const object = typeof settings === "string" ? JSON.parse(settings) : settings;

    // An empty `settings` means "nothing saved", not an empty configuration:
    // returning `{}` would make the kon start with no allowed extensions and no
    // size limit, instead of with its defaults.
    return object && Object.keys(object).length > 0 ? (object as MediaKonConfig) : null;
  } catch (err) {
    // It used to say "Table might not exist yet" and swallowed ANY error, so
    // a permissions or connection problem looked the same as "nothing
    // saved": the panel showed the defaults and there was no way to
    // notice that the saved configuration was not being read.
    ctx.logger.warn("[Media] Could not read the saved configuration", {
      error: messageOf(err),
    });
  }
  return null;
}

async function saveConfig(ctx: KonContext, config: MediaKonConfig): Promise<void> {
  await ctx.db.instance.execute(sql`
    INSERT INTO modules (key, name, category, enabled, settings)
    VALUES ('kon-media', 'Media Library', 'core', true, ${JSON.stringify(config)}::jsonb)
    ON CONFLICT (key)
    DO UPDATE SET settings = EXCLUDED.settings;
  `);
}
