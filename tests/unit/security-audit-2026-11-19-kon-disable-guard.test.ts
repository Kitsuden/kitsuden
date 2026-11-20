/**
 * Audit 2026-11-19: disabling or uninstalling a startup kon takes effect now
 * ============================================================================
 *
 * `loadKons()` mounts a kon's router once and Hono cannot unmount it. Disabling
 * the kon only changed its `modules` row, so its routes and MCP tools kept
 * serving until a restart. `lib/kon-activation.ts` puts a guard in front of every
 * startup kon mount (`mountKonRls(app, route, konId)`, also in the MCP pipeline)
 * that answers 404 "Kon not activated" once the kon is off.
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import {
  invalidateKonActivation,
  konActivationGuard,
  konSwitchedOff,
  resetKonActivationForTests,
  trackStartupKon,
} from "../../apps/api/src/lib/kon-activation";

let rows: { key: string; enabled: boolean }[] = [];

function appFor(konId: string) {
  const app = new Hono();
  app.use("/api/crm", konActivationGuard(konId));
  app.use("/api/crm/*", konActivationGuard(konId));
  app.get("/api/crm/companies", (c) => c.json({ items: [] }));
  return app;
}

afterEach(() => resetKonActivationForTests());

describe("startup kon activation guard", () => {
  it("disabling the kon makes its routes answer 404 without a restart", async () => {
    rows = [{ key: "crm", enabled: true }];
    resetKonActivationForTests(async () => rows);
    trackStartupKon("kon-crm", true);
    const app = appFor("kon-crm");

    expect((await app.request("/api/crm/companies")).status).toBe(200);

    rows = [{ key: "crm", enabled: false }];
    invalidateKonActivation(); // what the modules routes do after a write
    const off = await app.request("/api/crm/companies");
    expect(off.status).toBe(404);
    expect(((await off.json()) as { error: string }).error).toBe("Kon not activated");

    rows = [{ key: "crm", enabled: true }];
    invalidateKonActivation();
    expect((await app.request("/api/crm/companies")).status).toBe(200);
  });

  it("uninstalling (row deleted) switches it off too", async () => {
    rows = [{ key: "kon-crm", enabled: true }];
    resetKonActivationForTests(async () => rows);
    trackStartupKon("kon-crm", true);
    expect(await konSwitchedOff("kon-crm")).toBe(false);
    rows = [];
    invalidateKonActivation();
    expect(await konSwitchedOff("kon-crm")).toBe(true);
  });

  it("a kon loaded without a row stays on until the panel writes one", async () => {
    rows = [];
    resetKonActivationForTests(async () => rows);
    trackStartupKon("kon-grimoire-thing", false);
    expect(await konSwitchedOff("kon-grimoire-thing")).toBe(false);
    rows = [{ key: "grimoire-thing", enabled: false }];
    invalidateKonActivation();
    expect(await konSwitchedOff("kon-grimoire-thing")).toBe(true);
  });

  it("core features that were never tracked are never switched off", async () => {
    rows = [{ key: "reports", enabled: false }];
    resetKonActivationForTests(async () => rows);
    expect(await konSwitchedOff("reports")).toBe(false);
  });
});
