/**
 * Security: the page builder (`/api/page-builder`) is authorized ON ITS OWN
 * ============================================================================
 *
 * Router mounted WITHOUT `adminGate`: whatever is denied here is denied even if
 * the `ADMIN_ONLY_ROUTES` rule is removed. The team and the agent with
 * `content:edit` (Inti) write; an arbitrary account does not. Reads: drafts,
 * made-up statuses and pages with `requireAuth` do not reach the public; the
 * content of the blocks (HTML, embed, URLs) and `customCss` are sanitized.
 * Real SQL with PGlite.
 */

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerBlocksPolicy } from "../../packages/core/blocks/blocks.policy";
import { createBlocksRouter } from "../../packages/core/blocks/blocks.routes";

const USERS: Record<string, Record<string, unknown> | null> = {
  anonymous: null,
  user: { id: "u-user", role: "user" },
  editor: { id: "u-editor", role: "editor" },
  inti: { id: "agent-inti", role: "agent", scopes: ["content:edit"] },
  otherAgent: { id: "agent-x", role: "agent", scopes: ["datasets:read"] },
};

let client: PGlite;
let app: Hono;

async function request(who: keyof typeof USERS, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-who": who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: json };
}

async function page(fields: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fields);
  const r = await client.query<{ id: string }>(
    `INSERT INTO block_pages (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    cols.map((c) => fields[c])
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TYPE block_page_status AS ENUM ('draft','published','archived');
    CREATE TABLE block_pages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL, slug varchar(500) NOT NULL UNIQUE, description text,
      status block_page_status NOT NULL DEFAULT 'draft',
      meta_title varchar(500), meta_description text, og_image_id uuid,
      layout varchar(50) NOT NULL DEFAULT 'default', css_class varchar(200), custom_css text,
      published_at timestamptz, author_id uuid,
      is_homepage boolean NOT NULL DEFAULT false, require_auth boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE block_contents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id uuid NOT NULL REFERENCES block_pages(id) ON DELETE CASCADE,
      type varchar(64) NOT NULL, name varchar(200),
      sort_order integer NOT NULL DEFAULT 0, column_span integer NOT NULL DEFAULT 12,
      content jsonb NOT NULL,
      css_class varchar(200), background_color varchar(50), text_color varchar(50), padding varchar(50),
      is_visible boolean NOT NULL DEFAULT true, visible_from timestamptz, visible_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE block_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, description text,
      category varchar(100) NOT NULL, type varchar(64) NOT NULL, content jsonb NOT NULL,
      css_class varchar(200), background_color varchar(50), text_color varchar(50), padding varchar(50),
      is_active boolean NOT NULL DEFAULT true, usage_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
      requireAuth: async (c: any, next: any) =>
        c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401),
      optionalAuth: async (_c: any, next: any) => next(),
    } as any,
    // No cache: every request reads the database (the visibility decision is per request).
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      invalidate: async () => {},
    } as any,
  });

  app = new Hono();
  app.use("*", async (c, next) => {
    const u = USERS[c.req.header("x-who") ?? "anonymous"];
    if (u) c.set("user" as never, u as never);
    await next();
  });
  app.route("/api/page-builder", createBlocksRouter(ctx) as unknown as Hono);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  resetAuthz();
  registerBlocksPolicy();
  await client.exec(
    "DELETE FROM block_contents; DELETE FROM block_pages; DELETE FROM block_templates;"
  );
});

describe("writes", () => {
  it("an arbitrary account or another agent does not write; anonymous 401", async () => {
    const id = await page({ title: "P", slug: "p", status: "published" });
    for (const who of ["user", "otherAgent"] as const) {
      expect((await request(who, "POST", "/api/page-builder/pages", { title: "X" })).status).toBe(
        403
      );
      expect(
        (await request(who, "PATCH", `/api/page-builder/pages/${id}`, { title: "pwned" })).status
      ).toBe(403);
      expect((await request(who, "DELETE", `/api/page-builder/pages/${id}`)).status).toBe(403);
      expect(
        (
          await request(who, "POST", `/api/page-builder/pages/${id}/blocks`, {
            type: "text",
            content: { text: "x" },
          })
        ).status
      ).toBe(403);
      expect(
        (
          await request(who, "POST", "/api/page-builder/pages/from-block", {
            title: "t",
            blockType: "text",
          })
        ).status
      ).toBe(403);
      expect((await request(who, "POST", `/api/page-builder/pages/${id}/clone`, {})).status).toBe(
        403
      );
      expect(
        (
          await request(who, "POST", "/api/page-builder/templates", {
            name: "t",
            category: "c",
            type: "text",
            content: {},
          })
        ).status
      ).toBe(403);
    }
    expect(
      (await request("anonymous", "POST", "/api/page-builder/pages", { title: "X" })).status
    ).toBe(401);
    const r = await client.query<{ title: string }>("SELECT title FROM block_pages");
    expect(r.rows).toEqual([{ title: "P" }]);
  });

  it("the team and Inti (content:edit) can; the home page only the team", async () => {
    expect(
      (await request("editor", "POST", "/api/page-builder/pages", { title: "One", slug: "one" }))
        .status
    ).toBe(201);
    expect(
      (await request("inti", "POST", "/api/page-builder/pages", { title: "Two", slug: "two" }))
        .status
    ).toBe(201);
    expect(
      (
        await request("inti", "POST", "/api/page-builder/pages", {
          title: "Three",
          isHomepage: true,
        })
      ).status
    ).toBe(403);
  });

  it("mass assignment: authorId from the body is not saved; status, slug, CSS and styles are validated", async () => {
    const createdOne = await request("editor", "POST", "/api/page-builder/pages", {
      title: "A",
      authorId: "00000000-0000-4000-8000-000000000000",
    });
    expect(createdOne.status).toBe(201);
    expect(createdOne.body.authorId).toBeNull();

    expect(
      (
        await request("editor", "POST", "/api/page-builder/pages", {
          title: "B",
          status: "hacked",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("editor", "POST", "/api/page-builder/pages", {
          title: "C",
          customCss: "</style><script>alert(1)</script>",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("editor", "POST", "/api/page-builder/pages", {
          title: "D",
          blocks: [{ type: "text", cssClass: '" onmouseover="x', content: {} }],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("editor", "POST", "/api/page-builder/pages", {
          title: "E",
          blocks: [{ type: "does-not-exist", content: {} }],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("editor", "PATCH", `/api/page-builder/pages/${createdOne.body.id}`, {
          slug: "../x",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("editor", "PATCH", `/api/page-builder/pages/${createdOne.body.id}`, {
          status: "x",
        })
      ).status
    ).toBe(400);
  });

  it("block content is saved sanitized", async () => {
    const createdOne = await request("editor", "POST", "/api/page-builder/pages", {
      title: "F",
      blocks: [
        { type: "text", content: { format: "html", text: "<p>ok</p><script>alert(1)</script>" } },
        {
          type: "embed",
          content: {
            code: '<iframe src="https://evil.example/x"></iframe><img src=x onerror=alert(1)>',
          },
        },
        {
          type: "cta",
          content: { title: "t", buttonLabel: "b", buttonUrl: "javascript:alert(1)" },
        },
      ],
    });
    expect(createdOne.status).toBe(201);
    const r = await client.query<{ content: any }>(
      "SELECT content FROM block_contents ORDER BY sort_order"
    );
    expect(r.rows.map((f) => f.content)).toEqual([
      { format: "html", text: "<p>ok</p>" },
      { code: '<img src="x">' },
      { title: "t", buttonLabel: "b", buttonUrl: "" },
    ]);
  });
});

describe("public reads", () => {
  it("drafts, made-up statuses and requireAuth do not reach the public", async () => {
    await page({ title: "Pub", slug: "pub", status: "published" });
    const draft = await page({ title: "Draft", slug: "draft-page", status: "draft" });
    await page({ title: "Members", slug: "members", status: "published", require_auth: true });

    const slugs = async (who: keyof typeof USERS, q = "") =>
      (await request(who, "GET", `/api/page-builder/pages${q}`)).body.docs
        ?.map((p: any) => p.slug)
        .sort();

    expect(await slugs("anonymous")).toEqual(["pub"]);
    expect(await slugs("anonymous", "?status=draft")).toEqual(["pub"]);
    // `eqEnum` returned undefined with a made-up status and the condition disappeared: ALL of them came out.
    expect(await slugs("anonymous", "?status=made-up")).toEqual(["pub"]);
    expect(await slugs("editor", "?status=draft")).toEqual(["draft-page"]);
    expect((await request("editor", "GET", "/api/page-builder/pages?status=made-up")).status).toBe(
      400
    );

    expect((await request("anonymous", "GET", `/api/page-builder/pages/${draft}`)).status).toBe(
      404
    );
    expect((await request("anonymous", "GET", "/api/page-builder/pages/draft-page")).status).toBe(
      404
    );
    expect((await request("editor", "GET", "/api/page-builder/pages/draft-page")).status).toBe(200);

    expect((await request("anonymous", "GET", "/api/page-builder/pages/members")).status).toBe(404);
    expect((await request("anonymous", "GET", "/api/page-builder/render/members")).status).toBe(
      404
    );
    expect((await request("user", "GET", "/api/page-builder/render/members")).status).toBe(200);
    expect((await request("anonymous", "GET", "/api/page-builder/render/pub")).status).toBe(200);
    expect(
      (await request("anonymous", "GET", "/api/page-builder/render/pub")).body.requireAuth
    ).toBeUndefined();
  });

  it("what was saved earlier (or by a loader) is served sanitized, and bad customCss is not served", async () => {
    const id = await page({
      title: "Old",
      slug: "old",
      status: "published",
      custom_css: "</style><script>steal()</script>",
    });
    await client.query(
      "INSERT INTO block_contents (page_id, type, content) VALUES ($1, 'text', $2)",
      [id, JSON.stringify({ format: "html", text: "<b onmouseover=steal()>x</b>" })]
    );
    const render = await request("anonymous", "GET", "/api/page-builder/render/old");
    expect(render.body.page.customCss).toBeNull();
    expect(render.body.blocks[0].content.text).toBe("<b>x</b>");
    const loose = await request("anonymous", "GET", "/api/page-builder/pages/old");
    expect(JSON.stringify(loose.body)).not.toContain("steal");
  });
});
