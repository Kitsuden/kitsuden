#!/usr/bin/env bun
/**
 * What a RUNNING API would serve at `GET /api/docs/openapi.json` for one kon,
 * without starting it: the kon's router is built as the loader builds it
 * (`createRouter`), registered as the loader registers it (`registerKonRouter`),
 * and the document comes from the same function the route calls
 * (`generateOpenAPISpec`). Used by tests/unit/sdk-from-kon.test.ts to compare
 * `generate.mjs --from-url` with `generate.mjs --from-kon`.
 *
 *   bun --no-env-file tests/unit/fixtures/sdk-live-openapi.ts <kon folder> <out.json>
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

for (const k of ["DATABASE_URL", "DATABASE_ADMIN_URL", "REDIS_URL", "VALKEY_URL"])
  delete process.env[k];
process.env.NODE_ENV = "test";
process.env.KITSUDEN_TEST_DB = "memory";
process.env.DATABASE_URL = "postgres://offline:offline@127.0.0.1:1/kitsuden_sdk_offline_test";
process.env.LOG_LEVEL = "silent";
console.log = () => undefined;
console.info = () => undefined;
console.warn = () => undefined;

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg || !outArg) throw new Error("usage: sdk-live-openapi.ts <kon folder> <out.json>");
const dir = resolve(dirArg);
const api = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/api/src");

const { readManifestSync } = await import(pathToFileURL(join(api, "lib/installed-kons.ts")).href);
const { registerKonRouter } = await import(pathToFileURL(join(api, "lib/kon-routes.ts")).href);
const { generateOpenAPISpec } = await import(
  pathToFileURL(join(api, "lib/openapi-aggregator.ts")).href
);
const { inertCtx } = await import(
  pathToFileURL(resolve(api, "../../../packages/engine/src/operations.ts")).href
);

const manifest = readManifestSync(dir);
const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
const def = mod.kon ?? mod.default;
const mountPath = def.mountPath || manifest?.mount?.path;
// The host's auth middlewares are real functions (an inert proxy would be read
// as route metadata by `konRoutes`); everything else of the context stays inert.
const pass = async (_c: unknown, next: () => Promise<void>) => next();
const auth = { requireAuth: pass, optionalAuth: pass };
const inert = inertCtx();
const ctx = new Proxy(inert as object, {
  get: (t, p) => (p === "auth" ? auth : Reflect.get(t, p)),
});
registerKonRouter(def.id, mountPath, def.createRouter(ctx));
const spec = await generateOpenAPISpec([def], {
  servers: [{ url: "http://127.0.0.1/api", description: "Current server" }],
});
writeFileSync(outArg, JSON.stringify(spec));
process.exit(0);
