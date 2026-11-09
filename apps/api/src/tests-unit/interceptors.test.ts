/**
 * Interceptors — end-to-end tests on a minimal Hono app (no DB).
 */

import {
  applyInterceptors,
  timingInterceptor,
  responseEnvelope,
  cacheControl,
  maskFields,
  type Interceptor,
} from "@kitsuden/engine";
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

describe("Interceptors", () => {
  it("responseEnvelope wraps the body in { data, meta }", async () => {
    const app = new Hono();
    app.get("/x", applyInterceptors(responseEnvelope()), (c) => c.json({ id: 1 }));
    const res = await app.request("http://x/x");
    const body = (await res.json()) as any;
    expect(body.data).toEqual({ id: 1 });
    expect(body.meta.ts).toBeDefined();
  });

  it("responseEnvelope is idempotent if data is already present", async () => {
    const app = new Hono();
    app.get("/x", applyInterceptors(responseEnvelope()), (c) => c.json({ data: [1, 2] }));
    const res = await app.request("http://x/x");
    expect(await res.json()).toEqual({ data: [1, 2] });
  });

  it("timingInterceptor adds X-Response-Time", async () => {
    const app = new Hono();
    app.get("/x", applyInterceptors(timingInterceptor()), (c) => c.json({ ok: true }));
    const res = await app.request("http://x/x");
    expect(res.headers.get("X-Response-Time")).toMatch(/^\d+ms$/);
  });

  it("maskFields removes sensitive fields (recursive)", async () => {
    const app = new Hono();
    app.get("/x", applyInterceptors(maskFields("password", "secret")), (c) =>
      c.json({ id: 1, password: "x", nested: { secret: "y", keep: "z" } })
    );
    const res = await app.request("http://x/x");
    expect(await res.json()).toEqual({ id: 1, nested: { keep: "z" } });
  });

  it("cacheControl sets Cache-Control on a successful GET", async () => {
    const app = new Hono();
    app.get("/x", applyInterceptors(cacheControl(60)), (c) => c.json({ ok: true }));
    const res = await app.request("http://x/x");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("before can cut the pipeline (short-circuit)", async () => {
    const guard: Interceptor = {
      name: "guard",
      before: () => new Response("blocked", { status: 429 }),
    };
    const app = new Hono();
    let handlerRan = false;
    app.get("/x", applyInterceptors(guard), (c) => {
      handlerRan = true;
      return c.json({ ok: true });
    });
    const res = await app.request("http://x/x");
    expect(res.status).toBe(429);
    expect(handlerRan).toBe(false);
  });

  it("onError observes the error and rethrows it", async () => {
    let seen = "";
    const audit: Interceptor = {
      name: "audit",
      onError: (_ctx, err) => {
        seen = (err as Error).message;
      },
    };
    const app = new Hono();
    app.onError((err, c) => c.json({ error: err.message }, 500));
    app.get("/x", applyInterceptors(audit), () => {
      throw new Error("boom");
    });
    const res = await app.request("http://x/x");
    expect(res.status).toBe(500);
    expect(seen).toBe("boom");
  });

  it("onion model: after runs in reverse order", async () => {
    const order: string[] = [];
    const mk = (n: string): Interceptor => ({
      name: n,
      before: () => {
        order.push(`before:${n}`);
      },
      after: (_c, b) => {
        order.push(`after:${n}`);
        return b;
      },
    });
    const app = new Hono();
    app.get("/x", applyInterceptors(mk("A"), mk("B")), (c) => c.json({ ok: true }));
    await app.request("http://x/x");
    expect(order).toEqual(["before:A", "before:B", "after:B", "after:A"]);
  });
});
