/**
 * System Routes HTTP Integration Tests
 *
 * Tests authenticated grimoire/theme management endpoints that require a real
 * PostgreSQL database. Tests gracefully skip when only pg-mem is available.
 */

import { describe, it, expect, beforeAll } from "bun:test";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
let appInstance: any = null;

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

describe("System Routes HTTP (DB)", () => {
  beforeAll(async () => {
    const mod = await import("../index");
    appInstance = mod.app;
    dbAvailable = await isDatabaseAvailable();
  });

  const email = `system-routes-${generateTestId()}@example.com`;
  const password = "TestPassword123!";
  let cookie = "";

  it("creates and signs in an admin user", async () => {
    if (!dbAvailable) return;

    // The title already said «admin», but it was never given the role: theme, status and
    // deletion of grimoires are admin-only (middleware/authorization-matrix.ts).
    ({ cookie } = await enterAs(appInstance!, {
      email,
      password,
      name: "System Routes User",
      role: "admin",
    }));
    expect(cookie).toContain("session_token=");
  });

  it("PATCH /api/system/active-theme activates a grimoire", async () => {
    if (!dbAvailable) return;

    const res = await appInstance!.request(
      req(
        "/api/system/active-theme",
        {
          method: "PATCH",
          body: JSON.stringify({ themeId: "grimoire-default" }),
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.activeTheme).toBe("grimoire-default");
  });

  it("POST /api/system/grimoire-state deactivates the active grimoire", async () => {
    if (!dbAvailable) return;

    const res = await appInstance!.request(
      req(
        "/api/system/grimoire-state",
        {
          method: "POST",
          body: JSON.stringify({ action: "deactivate" }),
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.action).toBe("deactivate");
  });

  it("POST /api/system/grimoire-state activates a grimoire by id", async () => {
    if (!dbAvailable) return;

    const res = await appInstance!.request(
      req(
        "/api/system/grimoire-state",
        {
          method: "POST",
          body: JSON.stringify({ action: "activate", grimoireId: "grimoire-default" }),
        },
        cookie
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.action).toBe("activate");
    expect(body.activeGrimoire).toBe("grimoire-default");
  });

  it("DELETE /api/system/grimoires/:id returns 409 for active grimoire", async () => {
    if (!dbAvailable) return;

    const res = await appInstance!.request(
      req("/api/system/grimoires/grimoire-default", { method: "DELETE" }, cookie)
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toContain("Cannot delete grimoire");
  });
});
