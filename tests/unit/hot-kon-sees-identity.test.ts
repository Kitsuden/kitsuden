/**
 * A hot-activated kon sees the identity the API already resolved.
 * Before, `router.fetch(...)` started an empty context: an
 * agent with `Bearer` got 401 in the kon until the API was restarted.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { withHostContext, envForTheKon } from "../../apps/api/src/lib/host-context";

function kon() {
  const r = new Hono();
  r.post("/blocks", (c) => {
    const agent = (c.get as (k: string) => unknown)("agent") as { scopes?: string[] } | undefined;
    const ip = (c.env as { ip?: { address?: string } } | undefined)?.ip?.address ?? null;
    if (!agent) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ scopes: agent.scopes, ip });
  });
  return r;
}

function host(wrappedItem: Hono | null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).set("agent", { scopes: ["content:edit"] });
    await next();
  });
  const router = wrappedItem ?? kon();
  app.all("/api/games/*", (c) => {
    const url = new URL(c.req.raw.url);
    url.pathname = url.pathname.slice("/api/games".length);
    return wrappedItem
      ? router.fetch(new Request(url.toString(), c.req.raw), envForTheKon(c.env, c.get as never))
      : router.fetch(new Request(url.toString(), c.req.raw));
  });
  return app;
}

const request = (app: Hono) =>
  app.request("/api/games/blocks", { method: "POST" }, { ip: { address: "203.0.113.7" } });

describe("deferred kons delegate", () => {
  it("before: the kon did not see the agent → 401", async () => {
    expect((await request(host(null))).status).toBe(401);
  });

  it("now: it sees the agent and the socket IP", async () => {
    const r = await request(host(withHostContext(kon())));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ scopes: ["content:edit"], ip: "203.0.113.7" });
  });
});
