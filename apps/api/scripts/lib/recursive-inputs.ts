/**
 * Operations whose input is a recursive schema, and the spec split around them
 * ============================================================================
 *
 * Schemathesis's coverage phase walks every combination of a body's fields. On
 * a schema that contains itself (kon-dc's blueprint definition: templates and
 * steps that nest) that walk never ends: on 2026-11-20 it sent ~280,000
 * requests to `POST /api/dc/blueprints` until the kons job hit its time limit,
 * and no other operation was reached.
 *
 * The runner (`schemathesis.ts`) therefore tests these operations in a second
 * pass, with the `examples` and `fuzzing` phases only. Fuzzing is bounded by
 * `--max-examples`; coverage is not.
 *
 * How a recursive schema is recognised: zod's JSON Schema leaves `$defs` only
 * when a schema refers to itself (operations-openapi.ts, `rebaseDefs`); a flat
 * schema is inlined whole. So an input that holds `$defs` anywhere is recursive.
 */

type Json = Record<string, unknown>;

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function holdsDefs(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(holdsDefs);
  const obj = node as Json;
  if (obj.$defs && typeof obj.$defs === "object") return true;
  return Object.values(obj).some(holdsDefs);
}

/** True when the operation's body or parameters hold a recursive schema. */
export function hasRecursiveInput(operation: Json): boolean {
  return holdsDefs(operation.requestBody) || holdsDefs(operation.parameters);
}

export interface SplitSpec<D> {
  /** Every operation without a recursive input: all phases. */
  flat: D;
  /** Only the operations with a recursive input: no coverage phase. */
  recursive: D;
  /** `METHOD /path` of each operation moved to `recursive`. */
  recursiveKeys: string[];
}

/**
 * Splits an OpenAPI document in two by `hasRecursiveInput`. Both halves keep
 * the rest of the document (info, servers, components); `$ref`s that point into
 * `#/paths/...` stay valid because each operation keeps its own path and method.
 */
export function splitRecursiveInputs<D extends { paths: Record<string, Json> }>(
  doc: D,
  base = ""
): SplitSpec<D> {
  const flat = { ...doc, paths: {} as Record<string, Json> };
  const recursive = { ...doc, paths: {} as Record<string, Json> };
  const recursiveKeys: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    // What is not an operation (path-level `parameters`, `summary`…) belongs to
    // every operation of the path: both halves get it.
    const shared = Object.fromEntries(Object.entries(item).filter(([k]) => !METHODS.has(k)));
    for (const [key, value] of Object.entries(item)) {
      if (!METHODS.has(key)) continue;
      const target = hasRecursiveInput(value as Json) ? recursive : flat;
      if (target === recursive) recursiveKeys.push(`${key.toUpperCase()} ${base}${path}`);
      (target.paths[path] ??= { ...shared })[key] = value;
    }
  }
  return { flat: flat as D, recursive: recursive as D, recursiveKeys };
}

/** How many operations a document holds. */
export function operationCount(doc: { paths: Record<string, Json> }): number {
  return Object.values(doc.paths).reduce(
    (n, item) => n + Object.keys(item).filter((k) => METHODS.has(k)).length,
    0
  );
}
