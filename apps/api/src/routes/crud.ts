import {
  asSystem,
  withSavepoint,
  resolveExecutor,
  isUuid,
  recordChanges,
  DATASET_ENTRY_ENTITY,
} from "@kitsuden/engine";
import {
  accessToDataset,
  agentWritesByPolicy,
  agentSignature,
  publishedOrOwn,
} from "@kitsuden/shared";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { dataSets, dataEntries, siteSettings } from "../db/schema";
import {
  addSchemaVersionToData,
  syncDatasetIndexes,
  validateDatasetEntry,
} from "../lib/dataset-optimizations";
import { applyProvenanceInRest } from "../lib/provenance";
import { invalidateRealtimePolicy } from "../lib/realtime-wiring";
import {
  buildDatasetWhere,
  checkReadAccess,
  checkWriteAccess,
  type PolicyJson,
  type RLSUser,
} from "../lib/rls-builder";
import { forgetSiteSettings } from "../lib/site-settings";
import { requireAuth } from "../middleware/auth";
import { requireStaff } from "../middleware/auth-guard";
import { resolveEntryStatus } from "../middleware/permissions";
import type { AppVariables } from "../types/hono";

import { invalidateGraphQLCache } from "./graphql";

// ── Data Sets Lite (fallback when kon-datasets isn't loaded) ──
export const dataSetsRoutes = new Hono<{ Variables: AppVariables }>();

/**
 * The dataset (its definition, not its rows) applies the SAME read policy
 * as its entries.
 *
 * Before, the listing and the by-slug record returned all datasets to
 * anyone: the rows of a private dataset were protected, but its
 * name, its schema and its policy could be read without a session.
 */
const userOf = (c: { get: (k: "user") => unknown }) => (c.get("user") ?? null) as RLSUser | null;
/**
 * The agent's PER-DATASET scopes (`datasets:<slug>:read`, and the
 * denials `!datasets:<slug>:*`) decide before the policy; if they
 * say nothing, the policy does. Same as in kon-datasets (`canViewDataset`).
 */
const scopesOf = (user: RLSUser | null) =>
  (user as { scopes?: unknown } | null)?.scopes as string[] | undefined;
const readable = (dataset: { policyJson: unknown; slug?: string | null }, user: RLSUser | null) => {
  const access = accessToDataset(scopesOf(user), dataset.slug ?? null, "read");
  if (access) return access === "granted";
  // The team reaches every dataset, as in kon-datasets: an editor must be able to
  // use the dataset it just created, which is `admin`/`admin` by default.
  if (isFromTeam(user)) return true;
  return checkReadAccess((dataset.policyJson ?? null) as PolicyJson | null, user);
};
const writable = (dataset: { policyJson: unknown; slug?: string | null }, user: RLSUser | null) => {
  const access = accessToDataset(scopesOf(user), dataset.slug ?? null, "write");
  if (access) return access === "granted";
  // An agent key is not a session: `writeAccess: "authenticated"` does not let a
  // read-only key write.
  if (user?.role === "agent") {
    return agentWritesByPolicy(scopesOf(user), (dataset.policyJson ?? null) as PolicyJson | null);
  }
  if (isFromTeam(user)) return true;
  return checkWriteAccess((dataset.policyJson ?? null) as PolicyJson | null, user);
};

dataSetsRoutes.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const user = userOf(c);
  // Filtered AFTER reading: `limit` counts the visible ones of the page, not
  // those behind it. With 200 as the maximum, translating the policy
  // to SQL here is not worth it.
  const docs = (await db.select().from(dataSets).orderBy(dataSets.name).limit(limit)).filter((ds) =>
    readable(ds, user)
  );
  return c.json({ docs, totalDocs: docs.length });
});

dataSetsRoutes.get("/slug/:slug", async (c) => {
  const result = await db
    .select()
    .from(dataSets)
    .where(eq(dataSets.slug, c.req.param("slug")))
    .limit(1);
  // 404 also without permission: existence is not confirmed
  if (!result.length || !readable(result[0], userOf(c))) {
    return c.json({ error: "DataSet not found" }, 404);
  }
  return c.json(result[0]);
});

/**
 * A dataset by id.
 *
 * The panel calls it (`api.ts` → `/data-sets/:id`) and it did not exist: without kon-datasets
 * a dataset's record always answered 404.
 */
dataSetsRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);

  const [dataset] = await db.select().from(dataSets).where(eq(dataSets.id, id)).limit(1);
  if (!dataset || !readable(dataset, userOf(c))) {
    return c.json({ error: "DataSet not found" }, 404);
  }
  return c.json(dataset);
});

/**
 * Lists a dataset's entries applying its policyJson.
 *
 * SECURITY (two levels, see ADR-002):
 *   - Level 1 (here): `checkReadAccess` decides whether the user can read the
 *     dataset, and `buildDatasetWhere` translates its `rlsRules` into a Drizzle
 *     WHERE (e.g. ownerId = current_user). This is what really isolates,
 *     because an anonymous user's empty RLS context is an escape hatch in Postgres.
 *   - Level 2: the RLS transaction mounted in index.ts over this route.
 *
 * Before, it filtered ONLY by dataSetId with the global `db`: anyone saw the
 * entries of all users.
 */
dataSetsRoutes.get("/:id/entries", async (c) => {
  const datasetId = c.req.param("id");

  /**
   * An id that is not a UUID is a nonexistent dataset, not a server error.
   *
   * `eq(dataSets.id, datasetId)` with arbitrary text reaches Postgres as
   * is and it answers `invalid input syntax for type uuid`: 500. Any old
   * or mistyped link gave a server error instead of 404 — and a 500 on a public
   * route is log noise that hides the ones that do matter.
   *
   * Found by `scripts/smoke-routes.ts`.
   */
  if (!isUuid(datasetId)) return c.json({ error: "DataSet not found" }, 404);

  const limit = Math.min(Number(c.req.query("limit")) || 500, 1000);
  /**
   * Without `offset` there was no way to read a dataset of more than 1000 rows: the
   * public site kept the first ones and the rest did not exist for it
   * (a Star Rail character was missing skills because its row fell
   * beyond the cutoff).
   */
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const user = (c.get("user") ?? null) as RLSUser | null;

  const [dataset] = await db
    .select({ policyJson: dataSets.policyJson, slug: dataSets.slug })
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  // 404 (not 403) so as not to leak the existence of the dataset.
  if (!dataset) return c.json({ error: "DataSet not found" }, 404);

  const policy = dataset.policyJson as PolicyJson | null;
  if (!readable(dataset, user)) {
    return c.json({ error: "DataSet not found" }, 404);
  }

  const { where } = buildDatasetWhere(datasetId, policy?.rlsRules, user);
  // Without being on the team: published or their own
  const visible = isFromTeam(user) ? where : and(where, publishedOrOwn(user?.id));

  const executor = resolveExecutor(db) as typeof db;

  /**
   * `?count=exact`: how many rows the asker SEES in total (not just on this
   * page), with the SAME visibility filter and over the same RLS transaction
   * as the rows. It goes in `totalCount`; `totalDocs` remains the size
   * of the page, as always. With `limit=0` no rows are read: it only counts.
   *
   * For the websites' "By the numbers", which to know how many records there were read
   * ALL the rows of each dataset page by page (performance, 2026-10-27).
   */
  const count = c.req.query("count") === "exact";
  const onlyCount = count && c.req.query("limit") === "0";

  const totalCount = count
    ? Number(
        (
          await executor
            .select({ n: sql<number>`count(*)` })
            .from(dataEntries)
            .where(visible)
        )[0]?.n ?? 0
      )
    : undefined;

  // Runs on the request-scope RLS tx if it exists; otherwise the global db.
  const docs = onlyCount
    ? []
    : await executor
        .select()
        .from(dataEntries)
        .where(visible)
        // The id breaks ties: with two rows of the same `sortOrder`, the order between
        // pages is undefined and a row could be repeated or lost
        .orderBy(dataEntries.sortOrder, dataEntries.id)
        .limit(limit)
        .offset(offset);

  // Optional (X-Kitsuden-Provenance: 1): who wrote each row. If not requested, same as always.
  const rows = await applyProvenanceInRest(c, docs, executor, docs, "dataset_entry");
  return c.json(
    count
      ? { docs: rows, totalDocs: docs.length, offset, totalCount }
      : { docs: rows, totalDocs: docs.length, offset }
  );
});

/** An entry. Same two layers as the listing: policy and `rlsRules`. */
dataSetsRoutes.get("/:id/entries/:entryId", async (c) => {
  const datasetId = c.req.param("id");
  const entryId = c.req.param("entryId");
  if (!isUuid(datasetId) || !isUuid(entryId)) return c.json({ error: "Not found" }, 404);

  const user = userOf(c);
  const [dataset] = await db
    .select({ policyJson: dataSets.policyJson, slug: dataSets.slug })
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);
  if (!dataset || !readable(dataset, user)) return c.json({ error: "Not found" }, 404);

  const policy = dataset.policyJson as PolicyJson | null;
  const { where } = buildDatasetWhere(datasetId, policy?.rlsRules, user);

  const executor = resolveExecutor(db) as typeof db;
  const [entry] = await executor
    .select()
    .from(dataEntries)
    .where(
      and(
        where,
        eq(dataEntries.id, entryId),
        isFromTeam(user) ? undefined : publishedOrOwn(user?.id)
      )
    )
    .limit(1);

  if (!entry) return c.json({ error: "Not found" }, 404);
  const [withProvenance] = await applyProvenanceInRest(
    c,
    [entry],
    executor,
    [entry],
    "dataset_entry"
  );
  return c.json(withProvenance);
});

/**
 * Creating a dataset is a team matter (`admin`/`editor`).
 *
 * Before, `requireAuth` was enough, and sign-up is open: any account created
 * datasets with whatever `policyJson` it wanted, took slugs that the site will use
 * later (`/api/data-sets/slug/<slug>`) and triggered the creation of indexes
 * on `data_entries`. Audit 2026-10-15.
 */
dataSetsRoutes.post("/", requireStaff, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  // The policy decides who sees what (`readAccess: "public"` publishes the
  // rows): setting it is for administration only, as in the PATCH.
  if (body.policyJson !== undefined && userOf(c)?.role !== "admin") {
    return c.json({ error: "Only admins can set a dataset's policy" }, 403);
  }
  const schema = body.schema ?? body.fields ?? [];
  const [row] = await db
    .insert(dataSets)
    .values({
      name: body.name,
      slug: body.slug || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: body.description,
      icon: body.icon,
      schema,
      displayConfig: body.displayConfig,
      // Closed by default, like `POST /api/datasets`: opening a dataset to every
      // account is a decision, and sign-up may be open to anyone. The owner rule
      // stays, so a dataset later opened with `writeAccess` is still per owner.
      policyJson: body.policyJson || {
        readAccess: "admin",
        writeAccess: "admin",
        enableRLS: true,
        // `__USER_ID__` is the placeholder that rls-builder understands. Before, it set
        // "{{current_user_id}}", which was compared LITERALLY: the owner
        // rule never matched and nobody saw their rows (2026-10-15).
        rlsRules: [{ field: "ownerId", operator: "eq", value: DATASET_RLS_OWNER }],
      },
    })
    .returning();

  // Create partial indexes for this dataset's filterable fields.
  // Failures are logged but do not block dataset creation.
  await syncDatasetIndexes(row.id, row.slug, schema);

  await invalidateGraphQLCache();
  return c.json(row, 201);
});

/**
 * Columns that a PATCH can touch.
 *
 * Before it was `.set({ ...body })`: any session could change the `id`, the
 * `slug` or the `policyJson` of SOMEONE ELSE'S dataset — and changing the policy to
 * `readAccess: "public"` published the private rows of all its owners.
 */
const DATASET_EDITABLE = [
  "name",
  "description",
  "icon",
  "displayConfig",
  "workflowJson",
  "contentConfig",
] as const;

dataSetsRoutes.patch("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);
  const body = await c.req.json();
  const user = userOf(c);

  const [existing] = await db.select().from(dataSets).where(eq(dataSets.id, id)).limit(1);
  if (!existing || !readable(existing, user)) return c.json({ error: "DataSet not found" }, 404);

  // Changing the shape of a dataset affects the rows of ALL its owners
  if (user?.role !== "admin" && user?.role !== "editor") {
    return c.json({ error: "Only admins or editors can change a dataset" }, 403);
  }
  // And the policy decides who sees what: admins only
  if (body.policyJson !== undefined && user.role !== "admin") {
    return c.json({ error: "Only admins can change a dataset's policy" }, 403);
  }

  const changes: Record<string, unknown> = {};
  for (const key of DATASET_EDITABLE) {
    if (body[key] !== undefined) changes[key] = body[key];
  }
  if (body.policyJson !== undefined) changes.policyJson = body.policyJson;

  const schema = body.schema ?? body.fields;
  const [updated] = await db
    .update(dataSets)
    .set({
      ...changes,
      ...(schema !== undefined ? { schema } : {}),
      updatedAt: new Date(),
    })
    .where(eq(dataSets.id, id))
    .returning();

  if (schema !== undefined) {
    await syncDatasetIndexes(updated.id, updated.slug, schema, { dropRemoved: true });
  }

  await invalidateGraphQLCache();
  // Realtime caches the policy by slug: the old one and the new one (if it changed).
  invalidateRealtimePolicy(existing.slug);
  if (updated?.slug && updated.slug !== existing.slug) invalidateRealtimePolicy(updated.slug);
  return c.json(updated);
});

/**
 * Decides whose entry it is: the session's, unless the writer is on the
 * team and the payload names another owner.
 *
 * It is extracted instead of written inline because it is a SECURITY rule —
 * `owner_id` is the column the RLS policies rely on— and what
 * used to "prove" it was an `expect(source).toContain("ownerId = e.ownerId ??")`.
 * A grep over the source code does not check behavior: when refactoring
 * this line without changing what it does, the test went red; if someone deleted
 * the assignment leaving the text in a comment, it would stay green.
 *
 * The payload OVERRIDING the session is used by imports that attribute
 * rows to another user — and that is a team matter. Before it applied to any
 * account: a newly registered user created entries IN SOMEONE ELSE'S NAME in a
 * dataset with per-owner `rlsRules`, that is, slipped rows into their
 * private space. Now, without `canAttribute`, the owner is
 * always the writer.
 */
export function resolveEntryOwnerId(
  payload: Record<string, unknown>,
  sessionUserId: string | undefined,
  canAttribute = false
): string | null {
  if (canAttribute && payload.ownerId != null) return payload.ownerId as string;
  return sessionUserId ?? null;
}

/** The user placeholder that `rls-builder` understands (see `USER_ID_PLACEHOLDER`). */
export const DATASET_RLS_OWNER = "__USER_ID__";

const isFromTeam = (user: RLSUser | null) => user?.role === "admin" || user?.role === "editor";

dataSetsRoutes.post("/:id/entries", requireAuth, async (c) => {
  const id = c.req.param("id");

  // Same reason as in the GET.
  if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);

  const body = await c.req.json();
  const entries = Array.isArray(body) ? body : [body];

  const [dataset] = await db.select().from(dataSets).where(eq(dataSets.id, id)).limit(1);
  const user = userOf(c);
  if (!dataset || !(readable(dataset, user) || writable(dataset, user))) {
    return c.json({ error: "DataSet not found" }, 404);
  }

  // The policy has `writeAccess` and this route did not look at it: any session
  // wrote to an admin-only dataset.
  if (!writable(dataset, user)) {
    return c.json({ error: "You do not have permission to write to this dataset" }, 403);
  }

  const schema = dataset.schema ?? [];
  const validatedEntries: {
    original: { title?: string; thumbnailId?: string; sortOrder?: number; status?: string };
    data: Record<string, unknown>;
  }[] = [];

  for (const e of entries) {
    const payload = e.data ?? e;
    const validation = validateDatasetEntry(schema, payload);
    if (!validation.success) {
      return c.json(
        {
          error: "Validation failed",
          field: e,
          details: validation.error.format(),
        },
        400
      );
    }
    validatedEntries.push({ original: e, data: validation.data });
  }

  // What an AGENT creates is signed by its responsible human (owner);
  // without a signer, no owner, as before. See @kitsuden/shared signer.ts.
  const signatures = validatedEntries.map(({ data }) =>
    user?.role === "agent"
      ? agentSignature(c.get("user") as never, (data as { ownerId?: string }).ownerId, "nobody")
      : null
  );
  const rejection = signatures.find((f) => f && !f.ok);
  if (rejection && !rejection.ok) {
    return c.json({ error: "Forbidden", message: rejection.message, code: rejection.code }, 403);
  }

  // On the request's RLS transaction, so that the `data_entries_*` policies also
  // decide. A human on the team attributes rows to others (`resolveEntryOwnerId`),
  // which the owner policy would refuse: that was authorized above, in the app.
  const executor = resolveExecutor(db) as typeof db;
  const insert = () =>
    executor
      .insert(dataEntries)
      .values(
        validatedEntries.map(({ original, data }, i) => {
          const versioned = addSchemaVersionToData(schema, data);
          const signature = signatures[i];
          const ownerId =
            signature && signature.ok
              ? signature.author
              : resolveEntryOwnerId(versioned, c.get("user")?.id, isFromTeam(user));
          return {
            title:
              (versioned.title as string) ||
              (versioned.name as string) ||
              original.title ||
              "Untitled",
            dataSetId: id,
            data: { ...versioned, ownerId },
            // Status, order and thumbnail are only set by the team; for everyone else the
            // status is decided by the dataset's flow (`workflowJson.requireApproval`).
            // Before, any account published without review.
            thumbnailId: isFromTeam(user) ? original.thumbnailId : undefined,
            sortOrder: isFromTeam(user) ? original.sortOrder || 0 : 0,
            status: isFromTeam(user)
              ? original.status || "published"
              : resolveEntryStatus(dataset.workflowJson as never),
            ownerId,
            createdById: c.get("user")?.id ?? null,
          };
        })
      )
      .returning();
  let rows: Awaited<ReturnType<typeof insert>>;
  try {
    rows = await withSavepoint(() => (isFromTeam(user) ? asSystem(insert) : insert()));
  } catch (error) {
    // 42501: the database refused what the application let through.
    if (
      (error as { code?: string; cause?: { code?: string } })?.code === "42501" ||
      (error as { cause?: { code?: string } })?.cause?.code === "42501"
    ) {
      return c.json({ error: "You do not have permission to write to this dataset" }, 403);
    }
    throw error;
  }
  // The record history (core migration 0076), as the kon-datasets routes write it.
  await recordChanges(
    executor,
    rows.map((row) => ({
      entity: DATASET_ENTRY_ENTITY,
      rowId: row.id,
      action: "create" as const,
      after: row,
      user: c.get("user"),
      diff: { nested: "data", skip: ["id", "dataSetId", "createdById"] },
    })),
    (err) => console.warn("[datasets-lite] could not record the entries' history:", err)
  );
  await invalidateGraphQLCache();
  return c.json(rows, 201);
});

// ── Site Settings (singleton) ──
export const settingsRoutes = new Hono();

export async function getSettingsHandler(c: any) {
  const result = await db.select().from(siteSettings).limit(1);
  if (!result.length) {
    const [defaults] = await db.insert(siteSettings).values({}).returning();
    return c.json(defaults);
  }
  return c.json(result[0]);
}
settingsRoutes.get("/", getSettingsHandler);

/**
 * What a settings PATCH can touch. Before it was `.set({ ...body })`: with
 * the whole body, `id` or `updatedAt` were also rewritten (the route is admin-only,
 * but an allowlist does not depend on the gate still being there).
 */
export const EDITABLE_SETTINGS = [
  "siteName",
  "siteDescription",
  "siteUrl",
  "branding",
  "mainNav",
  "social",
  "analytics",
  "activeTheme",
  "footerText",
] as const;

export function onlyEditableSettings(body: unknown): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if (!body || typeof body !== "object") return clean;
  for (const key of EDITABLE_SETTINGS) {
    if ((body as Record<string, unknown>)[key] !== undefined) {
      clean[key] = (body as Record<string, unknown>)[key];
    }
  }
  return clean;
}

export async function patchSettingsHandler(c: any) {
  const body = onlyEditableSettings(await c.req.json());
  const existing = await db.select().from(siteSettings).limit(1);
  if (!existing.length) {
    const [row] = await db
      .insert(siteSettings)
      .values({ ...body })
      .returning();
    forgetSiteSettings();
    return c.json(row);
  }
  const [updated] = await db
    .update(siteSettings)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(siteSettings.id, existing[0].id))
    .returning();
  // Without this, changing the Site URL would take up to 30 s to reach the wikis
  forgetSiteSettings();
  return c.json(updated);
}
settingsRoutes.patch("/", patchSettingsHandler);

/**
 * Live status of the group's channel — the data that paints the
 * "We are live" banner of the websites.
 *
 * Public: what it returns is the same as anyone sees on the Twitch
 * channel page (title, game, viewers). It is cached for 60 s in
 * memory: helix allows 800 requests/minute, but a front page with traffic
 * should not need even one per minute. With no channel configured or no
 * credentials it responds `configured: false` — the banner is simply
 * not painted, and the page does NOT go down because of a third party: on a Twitch failure
 * it responds `live: null`, which reads as "not live".
 */
let directCache: { value: unknown; expires: number } | null = null;

settingsRoutes.get("/social-live", async (c) => {
  if (directCache && directCache.expires > Date.now()) {
    return c.json(directCache.value);
  }

  let response: Record<string, unknown>;
  try {
    const [row] = await db.select().from(siteSettings).limit(1);
    const login = (row?.social?.twitch ?? "").trim();
    if (!login) {
      response = { configured: false, live: null };
    } else {
      const { getStreamStatusByLogin, isTwitchConfigured } = await import("../services/twitch");
      if (!isTwitchConfigured()) {
        response = {
          configured: false,
          live: null,
          reason: "Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET",
        };
      } else {
        const statuses = await getStreamStatusByLogin([login]);
        const direct = [...statuses.values()][0] ?? null;
        response = {
          configured: true,
          live: direct
            ? {
                login,
                url: `https://www.twitch.tv/${login}`,
                title: direct.title,
                game: direct.gameName,
                viewers: direct.viewerCount,
                thumbnail: direct.thumbnailUrl,
              }
            : null,
        };
      }
    }
  } catch (error) {
    console.error("[social-live] Twitch query:", error);
    response = { configured: true, live: null };
  }

  directCache = { value: response, expires: Date.now() + 60_000 };
  return c.json(response);
});

// ── Auth ──
// Auth is now handled by Better-Auth in lib/auth.ts
// Mounted via app.on(["POST", "GET"], "/api/auth/*") in index.ts

// ── Sync Routes ──
export const syncRoutes = new Hono();

export async function igdbSearchHandler(c: any) {
  const { query, limit } = await c.req.json();
  const { searchGames } = await import("../services/igdb");
  const results = await searchGames(query, limit);
  return c.json(results);
}
syncRoutes.post("/igdb/search", igdbSearchHandler);

// NOTE: IGDB import moved to kon-games. The core BaaS does not depend on gaming domain tables.
export async function igdbImportHandler(c: any) {
  return c.json(
    {
      error: "IGDB import is handled by kon-games. Install it with: kitsuden install kon-games",
    },
    501
  );
}
syncRoutes.post("/igdb/import/:igdbId", igdbImportHandler);

export async function twitchStatusHandler(c: any) {
  const { channelIds } = await c.req.json();
  const { getStreamStatus } = await import("../services/twitch");
  const statuses = await getStreamStatus(channelIds);
  return c.json(Object.fromEntries(statuses));
}
syncRoutes.post("/twitch/status", twitchStatusHandler);
