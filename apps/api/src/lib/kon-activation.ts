/**
 * Is a kon loaded at startup still switched on?
 * ============================================================================
 *
 * `loadKons()` mounts a kon's router with `app.route()` once, at startup, and
 * Hono cannot unmount it. Disabling the kon (`PATCH /api/modules/:key` with
 * `enabled:false`) or uninstalling it (`POST /api/modules/:key/uninstall`) only
 * changed the `modules` row: its routes, its SDK operations and the MCP tools
 * derived from them kept answering until a restart, while the panel said the
 * kon was off. Only deferred kons (`deferred-kons.ts`) checked activation.
 *
 * Now every startup kon gets a guard in front of its mount (`mountKonRls` with
 * its id) and the MCP pipeline asks the same question. The kon is OFF when:
 *
 *   · its `modules` row exists with `enabled = false`; or
 *   · it had a row at startup and the row is gone (uninstalled).
 *
 * A kon loaded without a row (from the grimoire or `installed_kons`) stays on
 * until the panel writes a row for it. Core features mounted in index.ts are
 * never tracked here, so they are never switched off by this guard.
 *
 * The rows are cached for a few seconds (as in deferred-kons) and the modules
 * routes invalidate the cache, so the change is seen at once in this process
 * and within the TTL in other replicas.
 */

import type { MiddlewareHandler } from "hono";

/** konId (as loaded) → did it have a `modules` row at startup? */
const startupKons = new Map<string, boolean>();

type ReadRows = () => Promise<{ key: string; enabled: boolean }[]>;

async function readFromDb(): Promise<{ key: string; enabled: boolean }[]> {
  const [{ db }, { modules }] = await Promise.all([import("../db"), import("../db/schema")]);
  return db.select({ key: modules.key, enabled: modules.enabled }).from(modules);
}

let readRows: ReadRows = readFromDb;
let cache: Map<string, boolean> | null = null;
let stamp = 0;
const TTL_MS = 10_000;

function sameKon(a: string, b: string): boolean {
  return a === b || a.replace(/^kon-/, "") === b.replace(/^kon-/, "");
}

/** `loadKons()` calls it for each kon it mounts. */
export function trackStartupKon(konId: string, hadRowAtStartup: boolean): void {
  startupKons.set(konId, hadRowAtStartup);
}

/** The modules routes call it after enabling, disabling or uninstalling. */
export function invalidateKonActivation(): void {
  cache = null;
}

async function rows(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - stamp < TTL_MS) return cache;
  try {
    const list = await readRows();
    cache = new Map(list.map((r) => [r.key, r.enabled]));
  } catch {
    // Database down: keep the last known answer; with none, nothing is
    // switched off (requests to the kon would fail on the database anyway).
    cache = cache ?? new Map();
  }
  stamp = Date.now();
  return cache;
}

/** Was this startup-loaded kon disabled or uninstalled since startup? */
export async function konSwitchedOff(konId: string): Promise<boolean> {
  let hadRow: boolean | undefined;
  for (const [id, had] of startupKons) if (sameKon(id, konId)) hadRow = had;
  if (hadRow === undefined) return false; // not a startup kon: not ours to judge
  const current = await rows();
  let found: boolean | undefined;
  for (const [key, enabled] of current) {
    if (sameKon(key, konId)) found = found === true ? true : enabled;
  }
  if (found === undefined) return hadRow; // uninstalled after startup
  return !found;
}

/** Middleware in front of a startup kon's mount: 404 like a deferred kon that is off. */
export function konActivationGuard(konId: string): MiddlewareHandler {
  return async (c, next) => {
    if (await konSwitchedOff(konId)) {
      return c.json(
        {
          error: "Kon not activated",
          message: `'${konId}' exists but is not activated. Activate it from Kons in the panel.`,
          kon: konId,
        },
        404
      );
    }
    await next();
  };
}

/** Tests only: replace the database read and forget the state. */
export function resetKonActivationForTests(reader?: ReadRows): void {
  startupKons.clear();
  cache = null;
  stamp = 0;
  readRows = reader ?? readFromDb;
}
