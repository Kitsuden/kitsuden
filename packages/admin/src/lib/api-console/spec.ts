/**
 * The API console's document: what `<rapi-doc-mini>` is given to render
 * ============================================================================
 *
 * The console never lets RapiDoc fetch a document itself. The panel fetches
 * `/api/docs/<kon>/openapi.json` and hands over the object this file returns:
 *
 *   - Every `description`, `summary` and `title` is neutralised: RapiDoc renders
 *     them as Markdown into HTML (`marked` → its sanitizer → `unsafeHTML`), and
 *     its sanitizer, outside browsers with the native Sanitizer API, only strips
 *     `<script>`, `on*` attributes and `javascript:` in `href`/`src`. Kons can be
 *     third-party code and their descriptions reach the document, so no raw HTML
 *     may survive (docs/api-contract.md, "The API console in the panel").
 *   - External `$ref`s are dropped: RapiDoc would fetch them from wherever they point.
 *   - `servers` becomes this API only, at every level, and security schemes go:
 *     a request carries the panel session, never a token typed into the console.
 *   - Only the chosen operation (or tag) stays.
 *
 * Pure functions, no DOM: `spec.test.ts`.
 */

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** The keys whose text RapiDoc turns into HTML. */
const MARKDOWN_KEYS = new Set(["description", "summary", "title"]);

/**
 * Markdown with no way to become live HTML.
 *
 *   - `&`, `<`, `>` become entities: no tag, comment or entity smuggling
 *     (`java&#9;script:`) gets through, and `marked` shows them as the characters.
 *     Inside a code span the entity is shown as written (`&lt;id&gt;`): readability
 *     loses there, on purpose.
 *   - A link to `javascript:`/`vbscript:` (`[x](javascript:…)`, `[x]: javascript:…`,
 *     with `\:`) loses its scheme: the colon becomes `%3A`, a relative link.
 *   - `![…](…)` is not an image: it would load from any host when the console opens.
 */
export function neutraliseMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(\]\(|\]:)(\s*)((?:java|vb)script)\s*\\?:/gi, "$1$2$3%3A")
    .replace(/!\[/g, "!&#91;");
}

export type ConsoleSelection =
  { kind: "operation"; method: HttpMethod; path: string } | { kind: "tag"; tag: string };

export interface ConsoleOperation {
  method: HttpMethod;
  path: string;
  summary: string;
  operationId: string;
  tags: string[];
}

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isMethod = (k: string): k is HttpMethod => (HTTP_METHODS as readonly string[]).includes(k);

/** The operations of a document, by tag, then path, then method. */
export function listOperations(spec: unknown): ConsoleOperation[] {
  if (!isObject(spec) || !isObject(spec.paths)) return [];
  const out: ConsoleOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!isObject(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!isMethod(method) || !isObject(op)) continue;
      const tags = Array.isArray(op.tags)
        ? op.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      out.push({
        method,
        path,
        summary: typeof op.summary === "string" ? op.summary : "",
        operationId: typeof op.operationId === "string" ? op.operationId : "",
        tags,
      });
    }
  }
  const order = (m: HttpMethod) => HTTP_METHODS.indexOf(m);
  return out.sort(
    (a, b) =>
      (a.tags[0] ?? "").localeCompare(b.tags[0] ?? "") ||
      a.path.localeCompare(b.path) ||
      order(a.method) - order(b.method)
  );
}

/** The tags that have operations, in the order of `listOperations`. */
export function listTags(operations: ConsoleOperation[]): string[] {
  return [...new Set(operations.flatMap((op) => op.tags))];
}

/** A selection as a `<select>` value, and back. */
export function selectionValue(sel: ConsoleSelection): string {
  return sel.kind === "tag" ? `tag:${sel.tag}` : `op:${sel.method} ${sel.path}`;
}

export function parseSelection(value: string): ConsoleSelection | null {
  if (value.startsWith("tag:")) return { kind: "tag", tag: value.slice(4) };
  const m = /^op:([a-z]+) (.+)$/.exec(value);
  if (m && isMethod(m[1])) return { kind: "operation", method: m[1], path: m[2] };
  return null;
}

/** A deep copy with every Markdown text neutralised and no external `$ref`. */
function clean(value: Json, key: string | null): Json {
  if (typeof value === "string") {
    return key !== null && MARKDOWN_KEYS.has(key) ? neutraliseMarkdown(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => clean(v, null));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    // Only a local pointer (`#/components/…`); RapiDoc fetches any other one.
    if (k === "$ref" && !(typeof v === "string" && v.startsWith("#"))) continue;
    if (k === "__proto__") continue;
    out[k] = clean(v, k);
  }
  return out;
}

function keeps(sel: ConsoleSelection, path: string, method: string, op: JsonObject): boolean {
  if (sel.kind === "operation") return sel.path === path && sel.method === method;
  return Array.isArray(op.tags) && op.tags.includes(sel.tag);
}

/**
 * The document to hand to `loadSpec()`: neutralised (see the file header),
 * pointed at `serverUrl` only, with no security schemes, webhooks or callbacks,
 * and only the selected operations. The input is not changed.
 */
export function prepareConsoleSpec(
  spec: unknown,
  { serverUrl, selection }: { serverUrl: string; selection: ConsoleSelection }
): JsonObject {
  const doc = clean(isObject(spec) ? spec : {}, null) as JsonObject;

  const paths: JsonObject = {};
  for (const [path, item] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    if (!isObject(item)) continue;
    const kept: JsonObject = {};
    for (const [method, op] of Object.entries(item)) {
      if (!isMethod(method) || !isObject(op) || !keeps(selection, path, method, op)) continue;
      const { servers: _s, security: _sec, callbacks: _cb, ...rest } = op;
      kept[method] = rest;
    }
    if (Object.keys(kept).length === 0) continue;
    for (const shared of ["parameters", "summary", "description"]) {
      if (item[shared] !== undefined) kept[shared] = item[shared];
    }
    paths[path] = kept;
  }

  const { webhooks: _w, security: _sec, servers: _s, ...rest } = doc;
  const components = isObject(rest.components) ? { ...rest.components } : undefined;
  if (components) delete components.securitySchemes;

  return {
    ...rest,
    ...(components ? { components } : {}),
    servers: [{ url: serverUrl }],
    paths,
  };
}
