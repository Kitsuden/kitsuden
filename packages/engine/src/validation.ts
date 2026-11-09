/**
 * Kitsuden — Request Validation (FormRequest-style)
 * ============================================================================
 *
 * Validation DX in the style of Laravel FormRequest / Django forms, on top of Zod:
 *   - A single `validate(schema, target)` helper as middleware.
 *   - On error → ALWAYS the same envelope (AppError.validation with per-field
 *     details). No ad-hoc responses in each route.
 *   - On success → the typed data is left in `c.get("valid:<target>")`, and is
 *     read with the typed helper `validated<T>(c, target)`.
 *
 * Usage:
 *   const CreatePost = z.object({ title: z.string().min(1), body: z.string() });
 *   app.post("/posts", validate(CreatePost), (c) => {
 *     const input = validated<z.infer<typeof CreatePost>>(c);   // typed
 *     ...
 *   });
 *
 * ── UNKNOWN FIELDS ARE REJECTED, NOT IGNORED ───────────────────────────────
 *
 * By default, Zod silently STRIPS whatever the schema does not know. Here that
 * cost real data: the blog editor sent `tags` and the route expected
 * `tagIds`, so tags were lost on save and the response was a
 * 200. Nobody notices a field that disappears.
 *
 * For a human it is a hard failure to spot. For an AI agent it is impossible:
 * it cannot debug a silence, and a misnamed field is exactly the
 * mistake a model makes. So a body with keys the schema does not
 * know answers 422 with the key, the closest suggestion and the list of
 * valid keys.
 *
 * Only in the BODY (`json` and `form`). In the query extras are tolerated: a
 * `?utm_source=` or an anti-cache parameter are normal and rejecting them would break
 * links that have nothing wrong with them.
 *
 * `id`, `createdAt` and `updatedAt` are ignored —and a warning is given in the
 * `X-Kitsuden-Ignored-Fields` header— because they are managed by the server and the most
 * common client pattern is to read an object and send it back whole on update.
 * Rejecting them would make that pattern fail without protecting anything.
 */

import type { Context, MiddlewareHandler } from "hono";
import { z, type ZodTypeAny } from "zod";

import { AppError } from "./errors";
import { withRouteMeta } from "./route-meta";

export type ValidationTarget = "json" | "query" | "param" | "form";

function keyFor(target: ValidationTarget): string {
  return `valid:${target}`;
}

async function readTarget(c: Context, target: ValidationTarget): Promise<unknown> {
  switch (target) {
    case "json":
      try {
        return await c.req.json();
      } catch {
        throw AppError.badRequest("Invalid or missing JSON body");
      }
    case "query":
      return c.req.query();
    case "param":
      return c.req.param();
    case "form":
      return await c.req.parseBody();
  }
}

/** Flattens Zod issues to `{ field: [messages] }`. */
function formatIssues(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length ? issue.path.join(".") : "_";
    (out[path] ??= []).push(issue.message);
  }
  return out;
}

// ── Unknown fields ───────────────────────────────────────────────────────────

/** Managed by the server; a client sends them back when doing GET → PATCH. */
const SERVER_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

export interface UnknownField {
  /** Path of the object that contains it (`""` at the root, `theme` if it is inside). */
  path: string;
  key: string;
  didYouMean: string | null;
  validKeys: string[];
}

/**
 * What zod 4 exposes of each schema: `_zod.def.type` says what it is ("object",
 * "optional", "pipe"…) and the rest of `def` its pieces.
 */
type InternalZod = { _zod?: { def: Record<string, unknown> & { type?: string } } };

function defOf(s: unknown): (Record<string, unknown> & { type?: string }) | undefined {
  return (s as InternalZod | undefined)?._zod?.def;
}

/** Strips the layers that do not change the SHAPE: optional, default, transform… */
function unwrap(schema: unknown): InternalZod | undefined {
  let s = schema as InternalZod | undefined;
  for (let i = 0; i < 20 && s?._zod; i++) {
    const def = s._zod.def;
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "catch":
      case "readonly":
      case "nonoptional":
        s = def.innerType as InternalZod;
        break;
      case "pipe":
        // `.transform()` and `.pipe()`: the shape it receives is the input one
        s = def.in as InternalZod;
        break;
      case "lazy":
        s = (def.getter as () => InternalZod)();
        break;
      default:
        return s;
    }
  }
  return s;
}

interface ObjectShape {
  shape: Record<string, unknown>;
  /** `passthrough` or with `catchall`: accepts extra keys on purpose. */
  open: boolean;
}

function objectShape(schema: unknown): ObjectShape | null {
  const def = defOf(unwrap(schema));
  if (!def) return null;

  if (def.type === "object") {
    const shape = def.shape as Record<string, unknown>;
    // `passthrough()` is an `unknown` catchall; `strict()`, a `never` one
    const catchall = defOf(def.catchall)?.type;
    const open = !!catchall && catchall !== "never";
    return { shape, open };
  }

  if (def.type === "intersection") {
    const left = objectShape(def.left);
    const right = objectShape(def.right);
    if (!left || !right) return null;
    return { shape: { ...left.shape, ...right.shape }, open: left.open || right.open };
  }

  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/**
 * The closest valid key, or `null` if none is similar enough.
 *
 * It is normalized before comparing —lowercase, without `_` or `-`— because the most
 * frequent mistake is not a typo but the wrong convention: `tag_ids` for
 * `tagIds`. And the threshold is strict on purpose: a bad suggestion is worse
 * than none, because the agent will follow it.
 */
export function similarKey(key: string, valid: readonly string[]): string | null {
  const normalize = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, "");
  const n = normalize(key);
  let best: string | null = null;
  let smaller = Infinity;
  for (const v of valid) {
    const nv = normalize(v);
    if (nv === n) return v;
    const d = distance(n, nv);
    if (d < smaller) {
      smaller = d;
      best = v;
    }
  }
  const threshold = Math.max(2, Math.floor(key.length / 3));
  return smaller <= threshold ? best : null;
}

/**
 * Looks for keys the schema does not know, walking nested objects and lists.
 *
 * In a union it compares against the option that leaves the FEWEST unknowns: if the
 * body fits cleanly in any of them, there is nothing to report.
 */
export function searchUnknownFields(
  schema: unknown,
  value: unknown,
  route: string[] = [],
  unknownAll: UnknownField[] = [],
  ignored: string[] = []
): { unknownAll: UnknownField[]; ignored: string[] } {
  const s = unwrap(schema);
  const def = defOf(s);
  const type = def?.type;

  if (type === "array") {
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        searchUnknownFields(def!.element, v, [...route, String(i)], unknownAll, ignored)
      );
    }
    return { unknownAll, ignored };
  }

  // In zod 4 the discriminated union is also `union`
  if (type === "union") {
    const options = def!.options as unknown[];
    let best: ReturnType<typeof searchUnknownFields> | null = null;
    for (const option of options) {
      const r = searchUnknownFields(option, value, route, [], []);
      if (!best || r.unknownAll.length < best.unknownAll.length) best = r;
      if (r.unknownAll.length === 0) break;
    }
    if (best) {
      unknownAll.push(...best.unknownAll);
      ignored.push(...best.ignored);
    }
    return { unknownAll, ignored };
  }

  const shape = objectShape(s);
  if (!shape || !isPlainObject(value)) return { unknownAll, ignored };

  const valid = Object.keys(shape.shape);
  if (!shape.open) {
    for (const key of Object.keys(value)) {
      if (key in shape.shape) continue;
      if (SERVER_FIELDS.has(key)) {
        ignored.push([...route, key].join("."));
        continue;
      }
      unknownAll.push({
        path: route.join("."),
        key,
        didYouMean: similarKey(key, valid),
        validKeys: valid,
      });
    }
  }

  for (const [key, sub] of Object.entries(shape.shape)) {
    if (key in value) {
      searchUnknownFields(sub, value[key], [...route, key], unknownAll, ignored);
    }
  }

  return { unknownAll, ignored };
}

function messageOf(d: UnknownField): string {
  const where = d.path ? `${d.path}.${d.key}` : d.key;
  const suggestion = d.didYouMean ? ` Did you mean «${d.didYouMean}»?` : "";
  const valid = d.validKeys.length ? d.validKeys.join(", ") : "(none)";
  return `Unknown field «${where}».${suggestion} Valid fields: ${valid}.`;
}

/**
 * Validation middleware. On failure it throws AppError.validation (422) with
 * `details.fields`; on success it leaves the parsed/coerced data in the context.
 *
 * It also leaves its schema in the route metadata: that is where the
 * body documented in the OpenAPI comes from and, therefore, the generated SDK's type.
 */
export function validateRequest(
  schema: ZodTypeAny,
  target: ValidationTarget = "json"
): MiddlewareHandler {
  const mw: MiddlewareHandler = async (c, next) => {
    const raw = await readTarget(c, target);
    const result = schema.safeParse(raw);

    const strictItem = target === "json" || target === "form";
    const { unknownAll, ignored } = strictItem
      ? searchUnknownFields(schema, raw)
      : { unknownAll: [] as UnknownField[], ignored: [] as string[] };

    if (!result.success || unknownAll.length > 0) {
      const fields = result.success ? {} : formatIssues(result.error);
      for (const d of unknownAll) {
        const key = d.path ? `${d.path}.${d.key}` : d.key;
        (fields[key] ??= []).push(messageOf(d));
      }

      throw AppError.validation(
        result.success ? "Unknown fields in the request" : "Validation failed",
        {
          target,
          fields,
          ...(unknownAll.length > 0
            ? {
                unknownKeys: unknownAll,
                hint:
                  "Kitsuden rejects fields it does not know instead of ignoring them: " +
                  "a misnamed field would be lost without warning.",
              }
            : {}),
        }
      );
    }

    if (ignored.length > 0) c.header("X-Kitsuden-Ignored-Fields", ignored.join(", "));

    c.set(keyFor(target) as never, result.data as never);
    await next();
  };

  return withRouteMeta(mw, { validation: [{ target, schema }] });
}

/** Reads a route's validated, typed data. */
export function validated<T>(c: Context, target: ValidationTarget = "json"): T {
  return c.get(keyFor(target) as never) as T;
}

/**
 * Imperative validation (without middleware), for use inside a handler or job.
 * Throws AppError.validation if it does not pass.
 *
 * It does NOT reject unknown fields: it is also used on database rows and internal
 * data, which legitimately carry extra columns. The strict rule
 * is for what comes in over HTTP, and that goes through `validateRequest`.
 */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.validation("Validation failed", { fields: formatIssues(result.error) });
  }
  return result.data;
}

/**
 * Does this text have the shape of a UUID?
 *
 * It exists because an `id` that is not one CANNOT be passed to a query: Postgres
 * answers `invalid input syntax for type uuid`, and that comes out of the error
 * handler as a **500**. That is, a mistyped URL parameter was
 * reported as a server failure.
 *
 * It really happened, and in the silliest way: `GET /api/media/upload` matches
 * the detail route `/api/media/:id`, so `id` was `"upload"`. A broken link,
 * a crawler or someone testing by hand was enough to fill the log with
 * 500 errors on a perfectly healthy database.
 *
 * Whoever fails this check receives **404**, not 400: if the id cannot
 * exist, "not found" is exactly what happens, and it also does not reveal
 * which key format the table uses internally.
 */
export function isUuid(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
