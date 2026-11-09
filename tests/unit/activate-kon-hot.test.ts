/**
 * Activating a kon hot, without restarting
 * ============================================================================
 *
 * Activating a kon from the panel does TWO things:
 *
 *   · Create its tables  → `lib/kon-migrations.ts`.
 *   · Serve its routes   → `lib/deferred-kons.ts`.
 *
 * This test pins down the second one, which is the tricky one.
 *
 * ── WHY ROUTES CANNOT BE MOUNTED HOT ────────────────────────────────────────
 *
 * Hono builds its router's matcher lazily, on the first request, and from then
 * on freezes it. `app.route()` after that throws:
 *
 *     Can not add a route since the matcher is already built.
 *
 * `loadKons()` runs once at startup. So a kon activated while the server is
 * running has its tables but no endpoint until the next restart.
 *
 * ── WHAT IS DONE ABOUT IT ───────────────────────────────────────────────────
 *
 * Saying so. `PATCH /api/modules/:key` returns `requiresRestart: true` and the
 * panel shows a notice. The alternative —keeping quiet— produces a kon that
 * shows up in the menu and returns 404 on every screen without explaining why:
 * half an installation presented as complete, the kind of failure that cost an
 * entire debugging session.
 *
 * ── IF THIS TEST FAILS ──────────────────────────────────────────────────────
 *
 * It means Hono changed and now DOES allow mounting routes after serving.
 * That would be good news: the kon could be mounted hot and the restart
 * notice removed. Do not delete it without making that change.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("mounting routes while the server is running", () => {
  it("Hono does NOT support app.route() after the first request", async () => {
    const app = new Hono();
    app.get("/already-existed", (c) => c.text("ok"));

    // Serving a request is what commits the matcher. Before this,
    // adding routes works: that is why `loadKons()` can mount them at startup.
    const earlier = await app.request("/already-existed");
    expect(earlier.status).toBe(200);

    const kon = new Hono();
    kon.get("/ping", (c) => c.text("pong"));

    expect(() => app.route("/api/kon-new", kon)).toThrowError(/matcher is already built/i);
  });

  it("before the first request, mounting does work", async () => {
    // The other half of the contract: it is what `loadKons()` does at startup.
    const app = new Hono();
    const kon = new Hono();
    kon.get("/ping", (c) => c.text("pong"));
    app.route("/api/kon-new", kon);

    const res = await app.request("/api/kon-new/ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  /**
   * ── THE SOLUTION ─────────────────────────────────────────────────────────
   *
   * What Hono freezes is the ROUTE TABLE, not what each handler does. So
   * the path is reserved at startup with a wildcard and the destination is
   * decided on each request. It is what `lib/deferred-kons.ts` does with
   * switched-off kons, and what allows activating one without restarting.
   *
   * The whole mechanism is reproduced here, in miniature: if this broke, hot
   * activation would stop working without anything else failing.
   */
  it("reserving the path at startup DOES allow serving a kon activated later", async () => {
    const app = new Hono();
    const MOUNT = "/api/demo";
    let router: Hono | null = null;

    const delegate = async (c: {
      req: { raw: Request };
      json: (b: unknown, s?: number) => Response;
    }) => {
      if (!router) return c.json({ error: "Kon not activated" }, 404);
      // The sub-router declares its routes RELATIVE to the mount point: without stripping the
      // prefix it would look for `/api/demo/ping` instead of `/ping` and return 404 for the
      // wrong reason.
      const url = new URL(c.req.raw.url);
      url.pathname = url.pathname.slice(MOUNT.length) || "/";
      return router.fetch(new Request(url.toString(), c.req.raw));
    };

    app.all(MOUNT, delegate as never);
    app.all(`${MOUNT}/*`, delegate as never);

    // A request is served: from here on the matcher is frozen.
    const off = await app.request(`${MOUNT}/ping`);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "Kon not activated" });

    // Hot activation: only the router is assigned. Nothing touches the route table.
    const kon = new Hono();
    kon.get("/ping", (c) => c.json({ pong: true }));
    kon.post("/items", async (c) => c.json({ createdAt: await c.req.json() }, 201));
    router = kon;

    const get = await app.request(`${MOUNT}/ping`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ pong: true });

    // The request body must survive the URL rewrite.
    const post = await app.request(`${MOUNT}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({ createdAt: { a: 1 } });

    // And a 404 inside the kon is still the kon's 404, not the delegator's.
    expect((await app.request(`${MOUNT}/does-not-exist`)).status).toBe(404);
  });
});
