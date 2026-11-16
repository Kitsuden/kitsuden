/**
 * Agent guide — what is served at `GET /llms.txt`
 * ============================================================================
 *
 * For a product built for people who build with agents, this IS the
 * documentation: it is the first thing an agent reads. It is tiered, because
 * every byte of it lands in a model's context:
 *
 *   · `GET /llms.txt` — the INDEX: getting started, the rules an agent tends to
 *     break (with the error it will see), how to build something new, a few
 *     generic recipes, and one line per mounted kon saying where its routes are.
 *   · `GET /llms.txt?kon=<id>[,<id>…]` — only those kons' routes, generated from
 *     the mounted router. They cannot fall behind the API because they come from it.
 *   · `GET /llms.txt?full=1` — the index sections and every kon's routes in one
 *     document (what `/llms.txt` used to return).
 *
 * The output is deterministic for identical inputs (kons sorted by id, routes by
 * path then method, code-point comparison rather than the locale's) so clients
 * can cache it and models can prompt-cache it; the route answers with an ETag.
 *
 * A kon's own rules belong to that kon's description of its operations.
 */

import { createHash } from "node:crypto";

import type { KonRoute } from "./kon-routes";

const RULES = `## Rules an agent tends to break

Each one cost a real failure. If you break it, the error says so.

1. **Fields that do not exist are rejected, not ignored.** A body with an
   unknown key responds **422** with \`error.details.unknownKeys\`: the key,
   \`didYouMean\` with the correct name and \`validKeys\`. Do not retry with the
   same body: fix the name it suggests.
2. **\`id\`, \`createdAt\` and \`updatedAt\` are ignored** in bodies —the
   server sets them— and the \`X-Kitsuden-Ignored-Fields\` header warns about it.
3. **A 404 under \`/api\` carries \`didYouMean\`** with similar routes, and a **405**
   carries the valid methods in \`allow\`. Read them before trying another route.
4. **A 409 with \`section\` means a part of the kon is turned off.** The
   \`enableWith\` field says which setting turns it on. It is not a fault.

5. **An agent operates with scopes.** A valid \`kitsuden_agent_*\` token is not
   enough: without the scope, an action answers 403. A sensitive action can
   answer \`202 KITSUDEN_E_APPROVAL_REQUIRED\`: a human must approve it, so report
   it and do not retry.`;

function header(baseUrl: string, publishedContract: boolean): string {
  return `# Kitsuden — agent guide

> The JS backend where you declare a model once and your agents can use it, with
> permissions and human approval.
> This guide is served by the running API and its routes come from the mounted code.

## Getting started

- **API:** \`${baseUrl}\`
${
  publishedContract
    ? `- **Full contract:** \`GET ${baseUrl}/docs/openapi.json\``
    : "- **Full contract:** this installation does not publish it (`ENABLE_SWAGGER=false`). The kon routes are in this guide and, over MCP, `tools/list` gives each tool with its schema."
}
- **Credential:** \`Authorization: Bearer kitsuden_agent_…\`, an agent token
  created in the admin panel (Agents) with the scopes it needs.
- **MCP:** \`POST ${baseUrl}/mcp\`; \`tools/list\` gives each tool with its schema. Connect
  with \`?toolset=\` (\`data\`, \`kon:<id>\`…) to list only what you need. If you see only
  \`kitsuden_find_tools\` and \`kitsuden_call_tool\`, the full list was too big: search, then call.
- **SDK:** \`kitsuden generate-sdk\` writes a typed client.
- **This guide is an index.** A kon's routes: \`GET ${baseUrl}/llms.txt?kon=<id>\` (several:
  \`?kon=a,b\`). Everything in one document: \`GET ${baseUrl}/llms.txt?full=1\`.`;
}

function building(baseUrl: string): string {
  return `## Building something new

- **No code: a dataset.** For records with fields (a catalog, a log, form answers), create a
  dataset: MCP \`kitsuden_create_dataset\` (scope \`mcp:admin\`) or \`POST ${baseUrl}/data-sets\`
  (admin or editor). Its rows are read and written through \`${baseUrl}/items/<slug>\` or the
  MCP tools \`kitsuden_query_collection\` and \`kitsuden_create_record\`.
- **Code: a kon.** Own tables, business rules or own routes need a kon, written in a Kitsuden
  checkout with the CLI (the running API cannot create one):
  - \`kitsuden make kon <name>\`: a CRUD kon mounted at \`/api/<name>\`, with its policy, a
    migration with row security and route tests. \`--fields "title:string!,price:number,published:boolean"\`
    sets its columns (\`!\` = required; types: string, text, integer, number, boolean, date,
    datetime, json, uuid).
  - \`kitsuden make model <name> --kon <kon>\`: a declared model (\`defineModel\`) inside a kon.
  - \`kitsuden makemigrations\` (\`--kon <kon>\`, \`--dry-run\`): writes the migration SQL from the
    models and never applies it; review it, then \`pnpm db:migrate\`.
  - Then switch the kon on in the admin panel (Kons). Guide: \`docs/kons/README.md\`; models:
    \`docs/agents/models.md\`.`;
}

function recipes(baseUrl: string): string {
  return `## Recipes

### Store records in a new dataset (no code)

1. \`kitsuden_list_datasets\`: make sure it does not exist yet.
2. \`kitsuden_create_dataset\` with \`{ name, slug, fields: [{ name, type, label, required }] }\`.
3. One \`kitsuden_create_record\` per row: \`{ collection: "<slug>", data: { … } }\` (REST:
   \`POST ${baseUrl}/items/<slug>\`). Read back with \`kitsuden_query_collection\` \`{ collection: "<slug>" }\`.

### A CRUD kon, from nothing to a working route

1. \`kitsuden make kon <name> --fields "title:string!,price:number"\` in a Kitsuden checkout.
2. Run the steps it prints: \`pnpm install\`, \`pnpm test:unit -- kon-<name>\`, \`pnpm db:migrate\`.
3. Switch \`kon-<name>\` on in the admin panel (Kons).
4. \`GET ${baseUrl}/llms.txt?kon=<name>\` now lists \`GET|POST /api/<name>\` and
   \`GET|PATCH|DELETE /api/<name>/:id\`; over MCP they are \`<name>__list\`, \`<name>__create\`…,
   with scopes \`kon:<name>:<operation>\`.

### A sensitive write that needs a human

1. Send the write (e.g. a delete: MCP \`kitsuden_delete_record\`, or a kon's \`DELETE\` route
   with an \`Idempotency-Key\` header).
2. A \`202\` with \`code: KITSUDEN_E_APPROVAL_REQUIRED\` means nothing ran: the body carries
   \`proposal.id\` and \`proposal.statusUrl\`.
3. Tell the human the proposal id. Read \`GET ${baseUrl}/proposals/<id>\` (MCP:
   \`kitsuden_proposal_status\` \`{ proposal_id }\`) until it is executed, failed, rejected or
   expired. Do not resend the write.`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** Code-point order: the same on every machine, whatever its locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `kon-blog`, `blog` and ` Blog ` name the same kon. */
const bareId = (id: string) => id.trim().toLowerCase().replace(/^kon-/, "");

function bodyFields(route: KonRoute): string {
  const body = route.validation.find((v) => v.target === "json" || v.target === "form");
  type Def = { type?: string; in?: unknown; shape?: Record<string, unknown> };
  let def = (body?.schema as { _zod?: { def: Def } } | undefined)?._zod?.def;
  // `.transform()`/`.pipe()` wrap the object in a `pipe`: its input is looked at
  for (let i = 0; i < 5 && def?.type === "pipe"; i++) {
    def = (def.in as { _zod?: { def: Def } } | undefined)?._zod?.def;
  }
  if (def?.type !== "object" || !def.shape) return "";
  const keys = Object.keys(def.shape);
  return keys.length ? ` · body: ${keys.join(", ")}` : "";
}

/** The documented routes of each kon, kons sorted by id and routes by path then method. */
function groupByKon(list: KonRoute[]): [string, KonRoute[]][] {
  const byKon = new Map<string, KonRoute[]>();
  for (const r of list) {
    if (r.path.includes("*")) continue;
    const group = byKon.get(r.konId) ?? [];
    group.push(r);
    byKon.set(r.konId, group);
  }
  return [...byKon.entries()]
    .map(([konId, group]): [string, KonRoute[]] => [
      konId,
      [...group].sort((a, b) => compare(a.path, b.path) || compare(a.method, b.method)),
    ])
    .sort(([a], [b]) => compare(a, b));
}

function konBlock(konId: string, group: KonRoute[]): string {
  const lines = group.map((r) => {
    const marks = [
      r.auth === "required" ? "credential" : "",
      r.section ? `section «${r.section}»` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const summary = r.summary ? ` — ${r.summary}` : "";
    return `- \`${r.method} ${r.path}\`${summary}${marks ? ` [${marks}]` : ""}${bodyFields(r)}`;
  });
  return `### ${konId}\n\n${lines.join("\n")}`;
}

const NOT_GENERATED =
  "They are generated when serving `GET /llms.txt` from the running API: they come from the mounted router, \nso they depend on which kons each installation has turned on.";
const NO_KON = "(No kon mounted in this installation.)";

function allRoutes(list: KonRoute[] | undefined): string {
  if (list === undefined) return `## Kon routes\n\n${NOT_GENERATED}`;
  const groups = groupByKon(list);
  if (groups.length === 0) return `## Kon routes\n\n${NO_KON}`;
  const blocks = groups.map(([konId, group]) => konBlock(konId, group));
  return `## Kon routes\n\nGenerated from the mounted router.\n\n${blocks.join("\n\n")}`;
}

function konIndex(list: KonRoute[] | undefined, baseUrl: string): string {
  if (list === undefined) return `## Kons\n\n${NOT_GENERATED}`;
  const groups = groupByKon(list);
  if (groups.length === 0) return `## Kons\n\n${NO_KON}`;
  const lines = groups.map(
    ([konId, group]) =>
      `- ${konId} — ${group.length} route${group.length === 1 ? "" : "s"} · GET ${baseUrl}/llms.txt?kon=${konId}`
  );
  return `## Kons\n\nEach kon's routes, generated from the mounted router, are one request away.\n\n${lines.join("\n")}`;
}

// ── Documents ────────────────────────────────────────────────────────────────

export interface AgentGuideOptions {
  baseUrl: string;
  routes?: KonRoute[];
  /** Is `/api/docs/openapi.json` served? (`ENABLE_SWAGGER`). Yes by default. */
  publishedContract?: boolean;
  /** `index` (the default, what `GET /llms.txt` serves) or `full` (every kon's routes). */
  view?: "index" | "full";
}

/** The index (default) or the full guide. Same input, same bytes. */
export function generateAgentGuide(options: AgentGuideOptions): string {
  const { baseUrl } = options;
  const full = options.view === "full";
  return [
    header(baseUrl, options.publishedContract ?? true),
    RULES,
    building(baseUrl),
    recipes(baseUrl),
    full ? allRoutes(options.routes) : konIndex(options.routes, baseUrl),
    "",
  ].join("\n\n");
}

/**
 * Only the routes of the kons asked for (`blog` or `kon-blog`), in kon-id order
 * whatever the order of the request. `null` with the unknown ids if any is not mounted.
 */
export function generateKonGuide(options: {
  baseUrl: string;
  routes: KonRoute[];
  kons: string[];
}): { body: string; unknown: null } | { body: null; unknown: string[] } {
  const groups = groupByKon(options.routes);
  const wanted = [...new Set(options.kons.map(bareId).filter(Boolean))];
  const known = new Set(groups.map(([konId]) => bareId(konId)));
  const unknown = wanted.filter((id) => !known.has(id)).sort(compare);
  if (unknown.length) return { body: null, unknown };

  const chosen = groups.filter(([konId]) => wanted.includes(bareId(konId)));
  const blocks = chosen.map(([konId, group]) => konBlock(konId, group));
  const body = [
    `# Kitsuden — routes of ${chosen.map(([konId]) => konId).join(", ")}`,
    `> Generated from the mounted router. Rules, recipes and the other kons: \`GET ${options.baseUrl}/llms.txt\`.`,
    blocks.join("\n\n"),
    "",
  ].join("\n\n");
  return { body, unknown: null };
}

/** Mounted kon ids, sorted: what a 404 lists. */
export function mountedKonIds(routes: KonRoute[]): string[] {
  return groupByKon(routes).map(([konId]) => konId);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Strong ETag of a body: its SHA-256, quoted. */
export function guideEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** Does `If-None-Match` (a list, `*`, weak or strong tags) match this ETag? */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//, "") === bare);
}

const yes = (v: string | null | undefined) =>
  v != null && ["1", "true", "yes"].includes(v.trim().toLowerCase());

export type GuideResponse =
  | { status: 200 | 404; body: string; headers: Record<string, string> }
  | { status: 304; body: null; headers: Record<string, string> };

/**
 * The whole answer of `GET /llms.txt`: which document the query asks for, its
 * caching headers and the 304. `?kon=` wins over `?full=`.
 */
export function agentGuideResponse(
  options: Omit<AgentGuideOptions, "view" | "routes"> & {
    routes: KonRoute[];
    query: { kon?: string | null; full?: string | null };
    ifNoneMatch?: string | null;
  }
): GuideResponse {
  const contentType = "text/markdown; charset=utf-8";
  const kons = (options.query.kon ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let body: string;
  if (kons.length) {
    const r = generateKonGuide({ baseUrl: options.baseUrl, routes: options.routes, kons });
    if (r.body === null) {
      const valid = mountedKonIds(options.routes);
      return {
        status: 404,
        body: `Unknown kon: ${r.unknown.join(", ")}.\nMounted kons: ${valid.length ? valid.join(", ") : "(none)"}.\nThe index lists them all: GET ${options.baseUrl}/llms.txt\n`,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      };
    }
    body = r.body;
  } else {
    body = generateAgentGuide({
      baseUrl: options.baseUrl,
      routes: options.routes,
      publishedContract: options.publishedContract,
      view: yes(options.query.full) ? "full" : "index",
    });
  }

  const etag = guideEtag(body);
  const headers = { etag, "cache-control": "public, max-age=300" };
  if (etagMatches(options.ifNoneMatch, etag)) return { status: 304, body: null, headers };
  return { status: 200, body, headers: { ...headers, "content-type": contentType } };
}
