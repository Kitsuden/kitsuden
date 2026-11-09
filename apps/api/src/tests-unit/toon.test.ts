import { parse as parseTron } from "@tron-format/tron";
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

import { forgetShapes, MIN_THRESHOLD } from "../lib/formats";
import { decodeToon, toonMiddleware, TOON_MIME, TRON_MIME, AUTO_MIME } from "../lib/toon";

/**
 * Format negotiation on /api/* with a real Hono app (not a simulated
 * context): what matters is what the client receives.
 */

const FLAT_LIST = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  slug: `tag-${i + 1}`,
  name: `Tag ${i + 1}`,
}));
// Repeated objects with arrays inside: TOON falls back to list form, TRON declares them as a class.
const NESTED = {
  docs: Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`,
    title: `Entry ${i}`,
    data: { skills: [`s${i}`, `t${i}`], stats: { atk: i, def: i * 2 } },
    tags: ["a", "b"],
  })),
  totalDocs: 20,
};

function app(body: unknown, status = 200) {
  const a = new Hono();
  a.use("/api/*", async (c, next) => {
    await next();
    c.header("X-From-Outside", "kept"); // like CORS: set by another layer
  });
  a.use("/api/*", toonMiddleware());
  a.get("/api/thing", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(body as object, status as 200);
  });
  return a;
}

async function request(
  body: unknown,
  options: { accept?: string; query?: string; status?: number } = {}
) {
  const res = await app(body, options.status).request(`/api/thing${options.query ?? ""}`, {
    headers: options.accept ? { accept: options.accept } : {},
  });
  return { res, text: await res.text() };
}

beforeEach(() => forgetShapes());

describe("without asking for anything, or asking for JSON: the response does not change", () => {
  it("without Accept or ?format: plain JSON, no format header", async () => {
    const { res, text } = await request(FLAT_LIST);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-kitsuden-format")).toBeNull();
    expect(JSON.parse(text)).toEqual(FLAT_LIST);
  });

  it("Accept: application/json wins over ?format=toon / tron / auto (panel, Inti and sites)", async () => {
    for (const q of ["?format=toon", "?format=tron", "?format=auto"]) {
      const { res, text } = await request(FLAT_LIST, {
        accept: "application/json",
        query: q,
      });
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual(FLAT_LIST);
    }
  });

  it("errors are not encoded", async () => {
    const { res, text } = await request({ error: "x" }, { accept: TOON_MIME, status: 404 });
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ error: "x" });
  });
});

describe("TOON / TRON requested", () => {
  it("Accept: application/vnd.toon → TOON, and it reads back the same", async () => {
    const { res, text } = await request(FLAT_LIST, { accept: TOON_MIME });
    expect(res.headers.get("content-type")).toBe(TOON_MIME);
    expect(res.headers.get("x-kitsuden-format")).toBe("toon");
    expect(text.startsWith("[30]{id,slug,name}:")).toBe(true);
    expect(decodeToon(text)).toEqual(FLAT_LIST);
  });

  it("does not drop the sibling keys of `data` (a tier list's `view`, `profile`)", async () => {
    // Before, encodeTOON unwrapped { data } and lost everything else.
    const body = {
      data: { slug: "aniimo", tiers: [{ id: "S" }, { id: "A" }] },
      view: { rows: [["a", "b"]] },
      profile: null,
    };
    const { text } = await request(body, { query: "?format=toon" });
    expect(decodeToon(text)).toEqual(body);
  });

  it("Accept: application/vnd.tron → TRON", async () => {
    const { res, text } = await request(NESTED, { accept: TRON_MIME });
    expect(res.headers.get("content-type")).toBe(TRON_MIME);
    expect(res.headers.get("x-kitsuden-format")).toBe("tron");
    expect(text.startsWith("class A:")).toBe(true);
    expect(parseTron(text)).toEqual(NESTED);
  });

  it("if TRON cannot represent the data, it responds JSON and says so", async () => {
    // TRON 0.1.3 writes a property named `null` unquoted and then cannot read it back.
    const body = [
      { null: 1, b: 2 },
      { null: 3, b: 4 },
    ];
    const { res, text } = await request(body, { accept: TRON_MIME });
    expect(res.headers.get("x-kitsuden-format")).toBe("json");
    expect(JSON.parse(text)).toEqual(body);
  });

  it("keeps the headers from the other layers and adds Vary: Accept", async () => {
    const { res } = await request(FLAT_LIST, { accept: TOON_MIME });
    expect(res.headers.get("x-from-outside")).toBe("kept");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toContain("Accept");
  });
});

describe("auto: the shortest one that loses nothing", () => {
  it("flat list → TOON", async () => {
    const { res, text } = await request(FLAT_LIST, { accept: AUTO_MIME });
    expect(res.headers.get("x-kitsuden-format")).toBe("toon");
    expect(decodeToon(text)).toEqual(FLAT_LIST);
  });

  it("repeated and nested objects → TRON", async () => {
    const { res, text } = await request(NESTED, { query: "?format=auto" });
    expect(res.headers.get("x-kitsuden-format")).toBe("tron");
    expect(parseTron(text)).toEqual(NESTED);
  });

  it("small response → JSON", async () => {
    const body = { ok: true, id: "x" };
    expect(JSON.stringify(body).length).toBeLessThan(MIN_THRESHOLD);
    const { res, text } = await request(body, { accept: AUTO_MIME });
    expect(res.headers.get("x-kitsuden-format")).toBe("json");
    expect(JSON.parse(text)).toEqual(body);
  });

  it('formats="json,toon" limits the candidates (a client without TRON)', async () => {
    const { res } = await request(NESTED, { accept: `${AUTO_MIME}; formats="json,toon"` });
    expect(["json", "toon"]).toContain(res.headers.get("x-kitsuden-format")!);
  });
});
