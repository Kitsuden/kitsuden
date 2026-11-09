/**
 * kitsuden make kon <name> — a minimal kon with the shape of the real kons
 * ============================================================================
 *
 * The ONE way to start a kon. It works in three places:
 *
 *   · inside a Kitsuden project or checkout (`packages/kons/` next to a pnpm workspace):
 *       packages/kons/kon-<slug>/  +  tests/unit/kon-<slug>.test.ts
 *     The kon is declared in kitsuden.kons.json in `link` mode, so the API loads it at once.
 *   · inside a kons repository like kitsuden-kons (`kons/` + `tsconfig.kons.json`):
 *       kons/kon-<slug>/           +  tests/unit/kon-<slug>.test.ts
 *   · anywhere else, with `--standalone [dir]`: a NEW kons repository of your own
 *       (default `./kitsuden-kon-<slug>/`), with the kon inside, linked to a Kitsuden checkout by
 *       `pnpm link-core`, installable with `kitsuden kon add <slug> --from <that repo>`.
 *
 * What it writes in the kon folder:
 *
 *   kon.json                 manifest: the ONE place for id, version, tables, mount, maturity
 *   package.json             files[], typecheck
 *   tsconfig.json
 *   index.ts                 defineKonSdk(...) — reads version and tables from kon.json
 *   <slug>.schema.ts         Drizzle table (to type the queries)
 *   <slug>.policy.ts         deny-by-default policy, with the engine's `actsAsUserIn`
 *   <slug>.routes.ts         CRUD as kon SDK OPERATIONS: REST + OpenAPI 3.1 + MCP tools in one go
 *   migrations/0000_initial.sql   the table, and its row security in two lines (core helpers)
 *   README.md, AGENTS.md     for humans, and for coding agents and agents calling the kon
 *
 * and a test of the REAL routes on PGlite, with a non-superuser role and the host's per-request
 * RLS transaction, so the generated policies and row security are exercised from the first run.
 *
 * `packages/cli/tests/make-kon.test.mjs` generates a standalone kon, links it to this checkout and
 * runs its test and `tsc` in it.
 */

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { readKonsFile, writeKonsFile } from "../kons/installation.js";

export interface MakeKonOptions {
  force?: boolean;
  root?: string;
  icon?: string;
  title?: string;
  description?: string;
  /** Create a new kons repository (`true` → `./kitsuden-kon-<slug>`, or this folder). */
  standalone?: boolean | string;
}

export const DEFAULT_ICON = "Package";

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The CLI package root (dist/commands → dist → package), where `templates/` lives. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function konSlug(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .replace(/^kon-/, "");
}

const pascal = (slug: string) =>
  slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
const camel = (slug: string) => {
  const p = pascal(slug);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const title = (slug: string) =>
  slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
const snake = (slug: string) => slug.replace(/-/g, "_");

export type KonLayout = "project" | "kons-repo";

const isProject = (dir: string) =>
  existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "kons"));
const isKonsRepo = (dir: string) =>
  existsSync(join(dir, "kons")) && existsSync(join(dir, "tsconfig.kons.json"));

/** Climbs from `from` up to the root of a Kitsuden project/checkout (`packages/kons`). */
export function findRepoRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (isProject(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Where the kons live under a root: `kons/` in a kons repository, `packages/kons/` in a project. */
export function konsDirOf(root: string): string {
  return isKonsRepo(root) ? join(root, "kons") : join(root, "packages", "kons");
}

/** The root of the nearest Kitsuden project or kons repository above `from`. */
export function findKonsRoot(from: string): string | null {
  return findTarget(from)?.root ?? null;
}

/** Climbs from `from` to the nearest place a kon can be generated in. */
export function findTarget(from: string): { root: string; layout: KonLayout } | null {
  let dir = resolve(from);
  for (;;) {
    if (isKonsRepo(dir)) return { root: dir, layout: "kons-repo" };
    if (isProject(dir)) return { root: dir, layout: "project" };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * If `from` is inside a kon folder (`kon.json` at `from` or an ancestor under `kons/` or
 * `packages/kons/`), returns its short name (`notes` for `kon-notes`). Lets `make policy/request/
 * model/job/test` and `makemigrations` work from inside the kon's folder without `--kon`.
 */
export function findEnclosingKon(from: string): string | null {
  const target = findTarget(from);
  if (!target) return null;
  const konsDir = konsDirOf(target.root);
  let dir = resolve(from);
  while (dir.startsWith(konsDir) && dir !== konsDir) {
    const manifest = join(dir, "kon.json");
    if (existsSync(manifest)) {
      try {
        const id = (JSON.parse(readFileSync(manifest, "utf8")) as { id?: string }).id;
        if (id) return id.replace(/^kon-/, "");
      } catch {
        // fall back to folder name
      }
      return dir
        .slice(konsDir.length + 1)
        .split(/[\\/]/)[0]!
        .replace(/^kon-/, "");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Keys of the admin's ICONS map (packages/admin/src/lib/icons.ts), when it is at hand. */
export function adminIcons(root: string): Set<string> | null {
  const map = join(root, "packages", "admin", "src", "lib", "icons.ts");
  if (!existsSync(map)) return null;
  const block = readFileSync(map, "utf8").match(/const ICONS[^{]*\{([\s\S]*?)\n\s*\};/);
  if (!block) return null;
  const keys = new Set<string>();
  for (const line of block[1]!.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Za-z0-9]*)\s*[,:]/);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/** Mount paths and tables already used by other kons in this place (to avoid clashing). */
function busyWithOthers(konsDir: string): {
  routes: Map<string, string>;
  tables: Map<string, string>;
} {
  const routes = new Map<string, string>();
  const tables = new Map<string, string>();
  if (!existsSync(konsDir)) return { routes, tables };
  for (const e of readdirSync(konsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const manifest = join(konsDir, e.name, "kon.json");
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, "utf8"));
        if (json.mount?.path) routes.set(json.mount.path, e.name);
        for (const t of json.tables ?? []) {
          const n = typeof t === "string" ? t : t?.name;
          if (n) tables.set(n, e.name);
        }
      } catch {
        // a broken manifest is reported by the kon-manifest guard; nothing is decided here
      }
    }
    // Some kons fix the route in code (`mountPath`), not in kon.json.
    const index = join(konsDir, e.name, "index.ts");
    if (existsSync(index)) {
      for (const m of readFileSync(index, "utf8").matchAll(/mountPath:\s*"([^"]+)"/g)) {
        routes.set(m[1]!, e.name);
      }
    }
  }
  return { routes, tables };
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface KonPlan {
  root: string;
  layout: KonLayout;
  /** A new kons repository was scaffolded at `root` (`--standalone`). */
  standalone: boolean;
  slug: string;
  id: string;
  table: string;
  path: string;
  /** Folder of the kon, relative to `root`. */
  konDir: string;
  files: GeneratedFile[];
}

/** Where to generate: an explicit root, the nearest project or kons repo, or a new repo. */
function resolveTarget(slug: string, options: MakeKonOptions) {
  if (options.standalone) {
    const dir = resolve(
      typeof options.standalone === "string" ? options.standalone : `kitsuden-kon-${slug}`
    );
    if (existsSync(dir) && readdirSync(dir).length > 0 && !options.force) {
      throw new Error(
        `${dir} already exists and is not empty (pick another folder or use --force)`
      );
    }
    return { root: dir, layout: "kons-repo" as const, standalone: true };
  }
  const found = options.root
    ? isKonsRepo(resolve(options.root))
      ? { root: resolve(options.root), layout: "kons-repo" as const }
      : isProject(resolve(options.root))
        ? { root: resolve(options.root), layout: "project" as const }
        : null
    : findTarget(process.cwd());
  if (!found) {
    throw new Error(
      "Not inside a Kitsuden project (packages/kons) or a kons repository (kons/ + tsconfig.kons.json). " +
        `Run it there, pass --root <dir>, or start a kons repository of your own with --standalone.`
    );
  }
  return { ...found, standalone: false };
}

/** Computes everything that is going to be written, without writing anything. */
export function planKon(name: string, options: MakeKonOptions = {}): KonPlan {
  const slug = konSlug(name);
  if (!SLUG.test(slug)) {
    throw new Error(
      `Invalid kon name "${name}". Use lowercase letters, digits and dashes, starting with a letter (e.g. "recipes", "event-log").`
    );
  }
  const { root, layout, standalone } = resolveTarget(slug, options);
  const id = `kon-${slug}`;
  const konDir = layout === "project" ? `packages/kons/${id}` : `kons/${id}`;
  if (existsSync(join(root, konDir)) && !options.force) {
    throw new Error(`${konDir} already exists (use --force to overwrite its generated files)`);
  }

  const icon = options.icon ?? DEFAULT_ICON;
  const icons = adminIcons(root);
  if (icons && !icons.has(icon)) {
    throw new Error(
      `Icon "${icon}" is not in the admin icon map (packages/admin/src/lib/icons.ts). ` +
        `Pick one that is (e.g. ${DEFAULT_ICON}) or add it there first.`
    );
  }

  const table = `${snake(slug)}_items`;
  const route = `/api/${slug}`;
  const busy = busyWithOthers(join(root, dirname(konDir)));
  const routeOf = busy.routes.get(route);
  if (routeOf && routeOf !== id)
    throw new Error(`Mount path ${route} is already used by ${routeOf}`);
  const tableOf = busy.tables.get(table);
  if (tableOf && tableOf !== id)
    throw new Error(`Table ${table} is already declared by ${tableOf}`);

  const P = pascal(slug);
  const c = camel(slug);
  const visibleName = options.title ?? title(slug);
  const description =
    options.description ??
    `${visibleName}: items with a title, a body and a draft/published status.`;
  const resource = `${slug}-item`;

  const files: GeneratedFile[] = [];
  const add = (rel: string, content: string) => files.push({ path: join(root, rel), content });
  const k = konDir;

  add(
    `${k}/kon.json`,
    `${JSON.stringify(
      {
        // In a kons repository the schema sits at its root; in a project, the published one.
        $schema:
          layout === "kons-repo"
            ? "../../schemas/kon-schema.json"
            : "https://raw.githubusercontent.com/Kitsuden/kitsuden-kons/main/schemas/kon-schema.json",
        id,
        name: visibleName,
        description,
        version: "0.1.0",
        // The kon SDK contract it is written for (GET /api/version → sdk.kons): the loader
        // refuses to mount a kon that asks for a newer one.
        sdk: 1,
        // A freshly generated kon has not been used by anyone yet.
        maturity: "experimental",
        category: "content",
        type: "kon",
        tier: "specialized",
        icon,
        kitsuden: ">=0.9.0",
        mount: { path: route },
        tables: [
          {
            name: table,
            label: visibleName,
            icon,
            searchableFields: ["title"],
            filterableFields: ["status"],
          },
        ],
        admin: {
          category: "content",
          views: [{ id: `grid-${slug}`, type: "grid", title: visibleName, table }],
        },
        dependencies: { kons: [], core: ["auth"] },
        schema: { entry: null, strategy: "sql" },
      },
      null,
      2
    )}\n`
  );

  add(
    `${k}/package.json`,
    `${JSON.stringify(
      {
        name: `@kitsuden/${id}`,
        version: "0.1.0",
        description,
        type: "module",
        main: "./index.ts",
        types: "./index.ts",
        // What `kitsuden kon add` and a registry publish copy: every top-level entry but tests
        // and tsconfig, sorted — the same list `pnpm kon:sync` computes in a kons repository.
        files: [
          "AGENTS.md",
          "README.md",
          `${slug}.policy.ts`,
          `${slug}.routes.ts`,
          `${slug}.schema.ts`,
          "index.ts",
          "kon.json",
          "migrations",
        ].sort(),
        scripts: { typecheck: "tsc --noEmit" },
        keywords: ["kitsuden", "kon", slug],
        license: "MIT",
        // `@kitsuden/shared`, `@kitsuden/engine`, hono and drizzle-orm are the host's: a kon
        // runs inside a Kitsuden API and must share ONE copy of them with it.
        peerDependencies: { "drizzle-orm": "^0.45.0", hono: "^4.7.0" },
        kitsuden: { type: "kon", id, core: false, defaultEnabled: false },
      },
      null,
      2
    )}\n`
  );

  add(
    `${k}/tsconfig.json`,
    `${JSON.stringify(
      layout === "kons-repo"
        ? {
            extends: "../../tsconfig.kons.json",
            compilerOptions: { noEmit: true },
            include: ["*.ts", "src/**/*.ts"],
            exclude: ["node_modules", "dist", "tests", "**/*.test.ts"],
          }
        : {
            extends: "../../../tsconfig.json",
            compilerOptions: {
              noEmit: true,
              resolveJsonModule: true,
              baseUrl: ".",
              paths: {
                "@kitsuden/shared": ["../../../packages/shared/src/index.ts"],
                "@kitsuden/shared/*": ["../../../packages/shared/src/*"],
                "@kitsuden/engine": ["../../../packages/engine/index.ts"],
                "@kitsuden/engine/*": ["../../../packages/engine/*"],
                "@/*": ["../../../apps/api/src/*"],
              },
            },
            include: ["*.ts", "src/**/*.ts"],
            exclude: ["node_modules", "dist", "tests", "**/*.test.ts"],
          },
      null,
      2
    )}\n`
  );

  add(
    `${k}/migrations/0000_initial.sql`,
    `-- ${id} — initial schema
-- ============================================================================
-- A kon's tables are created HERE, never from code: the API connects with a role without the
-- CREATE privilege (which is what makes row security effective). Applied by \`pnpm db:migrate\`,
-- by \`kitsuden kon add\`, or by the panel when the kon is switched on.
--
-- A migration that was applied is history: to change the table, add 0001_<what>.sql.

CREATE TABLE IF NOT EXISTS ${table} (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       varchar(200) NOT NULL,
  body        text,
  status      varchar(20) NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'published')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ${table}_status_idx ON ${table} (status, created_at DESC);

-- Row security, with the core's helpers (agent-functions.sql), so the database says the same as
-- ${slug}.policy.ts even if a query forgets a filter:
--   · the team (admin, editor), the system, and an agent with \`${resource}:view\` (read) or
--     \`${resource}:update\` (write) — or the whole kon (\`${slug}:*\`, \`kon:${slug}:*\`);
--   · anyone, signed in or not, reads what is published.
-- For rows that belong to a user, use kitsuden_rls_owned(table, owner_column, kon, view, change).
SELECT kitsuden_rls_team('${table}', '${slug}', '${resource}:view', '${resource}:update');
SELECT kitsuden_rls_public_read('${table}', $$status = 'published'$$);
`
  );

  add(
    `${k}/${slug}.schema.ts`,
    `/**
 * ${visibleName} — Drizzle schema
 * ============================================================================
 *
 * Only to TYPE the queries. The table is created by \`migrations/0000_initial.sql\`
 * (kon.json: \`schema.strategy = "sql"\`), so this file and the migrations change together.
 */

import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const STATUSES = ["draft", "published"] as const;
export type Status = (typeof STATUSES)[number];

export const ${c}Items = pgTable("${table}", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  status: varchar("status", { length: 20 }).$type<Status>().notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ${P}Item = typeof ${c}Items.$inferSelect;
export type New${P}Item = typeof ${c}Items.$inferInsert;
`
  );

  add(
    `${k}/${slug}.policy.ts`,
    `/**
 * ${visibleName} — authorization policy
 * ============================================================================
 * Deny-by-default: an action with no rule is denied. Importing this module registers the policy
 * "${resource}". \`register${P}Policy()\` exists because tests call \`resetAuthz()\`.
 *
 *   · anyone (anonymous too)   → sees what is PUBLISHED;
 *   · the kon's team           → sees drafts and creates, edits and deletes. That is a human
 *                                admin or editor, or an agent that opens the whole kon
 *                                (\`${slug}:*\`, \`kon:${slug}:*\`, \`admin\`): \`isEffectiveStaff\`.
 *   · \`actAsUser\`              → may an agent use the routes of "any signed-in account"?
 *                                \`actsAsUserIn("${slug}")\` is the core's rule: a human always,
 *                                an agent with \`user:act\` or a scope of this kon.
 *
 * Account sign-up is public: "having a session" gives nothing by itself.
 */
import { actsAsUserIn, definePolicy, isEffectiveStaff, type AuthzUser } from "@kitsuden/engine";

export function isStaff(user: AuthzUser | null): boolean {
  return isEffectiveStaff(user, "${slug}");
}

export interface ${P}Resource {
  status: string;
}

export function register${P}Policy(): void {
  definePolicy<${P}Resource | null>("${resource}", {
    view: (user, item) => isStaff(user) || item?.status === "published",
    create: (user) => isStaff(user),
    update: (user) => isStaff(user),
    delete: (user) => isStaff(user),
    actAsUser: actsAsUserIn("${slug}"),
  });
}

register${P}Policy();
`
  );

  add(
    `${k}/${slug}.routes.ts`,
    `/**
 * ${visibleName} — operations (kon SDK, Kitsuden's docs/kons/README.md)
 * ============================================================================
 *
 *   GET    ${route}          list      (anonymous: published only; staff: everything)
 *   GET    ${route}/:id      get
 *   POST   ${route}          create    (staff)
 *   PATCH  ${route}/:id      update    (staff)
 *   DELETE ${route}/:id      delete    (staff)
 *
 * Each operation is declared ONCE with \`defineOperation\`: from the declaration come the REST
 * route (422 validation, permission, idempotency and row security inherited), its OpenAPI 3.1
 * operation and its MCP tool (\`${slug}__<id>\`).
 *
 * Rules for handlers (they run inside the request's RLS transaction):
 *   · queries IN SERIES (no \`Promise.all\` over the request's transaction);
 *   · a SQL error you want to tolerate goes inside \`withSavepoint\`;
 *   · \`ctx.db.asSystem(fn)\` only AFTER the application has authorized the action, for what the
 *     caller's own row security would not allow (counting other people's rows, an anonymous
 *     sign-up, a webhook);
 *   · long external calls go outside the transaction (\`ctx.db.background\`).
 */

import {
  AppError,
  defineOperation,
  isUuid,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import { z } from "@kitsuden/engine/zod";
import type { KonContext } from "@kitsuden/shared";
import { desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Hono } from "hono";

import { isStaff, register${P}Policy } from "./${slug}.policy";
import * as schema from "./${slug}.schema";
import { ${c}Items, STATUSES } from "./${slug}.schema";

register${P}Policy();

export type ${P}Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The kon's id: part of the fine scope of each operation (\`kon:${slug}:<op>\`). */
export const KON_ID = "${id}";

const RESOURCE = "${resource}";

// ── Schemas: those of the route, the OpenAPI and the MCP tool ─────────────────

/** Strict: a field that is not here is a 422 with \`didYouMean\`. */
const Create = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100_000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
});
const Edit = Create.partial();
const ParamId = z.object({ id: z.string().describe("Item id (uuid; anything else is a 404)") });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

const Item = z.object({
  id: z.guid(),
  title: z.string(),
  body: z.string().nullable(),
  status: z.enum(STATUSES),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

/** The kon's operations, with their injected context. */
export function ${c}Operations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance as ${P}Db;

  async function load(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await db.select().from(${c}Items).where(eq(${c}Items.id, id)).limit(1);
    return row ?? null;
  }

  return [
    defineOperation({
      id: "list",
      method: "GET",
      route: "/",
      summary: ${JSON.stringify(`List ${visibleName.toLowerCase()}`)},
      description:
        "Newest first. The public sees published items only; admin and editor also see drafts.",
      access: "optional",
      input: { query: ListQuery },
      output: { schema: z.object({ docs: z.array(Item) }) },
      handle: async ({ query }, { user }) => {
        const limit = query.limit ?? 50;
        const docs = isStaff(user)
          ? await db.select().from(${c}Items).orderBy(desc(${c}Items.createdAt)).limit(limit)
          : await db
              .select()
              .from(${c}Items)
              .where(eq(${c}Items.status, "published"))
              .orderBy(desc(${c}Items.createdAt))
              .limit(limit);
        return { docs };
      },
    }),

    defineOperation({
      id: "get",
      method: "GET",
      route: "/:id",
      summary: "Get one item",
      description: "One item by id. A draft you cannot see answers like one that does not exist (404).",
      access: "optional",
      permission: { policy: { resource: RESOURCE, action: "view", inHandler: true } },
      input: { params: ParamId },
      output: { schema: Item },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { can }) => {
        const row = await load(params.id);
        if (!row || !(await can(row))) throw AppError.notFound("Not found");
        return row;
      },
    }),

    defineOperation({
      id: "create",
      method: "POST",
      route: "/",
      summary: "Create an item",
      description: "Creates an item (draft unless status is given). Staff only.",
      access: "session",
      permission: { policy: { resource: RESOURCE, action: "create" } },
      input: { body: Create },
      output: { status: 201, schema: Item },
      handle: async ({ body }) => {
        const [row] = await db
          .insert(${c}Items)
          .values({ title: body.title, body: body.body ?? null, status: body.status ?? "draft" })
          .returning();
        return row;
      },
    }),

    defineOperation({
      id: "update",
      method: "PATCH",
      route: "/:id",
      summary: "Update an item",
      description: "Changes the given fields. Staff only.",
      access: "session",
      permission: { policy: { resource: RESOURCE, action: "update", inHandler: true } },
      input: { params: ParamId, body: Edit },
      output: { schema: Item },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params, body }, { authorize }) => {
        const row = await load(params.id);
        if (!row) throw AppError.notFound("Not found");
        await authorize(row);
        const [updated] = await db
          .update(${c}Items)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(${c}Items.id, row.id))
          .returning();
        return updated;
      },
    }),

    defineOperation({
      id: "delete",
      method: "DELETE",
      route: "/:id",
      summary: "Delete an item",
      description: "Deletes an item. Cannot be undone. Staff only.",
      access: "session",
      permission: { policy: { resource: RESOURCE, action: "delete", inHandler: true } },
      sensitive: true,
      input: { params: ParamId },
      output: { status: 204 },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ params }, { authorize }) => {
        const row = await load(params.id);
        if (!row) throw AppError.notFound("Not found");
        await authorize(row);
        await db.delete(${c}Items).where(eq(${c}Items.id, row.id));
      },
    }),
  ];
}

/** The REST router, generated from the operations. */
export function create${P}Router(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, ${c}Operations(ctx), ctx);
}
`
  );

  add(
    `${k}/index.ts`,
    `/**
 * @kitsuden/${id} — ${visibleName}
 *
 * Mount: ${route}. Generated by \`kitsuden make kon ${slug}\` with the kon SDK: the router, the
 * OpenAPI and the MCP tools come from the operations in ${slug}.routes.ts.
 *
 * Version and tables come from kon.json, the one place they are written.
 */

import { defineKonSdk } from "@kitsuden/engine";
import type { KonContext, KonDefinition } from "@kitsuden/shared";

import manifest from "./kon.json" with { type: "json" };
import { create${P}Router, ${c}Operations } from "./${slug}.routes";

export * from "./${slug}.schema";
export { register${P}Policy, isStaff } from "./${slug}.policy";
export { create${P}Router, ${c}Operations };

export const kon: KonDefinition = defineKonSdk({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  icon: manifest.icon,
  mountPath: manifest.mount.path,
  operations: (ctx: KonContext) => ${c}Operations(ctx),
  tables: manifest.tables.map((t) => t.name),
  admin: {
    category: "content",
    views: [{ id: "grid-${slug}", type: "grid", title: manifest.name, table: "${table}" }],
  },
  dependencies: { kons: [], core: ["auth"] },
});

export default kon;
`
  );

  const testCommand =
    layout === "kons-repo" ? `pnpm test -- kon-${slug}` : `pnpm test:unit -- kon-${slug}`;
  add(
    `${k}/README.md`,
    `# ${id}

${description}

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | content | 0.1.0 | \`${route}\` | — |

Generated by \`kitsuden make kon ${slug}\` with the kon SDK (Kitsuden's docs/kons/README.md):
each route is an operation declared once in \`${slug}.routes.ts\`, which also gives it its
OpenAPI 3.1 entry and its MCP tool.

## Install

Inside a Kitsuden project: \`kitsuden kon add ${slug}\`, then restart the API.

## What it adds

Table \`${table}\`: items with a title, a body and a status (\`draft\` or \`published\`), created by
\`migrations/0000_initial.sql\` with its row security.

## HTTP API

| Route | Who |
| --- | --- |
| \`GET ${route}\` | anyone (published items; admin/editor see drafts too) |
| \`GET ${route}/:id\` | anyone for published items |
| \`POST ${route}\` | admin, editor, or an agent with this kon's scope |
| \`PATCH ${route}/:id\` | admin, editor, or an agent with this kon's scope |
| \`DELETE ${route}/:id\` | admin, editor, or an agent with this kon's scope |

## Who can do what

\`${slug}.policy.ts\` decides. Anyone reads published items; admin and editor read drafts and
write. A draft you cannot see answers 404.

## Configuration

None.

## Agents and MCP

MCP tools \`${slug}__list\`, \`${slug}__get\`, \`${slug}__create\`, \`${slug}__update\` and
\`${slug}__delete\`; fine scopes \`kon:${slug}:<operation>\`. See [AGENTS.md](AGENTS.md).

## Tests

\`tests/unit/kon-${slug}.test.ts\` (\`${testCommand}\`).

## License

MIT
`
  );

  add(
    `${k}/AGENTS.md`,
    `# AGENTS.md — ${id}

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Keep it true when the kon changes.

## What it is

${description}

## Calling it

- Reading published items needs no key. Writes need a key with \`${slug}:*\`, \`kon:${slug}:*\` or
  the operation's fine scope (\`kon:${slug}:create\`, \`kon:${slug}:update\`, \`kon:${slug}:delete\`).
  A deny on the key (\`!kon:${slug}:delete\`) wins over any grant.
- MCP tools: \`${slug}__list\`, \`${slug}__get\`, \`${slug}__create\`, \`${slug}__update\`,
  \`${slug}__delete\`. \`delete\` is marked sensitive.
- A write held for human approval answers \`202 KITSUDEN_E_APPROVAL_REQUIRED\`: report the proposal,
  do not retry.
- A 404 on a draft means row security hid it from you, not that it does not exist.

## Map of the code

- \`kon.json\` — manifest: version, tables, mount path, dependencies. The single source.
- \`index.ts\` — the kon definition; reads version and tables from \`kon.json\`.
- \`${slug}.routes.ts\` — the operations (REST route, OpenAPI entry and MCP tool each).
- \`${slug}.policy.ts\` — who may view, create, update and delete.
- \`${slug}.schema.ts\` — the drizzle table.
- \`migrations/\` — numbered SQL, with the table's row security.

## Rules that must hold

- Tables are created by migrations only, never at runtime.
- The public never sees a draft: the route filters by \`status\` and row security filters again.

## Changing it

- Schema change: edit \`${slug}.schema.ts\` and add the next numbered migration. Never edit an
  applied migration.
- New file next to \`index.ts\`: run \`pnpm kon:sync\` (package.json \`files\`).
- Behaviour change: bump \`version\` in \`package.json\` and run \`pnpm kon:sync\` (it copies it
  to \`kon.json\`).

## Tests

\`${testCommand}\`
`
  );

  const imports =
    layout === "kons-repo"
      ? {
          context: "../../.kitsuden/apps/api/src/lib/test-kon-context",
          host: "../../.kitsuden/tests/unit/helpers/rls-host",
          kon: `../../kons/${id}`,
          bench: `import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";`,
          base: `migratedBase("${id}", ["0000_initial.sql"])`,
          drop: "dropToAppRole(client)",
        }
      : {
          context: "../../apps/api/src/lib/test-kon-context",
          host: "./helpers/rls-host",
          kon: `../../packages/kons/${id}`,
          bench: `import { asAppRole, databaseWithRls, requestAs, testAuth } from "./helpers/kon-with-users";`,
          base: `databaseWithRls("${id}", ["0000_initial.sql"])`,
          drop: "asAppRole(client)",
        };

  add(
    `tests/unit/kon-${slug}.test.ts`,
    `/**
 * ${id} — REAL routes on PGlite, a non-superuser role and per-request row security
 * ============================================================================
 *
 * Generated by \`kitsuden make kon ${slug}\`. Mounts \`create${P}Router\` behind the host's RLS
 * transaction (\`rlsHost\`), with the kon's migration, and checks the policy AND the database:
 * anonymous and signed-in users read what is published, only the team writes, an agent only with
 * the kon's scope, and a field outside the allowlist gives 422.
 */

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "${imports.context}";
import { rlsHost } from "${imports.host}";
import { register${P}Policy } from "${imports.kon}/${slug}.policy";
import { create${P}Router } from "${imports.kon}/${slug}.routes";

${imports.bench}

let client: PGlite;
let request: ReturnType<typeof requestAs>;

beforeAll(async () => {
  client = await ${imports.base};
  const db = await ${imports.drop};
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  const app = host.mount(create${P}Router(ctx));
  // The real API turns an AppError into its status; here, the same.
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  request = requestAs(app);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  register${P}Policy();
});

describe("${id}", () => {
  let published: string;
  let draft: string;

  it("only the team creates", async () => {
    expect((await request("anon", "POST", "/", { title: "x" })).status).toBe(401);
    expect((await request("a", "POST", "/", { title: "x" })).status).toBe(403);

    const r1 = await request("staff", "POST", "/", { title: "Published", status: "published" });
    expect(r1.status).toBe(201);
    published = (await r1.json()).id;

    const r2 = await request("admin", "POST", "/", { title: "Draft" });
    expect(r2.status).toBe(201);
    draft = (await r2.json()).id;
  });

  it("an agent writes only with the kon's scope", async () => {
    expect((await request({ agent: ["blog:*"] }, "POST", "/", { title: "x" })).status).toBe(403);
    expect((await request({ agent: ["${slug}:*"] }, "POST", "/", { title: "By an agent" })).status).toBe(201);
  });

  it("a field outside the allowlist is rejected (422)", async () => {
    const r = await request("staff", "POST", "/", { title: "x", isAdmin: true });
    expect(r.status).toBe(422);
  });

  it("anonymous sees what is published and not drafts", async () => {
    const list = await (await request("anon", "GET", "/")).json();
    const ids = list.docs.map((d: { id: string }) => d.id);
    expect(ids).toContain(published);
    expect(ids).not.toContain(draft);

    expect((await request("anon", "GET", \`/\${published}\`)).status).toBe(200);
    expect((await request("anon", "GET", \`/\${draft}\`)).status).toBe(404);
  });

  it("the team sees drafts", async () => {
    const list = await (await request("staff", "GET", "/")).json();
    expect(list.docs.map((d: { id: string }) => d.id)).toContain(draft);
  });

  it("an id that is not a UUID gives 404, not a 500", async () => {
    expect((await request("anon", "GET", "/not-a-uuid")).status).toBe(404);
  });

  it("editing and deleting require the team", async () => {
    // A draft does not even exist for a customer: row security hides it, so 404, never 403.
    expect((await request("a", "PATCH", \`/\${draft}\`, { status: "published" })).status).toBe(404);
    // A published item is visible to them, and still not theirs to change.
    expect((await request("a", "PATCH", \`/\${published}\`, { title: "x" })).status).toBe(403);
    expect((await request("a", "DELETE", \`/\${published}\`)).status).toBe(403);

    const r = await request("staff", "PATCH", \`/\${draft}\`, { status: "published" });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("published");

    expect((await request("admin", "DELETE", \`/\${draft}\`)).status).toBe(204);
    expect((await request("anon", "GET", \`/\${draft}\`)).status).toBe(404);
  });
});
`
  );

  return { root, layout, standalone, slug, id, table, path: route, konDir, files };
}

/** Copies the kons-repository skeleton (templates/kons-repo) into a new folder. */
function scaffoldKonsRepo(root: string, slug: string): void {
  const template = join(PACKAGE_ROOT, "templates", "kons-repo");
  if (!existsSync(template)) {
    throw new Error(`The CLI package has no templates/kons-repo (${template})`);
  }
  cpSync(template, root, { recursive: true });
  // npm drops dotfiles named like these from a published package, so they travel without the dot.
  for (const f of ["gitignore", "gitattributes", "npmrc"]) {
    if (existsSync(join(root, f))) renameSync(join(root, f), join(root, `.${f}`));
  }
  for (const f of ["package.json", "README.md"]) {
    const p = join(root, f);
    if (existsSync(p)) {
      writeFileSync(p, readFileSync(p, "utf8").replaceAll("__KON_SLUG__", slug), "utf8");
    }
  }
}

export async function writePlan(plan: KonPlan): Promise<void> {
  if (plan.standalone) {
    await mkdir(plan.root, { recursive: true });
    scaffoldKonsRepo(plan.root, plan.slug);
  }
  for (const f of plan.files) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content, "utf8");
  }
}

/**
 * A kon generated in a project ends up INSTALLED: declared in kitsuden.kons.json in `link` mode
 * (used in place; `kitsuden kon remove` does not delete its files). The API only loads what is
 * declared: without this, the freshly made kon would not exist for it.
 */
function declareGeneratedKon(plan: KonPlan): void {
  const file = readKonsFile(plan.root);
  file.kons[plan.id] = {
    source: "kitsuden make kon",
    version: "0.1.0",
    sdk: 1,
    mode: "link",
    path: `./${plan.konDir}`,
    installedAt: new Date().toISOString(),
  };
  writeKonsFile(plan.root, file);
}

export async function makeKonCommand(name: string, options: MakeKonOptions = {}): Promise<void> {
  let plan: KonPlan;
  try {
    plan = planKon(name, options);
  } catch (e) {
    console.error(chalk.red(`✖ ${(e as Error).message}`));
    process.exit(1);
  }
  await writePlan(plan);
  if (plan.layout === "project") declareGeneratedKon(plan);

  const rel = (p: string) => relative(process.cwd(), p).split("\\").join("/") || ".";
  console.log(
    chalk.green(
      `✔ Created ${plan.id}${plan.standalone ? ` in a new kons repository: ${rel(plan.root)}` : ""}`
    )
  );
  for (const f of plan.files) console.log(chalk.gray(`  ${rel(f.path)}`));

  const steps =
    plan.layout === "project"
      ? `  pnpm install                                   # registers the new workspace package
  pnpm test:unit -- kon-${plan.slug}                  # its route tests
  pnpm db:migrate                                # creates ${plan.table}

  Then switch ${plan.id} on in the admin (Kons). Routes: ${plan.path}`
      : `${plan.standalone ? `  cd ${rel(plan.root)}\n  git init\n` : ""}  KITSUDEN_DIR=<your Kitsuden checkout> pnpm link-core   # once: the core this repo builds against
  pnpm install
  pnpm test -- kon-${plan.slug}                       # its route tests
  pnpm kon:sync                                   # after adding files: package.json files[]

  Install it in a Kitsuden project:  kitsuden kon add ${plan.slug} --from ${rel(plan.root)}`;
  console.log(`\n${chalk.bold("Next steps")}\n\n${steps}\n`);
}
