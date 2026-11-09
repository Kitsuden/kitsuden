/**
 * Kons installed by configuration + hot activation
 * ============================================================================
 *
 * Three things, against real Postgres and with the real loader:
 *
 *   1. THE /api/shop FAILURE. kon-ecommerce declares `mountPath: "/api/shop"` in
 *      its code and its kon.json said nothing: at startup `/api/ecommerce` and
 *      `/api/custom/kon-ecommerce` were reserved, and after activating it with
 *      `PATCH /api/modules/kon-ecommerce` all of `/api/shop/*` gave 404 until
 *      restart. The `kon-shop-test` fixture has exactly that shape.
 *   2. INSTALLED = DECLARED. The fixture is installed with `KITSUDEN_KONS`
 *      (id=path), not by being in any folder the loader walks.
 *   3. SDK. A kon that asks for a higher SDK than the core's (`kon-future-test`,
 *      sdk 99) is not imported, not mounted and not reserved, and the reason appears in
 *      the load report.
 */

import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import { activateKonHot } from "../lib/deferred-kons";
import { installedKon, forgetInstalledKons } from "../lib/installed-kons";
import { getLoadReport, loadKons, candidateMountRoutes } from "../lib/module-loader";

import { isDatabaseAvailable } from "./setup";

const STORE = join(import.meta.dir, "fixtures", "kon-shop-test");
const FUTURE = join(import.meta.dir, "fixtures", "kon-future-test");

const previousEnvironment = process.env.KITSUDEN_KONS;
let hasBase = false;
let app: Hono;

async function setModule(key: string, enabled: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO modules (key, name, enabled) VALUES (${key}, ${key}, ${enabled})
    ON CONFLICT (key) DO UPDATE SET enabled = ${enabled}`);
}

beforeAll(async () => {
  hasBase = await isDatabaseAvailable();
  if (!hasBase) return;

  // They are ADDED to whatever the installation already declares (kitsuden.kons.json).
  process.env.KITSUDEN_KONS = [previousEnvironment, `shop-test=${STORE}`, `future-test=${FUTURE}`]
    .filter(Boolean)
    .join(",");
  forgetInstalledKons();

  await setModule("kon-shop-test", false); // installed and OFF
  await setModule("kon-future-test", true); // active, but incompatible SDK

  app = new Hono();
  await loadKons(app as never);
});

afterAll(async () => {
  if (hasBase) {
    await db.execute(sql`DELETE FROM modules WHERE key IN ('kon-shop-test', 'kon-future-test')`);
  }
  if (previousEnvironment === undefined) delete process.env.KITSUDEN_KONS;
  else process.env.KITSUDEN_KONS = previousEnvironment;
  forgetInstalledKons();
});

describe("kons installed by configuration", () => {
  it("KITSUDEN_KONS declares the kon and its path (without walking folders)", () => {
    if (!hasBase) return;
    const kon = installedKon("shop-test");
    expect(kon?.id).toBe("kon-shop-test");
    expect(kon?.source).toBe("env");
    expect(kon?.path).toBe(STORE);
  });

  it("the code's path is reserved even if the kon.json does not declare it", async () => {
    const routes = await candidateMountRoutes(STORE, { id: "kon-shop-test" }, false);
    expect(routes).toContain("/api/storefront");
  });
});

describe("hot-activating a kon with mountPath only in the code (/api/shop)", () => {
  it("off: its route exists and explains that it is not activated", async () => {
    if (!hasBase) return;
    const r = await app.request("/api/storefront/products");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error?: string }).error).toBe("Kon not activated");
  });

  it("after activating it (what PATCH /api/modules/:key does) it responds WITHOUT restarting", async () => {
    if (!hasBase) return;
    await setModule("kon-shop-test", true);
    const activation = await activateKonHot("kon-shop-test");
    expect(activation).toEqual({ mounted: true });

    const r = await app.request("/api/storefront/products");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ products: ["mug"] });
  });
});

describe("incompatible kons SDK", () => {
  it("it is not imported, not mounted and the reason is in the report", async () => {
    if (!hasBase) return;
    expect((globalThis as Record<string, unknown>).__importedFutureKon).toBeUndefined();

    const report = getLoadReport();
    expect(report.loaded).not.toContain("kon-future-test");
    const rejection = report.declinedItems?.find((r) => r.id === "kon-future-test");
    expect(rejection?.reason).toMatch(/kons SDK v99.*v1/);

    // Neither mounted nor reserved: the path does not exist.
    const r = await app.request("/api/future-test");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("mounted");
  });
});
