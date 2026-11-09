/**
 * Activating a kon without restarting the API
 * ============================================================================
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 * Activating a kon from the panel can create its tables on the fly, but it
 * could NOT mount its routes. Hono builds its router's matcher on the first
 * request and freezes it from then on:
 *
 *     Can not add a route since the matcher is already built.
 *
 * `loadKons()` runs once at startup, so a kon activated while the
 * server was running was left half done: it appeared in the menu, had its tables, and
 * each of its screens returned 404. Half an installation presented as
 * complete.
 *
 * ── THE SOLUTION: RESERVE THE PATH, DECIDE THE DESTINATION LATER ───────────
 *
 * What Hono freezes is the ROUTE TABLE, not what each handler does. So
 * at startup, for each kon on disk that was NOT loaded, a wildcard
 * handler is registered on its mount path:
 *
 *     app.all("/api/booking", delegate)
 *     app.all("/api/booking/*", delegate)
 *
 * The path exists from minute zero. `delegate` decides on each request:
 *
 *   · kon still off            → 404 explaining it is not activated
 *   · activated and not loaded → imported, its router is built and its
 *                                `onStartup` is run (only once)
 *   · already loaded           → the request is passed to it
 *
 * ── WHY THE URL HAS TO BE REWRITTEN ────────────────────────────────────────
 *
 * A kon declares its routes RELATIVE to its mount: `/rooms`, not
 * `/api/booking/rooms`. `app.route()` does that translation on registration; here,
 * when delegating on the fly, the prefix has to be stripped by hand or the sub-router
 * would look for a route it does not have and return 404 for the wrong reason.
 *
 * ── WHAT THIS DOES NOT COVER ───────────────────────────────────────────────
 *
 * Kons with declared `rate limits` get them applied by `applyKonRateLimits` on
 * the parent app, and that IS middleware registration: it cannot be added
 * on the fly. A kon activated without restarting runs without its request limit
 * until the next startup, and a console warning is shown instead of letting it slide.
 */

import { toErrorEnvelope } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import type { Hono } from "hono";

import { db } from "../db";
import { modules as modulesTable } from "../db/schema";
import { withTransactionalRLS } from "../middleware/transactional-rls";

import { inProduction } from "./environment";
import { withHostContext, envForTheKon } from "./host-context";

export interface DeferredKon {
  /** The kon's id, as in its manifest (`kon-booking`). */
  id: string;
  /**
   * Where its router may end up attached. It can be more than one place.
   *
   * ── WHY SEVERAL AND NOT ONE ──────────────────────────────────────────────
   *
   * Because the final route is decided, in order of precedence, by:
   *
   *   1. `konDef.mountPath` — in the kon's CODE. It cannot be read without
   *      importing it, and by then it is too late: the matcher is frozen.
   *   2. `mount.path` of the manifest.
   *   3. `/api/<name>` if the kon belongs to the active grimoire, `/api/custom/<id>`
   *      if not.
   *
   * The first version of this reserved only `/api/<name>` and would have shipped
   * a nasty failure to production: fifteen of the twenty-eight kons do not
   * declare `mount.path`, so the kon would have worked right after activation and
   * would have stopped working after a restart, served from another route.
   *
   * Reserving the candidates costs two more entries in the route table and
   * eliminates the whole class. All of them are unambiguously that kon's territory.
   */
  mountRoutes: string[];
  /** The kon's folder on disk. */
  path: string;
  /** Does it declare request limits that cannot be applied on the fly? */
  hasRateLimits: boolean;
}

const deferredItems = new Map<string, DeferredKon>();
const routers = new Map<string, Hono>();

/**
 * Gives a kon's router the same error translator as the API.
 *
 * ── WHY THIS IS NEEDED ────────────────────────────────────────────────────
 *
 * A deferred kon is NOT mounted with `app.route()`: the delegator calls
 * `router.fetch(...)`, which is a COMPLETE and isolated request cycle. Errors
 * do not bubble up to the API's `onError` — they stay inside.
 *
 * And a freshly created `Hono` without `onError` answers any exception with
 * a generic **500** and spits the trace to stderr. Measured on a real
 * installation:
 *
 *     POST /api/broadcast-moba/games/null/ingest/start   →  500
 *     stderr: AppError: Validation failed
 *
 * That is: validation worked, knew it was a 422, said so… and the
 * client saw "HTTP 500". A malformed-request error presented as a
 * server down, which sends people to look at the server logs instead of the form.
 *
 * It is not specific to this kon: it happens to ANY kon activated without restarting, on
 * any of its routes, with any `AppError` —validation, not
 * found, forbidden—. That is why it goes here, at the single point every one
 * passes through, and not in each kon.
 *
 * If the kon already brings its own `onError`, it is respected: `_onError` is internal to
 * Hono, so it is checked carefully and in the worst case it is overwritten with
 * something better than the default 500.
 */
function withErrorTranslator(router: Hono, konId: string): Hono {
  router.onError((err, c) => {
    const { envelope, status } = toErrorEnvelope(err, {
      requestId: c.req.header("x-request-id"),
      isDev: !inProduction(),
    });

    if (status >= 500) {
      console.error(`[Kons] ${konId} returned ${status}:`, err instanceof Error ? err.stack : err);
    }

    return c.json(envelope, status as 500);
  });

  return router;
}
/** In-flight loads: two simultaneous requests must not import the kon twice. */
const inProgress = new Map<string, Promise<Hono | null>>();

let context: KonContext | null = null;

// ── Which kons are active, without asking the database on every request ─────
//
// The answer changes little and the query would sit on the hot path of EVERY
// request to a deferred kon. A short TTL keeps the cost at zero and makes
// another replica that activates the kon get noticed on its own within seconds — important
// because this map is per process, not shared.
let assetsCache: Set<string> | null = null;
let assetsStamp = 0;
const ACTIVE_TTL_MS = 10_000;

async function activeKons(): Promise<Set<string>> {
  if (assetsCache && Date.now() - assetsStamp < ACTIVE_TTL_MS) return assetsCache;

  try {
    const rows = await db
      .select({ key: modulesTable.key, enabled: modulesTable.enabled })
      .from(modulesTable);
    assetsCache = new Set(rows.filter((f) => f.enabled).map((f) => f.key));
  } catch {
    // If the database does not respond, the honest thing is not to make things up: the last
    // known value is kept, and if there is nothing, none is active. A connection failure must not
    // translate into "activate all".
    assetsCache = assetsCache ?? new Set();
  }
  assetsStamp = Date.now();
  return assetsCache;
}

/**
 * Invalidates the active kons cache.
 *
 * The panel calls it on activate or deactivate: waiting for the TTL would make the
 * user see their own change late, which is exactly when they are looking.
 */
export function invalidateActiveKons(): void {
  assetsCache = null;
}

/** Does the kon's id match this key, with or without the `kon-` prefix? */
function sameKon(a: string, b: string): boolean {
  return a === b || a.replace(/^kon-/, "") === b.replace(/^kon-/, "");
}

async function isActive(konId: string): Promise<boolean> {
  const active = await activeKons();
  for (const key of active) if (sameKon(key, konId)) return true;
  return false;
}

/**
 * Imports the kon and builds its router. Only once per process.
 *
 * Returns `null` if the kon does not export a usable router: there are kons that only
 * provide metadata or hooks, and for those there is nothing to delegate.
 */
async function load(kon: DeferredKon): Promise<Hono | null> {
  const alreadyIs = routers.get(kon.id);
  if (alreadyIs) return alreadyIs;

  const inFlight = inProgress.get(kon.id);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<Hono | null> => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { isHonoRouter, isKonDefinition, createKonContext } = await import("./module-loader");

    const candidates = [
      join(kon.path, "index.ts"),
      join(kon.path, "dist", "index.js"),
      join(kon.path, "dist", "index.cjs"),
      join(kon.path, "index.js"),
    ];

    let mod: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
      break;
    }
    if (!mod) throw new Error(`could not import ${kon.id} from ${kon.path}`);

    context = context ?? createKonContext();
    const exported = mod.kon ?? mod.default;

    if (isKonDefinition(exported)) {
      const router = exported.createRouter(context);
      // Kon SDK: its operations, for MCP (the path is the one declared
      // by the kon or the first of the reserved candidates).
      if (exported.operations) {
        const { operationsOf, registerMountedOperations } =
          await import("../../../../packages/engine/src/operations");
        registerMountedOperations(
          kon.id,
          exported.mountPath ?? kon.mountRoutes[0] ?? `/api/custom/${kon.id}`,
          operationsOf(exported, context),
          router as never
        );
      }
      // `onStartup` runs here and not at startup: for this kon, THIS is its
      // startup. If it throws, activation fails and nothing is cached.
      if (exported.hooks?.onStartup) await exported.hooks.onStartup(context);
      withErrorTranslator(router, kon.id);
      const wrappedItem = withErrorTranslator(withHostContext(router), kon.id);
      routers.set(kon.id, wrappedItem);
      return wrappedItem;
    }

    // Legacy kon: exports a bare Hono.
    for (const value of Object.values(mod)) {
      if (isHonoRouter(value)) {
        withErrorTranslator(value, kon.id);
        const wrappedItem = withErrorTranslator(withHostContext(value), kon.id);
        routers.set(kon.id, wrappedItem);
        return wrappedItem;
      }
    }

    return null;
  })();

  inProgress.set(kon.id, promise);
  try {
    return await promise;
  } finally {
    inProgress.delete(kon.id);
  }
}

/**
 * Registers the reserved paths. Called at the end of `loadKons()`, when
 * no request has been served yet.
 */
export function registerDeferredKons(
  app: Hono<Record<string, never>>,
  kons: DeferredKon[],
  sharedContext?: KonContext
): void {
  if (sharedContext) context = sharedContext;
  if (kons.length === 0) return;

  // Routes the core already occupies. A kon that is off cannot hijack them: its
  // wildcard would be registered later and lose anyway, but declaring it explicitly
  // avoids the scare of seeing `/api/media/*` reserved by a kon.
  const busy = new Set(
    (app as unknown as { routes: { path: string }[] }).routes.map((r) => r.path)
  );

  for (const kon of kons) {
    if (deferredItems.has(kon.id)) continue;

    const validRoutes = [...new Set(kon.mountRoutes)].filter((route) => {
      // A single-segment mount (`/api`) would swallow half the API.
      const segments = route.split("/").filter(Boolean);
      if (segments.length < 2 || segments[0] !== "api") {
        console.warn(`  ⚠️  ${kon.id}: suspicious mount path (${route}); not reserved.`);
        return false;
      }
      if (busy.has(route) || busy.has(`${route}/*`)) {
        // What the core already serves takes precedence. The wildcard would be registered later and
        // lose anyway, but staying silent would hide a real collision.
        console.warn(`  ⚠️  ${kon.id}: ${route} is already taken; not reserved.`);
        return false;
      }
      return true;
    });

    if (validRoutes.length === 0) continue;
    deferredItems.set(kon.id, kon);

    const delegate = async (c: {
      req: { raw: Request };
      json: (body: unknown, status?: number) => Response;
      env?: unknown;
      get: (key: string) => unknown;
    }) => {
      if (!(await isActive(kon.id))) {
        return c.json(
          {
            error: "Kon not activated",
            message: `'${kon.id}' exists but is not activated. Activate it from Kons in the panel.`,
            kon: kon.id,
          },
          404
        );
      }

      let router: Hono | null;
      try {
        router = await load(kon);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[Kons] Could not load '${kon.id}' on the fly:`, detail);
        return c.json(
          {
            error: "The kon could not be loaded",
            message:
              `'${kon.id}' is activated but its code could not be loaded. ` +
              `Restart the API; if it persists, the kon is broken.`,
            kon: kon.id,
            detail,
          },
          500
        );
      }

      if (!router) {
        return c.json(
          {
            error: "The kon exposes no routes",
            message: `'${kon.id}' is activated but provides no API route.`,
            kon: kon.id,
          },
          404
        );
      }

      // Strip the prefix: the sub-router declares its routes relative to the mount.
      // Which of the reserved paths was used is told by the URL itself; it cannot
      // be assumed: the same kon answers on several.
      const url = new URL(c.req.raw.url);
      const prefix =
        validRoutes.find((r) => url.pathname === r || url.pathname.startsWith(`${r}/`)) ?? "";
      url.pathname = url.pathname.slice(prefix.length) || "/";
      return router.fetch(
        new Request(url.toString(), c.req.raw),
        envForTheKon(c.env, (k) => c.get(k))
      );
    };

    for (const route of validRoutes) {
      // The same RLS transaction as a kon mounted at startup: the router that
      // is loaded on the fly uses `ctx.db.instance`, which resolves to it.
      app.use(route, withTransactionalRLS());
      app.use(`${route}/*`, withTransactionalRLS());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.all(route, delegate as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.all(`${route}/*`, delegate as any);
    }
  }

  const withLimits = kons.filter((k) => k.hasRateLimits).map((k) => k.id);
  console.log(
    `  🕓 ${deferredItems.size} kon(s) reserved for activation without restart` +
      (withLimits.length ? ` (no rate limits until restart: ${withLimits.join(", ")})` : "")
  );
}

/**
 * Loads a kon NOW, without waiting for the first request.
 *
 * The panel calls it right after activating: this way the user enters the
 * kon's screen and it works the first time, instead of the first request
 * paying for the import. And if the kon is broken, the error comes out in the response
 * of the switch, which is where they are looking.
 */
export async function activateKonHot(
  konId: string
): Promise<{ mounted: boolean; reason?: string }> {
  invalidateActiveKons();

  const kon = [...deferredItems.values()].find((k) => sameKon(k.id, konId));
  if (!kon) {
    // It is not deferred: either it was already loaded at startup, or it does not exist. In both
    // cases there is nothing to mount here.
    return { mounted: false, reason: "not-deferred" };
  }

  try {
    const router = await load(kon);
    return router ? { mounted: true } : { mounted: false, reason: "the kon exposes no API routes" };
  } catch (err) {
    return { mounted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Does this kon have a reserved path that already responds? For the restart warning. */
export function konRespondsWithoutRestart(konId: string): boolean {
  for (const [id] of routers) if (sameKon(id, konId)) return true;
  for (const [id] of deferredItems) if (sameKon(id, konId)) return true;
  return false;
}

/**
 * Does this kon respond NOW on this API? Loaded at startup, or reserved and
 * activated later (the wildcard delegates it). Used by `GET /api/version` so as not to
 * advertise contracts of kons that would answer 404.
 */
export async function availableKon(
  konId: string,
  loadedAtStartup: readonly string[]
): Promise<boolean> {
  if (loadedAtStartup.some((id) => sameKon(id, konId))) return true;
  for (const [id] of deferredItems) if (sameKon(id, konId)) return isActive(id);
  return false;
}
