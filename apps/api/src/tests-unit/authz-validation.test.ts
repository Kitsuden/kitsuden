/**
 * Policies/Gates + Validation + Error Envelope — deterministic unit tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

import {
  definePolicy,
  defineGate,
  can,
  authorize,
  policyMap,
  resetAuthz,
  requireGate,
  type AuthzUser,
} from "../lib/authz";
import { AppError, toErrorEnvelope, respondError, ErrorCode } from "../lib/errors";
import { validateRequest, validated, parseOrThrow } from "../lib/validation";

interface Post {
  id: string;
  ownerId: string | null;
  published: boolean;
}

const alice: AuthzUser = { id: "alice", role: "user" };
const bob: AuthzUser = { id: "bob", role: "user" };
const admin: AuthzUser = { id: "root", role: "admin" };

// ── Policies / Gates ──────────────────────────────────────────────────────────

describe("Authorization — Policies & Gates", () => {
  beforeEach(() => {
    resetAuthz();
    definePolicy<Post>("post", {
      view: (u, p) => p.published || p.ownerId === u?.id || u?.role === "admin",
      update: (u, p) => u?.role === "admin" || p.ownerId === u?.id,
    });
    defineGate("access-admin", (u) => u?.role === "admin");
  });

  it("deny-by-default: an action with no rule is denied", async () => {
    const post: Post = { id: "1", ownerId: "alice", published: true };
    expect(await can(alice, "delete", post, "post")).toBe(false);
  });

  it("the owner can update; a third party cannot", async () => {
    const post: Post = { id: "1", ownerId: "alice", published: false };
    expect(await can(alice, "update", post, "post")).toBe(true);
    expect(await can(bob, "update", post, "post")).toBe(false);
    expect(await can(admin, "update", post, "post")).toBe(true);
  });

  it("view respects published and ownership", async () => {
    const draft: Post = { id: "1", ownerId: "alice", published: false };
    expect(await can(bob, "view", draft, "post")).toBe(false);
    expect(await can(alice, "view", draft, "post")).toBe(true);
    const pub: Post = { id: "2", ownerId: "alice", published: true };
    expect(await can(bob, "view", pub, "post")).toBe(true);
  });

  it("global gates (no resource)", async () => {
    expect(await can(admin, "access-admin")).toBe(true);
    expect(await can(alice, "access-admin")).toBe(false);
    expect(await can(alice, "nonexistent-gate")).toBe(false); // deny-by-default
  });

  it("authorize throws 401 with no user and 403 with a user lacking permission", async () => {
    const post: Post = { id: "1", ownerId: "alice", published: false };
    await expect(authorize(null, "update", post, "post")).rejects.toMatchObject({
      code: ErrorCode.UNAUTHENTICATED,
    });
    await expect(authorize(bob, "update", post, "post")).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it("policyMap introspects the actions for UI/admin", async () => {
    const post: Post = { id: "1", ownerId: "alice", published: true };
    expect(await policyMap(alice, "post", post)).toEqual({ view: true, update: true });
    expect(await policyMap(bob, "post", post)).toEqual({ view: true, update: false });
  });

  it("requireGate middleware: 403 a no-admin, 200 a admin", async () => {
    const app = new Hono();
    app.onError((err, c) => respondError(c, err));
    // The user setter must go BEFORE the gate.
    app.use("*", async (c, next) => {
      c.set("user", (c.req.header("x-role") === "admin" ? admin : alice) as never);
      await next();
    });
    app.use("/admin", requireGate("access-admin"));
    app.get("/admin", (c) => c.json({ ok: true }));

    const denied = await app.request("http://x/admin", { headers: { "x-role": "user" } });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error.code).toBe(ErrorCode.FORBIDDEN);

    const allowed = await app.request("http://x/admin", { headers: { "x-role": "admin" } });
    expect(allowed.status).toBe(200);
  });
});

// ── Validation (FormRequest-style) ────────────────────────────────────────────

describe("Validation — FormRequest style", () => {
  const schema = z.object({ title: z.string().min(1), age: z.coerce.number().int().min(0) });

  it("parseOrThrow returns typed and coerced data", () => {
    const out = parseOrThrow(schema, { title: "hi", age: "42" });
    expect(out).toEqual({ title: "hi", age: 42 });
  });

  it("parseOrThrow throws VALIDATION with per-field details", () => {
    try {
      parseOrThrow(schema, { title: "", age: -1 });
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.code).toBe(ErrorCode.VALIDATION);
      const fields = (err.details as any).fields;
      expect(fields.title).toBeDefined();
      expect(fields.age).toBeDefined();
    }
  });

  it("validate middleware: 422 on failure, typed data on success", async () => {
    const app = new Hono();
    app.onError((err, c) => respondError(c, err));
    app.post("/x", validateRequest(schema), (c) => c.json(validated(c)));

    const bad = await app.request("http://x/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", age: "no" }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).error.code).toBe(ErrorCode.VALIDATION);

    const ok = await app.request("http://x/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hi", age: "5" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ title: "hi", age: 5 });
  });
});

// ── Error envelope ────────────────────────────────────────────────────────────

describe("Error envelope", () => {
  it("AppError is serialized with code and details", () => {
    const { envelope, status } = toErrorEnvelope(AppError.conflict("dup", { field: "email" }), {});
    expect(status).toBe(409);
    expect(envelope.error.code).toBe(ErrorCode.CONFLICT);
    expect(envelope.error.details).toEqual({ field: "email" });
  });

  it("unknown 5xx errors do not expose the message in prod", () => {
    const { envelope, status } = toErrorEnvelope(new Error("internal secret"), { isDev: false });
    expect(status).toBe(500);
    expect(envelope.error.message).toBe("Internal server error");
  });

  it("in dev it does show the 5xx message", () => {
    const { envelope } = toErrorEnvelope(new Error("detail"), { isDev: true });
    expect(envelope.error.message).toBe("detail");
  });
});
