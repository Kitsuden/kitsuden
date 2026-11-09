/**
 * Kitsuden — Kon Loader v4 (configuration-based installation)
 *
 * Mounts the kons that are INSTALLED and ACTIVE:
 *
 *   · installed  → `installed-kons.ts`: the `packages/core` modules, what is
 *                  declared in `kitsuden.kons.json` (`kitsuden kon add`) and
 *                  in `KITSUDEN_KONS`, plus what is registered in `installed_kons`.
 *   · active     → the `modules` table (the panel) and the active grimoire.
 *
 * `packages/kons/` and `node_modules` are NO longer walked looking for whatever is there:
 * a kon that is on disk and was not declared does not exist for the API.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 3-TIER ARCHITECTURE:
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tier 1 — ENGINE (packages/engine/):
 *   Always active. Auth, DB, Workers. NOT loaded here.
 *
 * Tier 2 — CORE (packages/core/):
 *   datasets, media, blocks: core kons, always installed.
 *
 * Tier 3 — KONS (kitsuden-kons repo, installed with `kitsuden kon add`):
 *   Loaded dynamically. Modern kons use dependency injection.
 *
 * Before importing a kon, the `sdk` in its manifest is checked against that
 * of this core (`GET /api/version` → `sdk.kons`): one written for a newer
 * SDK is NOT mounted, and the reason appears in the log and in `getLoadReport()`.
 */

import type {
  ContentTarget,
  ContentTargetInfo,
  KonContentPublishing,
  KonContext,
  KonDefinition,
  PromotionData,
  PublishResult,
} from "@kitsuden/shared";
import type { Hono, MiddlewareHandler } from "hono";

let cachedLoadedKons: KonDefinition[] = [];

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

// Deep import (NOT the facade): the engine index re-exports loadKons/
// loadModules from this very file — the facade here would create a cycle.
// This holds for EVERYTHING that comes from the engine, not just registerKon: importing
// `@kitsuden/engine` for a loose utility closes the same cycle. It already happened.
import { messageOf } from "../../../../packages/engine/src/errors";
import { registerKon } from "../../../../packages/engine/src/kon";
import {
  operationsOf,
  registerMountedOperations,
} from "../../../../packages/engine/src/operations";
import {
  afterCommit,
  asSystem,
  theRequestDb as requestDb,
  background,
} from "../../../../packages/engine/src/rls-request";

import { KONS_SDK_VERSION } from "@kitsuden/shared";
import { eq, inArray, sql as sqlTag } from "drizzle-orm";

import { db } from "../db";
import { siteSettings, modules as modulesTable, installedKons } from "../db/schema";
import { authUsers } from "../db/schema-core";
import { requireAuth, requireRole, optionalAuth } from "../middleware/auth";
import { withTransactionalRLS } from "../middleware/transactional-rls";
import { KON_REGISTRY } from "../services/module-registry";

import { auth } from "./auth";
import { invalidateCache } from "./cache";
import type { DeferredKon } from "./deferred-kons";
import { rawNodeEnv } from "./environment";
import { events } from "./events";
import { file } from "./file";
import { readGrimoireKons, readKonJsonManifest } from "./grimoire-manifest";
import { konIdOf, installedKon, listInstalledKons, incompatibleSdkReason } from "./installed-kons";
import { checkKonCompatibility } from "./kitsuden-compat";
import { registerKonRouter } from "./kon-routes";
import { logger } from "./logger";
import { registerKonToolsets } from "./mcp-settings";
import { limiterEnabled, rateLimit } from "./rate-limiter";
import { realtimeManager } from "./realtime";
import { sitePublicUrl } from "./site-settings";
import { deleteObject, saveObject, readObject, listObjects, publicUrlOf } from "./store";

/** An npm package name, scoped or not: no `..`, no absolute paths. */
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A relative path with no `..` segment (either separator). */
function safeRelativePath(p: string): boolean {
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * The `db` that kons receive (`ctx.db.instance`): on each access it resolves
 * to the RLS transaction of the current request or, outside a request, to the
 * global `db` (see `theRequestDb` in the engine).
 */
const theRequestDb = requestDb(db);

/** The only thing `mountKonRls` needs from the app: registering middleware. */
interface AppWithMiddleware {
  use(route: string, ...handlers: MiddlewareHandler[]): unknown;
}

/**
 * Mounts the RLS transaction in front of a kon router: at `route` and at everything
 * under it. It must be registered BEFORE the router (in Hono, middleware
 * only runs if it was registered before the route).
 */
export function mountKonRls(app: AppWithMiddleware, route: string): void {
  const base = route.replace(/\/+$/, "");
  app.use(base, withTransactionalRLS());
  app.use(`${base}/*`, withTransactionalRLS());
}

/**
 * Content Publishing Registry — defined here to avoid importing from the engine.
 *
 * The types DO come from `@kitsuden/shared`, which is where the contract lives
 * (`ContentTarget`, `PromotionData`, `PublishResult`). Before, the whole class
 * was `any`: targets were stored without checking that they had `publish`, and
 * `promote` returned anything. Implementing `KonContentPublishing`
 * explicitly makes a change in the contract break here, which is where
 * you need to find out.
 */
class ContentPublishingRegistry implements KonContentPublishing {
  private targets = new Map<string, ContentTarget>();

  /**
   * The context is read LAZILY, it is not stored.
   *
   * It is a chicken-and-egg problem: the registry is part of the `KonContext` and also needs
   * it. Storing a reference forced building the context halfway
   * and completing it afterwards, which is why all this was `any`. With a
   * getter, the context is complete by the time anyone publishes anything.
   */
  private readonly readCtx: () => KonContext;

  constructor(readCtx: () => KonContext) {
    this.readCtx = readCtx;
  }

  private get ctx(): KonContext {
    return this.readCtx();
  }

  register(target: ContentTarget): void {
    if (this.targets.has(target.id)) {
      this.ctx.logger.warn(
        `ContentTarget '${target.id}' is being re-registered by ${target.konId}`
      );
    }
    this.targets.set(target.id, target);
    this.ctx.logger.info(`ContentTarget registered: '${target.id}' (${target.name})`);
  }

  unregister(targetId: string): void {
    const target = this.targets.get(targetId);
    if (target) {
      this.targets.delete(targetId);
      this.ctx.logger.info(`ContentTarget unregistered: '${targetId}' (${target.name})`);
    }
  }

  getAvailableTargets(): ContentTargetInfo[] {
    return Array.from(this.targets.values()).map((target) => ({
      id: target.id,
      name: target.name,
      konId: target.konId,
      capabilities: target.capabilities,
    }));
  }

  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  async promote(targetId: string, data: PromotionData): Promise<PublishResult> {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(`Content target '${targetId}' is not available`);
    }
    return target.publish(data, this.ctx);
  }

  async unpublish(targetId: string, contentId: string): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target?.unpublish) {
      throw new Error(`Content target '${targetId}' does not support unpublish`);
    }
    return target.unpublish(contentId, this.ctx);
  }

  getPublishedUrl(targetId: string, result: PublishResult): string {
    const target = this.targets.get(targetId);
    if (!target) return result.url ?? "";
    return target.getPublishedUrl(result);
  }
}

/**
 * Get grimoire kon keys dynamically from both hardcoded registry and active grimoire.
 * This ensures kons defined in grimoire.json are correctly identified as grimoire kons.
 */
async function getGrimoireKonKeys(activeGrimoire: string | null): Promise<Set<string>> {
  const keys = new Set<string>();

  // Add hardcoded registry grimoire kons
  for (const g of KON_REGISTRY.filter((g) => g.category === "grimoire")) {
    keys.add(g.key);
    // Also add without kon- prefix for flexibility
    keys.add(g.key.replace(/^kon-/, ""));
  }

  // Add kons from active grimoire (from grimoire.json)
  if (activeGrimoire) {
    const grimoireKons = await getGrimoireKons(activeGrimoire);
    for (const konId of grimoireKons) {
      keys.add(konId);
      // Also add without kon- prefix
      keys.add(konId.replace(/^kon-/, ""));
    }
  }

  return keys;
}

/** Kon metadata from any source */
interface KonSource {
  id: string;
  name: string;
  source: "local" | "npm" | "grimoire" | "legacy";
  path: string;
  manifest?: KonManifest;
  enabled: boolean;
}

/** Check if a value is a Hono router */
export function isHonoRouter(val: unknown): val is Hono {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof (val as { fetch?: unknown }).fetch === "function" &&
    typeof (val as { route?: unknown }).route === "function"
  );
}

/** Check if value is a KonDefinition (modern) */
export function isKonDefinition(val: unknown): val is KonDefinition {
  return (
    typeof val === "object" &&
    val !== null &&
    "id" in val &&
    "createRouter" in val &&
    typeof (val as { createRouter?: unknown }).createRouter === "function"
  );
}

/**
 * Mounts the rate limits that the kon declares for its own routes.
 *
 * WHY THIS EXISTS
 *
 * The host applies a generous global limit (300 req/min), calibrated for
 * reads. But only the kon knows which of its routes are EXPENSIVE — those that
 * send an email, charge, or launch a heavy job. Without this mechanism the
 * only alternative was adding the kon's route to the host's map, which
 * breaks isolation: `apps/api` must not name any kon.
 *
 * The declared routes are relative to the `mountPath`, so the limit travels
 * with the kon even if it is remounted elsewhere.
 */
export function applyKonRateLimits(app: Hono<any>, konDef: KonDefinition, mountPath: string): void {
  const limits = konDef.rateLimits;
  if (!limits?.length) return;
  // The same switch as the global limit (critical-features.ts).
  if (!limiterEnabled()) return;

  const base = mountPath.replace(/\/$/, "");

  for (const rule of limits) {
    const path = `${base}${rule.path.startsWith("/") ? rule.path : `/${rule.path}`}`;

    app.use(
      path,
      rateLimit({
        limit: rule.limit,
        window: rule.window,
        message: rule.message,
        failClosed: rule.failClosed,
        // Own counter: with the default key it shared a zset with the
        // global `/api/*` limiter and each request counted twice.
        space: `kon:${konDef.id}`,
      })
    );

    if (process.env.LOG_LEVEL === "debug") {
      console.log(
        `  [${konDef.id}] Rate limit: ${path} → ${rule.limit}/${rule.window}s` +
          (rule.failClosed ? " (fail-closed)" : "")
      );
    }
  }
}

/** Check if value is an Auto-Kon (created by defineKon) */
export function isAutoKon(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    "id" in val &&
    "config" in val &&
    "initialize" in val &&
    typeof (val as { initialize?: unknown }).initialize === "function"
  );
}

/**
 * Create KonContext with all dependencies injected
 */
/**
 * `NODE_ENV` narrowed to the three values that `KonContext` declares.
 *
 * Before it was `(process.env.NODE_ENV as any) || "development"`, which let
 * through to kons anything that was in the environment —a
 * `NODE_ENV=staging` slipped in as if it were a valid value— and every kon that
 * did `if (env === "production")` silently decided wrong.
 */
function validEnvironment(value: string | undefined): KonContext["config"]["environment"] {
  return value === "production" || value === "test" ? value : "development";
}

export function createKonContext(): KonContext {
  // It is declared as `KonContext` from the start, not as `any` with an
  // `as KonContext` at the end. With the cast on the way out, an extra field, a missing
  // one or one with a changed shape went through without anything warning —
  // in exactly the function that builds what the 29 kons receive.
  //
  // `contentPublishing` is assigned later (it needs the context itself), so
  // it is omitted here and completed below.
  const context: Omit<KonContext, "contentPublishing"> & {
    contentPublishing?: KonContext["contentPublishing"];
  } = {
    // Database
    //
    // `instance` is the REQUEST's connection: inside a kon route it
    // resolves to the transaction of `withTransactionalRLS()` (mounted in front of
    // every router in `loadKons`), with `app.current_user_id`/`_role` set, so
    // Postgres applies the policies to everything the kon reads or writes.
    // Outside a request (startup, `onStartup`, background tasks) it resolves to the
    // global `db`, which is the system context.
    //
    // Before it was just the global `db`: in kon routes RLS failed
    // OPEN (no context = system) and every kon that wanted to isolate something made
    // its own workaround (an RLS-context helper, an act-as-user helper, loose `set_config`).
    db: {
      instance: theRequestDb,
      execute: async (sql: string) => theRequestDb.execute(sql),
      tableExists: async (tableName: string) => {
        // A schema question, not a data one: go to the catalog with the global db,
        // so that a policy that hides all rows does not confuse it.
        const res = await db.execute(
          sqlTag`SELECT to_regclass(${`public.${tableName}`}) IS NOT NULL AS exists`
        );
        const row = ((res as unknown as { rows?: { exists: boolean }[] }).rows ?? [])[0];
        return Boolean(row?.exists);
      },
      asSystem,
      // An EMPTY request scope: without `tx`, the proxy resolves to the global db, and
      // the timers and promises that `fn` creates inherit that empty scope.
      background,
    },

    // Cache
    cache: {
      get: async <T>(_key: string) => {
        return null as T | null;
      },
      set: async <T>(_key: string, _value: T, _ttlSeconds?: number) => {
        // Implementation
      },
      invalidate: async (pattern: string) => {
        await invalidateCache(pattern);
      },
    },

    // Events
    events: {
      // Only once the request's writes are committed: whoever reacts (an action, an agent) must find them, and
      // an event for a write that was rolled back must not go out at all.
      emit: (event: string, data: unknown) => {
        afterCommit(() => events.emit(event, data));
      },
      on: (event: string, handler: (data: unknown) => void) => {
        events.on(event, handler);
      },
    },

    // Agents and embeddings, through the core's engine (imports deferred: the engine pulls in the MCP tools,
    // which pull in this loader).
    agents: {
      run: async (options) => {
        const { runAgent } = await import("../services/agent-engine");
        // A kon serves many people with one agent: memory and brain notes are shared by every session of
        // that agent, so one visitor would read what another said. Off, whatever the agent is set to.
        const result = await runAgent({
          ...options,
          enableMemory: false,
          enableBrainSearch: false,
        });
        return {
          response: result.response,
          sessionId: result.sessionId,
          traceId: result.traceId,
          provider: result.provider,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          toolCalls: (result.toolCalls ?? []).map((t) => ({
            name: t.name,
            ok: t.ok,
            ...(t.pendingApproval ? { pendingApproval: t.pendingApproval } : {}),
          })),
        };
      },
    },
    ai: {
      embed: async (texts: string[]) => {
        const { generateEmbedding, hasRealEmbeddingProvider } =
          await import("../services/embeddings");
        if (!hasRealEmbeddingProvider()) return null;
        const out: number[][] = [];
        for (const text of texts) out.push(await generateEmbedding(text));
        return out;
      },
    },

    // Realtime
    realtime: {
      broadcast: (channel: string, message: unknown) => {
        realtimeManager.broadcast(channel, message);
      },
      sendToUser: (userId: string, message: unknown) => {
        realtimeManager.sendToUser(userId, message);
      },
    },

    // Auth
    auth: {
      requireAuth: requireAuth as any,
      requireRole: (roles: string[]) => requireRole(roles) as any,
      optionalAuth: optionalAuth as any,
      getSession: async (headers: Headers) => {
        return auth.api.getSession({ headers });
      },
      /**
       * The public part of some accounts, so that a kon can sign what it
       * publishes without reading `auth_users` —which belongs to the host—.
       *
       * Only `name` and `image` are returned and nothing else: no email or role. What does not
       * leave from here cannot end up in a public response by oversight.
       */
      usersById: async (ids: string[]) => {
        const clean = [...new Set(ids.filter(Boolean))];
        if (clean.length === 0) return new Map();
        const rows = await db
          .select({ id: authUsers.id, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(inArray(authUsers.id, clean));
        return new Map(rows.map((u) => [u.id, { ...u, image: u.image ?? null }]));
      },
    },

    // File storage (local disk or S3/MinIO, depending on
    // DEFAULT_STORAGE_PROVIDER).
    //
    // This was a skeleton: `getSignedUploadUrl` returned "" and `delete` did
    // nothing. The upload route asked for that URL and did `fetch("")`, so
    // EVERY upload died with «fetch() URL must not be a blank string» and the
    // endpoint responded 207 —partial success— without anyone being alarmed.
    //
    // `put` and `delete` are now the real operations. The signed URL ones
    // are kept because they are part of the contract kons see, but they only
    // mean something with S3: in local mode there is nobody to sign anything for, and
    // they return the direct public URL instead of an empty string.
    storage: {
      put: async (key: string, content: Buffer, contentType: string) =>
        saveObject(key, content, contentType),
      delete: async (key: string) => deleteObject(key),
      get: async (key: string) => readObject(key),
      list: async (prefix: string) => listObjects(prefix),
      publicUrl: (key: string) => publicUrlOf(key),
      getSignedUploadUrl: async (_key: string, _contentType: string, _expiresIn = 3600) => {
        // Uploading directly from the browser to the bucket requires S3; with local
        // disk the file has to go through the API. This is declared explicitly
        // instead of returning "" and blowing up later.
        throw new Error(
          "getSignedUploadUrl requires DEFAULT_STORAGE_PROVIDER=s3|minio. " +
            "With local storage, use ctx.storage.put()."
        );
      },
      getSignedDownloadUrl: async (key: string, _expiresIn = 3600) => publicUrlOf(key),
    },

    // Logger
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => {
        logger.info(meta || {}, message);
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        logger.warn(meta || {}, message);
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        logger.error(meta || {}, message);
      },
      debug: (message: string, meta?: Record<string, unknown>) => {
        logger.debug(meta || {}, message);
      },
    },

    // Config
    config: {
      siteName: process.env.SITE_NAME || "Kitsuden CMS",
      // API origin for newsletter and broadcast. It is NOT the public site:
      // that one is the site's public URL, which comes from the panel.
      siteUrl: process.env.SITE_URL || "http://localhost:3000",
      environment: validEnvironment(rawNodeEnv()),
    },

    // General settings → Site URL, live (see site-settings.ts)
    site: {
      publicUrl: sitePublicUrl,
    },
  };

  // Initialize the Content Publishing Registry with the context
  context.contentPublishing = new ContentPublishingRegistry(() => context as KonContext);

  return context as KonContext;
}

/**
 * Get the currently active grimoire from database.
 */
async function getActiveGrimoire(): Promise<string | null> {
  try {
    const [settings] = await db.select().from(siteSettings).limit(1);
    return (
      (settings as any)?.activeGrimoire ||
      settings?.activeTheme ||
      process.env.KITSUDEN_ACTIVE_GRIMOIRE ||
      process.env.KITSUDEN_ACTIVE_THEME ||
      null
    );
  } catch {
    return process.env.KITSUDEN_ACTIVE_GRIMOIRE || process.env.KITSUDEN_ACTIVE_THEME || null;
  }
}

/**
 * Grimoire manifest interface (grimoire.json)
 */
interface GrimoireManifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  type: "grimoire";
  kons: string[];
  optional_kons?: string[];
  config?: Record<string, unknown>;
  /** Per-kon settings: the grimoire's opinion on how each one starts. */
  konConfig?: Record<string, Record<string, unknown>>;
  bundled_modules?: string[];
}

/**
 * Kon manifest interface (kon.json)
 */
interface KonManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  /** Compatibility range with the core, e.g. ">=0.9.0" (see lib/kitsuden-compat.ts) */
  kitsuden?: string;
  /** Legacy: minimum core version (equivalent to kitsuden: ">=x.y.z") */
  minKitsudenVersion?: string;
  mount?: {
    path: string;
  };
  tables?: string[];
  dependencies?: string[];
  [key: string]: any;
}

/**
 * Resolve workspace root directory.
 */
// ── Core version for kon compatibility validation ──
let cachedCoreVersion: string | null = null;

async function getKitsudenCoreVersion(): Promise<string> {
  if (cachedCoreVersion) return cachedCoreVersion;
  try {
    const pkg = await file(join(process.cwd(), "package.json")).json();
    cachedCoreVersion = (pkg?.version as string) || "0.0.0";
  } catch {
    cachedCoreVersion = "0.0.0";
  }
  return cachedCoreVersion;
}

export async function resolveWorkspaceRoot(): Promise<string> {
  const cwdPackages = join(process.cwd(), "packages", "kons", "package.json");
  const devRoot = join(process.cwd(), "../../");
  try {
    const cwdCheck = file(cwdPackages);
    if (await cwdCheck.exists()) {
      return process.cwd();
    }
  } catch {}
  return devRoot;
}

/**
 * Resolve node_modules directory (handles monorepos)
 */
export async function resolveNodeModules(workspaceRoot: string): Promise<string[]> {
  const paths: string[] = [];

  // 1. Root node_modules
  paths.push(join(workspaceRoot, "node_modules"));

  // 2. Apps/api node_modules (if in monorepo)
  paths.push(join(workspaceRoot, "apps", "api", "node_modules"));

  // 3. Current working directory
  paths.push(join(process.cwd(), "node_modules"));

  return paths.filter((p) => existsSync(p));
}

/**
 * Read kon.json manifest from a path
 *
 * "There is no manifest" and "the manifest is broken" are VERY different things and
 * before both returned null silently, inside a `catch {}` that
 * wrapped the whole function. A kon.json with an extra comma disappeared from
 * startup without a single warning line, exactly like a directory
 * that is not a kon. Now the first is still normal and the second shouts.
 */
export async function readKonManifest(dir: string): Promise<KonManifest | null> {
  try {
    // Try kon.json first
    // The read lives in the leaf module: it does not pull in `db` or `Bun`, so
    // it can really be tested from the suite instead of being reimplemented.
    const fromKonJson = await readKonJsonManifest(dir);
    if (fromKonJson) {
      return fromKonJson as KonManifest;
    }

    // Fall back to package.json with kitsuden field
    const packageJsonPath = join(dir, "package.json");
    const pkgFile = file(packageJsonPath);
    if (await pkgFile.exists()) {
      let pkg: any;
      try {
        pkg = await pkgFile.json();
      } catch (err) {
        console.warn(`  ⚠️  ${packageJsonPath} is not valid JSON: ${messageOf(err)}`);
        return null;
      }
      if (pkg.kitsuden?.type === "kon") {
        return {
          id: pkg.kitsuden.id || pkg.name,
          name: pkg.kitsuden.name || pkg.name,
          version: pkg.version,
          description: pkg.description,
          author: pkg.author,
          license: pkg.license,
          minKitsudenVersion: pkg.kitsuden.minVersion,
          ...pkg.kitsuden,
        };
      }
    }

    return null;
  } catch (err) {
    // Only I/O failures (permissions, disk) get here. They also deserve noise:
    // a kon that does not load because it cannot be read is a missing kon.
    console.warn(`  ⚠️  Could not read the manifest at ${dir}: ${messageOf(err)}`);
    return null;
  }
}

/**
 * Get bundled kons for a grimoire by reading its grimoire.json manifest.
 */
export async function getGrimoireKons(
  grimoireId: string,
  workspaceRoot?: string
): Promise<string[]> {
  const root = workspaceRoot || process.cwd();
  try {
    // The fallback to kitsuden.json and the check that what was read is a
    // grimoire (and not the same directory's THEME) are in the helper.
    return await readGrimoireKons(join(root, "packages/grimoires", grimoireId));
  } catch (err) {
    console.warn(`  ⚠️  Could not read grimoire manifest for ${grimoireId}:`, err);
    return [];
  }
}

/**
 * Per-kon settings declared by the active grimoire (`konConfig`).
 *
 * Read from the same manifest as the kons list, and handed to the shared
 * context so that each kon looks up ITS entry. A read failure
 * must not bring down startup: without configuration, each kon uses its defaults, which
 * is exactly what happens when there is no active grimoire.
 */
export async function getGrimoireKonConfig(
  grimoireId: string,
  workspaceRoot?: string
): Promise<Record<string, Record<string, unknown>>> {
  const root = workspaceRoot || process.cwd();
  try {
    const manifestFile = file(join(root, "packages/grimoires", grimoireId, "grimoire.json"));
    if (!(await manifestFile.exists())) return {};
    const manifest: GrimoireManifest = await manifestFile.json();
    return manifest.konConfig ?? {};
  } catch (err) {
    console.warn(`  ⚠️  Could not read konConfig for ${grimoireId}:`, err);
    return {};
  }
}

/**
 * Get kons enabled in DB (from `modules` table).
 * This allows filesystem-discovered kons to be loaded after being
 * toggled ON in the admin UI, even if they're not in kitsuden.config.ts.
 */
async function getEnabledKonsFromDB(): Promise<string[]> {
  try {
    const rows = await db
      .select({ key: modulesTable.key, enabled: modulesTable.enabled })
      .from(modulesTable)
      .where(eq(modulesTable.enabled, true));

    return rows.map((r) => r.key);
  } catch {
    // Table might not exist yet on first run
    return [];
  }
}

/**
 * Get kons installed via npm/marketplace from `installed_kons` table.
 * These kons may not be in kitsuden.config.ts but were installed with
 * `kitsuden install <pkg>` and registered in the database.
 */
async function getInstalledKonsFromDB(): Promise<
  { konId: string; sourceUrl: string | null; path: string }[]
> {
  try {
    const rows = await db
      .select({
        konId: installedKons.konId,
        sourceUrl: installedKons.sourceUrl,
        path: installedKons.path,
      })
      .from(installedKons)
      .where(eq(installedKons.enabled, true));

    return rows;
  } catch {
    // Table might not exist yet on first run
    return [];
  }
}

/**
 * Topological sort kons by dependencies.kons
 * Ensures dependencies are loaded before dependents.
 * Detects circular dependencies and throws.
 */
export function sortKonsByDependencies(kons: KonSource[]): KonSource[] {
  const map = new Map<string, KonSource>();
  for (const g of kons) {
    map.set(g.id, g);
    // Also register without kon- prefix for flexibility
    map.set(g.id.replace(/^kon-/, ""), g);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: KonSource[] = [];

  function visit(g: KonSource, stack: string[]) {
    const key = g.id;
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      const cycle = stack.slice(stack.indexOf(key)).join(" → ");
      throw new Error(`Circular kon dependency detected: ${cycle}`);
    }

    visiting.add(key);
    stack.push(key);

    const rawDeps =
      (g.manifest?.dependencies as any)?.kons ?? (g.manifest?.dependencies as string[]);
    const deps = Array.isArray(rawDeps) ? rawDeps : [];

    for (const depId of deps) {
      const dep = map.get(depId);
      if (dep && dep.id !== g.id) {
        visit(dep, stack);
      }
    }

    stack.pop();
    visiting.delete(key);
    visited.add(key);
    result.push(g);
  }

  for (const g of kons) {
    visit(g, []);
  }

  return result;
}

/**
 * Where a kon that the database asks to load is.
 *
 * ── BY CONFIGURATION, NOT BY WALKING FOLDERS ───────────────────────────────
 *
 * This used to try, in this order, `packages/core/<x>`, three variants of
 * `packages/kons/<x>`, `node_modules/@kitsuden/<x>`, `node_modules/kon-<x>` and
 * ANY node_modules scope that had a folder with that name. It was
 * discovery through the file system: whatever was on disk existed.
 *
 * Since kons live outside the core (`kitsuden-kons` repo), a kon
 * exists for the API only if it is INSTALLED —declared in `kitsuden.kons.json`
 * or in `KITSUDEN_KONS`, or is a `packages/core` module— and the path is given by
 * `installed-kons.ts`. The only thing left here besides that is `installed_kons`, the
 * marketplace installation table (`kitsuden install`), so that what was already
 * installed that way is not orphaned.
 */
async function resolveKon(
  name: string,
  _workspaceRoot: string,
  nodeModulesPaths: string[]
): Promise<KonSource | null> {
  const cleanName = name.replace(/^kon-/, "");
  const dirName = `kon-${cleanName}`;

  const installed = installedKon(name);
  if (installed?.path) {
    const manifest = await readKonManifest(installed.path);
    return {
      id: manifest?.id || installed.id,
      name: manifest?.name || installed.id,
      source: /[\\/]node_modules[\\/]/.test(installed.path) ? "npm" : "local",
      path: installed.path,
      manifest: manifest || undefined,
      enabled: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SOURCE 3: installed_kons table (fallback)
  // ═══════════════════════════════════════════════════════════════════════
  // If the kon was installed via `kitsuden install` but isn't in
  // kitsuden.config.ts or any standard location, look it up in the DB.
  try {
    const dbResult = await db
      .select({
        konId: installedKons.konId,
        sourceUrl: installedKons.sourceUrl,
        path: installedKons.path,
        manifest: installedKons.manifest,
      })
      .from(installedKons)
      .where(eq(installedKons.enabled, true));

    for (const row of dbResult) {
      if (row.konId === name || row.konId === cleanName || row.konId === dirName) {
        // Try sourceUrl first (npm package name like @kitsuden/kon-crm).
        // A row is data anyone with write access to the table controls: only
        // a package name and a relative path without `..` are followed, so it
        // cannot point the loader at another directory on disk.
        const sourceUrl = row.sourceUrl && NPM_NAME.test(row.sourceUrl) ? row.sourceUrl : null;
        if (sourceUrl) {
          for (const nmPath of nodeModulesPaths) {
            const resolvedPath = join(nmPath, sourceUrl);
            if (existsSync(resolvedPath)) {
              const manifest =
                (row.manifest as KonManifest) || (await readKonManifest(resolvedPath)) || undefined;
              return {
                id: manifest?.id || row.konId,
                name: manifest?.name || row.konId,
                source: "npm",
                path: resolvedPath,
                manifest,
                enabled: true,
              };
            }
          }
        }

        // Fallback to stored path
        if (row.path && safeRelativePath(row.path) && existsSync(row.path)) {
          const manifest =
            (row.manifest as KonManifest) || (await readKonManifest(row.path)) || undefined;
          return {
            id: manifest?.id || row.konId,
            name: manifest?.name || row.konId,
            source: "npm",
            path: row.path,
            manifest,
            enabled: true,
          };
        }
      }
    }
  } catch {
    // installed_kons table might not exist yet
  }

  return null;
}

/**
 * Load and mount all configured kons.
 * Supports local, npm, and legacy kons.
 *
 * @param app - Hono app instance
 * @param existingContext - Optional existing KonContext to reuse (for Content Publishing)
 */
export async function loadKons(app: Hono<any>, existingContext?: KonContext): Promise<void> {
  // Load dynamic config with auto-discovery
  // `kitsuden.config.ts` is no longer read here: it decides nothing at runtime. Its
  // only consumer at runtime is `lib/seed-modules.ts`, which populates the
  // `modules` table at startup and never overwrites it again. It is watched by
  // `tests/unit/kon-source-of-truth.test.ts`.

  const workspaceRoot = await resolveWorkspaceRoot();
  const nodeModulesPaths = await resolveNodeModules(workspaceRoot);

  console.log(`  📁 Workspace root: ${workspaceRoot}`);
  console.log(`  📦 Node modules paths: ${nodeModulesPaths.length}`);

  const activeGrimoire = await getActiveGrimoire();
  const grimoireKons = activeGrimoire ? await getGrimoireKons(activeGrimoire, workspaceRoot) : [];

  // Get kons enabled in DB (includes filesystem-discovered kons toggled ON)
  const dbEnabledKeys = await getEnabledKonsFromDB();

  // Get kons installed via npm/marketplace from installed_kons table
  const dbInstalled = await getInstalledKonsFromDB();
  const dbInstalledKeys = dbInstalled.map((r) => r.konId);

  // ── Which kons are loaded ─────────────────────────────────────────────────
  //
  // The `modules` table rules, plus whatever the active grimoire contributes and whatever was
  // installed via npm.
  //
  // `kitsuden.config.ts` NO LONGER comes in here. It used to, and that was the second place
  // that decided which kons exist: a kon switched off from the panel was loaded again
  // because the file said yes. Now the file only SEEDS the database
  // —`lib/seed-modules.ts`, which runs before this—, so by the time
  // we get here the database already knows everything the file wanted and also
  // respects whatever the user has changed.
  const allKonNames = new Set([...grimoireKons, ...dbEnabledKeys, ...dbInstalledKeys]);

  // ── `webhooks` and `connectors` live in packages/core, not in packages/kons ──
  //
  // The map only says WHERE to find them; it does not decide whether they are loaded. That is decided by
  // the database, as for any other kon.
  //
  // Here there was a `CORE_MODULE_FLAGS` read from `kitsuden.config.ts` that made
  //
  //     allKonNames.delete(moduleName);   // "DISABLED (feature flag)"
  //
  // that is, it DELETED the kon even if the database said it was active. And since
  // neither of the two appears in the file's `core` list, the flag was always
  // `false`: webhooks and connectors could never be loaded, whatever
  // the panel said. It is the same trampling that kon-media had, with the
  // aggravating factor that here there was no way to turn them on.
  const CORE_DIR_MAP: Record<string, string> = {
    webhooks: "webhooks",
    connectors: "connectors",
  };

  if (allKonNames.size === 0) {
    console.log("📜 No kons configured");
    return;
  }

  // Are we running from the published bundle (npm package) instead of the
  // workspace? Detected by the absence of the host source.
  const isBundle = !existsSync(join(workspaceRoot, "apps/api/src/index.ts"));

  if (isBundle) {
    // BEFORE: a `return` was done here assuming kons came
    // "pre-compiled" inside the bundle. That is FALSE for the npm package: the
    // bundle only carries the runtime, so aborting here left the installation
    // without datasets, media or blocks — that is, without the framework's batteries.
    //
    // NOW: resolution continues, but from node_modules (@kitsuden/datasets,
    // @kitsuden/kon-*, …), which is where installed modules live. The
    // resolver already prioritizes `dist/index.js` over `index.ts`, so
    // published packages (compiled JS) load the same under Node and under Bun.
    console.log(`\n📦 Running from the published package — resolving kons from node_modules`);
  }

  console.log(`\n📜 Resolving ${allKonNames.size} kon(s)...`);
  if (activeGrimoire) {
    console.log(`  🏰 Active grimoire: ${activeGrimoire}`);
  }

  // Resolve all kons
  const resolvedKons: KonSource[] = [];
  const unresolved: string[] = [];

  for (const name of allKonNames) {
    // Try to resolve from filesystem
    const resolved = await resolveKon(name, workspaceRoot, nodeModulesPaths);
    if (resolved) {
      resolvedKons.push(resolved);
    } else {
      // Check for legacy core modules
      if (name in CORE_DIR_MAP) {
        const corePath = join(workspaceRoot, `packages/core/${CORE_DIR_MAP[name]}`);
        if (existsSync(corePath)) {
          resolvedKons.push({
            id: name,
            name,
            source: "legacy",
            path: corePath,
            enabled: true,
          });
          continue;
        }
      }

      // Check for legacy modules in apps/api/src/modules/
      const cleanForLegacy = name.replace(/^kon-/, "");
      const legacyPaths = [
        join(process.cwd(), `src/modules/${name}`),
        join(process.cwd(), `src/modules/${cleanForLegacy}`),
      ];
      let legacyFound = false;
      for (const legacyPath of legacyPaths) {
        if (existsSync(legacyPath)) {
          resolvedKons.push({
            id: name,
            name: cleanForLegacy,
            source: "legacy",
            path: legacyPath,
            enabled: true,
          });
          legacyFound = true;
          break;
        }
      }
      if (legacyFound) continue;

      unresolved.push(name);
    }
  }

  // What the database asks for and is not installed: with its name and the command that
  // fixes it. Before it was a bare "Could not resolve", which did not tell a missing
  // kon apart from a misspelled one.
  const notInstalled: string[] = [];
  for (const name of unresolved) {
    const declaredOne = installedKon(name);
    if (declaredOne && !declaredOne.path) {
      console.warn(
        `  ⚠️  ${declaredOne.id} is declared (${declaredOne.source === "env" ? "KITSUDEN_KONS" : "kitsuden.kons.json"}) ` +
          `but is not found on disk${declaredOne.declaredOne.path ? ` (${declaredOne.declaredOne.path})` : ""}. ` +
          `Reinstall it: kitsuden kon add ${declaredOne.id.replace(/^kon-/, "")}`
      );
    } else {
      notInstalled.push(konIdOf(name));
    }
  }
  if (notInstalled.length > 0) {
    console.warn(
      `  ⚠️  Active in the database but NOT installed (not mounted): ${notInstalled.join(", ")}
` + `     Install them with: kitsuden kon add <name>  (or declare them in KITSUDEN_KONS)`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEPENDENCY RESOLUTION: Topological sort
  // ═══════════════════════════════════════════════════════════════════════════
  const sortedKons = sortKonsByDependencies(resolvedKons);
  const depOrderInfo =
    sortedKons.length === resolvedKons.length
      ? "dependency order applied"
      : "warning: sort mismatch";

  console.log(`\n📜 Loading ${sortedKons.length} kon(s)... (${depOrderInfo})`);

  // Reset cached kons list
  cachedLoadedKons = [];

  // Create shared context for all kons (or reuse existing)
  const context = existingContext || createKonContext();

  // Get dynamic grimoire kon keys for proper mounting
  const grimoireKonKeys = await getGrimoireKonKeys(activeGrimoire);

  // The grimoire's opinion on each kon, BEFORE instantiating routers: a
  // kon reads its configuration when constructed, not afterwards.
  context.konConfig = activeGrimoire
    ? await getGrimoireKonConfig(activeGrimoire, workspaceRoot)
    : {};

  const loaded: string[] = [];
  const failed: string[] = [];
  const modern: string[] = [];
  const legacy: string[] = [];
  const fromNpm: string[] = [];
  const rejected: { id: string; reason: string }[] = [];

  for (const kon of sortedKons) {
    const cleanName = kon.id.replace(/^kon-/, "");
    const isGrimoireKon = grimoireKonKeys.has(kon.id) || grimoireKonKeys.has(cleanName);

    // Kon ↔ core compatibility (independent kon versioning):
    // warning if the manifest declares "kitsuden"/"minKitsudenVersion" and it is not satisfied.
    const compatWarning = checkKonCompatibility(await getKitsudenCoreVersion(), kon.manifest);
    if (compatWarning) {
      console.warn(`  ⚠️  ${compatWarning}`);
    }

    // Kons SDK, BEFORE importing: a kon written for a newer contract
    // does not get to run a single line in this core.
    const sdkReason = incompatibleSdkReason(kon.id, kon.manifest?.sdk);
    if (sdkReason) {
      console.error(`  ❌ ${kon.id} → NOT mounted: ${sdkReason}`);
      failed.push(kon.id);
      rejected.push({ id: kon.id, reason: sdkReason });
      continue;
    }

    let mountPath = isGrimoireKon ? `/api/${cleanName}` : `/api/custom/${kon.id}`;
    const customMountPath = kon.manifest?.mount?.path;
    if (customMountPath) {
      mountPath = customMountPath;
    }

    try {
      let mod: any;

      // Try to import from the resolved path
      const tryImports = [
        join(kon.path, "index.ts"),
        join(kon.path, "dist", "index.js"),
        join(kon.path, "dist", "index.cjs"),
        join(kon.path, "index.js"),
      ];

      for (const importPath of tryImports) {
        if (existsSync(importPath)) {
          try {
            mod = await import(pathToFileURL(importPath).href);
            break;
          } catch (err) {
            console.log(`    ⚠️  Failed to import from ${importPath}: ${(err as Error).message}`);
            continue;
          }
        }
      }

      if (!mod) {
        throw new Error(`Could not resolve module from any path in ${kon.path}`);
      }

      let routerMounted = false;
      let initExecuted = false;

      const konExport = mod.kon || mod.default;

      // ═══════════════════════════════════════════════════════════════════════
      // MODE 1A: Auto-Generated Kon (Tier 1)
      // ═══════════════════════════════════════════════════════════════════════
      if (isAutoKon(konExport)) {
        const autoKon = konExport as any;
        registerKon(autoKon);
        cachedLoadedKons.push(autoKon as KonDefinition);

        const category = isGrimoireKon ? "grimoire" : "kon";
        const sourceTag = kon.source === "npm" ? ", npm" : "";
        console.log(`  ✅ ${kon.id} [${category}, auto-api${sourceTag}] → metadata registered`);

        if (kon.source === "npm") {
          fromNpm.push(kon.id);
        }
        loaded.push(kon.id);
        modern.push(kon.id);
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // MODE 1B: Modern Kon (Dependency Injection)
      // ═══════════════════════════════════════════════════════════════════════
      if (isKonDefinition(konExport)) {
        const konDef = konExport;

        // Kons SDK: a kon written for a newer contract than this
        // core is not half-mounted (its operations could use fields
        // not understood here and open without the authorization they ask for).
        // (The manifest was already checked before importing; this covers the kon
        // that declares it only in code.)
        const codeSdkReason = incompatibleSdkReason(kon.id, konDef.sdk, KONS_SDK_VERSION);
        if (codeSdkReason) {
          rejected.push({ id: kon.id, reason: codeSdkReason });
          throw new Error(codeSdkReason);
        }

        // Create router with injected context
        const router = konDef.createRouter(context);

        // Apply custom mount path: kon definition > kon.json > default
        const finalMountPath = konDef.mountPath || customMountPath || mountPath;

        // Rate limits declared by the kon. They are mounted BEFORE the router
        // because in Hono middleware only runs if it was registered before the
        // route it protects. The routes are relative to the mountPath: the kon does not
        // know (and must not know) where it ends up attached.
        applyKonRateLimits(app, konDef, finalMountPath);
        // Its tool groups for agents (`kon:<id>/<set>`), before any MCP session reads them.
        registerKonToolsets(konDef.id, konDef.mcpToolsets);

        // Every request to the kon, in its RLS transaction (see `theRequestDb`).
        mountKonRls(app, finalMountPath);
        app.route(finalMountPath, router);
        // What is mounted is what is documented: the OpenAPI, the 404 with
        // suggestions and the guide for agents come from this registry.
        registerKonRouter(kon.id, finalMountPath, router);
        // The SDK operations: the MCP tools come from here.
        if (konDef.operations) {
          registerMountedOperations(
            kon.id,
            finalMountPath,
            operationsOf(konDef, context),
            router as never
          );
        }
        routerMounted = true;

        if (process.env.LOG_LEVEL === "debug") {
          console.log(`  [DEBUG ${kon.id}] Router type: ${router?.constructor?.name}`);
          console.log(
            `  [DEBUG ${kon.id}] Router routes:`,
            (router as any)?.routes?.map((r: any) => `${r.method.toUpperCase()} ${r.path}`) || "N/A"
          );
        }
        modern.push(kon.id);
        cachedLoadedKons.push(konDef);

        // Execute lifecycle hooks
        if (konDef.hooks?.onStartup) {
          await konDef.hooks.onStartup(context);
          initExecuted = true;
        }

        const status = `→ ${finalMountPath}`;
        const initStatus = initExecuted ? " + onStartup()" : "";
        const category = isGrimoireKon ? "grimoire" : "kon";
        const sourceTag = kon.source === "npm" ? ", npm" : "";
        console.log(`  ✅ ${kon.id} [${category}, modern${sourceTag}] ${status}${initStatus}`);

        if (kon.source === "npm") {
          fromNpm.push(kon.id);
        }
        loaded.push(kon.id);
        continue;
      }

      // ═══════════════════════════════════════════════════════════════════════
      // MODE 2: Legacy Router Export
      // ═══════════════════════════════════════════════════════════════════════
      for (const [, exportValue] of Object.entries(mod)) {
        if (isHonoRouter(exportValue)) {
          mountKonRls(app, mountPath);
          app.route(mountPath, exportValue as Hono);
          registerKonRouter(kon.id, mountPath, exportValue);
          routerMounted = true;
          break;
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // MODE 3: Legacy Init-only
      // ═══════════════════════════════════════════════════════════════════════
      for (const [exportName, exportValue] of Object.entries(mod)) {
        if (exportName.startsWith("init") && typeof exportValue === "function") {
          await (exportValue as () => Promise<void>)();
          initExecuted = true;
        }
      }

      if (routerMounted || initExecuted) {
        const status = routerMounted ? `→ ${mountPath}` : "(init only)";
        const initStatus = initExecuted ? " + init()" : "";
        const category = isGrimoireKon ? "grimoire" : "kon";
        const sourceTag = kon.source === "legacy" ? ", legacy" : "";
        console.log(`  ✅ ${kon.id} [${category}${sourceTag}] ${status}${initStatus}`);
        cachedLoadedKons.push({
          id: kon.id,
          name: kon.name,
          version: kon.manifest?.version || "0.0.0",
          createRouter: () => {
            throw new Error("Legacy kon has no createRouter");
          },
        } as KonDefinition);
        legacy.push(kon.id);
        loaded.push(kon.id);
      } else {
        console.log(`  ⚠️  ${kon.id} → no router or init found`);
        failed.push(kon.id);
      }
    } catch (err: unknown) {
      console.log(`  ❌ ${kon.id} → ${messageOf(err)}`);
      failed.push(kon.id);
    }
  }

  console.log(
    `\n📜 Kons: ${loaded.length} loaded` +
      (modern.length ? ` (${modern.length} modern)` : "") +
      (legacy.length ? ` (${legacy.length} legacy)` : "") +
      (fromNpm.length ? `, ${fromNpm.length} from npm` : "") +
      (failed.length ? `, ${failed.length} failed` : "")
  );

  // The summary gave the NUMBER of failed kons and nothing else. The lines with the
  // reason come out much earlier and in a normal startup have already scrolled away,
  // so "3 failed" was all that was left in view. Repeating them here, with
  // name, is the difference between finding out and not finding out.
  if (failed.length) {
    console.warn(`  ⚠️  Kons that did NOT load: ${failed.join(", ")}`);
  }

  lastReport = {
    loaded: [...loaded],
    failedItems: [...failed],
    modern: [...modern],
    inherited: [...legacy],
    fromNpm: [...fromNpm],
    declinedItems: [...rejected],
    notInstalled: [...notInstalled],
  };

  // ── Reserved paths for the kons that were NOT loaded ──────────────────────
  //
  // This is the LAST moment routes can be registered: as soon as the
  // app serves a request, Hono freezes its matcher and `app.route()` throws
  // «Can not add a route since the matcher is already built».
  //
  // Without this, activating a kon while the server was running created its tables and
  // left its endpoints nonexistent until the next restart. See
  // `lib/deferred-kons.ts`.
  await reserveDisabledKonPaths(app, workspaceRoot, new Set(loaded), context, grimoireKonKeys);
}

/**
 * Reserves the mount path of each INSTALLED kon that was not loaded.
 *
 * The catalog comes from the installation (`installed-kons.ts`), not from the `modules`
 * table or from walking a folder: a kon that is installed and off today may be
 * switched on tomorrow from the panel, and by then nothing can be registered
 * any more. One that is not installed has nothing to reserve.
 */
async function reserveDisabledKonPaths(
  // The same type that `loadKons` receives, without repeating the `any`: if that
  // signature narrows someday, this one follows on its own.
  app: Parameters<typeof loadKons>[0],
  _workspaceRoot: string,
  loaded: Set<string>,
  context: KonContext,
  /**
   * The kons contributed by the active grimoire.
   *
   * Needed to compute the mount path EXACTLY the same as the loop
   * above. Without this, a kon with no declared `mount.path` was reserved at
   * `/api/<name>` while the loader would have mounted it at
   * `/api/custom/<id>`: the path would have changed on restart, and the kon would have
   * worked hot and stopped working afterwards.
   */
  grimoireKonKeys: Set<string>
): Promise<void> {
  try {
    const { registerDeferredKons } = await import("./deferred-kons");

    const deferredItems: DeferredKon[] = [];
    for (const kon of listInstalledKons()) {
      if (kon.source === "core" || !kon.path) continue;

      const manifest = await readKonManifest(kon.path);
      if (!manifest?.id) continue;

      const cleanName = manifest.id.replace(/^kon-/, "");
      if (loaded.has(manifest.id) || loaded.has(cleanName)) continue;

      // One written for a newer SDK is not reserved either: activating it
      // would return a 500 on every request instead of the reason.
      const sdkReason = incompatibleSdkReason(manifest.id, manifest.sdk);
      if (sdkReason) {
        console.warn(`  ⚠️  ${manifest.id} is not reserved: ${sdkReason}`);
        continue;
      }

      const isFromGrimoire = grimoireKonKeys.has(manifest.id) || grimoireKonKeys.has(cleanName);

      deferredItems.push({
        id: manifest.id,
        mountRoutes: await candidateMountRoutes(kon.path, manifest, isFromGrimoire),
        path: kon.path,
        hasRateLimits: !!(manifest as { rateLimits?: unknown }).rateLimits,
      });
    }

    registerDeferredKons(app, deferredItems, context);
  } catch (err) {
    // Not being able to reserve paths must NOT prevent startup: the system stays
    // as it was before this improvement — activating a kon will require a restart.
    console.warn(`  ⚠️  Could not reserve paths for hot activation: ${messageOf(err)}`);
  }
}

/**
 * Where a kon that has not been loaded yet may end up mounted.
 *
 * The path is decided, in order of precedence, by: `konDef.mountPath` (in CODE) >
 * `mount.path` of the manifest > `/api/<name>` if it is from the grimoire >
 * `/api/custom/<id>`.
 *
 * ── THE FAILURE THIS FIXES (/api/shop) ─────────────────────────────────────
 *
 * Before, only the candidates that can be read without importing the kon were reserved:
 * `mount.path` of the manifest, `/api/<name>` and `/api/custom/<id>`. But
 * kon-ecommerce declares `mountPath: "/api/shop"` in its code and its kon.json
 * said nothing: `/api/ecommerce` and `/api/custom/kon-ecommerce` were reserved, and
 * after activating it with `PATCH /api/modules/kon-ecommerce` all of `/api/shop/*`
 * answered 404 until a restart. The same with kon-character-builder
 * (`/api/builder`).
 *
 * If the manifest does not declare `mount.path`, the module is now IMPORTED to read
 * `mountPath`. Importing does not run `createRouter` or `onStartup`: it only evaluates the
 * module, which must have no side effects. If it fails, the usual candidates
 * are reserved and a warning is given.
 */
export async function candidateMountRoutes(
  route: string,
  manifest: { id: string; mount?: { path?: string } },
  isFromGrimoire: boolean
): Promise<string[]> {
  const cleanName = manifest.id.replace(/^kon-/, "");
  const routes: string[] = [];

  if (manifest.mount?.path) {
    routes.push(manifest.mount.path);
  } else {
    try {
      for (const file of ["index.ts", join("dist", "index.js"), "index.js"]) {
        const candidate = join(route, file);
        if (!existsSync(candidate)) continue;
        const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
        const exported = (mod.kon ?? mod.default) as { mountPath?: unknown } | undefined;
        if (exported && typeof exported.mountPath === "string") routes.push(exported.mountPath);
        break;
      }
    } catch (err) {
      console.warn(
        `  ⚠️  ${manifest.id}: could not read its mountPath (${messageOf(err)}); ` +
          `declare "mount": { "path": … } in its kon.json`
      );
    }
  }

  routes.push(`/api/${cleanName}`);
  if (!isFromGrimoire) routes.push(`/api/custom/${manifest.id}`);
  return [...new Set(routes)];
}

/**
 * Result of the last loadKons().
 *
 * It exists so that startup can look at failures instead of trusting that
 * someone reads the console: a failed kon does not break the process, but neither can it
 * remain only in a message that gets lost.
 */
export interface LoadReport {
  loaded: string[];
  failedItems: string[];
  modern: string[];
  inherited: string[];
  fromNpm: string[];
  /** Kons that were not mounted because of their SDK version, with the reason. */
  declinedItems?: { id: string; reason: string }[];
  /** Active in the database but not installed (`kitsuden kon add`). */
  notInstalled?: string[];
}

let lastReport: LoadReport = {
  loaded: [],
  failedItems: [],
  modern: [],
  inherited: [],
  fromNpm: [],
};

export function getLoadReport(): LoadReport {
  return lastReport;
}

/**
 * Get the list of currently loaded kons.
 */
export async function getLoadedKons(): Promise<KonDefinition[]> {
  return cachedLoadedKons;
}

/**
 * @deprecated Use loadKons instead
 */
export const loadModules = loadKons;
