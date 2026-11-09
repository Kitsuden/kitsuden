/**
 * A misnamed field cannot be lost silently
 * ============================================================================
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 *
 * Zod strips by default the keys the schema does not know, and the response
 * comes back 200. In this project it cost data: the blog editor sent `tags`,
 * the route expected `tagIds`, and the tags vanished on save without
 * anything saying so.
 *
 * A human takes a while to notice. An AI agent never does: it cannot debug a
 * silence, and mixing up a field name is exactly the mistake a model makes.
 * Kitsuden is sold to people who build with agents, so this is the
 * error that matters most to turn into a sentence.
 *
 * ── WHAT IT GUARDS ─────────────────────────────────────────────────────────
 *
 * That `validateRequest` responds 422 with the unknown key, the closest one
 * and the valid ones; that it does not get in the way where extras are legitimate (query,
 * `passthrough`, records, server fields); and that it leaves its schema in the
 * route metadata, which is where the OpenAPI comes from.
 */

import {
  similarKey,
  readRouteMeta,
  respondError,
  validateRequest,
  validated,
} from "@kitsuden/engine";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";

type Envelope = {
  error: {
    code: string;
    message: string;
    details?: {
      fields?: Record<string, string[]>;
      unknownKeys?: { path: string; key: string; didYouMean: string | null; validKeys: string[] }[];
      hint?: string;
    };
  };
};

/** Mounts a POST route with the schema and returns the response to the given body. */
async function send(schema: z.ZodTypeAny, body: unknown) {
  let reachedHandler = false;
  const app = new Hono();
  app.onError((err, c) => respondError(c, err));
  app.post("/x", validateRequest(schema), (c) => {
    reachedHandler = true;
    return c.json(validated(c));
  });
  const res = await app.request("/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, reachedHandler };
}

describe("an unknown field responds 422 and says which one is the right one", () => {
  const Post = z.object({ title: z.string(), tagIds: z.array(z.string()).optional() });

  it("the real case: `tags` instead of `tagIds`", async () => {
    const { res, reachedHandler } = await send(Post, { title: "Hello", tags: ["a"] });

    expect(res.status).toBe(422);
    expect(reachedHandler, "a body with extra keys cannot reach the handler").toBe(false);

    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("VALIDATION");

    const unknown = body.error.details?.unknownKeys?.[0];
    expect(unknown).toMatchObject({ key: "tags", didYouMean: "tagIds" });
    expect(unknown?.validKeys).toEqual(["title", "tagIds"]);

    // And in `fields`, in a sentence that can be read as is.
    expect(body.error.details?.fields?.tags?.[0]).toContain("Did you mean «tagIds»?");
    expect(body.error.details?.hint).toMatch(/instead of ignoring them/);
  });

  it("inside a nested object it gives the full path", async () => {
    const Topic = z.object({ theme: z.object({ accent: z.string() }).optional() });
    const { res } = await send(Topic, { theme: { acent: "#fff" } });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.details?.unknownKeys?.[0]).toMatchObject({
      path: "theme",
      key: "acent",
      didYouMean: "accent",
    });
    expect(body.error.details?.fields?.["theme.acent"]).toBeDefined();
  });

  it("inside a list it says which element", async () => {
    const Items = z.object({
      items: z.array(z.object({ label: z.string(), imageUrl: z.string() })),
    });
    const { res } = await send(Items, { items: [{ label: "Aria", imgUrl: "x" }] });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.details?.unknownKeys?.[0]).toMatchObject({
      path: "items.0",
      key: "imgUrl",
      didYouMean: "imageUrl",
    });
  });

  it("the wrong convention is recognized: `tag_ids` → `tagIds`", () => {
    expect(similarKey("tag_ids", ["title", "tagIds"])).toBe("tagIds");
    expect(similarKey("TITLE", ["title"])).toBe("title");
  });

  it("if nothing looks similar, no suggestion is made up", async () => {
    /**
     * A wrong suggestion is worse than none: the agent would follow it and
     * end up sending a valid field with another field's data.
     */
    const { res } = await send(Post, { title: "Hello", zzqx: 1 });
    const body = (await res.json()) as Envelope;
    expect(body.error.details?.unknownKeys?.[0]?.didYouMean).toBeNull();
    expect(similarKey("name", ["title", "tagIds"])).toBeNull();
  });

  it("a wrong type and an unknown field are reported together", async () => {
    // Fixing them one at a time costs a round trip per error.
    const { res } = await send(Post, { title: 42, tags: ["a"] });
    const body = (await res.json()) as Envelope;
    expect(Object.keys(body.error.details?.fields ?? {}).sort()).toEqual(["tags", "title"]);
  });
});

describe("where extra keys are legitimate, they are not rejected", () => {
  it("`id`, `createdAt` and `updatedAt` are ignored and a warning is given", async () => {
    /**
     * Reading an object and returning it whole on update is the most common
     * client pattern. Rejecting it for carrying fields the server manages would
     * protect nothing and would break that pattern.
     */
    const { res, reachedHandler } = await send(z.object({ title: z.string() }), {
      id: "abc",
      title: "Hello",
      createdAt: "2026-01-01",
    });
    expect(res.status).toBe(200);
    expect(reachedHandler).toBe(true);
    expect(res.headers.get("X-Kitsuden-Ignored-Fields")).toBe("id, createdAt");
  });

  it("a `passthrough` schema accepts whatever it wants", async () => {
    const { res } = await send(z.object({ a: z.string() }).passthrough(), { a: "1", b: 2 });
    expect(res.status).toBe(200);
  });

  it("a free-form record accepts any key", async () => {
    // It is the shape of the Broadcast sides: the game profile validates it, not the route.
    const { res } = await send(z.object({ sideA: z.record(z.string(), z.unknown()) }), {
      sideA: { name: "Aria", whatever: true },
    });
    expect(res.status).toBe(200);
  });

  it("in a union it is enough to fit one option cleanly", async () => {
    const U = z.union([z.object({ a: z.number() }), z.object({ b: z.number() })]);
    expect((await send(U, { b: 1 })).res.status).toBe(200);
    expect((await send(U, { c: 1 })).res.status).toBe(422);
  });

  it("extra parameters are tolerated in the query", async () => {
    // `?utm_source=` or a cache-buster are normal in a link.
    const app = new Hono();
    app.onError((err, c) => respondError(c, err));
    app.get("/x", validateRequest(z.object({ page: z.coerce.number() }), "query"), (c) =>
      c.json(validated(c, "query"))
    );
    const res = await app.request("/x?page=2&utm_source=discord");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 2 });
  });
});

describe("the route describes itself", () => {
  const Body = z.object({ winnerId: z.string() });

  it("`validateRequest` leaves its schema and its target", () => {
    const meta = readRouteMeta(validateRequest(Body));
    expect(meta?.validation?.[0]?.target).toBe("json");
    expect(meta?.validation?.[0]?.schema).toBe(Body);
  });

  it("it is visible even through the wrapper of a sub-router with its own onError", () => {
    /**
     * Hono wraps the handler when mounting a sub-router that has `onError`, and
     * keeps the original aside. Without looking through that wrapper, the routes of
     * those routers would appear in the OpenAPI without a body.
     */
    const sub = new Hono();
    sub.onError((err, c) => respondError(c, err));
    sub.post("/report", validateRequest(Body), (c) => c.json({}));

    const parent = new Hono();
    parent.route("/matches", sub);

    const route = parent.routes.filter((r) => r.method === "POST" && r.path === "/matches/report");
    expect(route.length, "the sub-router route has to appear in the parent").toBeGreaterThan(0);

    const withSchema = route
      .map((r) => readRouteMeta(r.handler))
      .find((m) => m?.validation?.length);
    expect(withSchema?.validation?.[0]?.schema).toBe(Body);
  });
});
