/**
 * Kitsuden CMS — Page Builder: its operations (kon SDK)
 *
 * Pages, blocks and templates of `/api/page-builder`. Each route is a
 * DECLARED operation (`defineOperation`): from the declaration come the REST
 * route, its OpenAPI and its MCP tool (docs/kons/README.md). The schemas
 * are in `blocks.wire-schemas.ts`.
 *
 * The HTTP contract is the usual one (`page-builder` contract v1, pinned by
 * `tests/unit/inti-contract.test.ts`): each write's authorization is
 * declared in `permission` (the `page` policy) instead of being called by hand
 * at the start of the handler, with the same 401/403 responses.
 */

import { createHash } from "node:crypto";

import {
  can,
  defineOperation,
  eqEnum,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import {
  findSpanishBlockKeys,
  readBlockData,
  spanishKeysError,
  type KonContext,
} from "@kitsuden/shared";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { editsContent, registerBlocksPolicy } from "./blocks.policy";
import { invalidCss, invalidStyle, sanitizeBlockContent } from "./blocks.sanitize";
import { pages, blocks, blockTemplates, BLOCK_TYPES } from "./blocks.schema";
import {
  Block,
  BlockChanges,
  BlockInput,
  Clone,
  Success,
  PagesList,
  TemplatesList,
  Page,
  PageWithBlocks,
  PageFromBlock,
  PageFromBlockOutput,
  PageInput,
  RenderedPage,
  ParamId,
  PageParam,
  ParamSlug,
  Template,
  TemplateEntry,
  PageListQuery,
  PageQuery,
  PublishDraft,
  TemplatesQuery,
  Reordenar,
  BlockTypes,
} from "./blocks.wire-schemas";

/** The kon's id: it is part of the fine scope of each operation (`kon:blocks:<op>`). */
export const KON_ID = "kon-blocks";

/** The statuses the column accepts. Anything else is a 400 (or "published" for the public). */
const PAGE_STATUSES = ["draft", "published", "archived"] as const;
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BLOCKS_PER_REQUEST = 500;

function userOf(c: unknown): AuthzUser | null {
  return ((c as { get(k: string): unknown }).get("user") as AuthzUser | undefined) ?? null;
}

/**
 * The authorization of each write, INSIDE the kon (before: `requireAuth`,
 * i.e. any account). Returns the rejection or `null`.
 */
async function rejection(c: unknown, action: string): Promise<Response | null> {
  const u = userOf(c);
  if (await can(u, action, {}, "page")) return null;
  const json = (c as { json: (body: unknown, status: number) => Response }).json.bind(c);
  return u
    ? json({ error: "Forbidden", message: `Not authorized for '${action}' on page` }, 403)
    : json({ error: "Unauthorized", message: "Session required" }, 401);
}

/**
 * Can this visitor see this page? Published, and if it asks for a session, with
 * a session. The team (and the content agent) sees everything.
 */
function visiblePage(
  c: unknown,
  page: { status?: string | null; requireAuth?: boolean | null }
): boolean {
  const u = userOf(c);
  if (editsContent(u)) return true;
  if (page.status !== "published") return false;
  if (page.requireAuth && !u) return false;
  return true;
}

/**
 * Block content as it is served: English keys and sanitized (what was saved before this, too).
 *
 * `readBlockData` accepts the 0.8 (Spanish) keys a block stored before the 0.10 migration of this
 * kon could still carry (`titulo` → `title`…, see `@kitsuden/shared` block-keys.ts).
 * Remove in 0.10: back to `sanitizeBlockContent(type, content)`.
 */
function contentToServe(type: unknown, content: unknown): unknown {
  return sanitizeBlockContent(type, readBlockData(type, content));
}

/** A block as it is served: see `contentToServe`. */
function blockToServe<T extends { type?: unknown; content?: unknown }>(block: T): T {
  return { ...block, content: contentToServe(block.type, block.content) };
}

/**
 * The body of the 422 for content that still uses 0.8 key names (`titulo`, `campos`…), or `null`.
 * Writes speak only the 0.9 contract: a Spanish key would be saved and never read.
 */
function oldKeysError(
  items: ReadonlyArray<{ type?: unknown; content?: unknown } | null | undefined>
) {
  const found = items.flatMap((b, i) =>
    findSpanishBlockKeys(b?.type, b?.content).map((k) =>
      items.length > 1
        ? { path: `blocks[${i}].content.${k.path}`, use: `blocks[${i}].content.${k.use}` }
        : k
    )
  );
  return found.length ? spanishKeysError(found, "block content") : null;
}

/** `customCss` is only served if it is clean CSS (what was saved before validating it, too). */
function cssToServe(css: unknown): string | null {
  return typeof css === "string" && !invalidCss(css) ? css : null;
}

function validType(type: unknown): boolean {
  return typeof type === "string" && (BLOCK_TYPES as readonly string[]).includes(type);
}

/** A page `:id` can be a uuid or a slug; only the uuid is compared with `pages.id` */
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this block shown right now (switched on and inside its scheduled window)? */
function shownNow(
  block: { isVisible?: boolean | null; visibleFrom?: unknown; visibleUntil?: unknown },
  now: Date
): boolean {
  if (!block.isVisible) return false;
  if (block.visibleFrom && new Date(block.visibleFrom as string) > now) return false;
  if (block.visibleUntil && new Date(block.visibleUntil as string) < now) return false;
  return true;
}

/** Limits of a `contentPatch`: it edits fields, it is not a way to send a whole document. */
const MAX_PATCH_OPS = 100;
const MAX_PATCH_DEPTH = 20;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

type PatchOp = { segments: string[]; value: unknown };

/**
 * Reads `contentPatch: [{ path: "cards.0.title", value }]`. Dots separate keys and
 * numeric segments index arrays. Returns the operations or the 400 message.
 */
function parseContentPatch(raw: unknown): PatchOp[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "`contentPatch` must be a non-empty array of { path, value }";
  }
  if (raw.length > MAX_PATCH_OPS) return `\`contentPatch\` accepts up to ${MAX_PATCH_OPS} changes`;
  const ops: PatchOp[] = [];
  for (const item of raw) {
    const path = (item as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !path || path.length > 200) {
      return "Each `contentPatch` change needs a `path` (up to 200 characters)";
    }
    if (!Object.prototype.hasOwnProperty.call(item, "value")) {
      return `\`contentPatch\` change "${path}" has no \`value\``;
    }
    const segments = path.split(".");
    if (segments.length > MAX_PATCH_DEPTH || segments.some((s) => !s)) {
      return `Invalid \`contentPatch\` path: "${path}"`;
    }
    if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
      return `\`contentPatch\` path not allowed: "${path}"`;
    }
    ops.push({ segments, value: (item as { value: unknown }).value });
  }
  return ops;
}

/**
 * Applies the changes to a copy of the content. Missing objects on the way are
 * created; an array is only indexed by a number. Returns the new content or the 400 message.
 */
function applyContentPatch(content: unknown, ops: PatchOp[]): Record<string, unknown> | string {
  const root: Record<string, unknown> =
    content && typeof content === "object" && !Array.isArray(content)
      ? structuredClone(content as Record<string, unknown>)
      : {};
  for (const { segments, value } of ops) {
    let node: unknown = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i];
      const last = i === segments.length - 1;
      if (Array.isArray(node)) {
        if (!/^\d+$/.test(key)) return `"${segments.join(".")}": "${key}" is not an array index`;
        const index = Number(key);
        if (index > node.length) return `"${segments.join(".")}": index ${index} is past the end`;
        if (last) node[index] = value;
        else {
          if (node[index] === null || typeof node[index] !== "object") node[index] = {};
          node = node[index];
        }
      } else {
        const obj = node as Record<string, unknown>;
        if (last) obj[key] = value;
        else {
          if (obj[key] === null || typeof obj[key] !== "object") obj[key] = {};
          node = obj[key];
        }
      }
    }
  }
  return root;
}

/**
 * The version a write expects: `If-Match: "<updatedAt ISO>"` (quotes and `W/` optional) or
 * `expectedUpdatedAt` in the body. `undefined` = no check; `null` = unreadable (400).
 */
function expectedVersion(header: string | undefined, bodyValue: unknown): Date | null | undefined {
  const raw =
    typeof header === "string" && header.trim()
      ? header
          .trim()
          .replace(/^W\//, "")
          .replace(/^"(.*)"$/, "$1")
      : bodyValue;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Postgres's text of a `timestamptz` (`2026-11-20 12:00:00.123456+00`). */
const PG_TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?|Z)?$/;

/** The opaque cursor of the page list: base64url of `[updatedAt as Postgres text, id]`. */
function encodePageCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string): { at: string; id: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as [unknown, unknown];
    if (typeof at !== "string" || typeof id !== "string") return null;
    if (!IS_UUID.test(id) || !PG_TIMESTAMPTZ.test(at)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** The `ETag` of a GET body: weak, because the JSON is re-serialized on every request. */
function etagOf(body: unknown): string {
  return `W/"${createHash("sha1").update(JSON.stringify(body)).digest("base64url")}"`;
}

/** Does `If-None-Match` name this ETag (weak comparison, as RFC 9110 asks for GET)? */
function notModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/** The latest `updatedAt` of a page and its blocks, for `Last-Modified`. */
function lastModifiedOf(
  page: { updatedAt?: unknown },
  list: Array<{ updatedAt?: unknown }>
): Date | null {
  let latest = 0;
  for (const v of [page.updatedAt, ...list.map((b) => b.updatedAt)]) {
    const t = v ? new Date(v as string).getTime() : NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest ? new Date(latest) : null;
}

/**
 * Block types the editor can save but whose content this kon does not describe: their
 * fields belong to the site component (or the kon) that renders them. They are listed so a
 * client does not reject a type the API accepts; `schema` stays empty.
 */
const UNDESCRIBED_TYPE_CATEGORY: Record<string, string> = {
  richtext: "content",
  callout: "content",
  "facebook-group": "marketing",
  "image-gallery": "media",
  "comparison-slider": "media",
  "dynamic-carousel": "layout",
  "smart-grid": "layout",
  "smart-filter": "layout",
};

function undescribedType(type: string) {
  const name = type
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return {
    type,
    name,
    category: UNDESCRIBED_TYPE_CATEGORY[type] ?? "interactive",
    icon: "puzzle-piece",
    description: `${name} block. Its fields are defined by the component that renders it.`,
    schema: {},
    described: false,
  };
}

/**
 * The page builder's operations, with the kon's context injected.
 */
export function blockOperations(ctx: KonContext): AnyOperation[] {
  // The policy registry is global and `resetAuthz()` empties it (tests).
  registerBlocksPolicy();
  const ops: AnyOperation[] = [];
  const { db, cache, auth } = ctx;

  // Helper to get db instance
  const dbInstance = db.instance;

  // Helper for auth
  const requireAuth = auth.requireAuth;

  // Helper for cached query (adapt to KonContext cache API)
  const cachedQuery = async <T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> => {
    const cached = await cache.get(key);
    if (cached) return cached as T;
    const result = await fn();
    await cache.set(key, result, ttl);
    return result;
  };

  // Helper for cache invalidation
  const invalidateCache = async (pattern: string) => {
    await cache.invalidate(pattern);
  };

  /**
   * Build transform URL for media using kon-media presets
   *
   * Presets: thumbnail (150x150), small (400x300), medium (800x600),
   *          large (1200x800), hero (1920x1080)
   */
  const buildTransformUrl = (
    mediaId: string,
    preset: "thumbnail" | "small" | "medium" | "large" | "hero",
    focalPoint?: { x: number; y: number }
  ): string => {
    // Use preset endpoint for cleaner URLs
    let url = `/api/media/preset/${mediaId}/${preset}`;

    // Add focal point if provided (for smart cropping)
    if (focalPoint) {
      url += `?fp=${focalPoint.x.toFixed(2)},${focalPoint.y.toFixed(2)}`;
    }

    return url;
  };

  // Authentication applied inline to mutation routes only

  /** What a page may carry and should not (made-up status, CSS that is not CSS…). */
  function validatePageFields(body: Record<string, unknown>): string | null {
    if (
      body.status !== undefined &&
      !(PAGE_STATUSES as readonly string[]).includes(String(body.status))
    ) {
      return `Invalid status: "${String(body.status)}"`;
    }
    for (const field of ["requireAuth", "isHomepage"]) {
      if (body[field] !== undefined && typeof body[field] !== "boolean")
        return `\`${field}\` must be yes or no`;
    }
    return invalidCss(body.customCss) ?? invalidStyle(body);
  }

  /** The blocks that arrive to be saved: known type, clean style, and not infinite. */
  function validateBlocks(list: unknown[]): string | null {
    if (list.length > MAX_BLOCKS_PER_REQUEST) return "Too many blocks in one request";
    for (const b of list) {
      if (!b || typeof b !== "object") return "Invalid block";
      const block = b as Record<string, unknown>;
      if (!validType(block.type)) return `Unknown block type: "${String(block.type ?? "")}"`;
      const e = invalidStyle(block);
      if (e) return e;
    }
    return null;
  }

  /**
   * After a page or one of its blocks changed: the page's `updatedAt` (the sitemap's
   * `lastmod` and `Last-Modified` read it; a block edit used to leave it old), the cache
   * by id, by slug, the list and the render, and the `page:updated` event, which goes out
   * after commit so an action or a webhook can purge a site's cache.
   *
   * `touch: false` when the caller already wrote `updatedAt` in the same statement.
   */
  async function invalidatePage(pageId: string, opts: { touch?: boolean } = {}): Promise<void> {
    const [page] =
      opts.touch === false
        ? await dbInstance
            .select({ slug: pages.slug })
            .from(pages)
            .where(eq(pages.id, pageId))
            .limit(1)
        : await dbInstance
            .update(pages)
            .set({ updatedAt: new Date() })
            .where(eq(pages.id, pageId))
            .returning({ slug: pages.slug });
    await invalidateCache(`page:${pageId}:*`);
    await invalidateCache("pages:*");
    if (page?.slug) {
      await invalidateCache(`page:${page.slug}:*`);
      await invalidateCache(`render:${page.slug}`);
      ctx.events?.emit("page:updated", { id: pageId, slug: page.slug });
    }
  }

  // ═══════════════════════════════════════════════
  // PAGES CRUD
  // ═══════════════════════════════════════════════

  // List all pages
  ops.push(
    defineOperation({
      id: "list-pages",
      method: "GET",
      route: "/pages",
      summary: "List pages",
      description:
        "Paginated list of page-builder pages, newest update first. The public (and any caller without the content role) only sees published pages that do not require a session; staff and agents with content:edit can filter by any status.",
      access: "public",
      input: { query: PageListQuery },
      output: { schema: PagesList },
      errors: ["KITSUDEN_E_BAD_REQUEST"],
      handle: async (_input, { c }) => {
        const query = c.req.query();

        /**
         * ── THE STATUS IS NEGOTIATED WITH WHOEVER ASKS ───────────────────────────
         *
         * `?status=draft` without a session listed the drafts, and a status that does not
         * exist (`?status=x`) was WORSE: `eqEnum` returns `undefined`, the
         * condition disappeared and ALL the pages came out. For whoever does not edit
         * content the status is always `published`; for the team, a valid one or
         * a 400. And the cache carries the privilege in the key, or an editor's
         * first list would later be served to the public.
         */
        const priv = editsContent(userOf(c));
        const request = query.status || "published";
        if (priv && !(PAGE_STATUSES as readonly string[]).includes(request)) {
          return c.json({ error: `Invalid status: "${request}"` }, 400);
        }
        const status = priv ? request : "published";
        const limit = Math.min(Math.max(parseInt(query.limit || "50") || 50, 1), 100);
        const offset = Math.max(parseInt(query.offset || "0") || 0, 0);
        const layout = typeof query.layout === "string" ? query.layout : "";
        const search = typeof query.search === "string" ? query.search.slice(0, 200) : "";

        /**
         * ── CURSOR PAGING ──────────────────────────────────────────────────────
         *
         * A site that walks every page (a sitemap, a static build, Inti's page picker) paid a
         * `count(*)` per batch, and an OFFSET that grows: each batch re-read the ones before it, and a
         * page edited meanwhile moved and was skipped or repeated. With `?cursor=` (or `?paging=cursor`
         * for the first batch) the list is keyset-paged on (updatedAt, id), counts nothing, and answers
         * `nextCursor` (`null` on the last batch). The cursor is opaque: pass back what came.
         */
        const cursorMode = typeof query.cursor === "string" || query.paging === "cursor";
        let after: { at: string; id: string } | null = null;
        if (typeof query.cursor === "string" && query.cursor !== "") {
          after = decodePageCursor(query.cursor);
          if (!after) return c.json({ error: "Invalid cursor" }, 400);
        }

        const key = `pages:list:${status}:${limit}:${cursorMode ? `c:${query.cursor ?? ""}` : offset}:${layout}:${search}:${priv ? "priv" : "pub"}`;
        const result = await cachedQuery(key, 60, async () => {
          const whereConditions = [eqEnum(pages.status, status)!];
          if (!priv) whereConditions.push(eq(pages.requireAuth, false));

          // Filter by layout if provided
          if (layout) {
            whereConditions.push(eq(pages.layout, layout));
          }

          // Search by title
          if (search) {
            whereConditions.push(sql`${pages.title} ILIKE ${`%${search}%`}`);
          }

          if (after) {
            // Full precision: the cursor carries Postgres's own text of the timestamp (microseconds),
            // which a JavaScript Date would round to milliseconds and so skip or repeat rows.
            whereConditions.push(
              sql`(${pages.updatedAt}, ${pages.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
            );
          }

          const columns = {
            id: pages.id,
            title: pages.title,
            slug: pages.slug,
            description: pages.description,
            status: pages.status,
            layout: pages.layout,
            isHomepage: pages.isHomepage,
            publishedAt: pages.publishedAt,
            updatedAt: pages.updatedAt,
          };

          if (cursorMode) {
            const rows = await dbInstance
              .select({ ...columns, cursorAt: sql<string>`${pages.updatedAt}::text` })
              .from(pages)
              .where(and(...whereConditions))
              .orderBy(desc(pages.updatedAt), desc(pages.id))
              .limit(limit + 1);
            const more = rows.length > limit;
            const batch = more ? rows.slice(0, limit) : rows;
            const last = batch[batch.length - 1];
            return {
              docs: batch.map(({ cursorAt: _cursorAt, ...doc }: Record<string, unknown>) => doc),
              limit,
              nextCursor:
                more && last ? encodePageCursor(String(last.cursorAt), String(last.id)) : null,
            };
          }

          const pageList = await dbInstance
            .select(columns)
            .from(pages)
            .where(and(...whereConditions))
            // `id` breaks ties: two pages saved in the same instant kept no stable order between batches.
            .orderBy(desc(pages.updatedAt), desc(pages.id))
            .limit(limit)
            .offset(offset);

          const [{ count }] = await dbInstance
            .select({ count: sql<number>`count(*)::int` })
            .from(pages)
            .where(and(...whereConditions));

          return { docs: pageList, totalDocs: count, limit, offset };
        });

        return c.json(result);
      },
    })
  );

  // Get single page with blocks
  ops.push(
    defineOperation({
      id: "get-page",
      method: "GET",
      route: "/pages/:id",
      summary: "Get a page with its blocks",
      description:
        "One page by uuid or slug, with its visible blocks in order (block content sanitized). Drafts and session-only pages are a 404 for whoever cannot see them.",
      access: "public",
      input: { params: ParamId, query: PageQuery },
      output: { schema: PageWithBlocks },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { id } = c.req.param();
        const includeBlocks =
          (c.req.query("includeBlocks") ?? c.req.query("include_blocks")) !== "false";

        const pageData = await cachedQuery(`page:${id}:${includeBlocks}`, 120, async () => {
          // Get page
          const [page] = await dbInstance
            .select()
            .from(pages)
            // `id` is a uuid: comparing it with a slug ("home") made the cast fail in
            // Postgres and the route answered 500 instead of looking up by slug.
            .where(
              IS_UUID.test(id)
                ? sql`${pages.id} = ${id} OR ${pages.slug} = ${id}`
                : sql`${pages.slug} = ${id}`
            )
            .limit(1);

          if (!page) return null;

          // Get blocks if requested
          let pageBlocks: any[] = [];
          if (includeBlocks) {
            pageBlocks = await dbInstance
              .select()
              .from(blocks)
              .where(eq(blocks.pageId, page.id))
              .orderBy(asc(blocks.sortOrder));

            // Filter out invisible blocks based on visibility settings
            const now = new Date();
            pageBlocks = pageBlocks.filter((block) => shownNow(block, now));
          }

          return { ...page, blocks: pageBlocks };
        });

        // What is cached is the page as is; who can see it is decided here,
        // on each request. A draft or a page that needs a session does not exist for
        // whoever cannot see them (404, not 403: its existence is not confirmed).
        if (!pageData || !visiblePage(c, pageData)) {
          return c.json({ error: "Page not found" }, 404);
        }

        const body = {
          ...pageData,
          customCss: cssToServe(pageData.customCss),
          blocks: (pageData.blocks ?? []).map(blockToServe),
        };

        /**
         * Conditional GET. The ETag hashes the body, so it also changes when a scheduled
         * block enters or leaves its window (no `updatedAt` moves then). `no-cache`: a
         * client may keep the copy but must revalidate it; drafts and session pages stay
         * `private` so a shared cache never holds them.
         */
        const etag = etagOf(body);
        const lastModified = lastModifiedOf(pageData, pageData.blocks ?? []);
        c.header("ETag", etag);
        if (lastModified) c.header("Last-Modified", lastModified.toUTCString());
        c.header(
          "Cache-Control",
          pageData.status === "published" && !pageData.requireAuth
            ? "no-cache"
            : "private, no-cache"
        );
        if (notModified(c.req.header("if-none-match"), etag)) {
          return c.body(null, 304);
        }

        return c.json(body);
      },
    })
  );

  // Create page
  ops.push(
    defineOperation({
      id: "create-page",
      method: "POST",
      route: "/pages",
      summary: "Create a page",
      description:
        "Creates a page (draft by default) and, optionally, its blocks. The slug is derived from the title when missing. Making it the homepage needs a staff account.",
      access: "session",
      permission: { policy: { resource: "page", action: "create" } },
      input: { body: PageInput.optional() },
      output: { status: 201, schema: Page },
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        const body = input.body;

        // Without a title there is no page (nor a slug to derive): it was a 500 from `undefined.toLowerCase()`
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.title !== "string" ||
          !body.title.trim()
        ) {
          return c.json({ error: "Missing `title`" }, 400);
        }
        if (
          body.slug !== undefined &&
          (typeof body.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug))
        ) {
          return c.json({ error: "`slug` only allows lowercase letters, digits and hyphens" }, 400);
        }

        // Generate slug if not provided
        const slug =
          body.slug ||
          body.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        if (!RE_SLUG.test(slug))
          return c.json({ error: "Could not derive a URL from the title" }, 400);

        const fieldsError = validatePageFields(body);
        if (fieldsError) return c.json({ error: fieldsError }, 400);
        if (body.isHomepage) {
          const notCover = await rejection(c, "setHomepage");
          if (notCover) return notCover;
        }
        const newBlocks = Array.isArray(body.blocks) ? body.blocks : [];
        const blockErrors = validateBlocks(newBlocks);
        if (blockErrors) return c.json({ error: blockErrors }, 400);
        const oldKeys = oldKeysError(newBlocks as Array<{ type?: unknown; content?: unknown }>);
        if (oldKeys) return c.json(oldKeys, 422);

        // Check for duplicate slug
        const [existing] = await dbInstance
          .select({ id: pages.id })
          .from(pages)
          .where(eq(pages.slug, slug))
          .limit(1);

        if (existing) {
          return c.json({ error: "A page with this slug already exists" }, 409);
        }

        // If setting as homepage, unset other homepages
        if (body.isHomepage) {
          await dbInstance
            .update(pages)
            .set({ isHomepage: false })
            .where(eq(pages.isHomepage, true));
        }

        const [page] = await dbInstance
          .insert(pages)
          .values({
            title: body.title,
            slug,
            description: body.description,
            status: body.status || "draft",
            layout: body.layout || "default",
            metaTitle: body.metaTitle,
            metaDescription: body.metaDescription,
            ogImageId: body.ogImageId,
            cssClass: body.cssClass,
            customCss: body.customCss,
            publishedAt: body.status === "published" ? new Date() : null,
            // `authorId` is no longer taken from the body: it was free text that signed the
            // page in anyone's name (and the column is a uuid, whereas
            // account ids are not: the creator's cannot be stored).
            isHomepage: body.isHomepage === true,
            requireAuth: body.requireAuth === true,
          })
          .returning();

        // Create blocks if provided
        if (newBlocks.length) {
          const blockValues = newBlocks.map((block: any, index: number) => ({
            pageId: page.id,
            type: block.type,
            name: block.name,
            sortOrder: block.sortOrder ?? index,
            columnSpan: block.columnSpan ?? 12,
            content: sanitizeBlockContent(block.type, block.content ?? {}),
            cssClass: block.cssClass,
            backgroundColor: block.backgroundColor,
            textColor: block.textColor,
            padding: block.padding,
            isVisible: block.isVisible ?? true,
          }));

          await dbInstance.insert(blocks).values(blockValues);
        }

        await invalidateCache("pages:*");
        await invalidateCache("render:*");
        return c.json(page, 201);
      },
    })
  );

  // Update page
  /**
   * Publish a block as its own page.
   * ==========================================================================
   *
   * ── WHAT PROBLEM IT SOLVES ───────────────────────────────────────────────
   *
   * For a tier list to be a URL you had to: create it in its kon, create
   * a page, drag the block, configure it and publish. Five steps for
   * something the reader experiences as "a page with a tier list".
   *
   * ── WHY THIS ROUTE LIVES HERE AND IS GENERIC ─────────────────────────────
   *
   * The alternative was for `kon-tierlist` to write to `block_pages`. That would tie
   * it to `kon-blocks`, which is exactly the coupling avoided by
   * keeping the kons separate — and it would have to be repeated in every kon that
   * wants to publish something.
   *
   * Here it is the other way around: the owner of the pages offers "make me a page with
   * THIS block inside", and any kon can call it without anyone importing
   * anyone. The block type is validated against the enum, which is what the
   * table can actually store.
   *
   * ── IDEMPOTENT BY SLUG ───────────────────────────────────────────────────
   *
   * Republishing the same tier list UPDATES its page instead of failing
   * with "that slug already exists" or creating a second one. Republishing every patch is
   * the normal operation here, not the exception.
   */
  ops.push(
    defineOperation({
      id: "publish-block-as-page",
      method: "POST",
      route: "/pages/from-block",
      summary: "Publish one block as its own page",
      description:
        "Creates (201) or updates (200, same slug) a page that holds exactly one block. Republishing replaces the previous block instead of duplicating it, so it is safe to call again with the same slug.",
      access: "session",
      permission: { policy: { resource: "page", action: "create" } },
      idempotent: true,
      input: { body: PageFromBlock.optional() },
      output: { status: 201, schema: PageFromBlockOutput },
      handle: async (input, { c }) => {
        const body = (input.body ?? {}) as {
          blockType?: string;
          content?: Record<string, unknown>;
          title?: string;
          slug?: string;
          status?: string;
        };

        const title = (body.title ?? "").trim();
        if (!title) return c.json({ error: "A title is required" }, 422);

        const slug =
          (body.slug ?? "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") ||
          title
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");

        if (!slug) return c.json({ error: "Could not derive a URL from the title" }, 422);

        /**
         * The type is validated against the schema's list, not against one written
         * here: a parallel list is how we ended up with three vocabularies of
         * blocks that did not match.
         *
         * Since the column stopped being a Postgres enum, this check
         * is the ONLY thing separating the editor from the table: the database no longer
         * rejects a type that does not exist. That is why it cannot be relaxed.
         */
        const validTypes = BLOCK_TYPES as readonly string[];
        if (!body.blockType || !validTypes.includes(body.blockType)) {
          return c.json(
            {
              error: "Unknown block type",
              message: `«${body.blockType ?? ""}» cannot be saved in a page.`,
              valid: validTypes,
            },
            422
          );
        }
        const oldKeys = oldKeysError([{ type: body.blockType, content: body.content }]);
        if (oldKeys) return c.json(oldKeys, 422);

        const status = body.status === "published" ? "published" : "draft";

        const [existing] = await dbInstance
          .select({ id: pages.id })
          .from(pages)
          .where(eq(pages.slug, slug))
          .limit(1);

        let pageId: string;

        if (existing) {
          pageId = existing.id;
          await dbInstance
            .update(pages)
            .set({ title, status: status as never, updatedAt: new Date() })
            .where(eq(pages.id, pageId));

          /**
           * The previous blocks of THIS page are deleted before writing the
           * new one. The page is a wrapper for a single block; leaving the old ones
           * would fill it with copies on every republish.
           */
          await dbInstance.delete(blocks).where(eq(blocks.pageId, pageId));
        } else {
          const [createdOne] = await dbInstance
            .insert(pages)
            .values({ title, slug, status: status as never })
            .returning({ id: pages.id });
          pageId = createdOne.id;
        }

        await dbInstance.insert(blocks).values({
          pageId,
          type: body.blockType as never,
          sortOrder: 0,
          columnSpan: 12,
          content: sanitizeBlockContent(body.blockType, body.content ?? {}) as never,
        });

        // `updatedAt` was already written above (or by the insert)
        await invalidatePage(pageId, { touch: false });

        return c.json(
          {
            data: { id: pageId, slug, title, status },
            created: !existing,
          },
          existing ? 200 : 201
        );
      },
    })
  );

  ops.push(
    defineOperation({
      id: "update-page",
      method: "PATCH",
      route: "/pages/:id",
      summary: "Update a page",
      description:
        "Changes the given page fields. Publishing sets publishedAt when it was empty; changing the slug checks it is free; isHomepage needs a staff account.",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId, body: PageInput.optional() },
      output: { schema: Page },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Page not found" }, 404);
        const body = input.body;
        if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);

        const fieldsError = validatePageFields(body);
        if (fieldsError) return c.json({ error: fieldsError }, 400);
        if (
          body.slug !== undefined &&
          (typeof body.slug !== "string" || !RE_SLUG.test(body.slug))
        ) {
          return c.json({ error: "`slug` only allows lowercase letters, digits and hyphens" }, 400);
        }
        if (body.isHomepage !== undefined) {
          const notCover = await rejection(c, "setHomepage");
          if (notCover) return notCover;
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };

        if (body.title !== undefined) updates.title = body.title;
        if (body.description !== undefined) updates.description = body.description;
        if (body.status !== undefined) {
          updates.status = body.status;
          if (body.status === "published" && !body.publishedAt) {
            updates.publishedAt = new Date();
          }
        }
        if (body.layout !== undefined) updates.layout = body.layout;
        if (body.metaTitle !== undefined) updates.metaTitle = body.metaTitle;
        if (body.metaDescription !== undefined) updates.metaDescription = body.metaDescription;
        if (body.ogImageId !== undefined) updates.ogImageId = body.ogImageId;
        if (body.cssClass !== undefined) updates.cssClass = body.cssClass;
        if (body.customCss !== undefined) updates.customCss = body.customCss;
        if (body.requireAuth !== undefined) updates.requireAuth = body.requireAuth === true;

        // The slug before the change: a site keeps its page under the OLD address in its cache and
        // must purge it too, so `page:updated` carries it (`previousSlug`) when the page is renamed.
        let previousSlug: string | null = null;
        // Handle slug update with duplicate check
        if (body.slug !== undefined) {
          const [current] = await dbInstance
            .select({ slug: pages.slug })
            .from(pages)
            .where(eq(pages.id, id))
            .limit(1);
          previousSlug = current?.slug ?? null;
          const [existing] = await dbInstance
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.slug, body.slug), sql`${pages.id} != ${id}`))
            .limit(1);

          if (existing) {
            return c.json({ error: "A page with this slug already exists" }, 409);
          }
          updates.slug = body.slug;
        }

        // Handle homepage flag
        if (body.isHomepage === true) {
          await dbInstance
            .update(pages)
            .set({ isHomepage: false })
            .where(and(eq(pages.isHomepage, true), sql`${pages.id} != ${id}`));
          updates.isHomepage = true;
        } else if (body.isHomepage === false) {
          updates.isHomepage = false;
        }

        const [updated] = await dbInstance
          .update(pages)
          .set(updates)
          .where(eq(pages.id, id))
          .returning();

        if (!updated) {
          return c.json({ error: "Page not found" }, 404);
        }

        const renamed = previousSlug !== null && previousSlug !== updated.slug;
        await invalidateCache(`page:${id}:*`);
        await invalidateCache(`page:${updated.slug}:*`);
        if (renamed) await invalidateCache(`page:${previousSlug}:*`);
        await invalidateCache("pages:*");
        await invalidateCache("render:*");
        ctx.events?.emit("page:updated", {
          id: updated.id,
          slug: updated.slug,
          ...(renamed ? { previousSlug } : {}),
        });
        return c.json(updated);
      },
    })
  );

  // Delete page
  ops.push(
    defineOperation({
      id: "delete-page",
      method: "DELETE",
      route: "/pages/:id",
      summary: "Delete a page",
      description: "Deletes a page and all its blocks. Cannot be undone.",
      access: "session",
      permission: { policy: { resource: "page", action: "delete" } },
      input: { params: ParamId },
      output: { schema: Success.extend({ id: z.guid() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Page not found" }, 404);

        const [deleted] = await dbInstance.delete(pages).where(eq(pages.id, id)).returning();

        if (!deleted) {
          return c.json({ error: "Page not found" }, 404);
        }

        await invalidateCache(`page:${id}:*`);
        await invalidateCache(`page:${deleted.slug}:*`);
        await invalidateCache("pages:*");
        await invalidateCache("render:*");
        ctx.events?.emit("page:deleted", { id: deleted.id, slug: deleted.slug });
        return c.json({ success: true, id: deleted.id });
      },
    })
  );

  // ═══════════════════════════════════════════════
  // BLOCKS CRUD
  // ═══════════════════════════════════════════════

  // Add block to page
  ops.push(
    defineOperation({
      id: "create-block",
      method: "POST",
      route: "/pages/:pageId/blocks",
      summary: "Add a block to a page",
      description:
        "Appends a block (after the last one unless sortOrder is given). The content is sanitized for its type before it is stored.",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: PageParam, body: BlockInput.optional() },
      output: { status: 201, schema: Block },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const { pageId } = c.req.param();
        if (!IS_UUID.test(pageId)) return c.json({ error: "Page not found" }, 404);
        const body = input.body;
        const blockError = validateBlocks([body]);
        if (blockError) return c.json({ error: blockError }, 400);
        if (!body) return c.json({ error: "Invalid block" }, 400);
        const oldKeys = oldKeysError([body]);
        if (oldKeys) return c.json(oldKeys, 422);

        // Verify page exists
        const [page] = await dbInstance
          .select({ id: pages.id })
          .from(pages)
          .where(eq(pages.id, pageId))
          .limit(1);
        if (!page) {
          return c.json({ error: "Page not found" }, 404);
        }

        // Get current max sort order
        const [{ maxOrder }] = await dbInstance
          .select({ maxOrder: sql<number>`COALESCE(MAX(${blocks.sortOrder}), -1)` })
          .from(blocks)
          .where(eq(blocks.pageId, pageId));

        const [block] = await dbInstance
          .insert(blocks)
          .values({
            pageId,
            type: body.type,
            name: body.name,
            sortOrder: body.sortOrder ?? maxOrder + 1,
            columnSpan: body.columnSpan ?? 12,
            content: sanitizeBlockContent(body.type, body.content ?? {}),
            cssClass: body.cssClass,
            backgroundColor: body.backgroundColor,
            textColor: body.textColor,
            padding: body.padding,
            isVisible: body.isVisible ?? true,
            visibleFrom: body.visibleFrom,
            visibleUntil: body.visibleUntil,
          })
          .returning();

        await invalidatePage(pageId);
        return c.json(block, 201);
      },
    })
  );

  // Update block
  ops.push(
    defineOperation({
      id: "update-block",
      method: "PATCH",
      route: "/blocks/:id",
      summary: "Update a block",
      description:
        'Changes the given block fields; new content is sanitized for the block type. `contentPatch: [{ path, value }]` changes single content fields (dot paths, numeric segments index arrays) instead of replacing `content`. With `If-Match: "<updatedAt>"` (or `expectedUpdatedAt`) the write only happens if the block was not changed since; otherwise 409 with the current block.',
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId, body: BlockChanges.optional() },
      output: { schema: Block },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Block not found" }, 404);
        const body = input.body;
        if (!body || typeof body !== "object") return c.json({ error: "Invalid body" }, 400);
        const styleError = invalidStyle(body);
        if (styleError) return c.json({ error: styleError }, 400);

        const rawPatch = (body as { contentPatch?: unknown }).contentPatch;
        if (rawPatch !== undefined && body.content !== undefined) {
          return c.json({ error: "Send `content` or `contentPatch`, not both" }, 400);
        }
        const patch = rawPatch === undefined ? null : parseContentPatch(rawPatch);
        if (typeof patch === "string") return c.json({ error: patch }, 400);

        const expected = expectedVersion(
          c.req.header("if-match"),
          (body as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
        );
        if (expected === null) {
          return c.json(
            { error: "`If-Match` / `expectedUpdatedAt` must be the block's `updatedAt`" },
            400
          );
        }

        /**
         * Read, compare and write under a row lock: two editors saving the same block at
         * once are serialized, and with `contentPatch` each one changes only its own field
         * on top of what the other saved (the whole `content` used to win last).
         */
        type Outcome =
          | { kind: "missing" }
          | { kind: "conflict"; current: Record<string, unknown> }
          | { kind: "rejected"; status: 400 | 422; body: unknown }
          | { kind: "updated"; block: { pageId: string } & Record<string, unknown> };

        const outcome: Outcome = await dbInstance.transaction(async (trx: any) => {
          const [current] = await trx
            .select()
            .from(blocks)
            .where(eq(blocks.id, id))
            .limit(1)
            .for("update");
          if (!current) return { kind: "missing" };
          if (expected && new Date(current.updatedAt).getTime() !== expected.getTime()) {
            return { kind: "conflict", current: blockToServe(current) };
          }

          const updates: Record<string, unknown> = { updatedAt: new Date() };

          if (body.name !== undefined) updates.name = body.name;
          if (body.content !== undefined || patch) {
            // The type is needed to sanitize according to it (`embed`, `text`…).
            let next: unknown = body.content;
            if (patch) {
              const patched = applyContentPatch(
                readBlockData(current.type, current.content),
                patch
              );
              if (typeof patched === "string") {
                return { kind: "rejected", status: 400, body: { error: patched } };
              }
              next = patched;
            }
            const oldKeys = oldKeysError([{ type: current.type, content: next }]);
            if (oldKeys) return { kind: "rejected", status: 422, body: oldKeys };
            updates.content = sanitizeBlockContent(current.type, next);
          }
          if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
          if (body.columnSpan !== undefined) updates.columnSpan = body.columnSpan;
          if (body.cssClass !== undefined) updates.cssClass = body.cssClass;
          if (body.backgroundColor !== undefined) updates.backgroundColor = body.backgroundColor;
          if (body.textColor !== undefined) updates.textColor = body.textColor;
          if (body.padding !== undefined) updates.padding = body.padding;
          if (body.isVisible !== undefined) updates.isVisible = body.isVisible;
          if (body.visibleFrom !== undefined) updates.visibleFrom = body.visibleFrom;
          if (body.visibleUntil !== undefined) updates.visibleUntil = body.visibleUntil;

          const [updated] = await trx
            .update(blocks)
            .set(updates)
            .where(eq(blocks.id, id))
            .returning();
          return updated ? { kind: "updated", block: updated } : { kind: "missing" };
        });

        if (outcome.kind === "missing") return c.json({ error: "Block not found" }, 404);
        if (outcome.kind === "rejected") return c.json(outcome.body as object, outcome.status);
        if (outcome.kind === "conflict") {
          return c.json(
            {
              error: "The block changed since you read it",
              code: "KITSUDEN_E_CONFLICT",
              current: outcome.current,
            },
            409
          );
        }

        await invalidatePage(outcome.block.pageId);
        return c.json(outcome.block);
      },
    })
  );

  // Delete block
  ops.push(
    defineOperation({
      id: "delete-block",
      method: "DELETE",
      route: "/blocks/:id",
      summary: "Delete a block",
      description: "Removes one block from its page.",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Block not found" }, 404);

        const [block] = await dbInstance
          .select({ pageId: blocks.pageId })
          .from(blocks)
          .where(eq(blocks.id, id))
          .limit(1);
        if (!block) {
          return c.json({ error: "Block not found" }, 404);
        }

        await dbInstance.delete(blocks).where(eq(blocks.id, id));

        await invalidatePage(block.pageId);
        return c.json({ success: true });
      },
    })
  );

  // Reorder blocks
  ops.push(
    defineOperation({
      id: "reorder-blocks",
      method: "POST",
      route: "/pages/:pageId/blocks/reorder",
      summary: "Reorder the blocks of a page",
      description:
        "Sets sortOrder for up to 500 blocks of the page in one go. Blocks of other pages are ignored. Sending the same order twice leaves the same state.",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      idempotent: true,
      input: { params: PageParam, body: Reordenar.optional() },
      output: { schema: Success },
      handle: async (input, { c }) => {
        const { pageId } = c.req.param();
        const { blockOrders } = (input.body ?? {}) as {
          blockOrders?: unknown;
        };

        if (!Array.isArray(blockOrders)) {
          return c.json({ error: "blockOrders must be an array" }, 400);
        }
        // A transaction with one statement per element: without a cap, an array of
        // a million entries keeps the database busy as long as it takes.
        if (
          blockOrders.length > MAX_BLOCKS_PER_REQUEST ||
          !blockOrders.every(
            (b: any) =>
              b && typeof b.id === "string" && IS_UUID.test(b.id) && Number.isInteger(b.sortOrder)
          )
        ) {
          return c.json(
            { error: "blockOrders: up to 500 elements { id: uuid, sortOrder: integer }" },
            400
          );
        }

        // Update all blocks in a transaction
        await dbInstance.transaction(async (trx: any) => {
          for (const { id, sortOrder } of blockOrders) {
            await trx
              .update(blocks)
              .set({ sortOrder, updatedAt: new Date() })
              .where(and(eq(blocks.id, id), eq(blocks.pageId, pageId)));
          }
        });

        await invalidatePage(pageId);
        return c.json({ success: true });
      },
    })
  );

  // Duplicate block
  ops.push(
    defineOperation({
      id: "duplicate-block",
      method: "POST",
      route: "/blocks/:id/duplicate",
      summary: "Duplicate a block",
      description: "Copies a block to the end of the same page (name gets a '(Copy)' suffix).",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId },
      output: { status: 201, schema: Block },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Block not found" }, 404);

        const [original] = await dbInstance.select().from(blocks).where(eq(blocks.id, id)).limit(1);
        if (!original) {
          return c.json({ error: "Block not found" }, 404);
        }

        // Get max sort order for the page
        const [{ maxOrder }] = await dbInstance
          .select({ maxOrder: sql<number>`COALESCE(MAX(${blocks.sortOrder}), -1)` })
          .from(blocks)
          .where(eq(blocks.pageId, original.pageId));

        const [duplicated] = await dbInstance
          .insert(blocks)
          .values({
            pageId: original.pageId,
            type: original.type,
            name: `${original.name || original.type} (Copy)`,
            sortOrder: maxOrder + 1,
            columnSpan: original.columnSpan,
            // Remove in 0.10 (back to `original.content`): the copy is written in English.
            content: readBlockData(original.type, original.content),
            cssClass: original.cssClass,
            backgroundColor: original.backgroundColor,
            textColor: original.textColor,
            padding: original.padding,
            isVisible: original.isVisible,
            // Without them a scheduled block's copy was public at once
            visibleFrom: original.visibleFrom,
            visibleUntil: original.visibleUntil,
          })
          .returning();

        await invalidatePage(original.pageId);
        return c.json(duplicated, 201);
      },
    })
  );

  // ═══════════════════════════════════════════════
  // RENDER ENDPOINT (Public)
  // ═══════════════════════════════════════════════

  // Render page for public consumption
  ops.push(
    defineOperation({
      id: "render-page",
      method: "GET",
      route: "/render/:slug",
      summary: "Render a published page",
      description:
        "A published page ready to paint: page metadata plus visible blocks (scheduled visibility applied) with transform URLs for their media. Session-only pages need a session.",
      access: "public",
      input: { params: ParamSlug },
      output: { schema: RenderedPage },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { slug } = c.req.param();

        const rendered = await cachedQuery(`render:${slug}`, 300, async () => {
          // Get published page
          const [page] = await dbInstance
            .select()
            .from(pages)
            .where(and(eq(pages.slug, slug), eq(pages.status, "published")))
            .limit(1);

          if (!page) return null;

          // Get visible blocks
          const now = new Date();
          const pageBlocks = await dbInstance
            .select()
            .from(blocks)
            .where(and(eq(blocks.pageId, page.id), eq(blocks.isVisible, true)))
            .orderBy(asc(blocks.sortOrder));

          // Filter by visibility dates
          const visibleBlocks = pageBlocks.filter((block: any) => {
            if (block.visibleFrom && new Date(block.visibleFrom) > now) return false;
            if (block.visibleUntil && new Date(block.visibleUntil) < now) return false;
            return true;
          });

          // Process blocks to add transform URLs for media
          const processedBlocks = visibleBlocks.map((block: any) => {
            const content = block.content as Record<string, unknown>;
            const mediaUrls: Record<string, unknown> = {};

            /**
             * The media id is CHECKED, not forced.
             *
             * `content` is `Record<string, unknown>`: what is in `content.mediaId`
             * is whatever someone stored in the block, and it can be anything.
             * Passing it to `buildTransformUrl` with a cast compiled and built a
             * URL with `[object Object]` inside — a broken image on the published
             * page, not an error in the log.
             */
            const mediaId = (v: unknown): string | null =>
              typeof v === "string" && v.trim() ? v : null;

            // Generate transform URLs based on block type
            const heroId = mediaId(content?.mediaId);
            if (block.type === "hero" && heroId) {
              // Hero uses hero preset (1920x1080 cover) with optional focal point
              const focalPoint = content.focalPoint as never;
              mediaUrls.hero = buildTransformUrl(heroId, "hero", focalPoint);
              mediaUrls.large = buildTransformUrl(heroId, "large", focalPoint);
              mediaUrls.medium = buildTransformUrl(heroId, "medium", focalPoint);
              mediaUrls.small = buildTransformUrl(heroId, "small", focalPoint);
            }

            if (block.type === "image" && heroId) {
              // Image block uses multiple presets for responsive images
              mediaUrls.thumbnail = buildTransformUrl(heroId, "thumbnail");
              mediaUrls.small = buildTransformUrl(heroId, "small");
              mediaUrls.medium = buildTransformUrl(heroId, "medium");
              mediaUrls.large = buildTransformUrl(heroId, "large");
            }

            if (block.type === "cards" && content?.cards) {
              // Cards may have images - generate thumbnail and small
              //
              // `content.cards` is `unknown`: a block saved with `cards` as an
              // object (or as a string) made `.map` blow up in production.
              const cards = Array.isArray(content.cards) ? content.cards : [];
              mediaUrls.cards = cards
                .map((card: { id?: string; mediaId?: unknown }) => {
                  const cardId = mediaId(card?.mediaId);
                  if (!cardId) return null;
                  return {
                    cardId: card.id,
                    thumbnail: buildTransformUrl(cardId, "thumbnail"),
                    small: buildTransformUrl(cardId, "small"),
                    medium: buildTransformUrl(cardId, "medium"),
                  };
                })
                .filter(Boolean);
            }

            const authorId = mediaId(content?.authorImageId);
            if (block.type === "quote" && authorId) {
              // Quote author image uses thumbnail
              mediaUrls.authorImage = buildTransformUrl(authorId, "thumbnail");
            }

            return {
              id: block.id,
              type: block.type,
              content: contentToServe(block.type, block.content),
              columnSpan: block.columnSpan,
              cssClass: block.cssClass,
              backgroundColor: block.backgroundColor,
              textColor: block.textColor,
              padding: block.padding,
              mediaUrls: Object.keys(mediaUrls).length > 0 ? mediaUrls : undefined,
            };
          });

          return {
            page: {
              id: page.id,
              title: page.title,
              slug: page.slug,
              description: page.description,
              metaTitle: page.metaTitle || page.title,
              metaDescription: page.metaDescription,
              layout: page.layout,
              cssClass: page.cssClass,
              customCss: cssToServe(page.customCss),
              publishedAt: page.publishedAt,
            },
            blocks: processedBlocks,
            // It goes into the cache to decide below; it is not part of the response.
            requireAuth: page.requireAuth === true,
          };
        });

        /**
         * `requireAuth` was stored and NOBODY checked it: a page marked "signed-in
         * only" was served in full to anyone from here.
         */
        if (!rendered || (rendered.requireAuth && !userOf(c))) {
          return c.json({ error: "Page not found" }, 404);
        }

        const { requireAuth: _requireAuth, ...audience } = rendered;
        return c.json(audience);
      },
    })
  );

  // ═══════════════════════════════════════════════
  // BLOCK TEMPLATES
  // ═══════════════════════════════════════════════

  // List templates
  ops.push(
    defineOperation({
      id: "list-templates",
      unpaginated: "Page templates: a library curated by hand, filtered by category and type.",
      method: "GET",
      route: "/templates",
      summary: "List block templates",
      description:
        "Active block templates, most used first, optionally filtered by category or block type.",
      access: "public",
      input: { query: TemplatesQuery },
      output: { schema: TemplatesList },
      errors: ["KITSUDEN_E_BAD_REQUEST"],
      handle: async (input, { c }) => {
        const query = c.req.query();
        const category = query.category;
        const type = query.type;

        /**
         * The type filter is validated BEFORE entering the cache.
         *
         * `eqEnum` returns `undefined` when the value does not belong to the enum, which is its
         * way of avoiding the 500 Postgres gives when comparing an enum column with
         * garbage. But pushing it as-is into the array put `undefined` among the
         * conditions, and the effect was the OPPOSITE of what was asked: filtering by an
         * invalid type returned **all** the templates. A client with a typo
         * got the whole list believing it had filtered.
         *
         * It is checked here and not inside the callback for two reasons: there is no
         * `c` there to respond with, and an invalid request must not end up occupying a cache
         * entry for five minutes.
         */
        const typeFilter = type ? eqEnum(blockTemplates.type, type) : undefined;
        if (type && !typeFilter) {
          return c.json({ error: `Invalid block type: "${type}"` }, 400);
        }

        const result = await cachedQuery(
          `templates:list:${category || "all"}:${type || "all"}`,
          300,
          async () => {
            const conditions = [eq(blockTemplates.isActive, true)];

            if (category) {
              conditions.push(eq(blockTemplates.category, category));
            }
            if (typeFilter) {
              conditions.push(typeFilter);
            }

            const list = await dbInstance
              .select({
                id: blockTemplates.id,
                name: blockTemplates.name,
                description: blockTemplates.description,
                category: blockTemplates.category,
                type: blockTemplates.type,
                content: blockTemplates.content,
                cssClass: blockTemplates.cssClass,
                backgroundColor: blockTemplates.backgroundColor,
                textColor: blockTemplates.textColor,
                padding: blockTemplates.padding,
                usageCount: blockTemplates.usageCount,
              })
              .from(blockTemplates)
              .where(and(...conditions))
              .orderBy(desc(blockTemplates.usageCount));

            return {
              docs: list.map((t: { type: unknown; content: unknown }) => ({
                ...t,
                content: contentToServe(t.type, t.content),
              })),
            };
          }
        );

        return c.json(result);
      },
    })
  );

  // Create template
  ops.push(
    defineOperation({
      id: "create-template",
      method: "POST",
      route: "/templates",
      summary: "Create a block template",
      description: "Saves a reusable block (name, block type and content).",
      access: "session",
      permission: { policy: { resource: "page", action: "create" } },
      input: { body: TemplateEntry.optional() },
      output: { status: 201, schema: Template },
      handle: async (input, { c }) => {
        const body = input.body;
        if (
          !body ||
          typeof body !== "object" ||
          typeof body.name !== "string" ||
          !validType(body.type)
        ) {
          return c.json({ error: "A `name` and a valid block `type` are required" }, 400);
        }
        const styleError = invalidStyle(body);
        if (styleError) return c.json({ error: styleError }, 400);
        const oldKeys = oldKeysError([body]);
        if (oldKeys) return c.json(oldKeys, 422);

        const [template] = await dbInstance
          .insert(blockTemplates)
          .values({
            name: body.name,
            description: body.description,
            category: body.category,
            type: body.type,
            content: sanitizeBlockContent(body.type, body.content ?? {}),
            cssClass: body.cssClass,
            backgroundColor: body.backgroundColor,
            textColor: body.textColor,
            padding: body.padding,
          })
          .returning();

        await invalidateCache("templates:*");
        return c.json(template, 201);
      },
    })
  );

  // Update template usage count (called when used)
  ops.push(
    defineOperation({
      id: "use-template",
      method: "POST",
      route: "/templates/:id/use",
      summary: "Count one use of a template",
      description: "Increments the usage counter of a template (it orders the template list).",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId },
      output: { schema: Template },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Template not found" }, 404);

        const [updated] = await dbInstance
          .update(blockTemplates)
          .set({
            usageCount: sql`${blockTemplates.usageCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(blockTemplates.id, id))
          .returning();

        if (!updated) {
          return c.json({ error: "Template not found" }, 404);
        }

        return c.json(updated);
      },
    })
  );

  // ═══════════════════════════════════════════════
  // BLOCK TYPES REGISTRY
  // ═══════════════════════════════════════════════

  // Get available block types and their schemas
  ops.push(
    defineOperation({
      id: "block-types",
      method: "GET",
      route: "/block-types",
      summary: "List block types",
      description:
        "The block types a page can hold, each with the descriptor of its content fields.",
      access: "public",
      output: { schema: BlockTypes },
      handle: async (_input, { c }) => {
        const blockTypes = [
          {
            type: "hero",
            name: "Hero Section",
            category: "layout",
            icon: "layout",
            description: "Large banner with headline, description, and call-to-action",
            schema: {
              headline: { type: "string", required: true },
              subheadline: { type: "string" },
              description: { type: "string" },
              mediaId: { type: "string", description: "Background image/video" },
              mediaType: { type: "enum", options: ["image", "video"], default: "image" },
              alignment: { type: "enum", options: ["left", "center", "right"], default: "center" },
              minHeight: { type: "enum", options: ["sm", "md", "lg", "xl"], default: "md" },
              focalPoint: {
                type: "object",
                description: "Smart crop focal point (0-1)",
                properties: {
                  x: { type: "number", min: 0, max: 1, default: 0.5 },
                  y: { type: "number", min: 0, max: 1, default: 0.5 },
                },
              },
              primaryButton: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  url: { type: "string" },
                  variant: { type: "enum", options: ["primary", "secondary", "outline"] },
                },
              },
              secondaryButton: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
          {
            type: "text",
            name: "Text",
            category: "content",
            icon: "type",
            description: "Rich text content block",
            schema: {
              text: { type: "string", required: true },
              format: { type: "enum", options: ["html", "markdown", "plain"], default: "html" },
              alignment: {
                type: "enum",
                options: ["left", "center", "right", "justify"],
                default: "left",
              },
              textSize: { type: "enum", options: ["sm", "md", "lg", "xl"], default: "md" },
            },
          },
          {
            type: "image",
            name: "Image",
            category: "media",
            icon: "image",
            description: "Single image with optional caption and link",
            schema: {
              mediaId: { type: "string", required: true },
              altText: { type: "string" },
              caption: { type: "string" },
              alignment: {
                type: "enum",
                options: ["left", "center", "right", "full"],
                default: "center",
              },
              linkUrl: { type: "string" },
              openInNewTab: { type: "boolean", default: false },
            },
          },
          {
            type: "video",
            name: "Video",
            category: "media",
            icon: "video",
            description: "Self-hosted or embedded video",
            schema: {
              mediaId: { type: "string", description: "For self-hosted videos" },
              embedUrl: { type: "string", description: "YouTube/Vimeo URL" },
              provider: { type: "enum", options: ["youtube", "vimeo", "self"], default: "self" },
              autoplay: { type: "boolean", default: false },
              loop: { type: "boolean", default: false },
              muted: { type: "boolean", default: true },
              controls: { type: "boolean", default: true },
            },
          },
          {
            type: "grid",
            name: "Grid Layout",
            category: "layout",
            icon: "grid",
            description: "Multi-column grid for organizing content",
            schema: {
              columns: { type: "number", min: 1, max: 4, default: 2 },
              gap: { type: "enum", options: ["sm", "md", "lg"], default: "md" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    columnSpan: { type: "number", min: 1, max: 12 },
                    content: { type: "object" },
                  },
                },
              },
            },
          },
          {
            type: "cards",
            name: "Cards",
            category: "content",
            icon: "square-stack",
            description: "Card grid with images, titles, and descriptions",
            schema: {
              cards: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string", required: true },
                    description: { type: "string" },
                    mediaId: { type: "string" },
                    linkUrl: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                },
              },
              columns: { type: "enum", options: [1, 2, 3, 4], default: 3 },
              variant: {
                type: "enum",
                options: ["default", "horizontal", "compact"],
                default: "default",
              },
            },
          },
          {
            type: "quote",
            name: "Quote",
            category: "content",
            icon: "quote",
            description: "Testimonial or quote with attribution",
            schema: {
              quote: { type: "string", required: true },
              author: { type: "string" },
              authorTitle: { type: "string" },
              authorImageId: { type: "string" },
              style: { type: "enum", options: ["default", "large", "minimal"], default: "default" },
            },
          },
          {
            type: "cta",
            name: "Call to Action",
            category: "marketing",
            icon: "megaphone",
            description: "Promotional section with button",
            schema: {
              title: { type: "string", required: true },
              description: { type: "string" },
              buttonLabel: { type: "string", required: true },
              buttonUrl: { type: "string", required: true },
              buttonVariant: {
                type: "enum",
                options: ["primary", "secondary", "outline"],
                default: "primary",
              },
              alignment: { type: "enum", options: ["left", "center", "right"], default: "center" },
            },
          },
          {
            type: "embed",
            name: "Embed",
            category: "media",
            icon: "code",
            description: "HTML embed code (iframes, widgets, etc.)",
            schema: {
              code: { type: "string", required: true, description: "HTML embed code" },
              caption: { type: "string" },
            },
          },
          {
            type: "divider",
            name: "Divider",
            category: "layout",
            icon: "minus",
            description: "Horizontal line separator",
            schema: {
              style: { type: "enum", options: ["solid", "dashed", "dotted"], default: "solid" },
              width: { type: "enum", options: ["full", "partial"], default: "full" },
              color: { type: "string", description: "CSS color value" },
            },
          },
          {
            type: "spacer",
            name: "Spacer",
            category: "layout",
            icon: "arrows-out-vertical",
            description: "Vertical spacing block",
            schema: {
              height: { type: "enum", options: ["sm", "md", "lg", "xl", "2xl"], default: "md" },
            },
          },
          {
            type: "custom",
            name: "Custom Component",
            category: "advanced",
            icon: "puzzle-piece",
            description: "Custom React/Vue/Svelte component",
            schema: {
              component: { type: "string", required: true, description: "Component identifier" },
              props: { type: "object", description: "Component props" },
            },
          },
        ];

        /**
         * Every type the API accepts, not only the twelve described above: a client that
         * built its palette from this list refused types `BLOCK_TYPES` saves (`richtext`,
         * `tier-list`…). The extra ones carry an empty `schema` and `described: false`.
         */
        const described = new Set(blockTypes.map((t) => t.type));
        const all = [
          ...blockTypes.map((t) => ({ ...t, described: true })),
          ...BLOCK_TYPES.filter((t) => !described.has(t)).map(undescribedType),
        ];

        return c.json({ blockTypes: all });
      },
    })
  );

  // ═══════════════════════════════════════════════
  // CLONE PAGE
  // ═══════════════════════════════════════════════

  ops.push(
    defineOperation({
      id: "clone-page",
      method: "POST",
      route: "/pages/:id/clone",
      summary: "Clone a page",
      description:
        "Copies a page and its blocks as a new draft (never as homepage). Slug and title default to '<slug>-copy' and '<title> (Copy)'.",
      access: "session",
      permission: { policy: { resource: "page", action: "create" } },
      input: { params: ParamId, body: Clone },
      output: { status: 201, schema: Page },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Page not found" }, 404);
        const body = (input.body ?? {}) as {
          slug?: unknown;
          title?: unknown;
        };

        // Get original page with blocks
        const [original] = await dbInstance.select().from(pages).where(eq(pages.id, id)).limit(1);
        if (!original) {
          return c.json({ error: "Page not found" }, 404);
        }

        const originalBlocks = await dbInstance
          .select()
          .from(blocks)
          .where(eq(blocks.pageId, id))
          .orderBy(asc(blocks.sortOrder));

        // Generate new slug
        const newSlug =
          typeof body.slug === "string" && body.slug ? body.slug : `${original.slug}-copy`;
        const newTitle =
          typeof body.title === "string" && body.title.trim()
            ? body.title
            : `${original.title} (Copy)`;
        if (!RE_SLUG.test(newSlug))
          return c.json({ error: "`slug` only allows lowercase letters, digits and hyphens" }, 400);

        // Check for slug conflict
        const [existing] = await dbInstance
          .select({ id: pages.id })
          .from(pages)
          .where(eq(pages.slug, newSlug))
          .limit(1);
        if (existing) {
          return c.json({ error: "A page with this slug already exists" }, 409);
        }

        // Create cloned page
        const [cloned] = await dbInstance
          .insert(pages)
          .values({
            title: newTitle,
            slug: newSlug,
            description: original.description,
            status: "draft", // Always start as draft
            layout: original.layout,
            metaTitle: original.metaTitle,
            metaDescription: original.metaDescription,
            ogImageId: original.ogImageId,
            cssClass: original.cssClass,
            customCss: cssToServe(original.customCss),
            isHomepage: false, // Never clone as homepage
            requireAuth: original.requireAuth,
          })
          .returning();

        // Clone blocks
        if (originalBlocks.length > 0) {
          await dbInstance.insert(blocks).values(
            originalBlocks.map((block: any) => ({
              pageId: cloned.id,
              type: block.type,
              name: block.name,
              sortOrder: block.sortOrder,
              columnSpan: block.columnSpan,
              // A clone is a new write: a block the 0.10 migration missed comes out in English.
              content: contentToServe(block.type, block.content),
              cssClass: block.cssClass,
              backgroundColor: block.backgroundColor,
              textColor: block.textColor,
              padding: block.padding,
              isVisible: block.isVisible,
              /**
               * The schedule travels with the block. Without it a block scheduled for next
               * week was visible in the copy, and publishing the copy (Inti's drafts) made
               * it public early and next to the original, which stays hidden.
               */
              visibleFrom: block.visibleFrom,
              visibleUntil: block.visibleUntil,
            }))
          );
        }

        await invalidateCache("pages:*");
        return c.json(cloned, 201);
      },
    })
  );

  // ═══════════════════════════════════════════════
  // PUBLISH A DRAFT ONTO ITS PAGE
  // ═══════════════════════════════════════════════

  /**
   * Takes a draft (a copy made with `clone`) to the page it was copied from, in ONE
   * transaction.
   *
   * Before this route a client (Inti) did it with about 3N+6 calls: create the new
   * blocks hidden, delete the old ones, show the new ones, patch the page, delete the
   * copy. A 25-block page hit the agent quota halfway and was left public with 3 of its
   * 25 blocks. Here it all commits or nothing does.
   *
   * What it replaces is what a reader sees NOW: the page's blocks shown right now go,
   * and the draft's blocks shown right now take their places (their `sortOrder`, so a
   * hidden block keeps its spot when it is switched back on). Hidden and scheduled
   * blocks of the page stay as they are; the draft's own hidden ones are not copied,
   * since nobody editing the draft could see them. The id, slug, status, homepage flag
   * and session requirement of the page do not change.
   */
  ops.push(
    defineOperation({
      id: "publish-draft",
      method: "POST",
      route: "/pages/:id/publish-draft",
      summary: "Publish a draft onto its page",
      description:
        "Atomically replaces the page's currently shown blocks with the draft's, copies title, description, metaTitle, metaDescription and ogImageId, and deletes the draft. Hidden and scheduled blocks of the page are kept. Returns the page with its shown blocks.",
      access: "session",
      permission: { policy: { resource: "page", action: "update" } },
      input: { params: ParamId, body: PublishDraft.optional() },
      output: { schema: PageWithBlocks },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const { id } = c.req.param();
        if (!IS_UUID.test(id)) return c.json({ error: "Page not found" }, 404);
        const draftId = (input.body as { draftId?: unknown } | undefined)?.draftId;
        if (typeof draftId !== "string" || !IS_UUID.test(draftId)) {
          return c.json({ error: "`draftId` must be the uuid of the draft page" }, 400);
        }
        if (draftId === id) return c.json({ error: "A page cannot be its own draft" }, 400);

        type Outcome =
          | { kind: "missing"; what: "page" | "draft" }
          | { kind: "not-draft"; status: string }
          | { kind: "done"; slug: string; draftSlug: string };

        const outcome: Outcome = await dbInstance.transaction(async (trx: any) => {
          // Both rows locked, in a fixed order so two publishes cannot deadlock
          const locked = await trx
            .select()
            .from(pages)
            .where(sql`${pages.id} IN (${id}, ${draftId})`)
            .orderBy(asc(pages.id))
            .for("update");
          const page = locked.find((p: { id: string }) => p.id === id);
          const draft = locked.find((p: { id: string }) => p.id === draftId);
          if (!page) return { kind: "missing", what: "page" };
          if (!draft) return { kind: "missing", what: "draft" };
          if (draft.status !== "draft") return { kind: "not-draft", status: String(draft.status) };

          const now = new Date();
          const byOrder = (a: { sortOrder: number }, b: { sortOrder: number }) =>
            a.sortOrder - b.sortOrder;
          const pageBlocks = (await trx.select().from(blocks).where(eq(blocks.pageId, id))).sort(
            byOrder
          );
          const draftBlocks = (await trx.select().from(blocks).where(eq(blocks.pageId, draftId)))
            .filter((b: any) => shownNow(b, now))
            .sort(byOrder);

          const replaced = pageBlocks.filter((b: any) => shownNow(b, now));
          const orders = replaced.map((b: { sortOrder: number }) => b.sortOrder);
          const highest = Math.max(
            -1,
            ...pageBlocks.map((b: { sortOrder: number }) => b.sortOrder)
          );

          for (const b of replaced) {
            await trx.delete(blocks).where(eq(blocks.id, b.id));
          }
          if (draftBlocks.length) {
            await trx.insert(blocks).values(
              draftBlocks.map((b: any, i: number) => ({
                pageId: id,
                type: b.type,
                name: b.name,
                sortOrder: orders[i] ?? highest + 1 + (i - orders.length),
                columnSpan: b.columnSpan,
                content: contentToServe(b.type, b.content),
                cssClass: b.cssClass,
                backgroundColor: b.backgroundColor,
                textColor: b.textColor,
                padding: b.padding,
                isVisible: true,
                visibleFrom: b.visibleFrom,
                visibleUntil: b.visibleUntil,
              }))
            );
          }

          await trx
            .update(pages)
            .set({
              title: draft.title,
              description: draft.description,
              metaTitle: draft.metaTitle,
              metaDescription: draft.metaDescription,
              ogImageId: draft.ogImageId,
              updatedAt: now,
            })
            .where(eq(pages.id, id));
          // The draft's blocks go with it (on delete cascade)
          await trx.delete(pages).where(eq(pages.id, draftId));
          return { kind: "done", slug: page.slug, draftSlug: draft.slug };
        });

        if (outcome.kind === "missing") {
          return c.json(
            { error: outcome.what === "page" ? "Page not found" : "Draft not found" },
            404
          );
        }
        if (outcome.kind === "not-draft") {
          return c.json(
            { error: `Page ${draftId} is not a draft (status: ${outcome.status})` },
            400
          );
        }

        await invalidatePage(id, { touch: false });
        await invalidateCache(`page:${draftId}:*`);
        await invalidateCache(`page:${outcome.draftSlug}:*`);

        const [page] = await dbInstance.select().from(pages).where(eq(pages.id, id)).limit(1);
        const now = new Date();
        const shown = (
          await dbInstance
            .select()
            .from(blocks)
            .where(eq(blocks.pageId, id))
            .orderBy(asc(blocks.sortOrder))
        ).filter((b: any) => shownNow(b, now));
        return c.json({
          ...page,
          customCss: cssToServe(page?.customCss),
          blocks: shown.map(blockToServe),
        });
      },
    })
  );

  return ops;
}

/** The REST router, generated from the operations (mounted by the kon loader). */
export function createBlocksRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, blockOperations(ctx), ctx);
}

// Legacy exports maintained for compatibility
// Use createBlocksRouter(ctx) instead
export const blocksRoutes = createBlocksRouter;
