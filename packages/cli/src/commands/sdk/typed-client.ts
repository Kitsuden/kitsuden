/**
 * Typed client from the OpenAPI — what an agent cannot make up
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * `kitsuden generate-sdk` wrote some "fetchers" that only knew how to talk to
 * `/items/{collection}`: they substituted `{collection}` and `{id}` in the path and nothing
 * more. With the OpenAPI of the time it did not matter —it documented no kon
 * route—, but as soon as the contract started to include `/esports/...` or
 * `/tierlist/...`, the generator produced functions that called paths with a literal
 * `{tournamentId}` inside.
 *
 * And no body types. An agent that wrote `{ winner: "p1" }` instead of
 * `{ winnerId: "p1" }` did not find out until it read a 422 at runtime.
 *
 * ── WHAT IT DOES NOW ───────────────────────────────────────────────────────
 *
 * It generates ONE dependency-free TypeScript file with:
 *
 *   · a namespace per kon (`client.esports`, `client.tierlist`)
 *   · a method per operation, with path parameters, body and
 *     query typed from the contract's JSON Schema
 *   · an error (`KitsudenApiError`) that keeps the response body and
 *     puts the `didYouMean` suggestions in the message
 *
 * The goal is that an agent's most common error —a field name—
 * fails AT COMPILE TIME, which is where an agent does know how to fix itself.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  nullable?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  $ref?: string;
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  security?: unknown[];
  "x-kitsuden-section"?: string;
}

export interface EspecOpenApi {
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface GenerationOptions {
  /** Base URL set by default in the client. It can be changed when creating it. */
  baseUrl?: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

// ── Names ────────────────────────────────────────────────────────────────────

function palabras(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function camel(parts: string[]): string {
  const [first = "op", ...rest] = parts;
  const base =
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[0-9]/.test(base) ? `op${base}` : base;
}

function pascal(text: string): string {
  const c = camel(palabras(text));
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** `kon-esports` → `esports`; `Datasets` → `datasets`. */
function spaceOf(tag: string | undefined): string {
  if (!tag) return "api";
  return camel(palabras(tag.replace(/^kon-/, "")));
}

/**
 * Is this word the name of the namespace, in singular or plural?
 *
 * Datasets have an `operationId` like `dataset_characters_create` and live in
 * the `datasets` namespace. Comparing only exact equality did not strip the
 * prefix and the method came out as `datasetCharactersCreate` inside `datasets`.
 */
function sameSpace(palabra: string, space: string): boolean {
  const a = palabra.toLowerCase();
  const b = space.toLowerCase();
  return a === b || `${a}s` === b || a === `${b}s`;
}

/**
 * Method name.
 *
 * If the `operationId` is already readable (`reportSet`, set with `describeRoute`),
 * it is used as is: it is the name someone chose thinking of whoever reads it.
 * If it is the generated one (`media_post_folder_folderId_update`), it is
 * converted to camelCase by removing the kon prefix, which is already in the namespace.
 */
function methodName(operationId: string, space: string): string {
  if (/^[a-z][A-Za-z0-9]*$/.test(operationId)) return operationId;
  const parts = palabras(operationId);
  const withoutKon = parts.length > 1 && sameSpace(parts[0], space) ? parts.slice(1) : parts;
  return camel(withoutKon);
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function refName(ref: string): string {
  return pascal(ref.split("/").pop() ?? "Type");
}

function comment(text: string | undefined, indent: string): string {
  if (!text) return "";
  const clean = text.replace(/\*\//g, "* /").trim();
  return `${indent}/** ${clean.split("\n").join(`\n${indent} * `)} */\n`;
}

// ── JSON Schema → TypeScript ────────────────────────────────────────────────

function typeOf(s: JsonSchema | undefined, indent = ""): string {
  if (!s) return "unknown";
  if (s.$ref) return refName(s.$ref);

  let t: string;
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    t = s.enum.map((v) => JSON.stringify(v)).join(" | ");
  } else if (s.anyOf || s.oneOf) {
    t = (s.anyOf ?? s.oneOf)!.map((x) => typeOf(x, indent)).join(" | ");
  } else if (s.allOf) {
    t = s.allOf.map((x) => `(${typeOf(x, indent)})`).join(" & ");
  } else {
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    t =
      types.length > 1
        ? types.map((one) => primitiveType(one, s, indent)).join(" | ")
        : primitiveType(types[0], s, indent);
  }

  return s.nullable ? `${t} | null` : t;
}

function primitiveType(type: string | undefined, s: JsonSchema, indent: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = Array.isArray(s.items) ? undefined : s.items;
      return `Array<${typeOf(item, indent)}>`;
    }
    default: {
      const props = s.properties ?? {};
      if (Object.keys(props).length > 0) {
        const requiredValues = new Set(s.required ?? []);
        const inside = `${indent}  `;
        const fields = Object.entries(props)
          .map(
            ([key, sub]) =>
              `${comment(sub.description, inside)}${inside}${safeKey(key)}${
                requiredValues.has(key) ? "" : "?"
              }: ${typeOf(sub, inside)};`
          )
          .join("\n");
        /**
         * The object is only left open if the schema opens it. Adding `Record<string,
         * unknown>` by default would disable the excess-property check,
         * which is precisely what turns a `tags` into a compile error.
         */
        const open =
          s.additionalProperties === true
            ? " & Record<string, unknown>"
            : typeof s.additionalProperties === "object"
              ? ` & Record<string, ${typeOf(s.additionalProperties, indent)}>`
              : "";
        return `{\n${fields}\n${indent}}${open}`;
      }
      if (typeof s.additionalProperties === "object") {
        return `Record<string, ${typeOf(s.additionalProperties, indent)}>`;
      }
      if (type === "object" || s.additionalProperties === true) return "Record<string, unknown>";
      return "unknown";
    }
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

interface Operation {
  space: string;
  method: string;
  path: string;
  name: string;
  summary?: string;
  description?: string;
  ofRoute: OpenApiParameter[];
  fromQuery: OpenApiParameter[];
  body?: JsonSchema;
  protected: boolean;
  section?: string;
}

function collectOperations(espec: EspecOpenApi): Operation[] {
  const output: Operation[] = [];
  const used = new Map<string, Set<string>>();

  for (const [path, item] of Object.entries(espec.paths ?? {})) {
    for (const method of METHODS) {
      const op = (item as Record<string, OpenApiOperation | undefined>)[method];
      if (!op) continue;

      const space = spaceOf(op.tags?.[0]);
      const idBase =
        op.operationId ?? `${method}_${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`;

      let name = methodName(idBase, space);
      const inSpace = used.get(space) ?? new Set<string>();
      for (let n = 2; inSpace.has(name); n++) name = `${methodName(idBase, space)}${n}`;
      inSpace.add(name);
      used.set(space, inSpace);

      const content = op.requestBody?.content ?? {};
      const body = (content["application/json"] ?? Object.values(content)[0])?.schema;

      output.push({
        space,
        method: method.toUpperCase(),
        path,
        name,
        summary: op.summary,
        description: op.description,
        ofRoute: (op.parameters ?? []).filter((p) => p.in === "path"),
        fromQuery: (op.parameters ?? []).filter((p) => p.in === "query"),
        body,
        protected: Array.isArray(op.security) && op.security.length > 0,
        section: op["x-kitsuden-section"],
      });
    }
  }

  return output;
}

function signatureAndCall(op: Operation): { types: string; signature: string; call: string } {
  const baseType = pascal(`${op.space} ${op.name}`);
  const types: string[] = [];
  const args: string[] = [];

  if (op.ofRoute.length > 0) {
    const fields = op.ofRoute.map((p) => `  ${safeKey(p.name)}: string | number;`).join("\n");
    types.push(`export interface ${baseType}Path {\n${fields}\n}`);
    args.push(`path: ${baseType}Path`);
  }

  if (op.body) {
    types.push(`export type ${baseType}Body = ${typeOf(op.body)};`);
    args.push(`body: ${baseType}Body`);
  }

  if (op.fromQuery.length > 0) {
    const fields = op.fromQuery
      .map(
        (p) =>
          `  ${safeKey(p.name)}${p.required ? "" : "?"}: ${typeOf(p.schema)} | string | number | boolean;`
      )
      .join("\n");
    types.push(`export interface ${baseType}Query {\n${fields}\n}`);
    const required = op.fromQuery.some((p) => p.required);
    args.push(`query${required ? "" : "?"}: ${baseType}Query`);
  }

  const template = op.path.replace(
    /\{([^}]+)\}/g,
    (_m, name: string) => "${encodeURIComponent(String(path[" + JSON.stringify(name) + "]))}"
  );

  const init = [
    op.body ? "body" : "",
    op.fromQuery.length > 0 ? "query: query as Record<string, unknown> | undefined" : "",
  ]
    .filter(Boolean)
    .join(", ");

  return {
    types: types.join("\n\n"),
    signature: `<T = unknown>(${args.join(", ")}): Promise<T>`,
    call: `call<T>(options, ${JSON.stringify(op.method)}, \`${template}\`${init ? `, { ${init} }` : ""})`,
  };
}

// ── File template ────────────────────────────────────────────────────────────

const CORE = `export interface KitsudenClientOptions {
  /** Base URL of the API, ending in \`/api\`. */
  baseUrl?: string;
  /** Agent token (\`kitsuden_agent_*\`). Without it the browser cookies are used. */
  token?: string;
  /** For tests or environments without a global \`fetch\`. */
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
}

/**
 * API error with the response body intact.
 *
 * The message includes the \`didYouMean\` suggestions that Kitsuden returns
 * when a field does not exist, so they can be read without having to open \`body\`.
 */
export class KitsudenApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly method: string,
    readonly path: string
  ) {
    super(errorMessage(status, body, method, path));
    this.name = "KitsudenApiError";
  }
}

function errorMessage(status: number, body: unknown, method: string, path: string): string {
  const b = body as {
    error?: string | { message?: string; details?: { unknownKeys?: { key: string; didYouMean: string | null }[] } };
    message?: string;
  } | null;
  const principal =
    typeof b?.error === "string"
      ? b.error
      : (b?.error?.message ?? b?.message ?? \`HTTP \${status}\`);
  const unknownKeys = typeof b?.error === "object" ? (b.error.details?.unknownKeys ?? []) : [];
  const hints = unknownKeys.map((k) =>
    k.didYouMean ? \`«\${k.key}» → «\${k.didYouMean}»\` : \`«\${k.key}» does not exist\`
  );
  return \`\${method} \${path} → \${status}: \${principal}\${hints.length ? \` (\${hints.join(", ")})\` : ""}\`;
}

async function call<T>(
  options: KitsudenClientOptions,
  method: string,
  path: string,
  init: { query?: Record<string, unknown>; body?: unknown } = {}
): Promise<T> {
  const base = (options.baseUrl ?? DEFAULT_URL).replace(/\\/+$/, "");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const queryText = query.toString();

  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = \`Bearer \${options.token}\`;

  const res = await (options.fetch ?? fetch)(\`\${base}\${path}\${queryText ? \`?\${queryText}\` : ""}\`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: options.credentials ?? "include",
  });

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // It was not JSON: the text is returned as is.
  }

  if (!res.ok) throw new KitsudenApiError(res.status, data, method, path);
  return data as T;
}`;

/**
 * Generates the client from a Kitsuden OpenAPI.
 *
 * Pure function: it receives the spec and returns the code. The command takes care of
 * requesting it from the API and writing the file, so this is tested without a network.
 */
export function generateTypedClient(espec: EspecOpenApi, options: GenerationOptions = {}): string {
  const baseUrl = options.baseUrl ?? "http://localhost:3000/api";
  const operations = collectOperations(espec);

  const components = Object.entries(espec.components?.schemas ?? {})
    .map(([name, schema]) => `export type ${pascal(name)} = ${typeOf(schema)};`)
    .join("\n\n");

  const bySpace = new Map<string, Operation[]>();
  for (const op of operations) {
    const list = bySpace.get(op.space) ?? [];
    list.push(op);
    bySpace.set(op.space, list);
  }

  const typeBlocks: string[] = [];
  const spaces: string[] = [];

  for (const [space, ops] of [...bySpace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const methods: string[] = [];
    for (const op of ops) {
      const { types, signature, call: call } = signatureAndCall(op);
      if (types) typeBlocks.push(types);

      const doc = [
        op.summary ?? `${op.method} ${op.path}`,
        "",
        `\`${op.method} ${op.path}\``,
        op.protected ? "Requires a session or agent token." : "",
        op.section ? `Requires the section «${op.section}» to be enabled (otherwise, 409).` : "",
        op.description ?? "",
      ]
        .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
        .join("\n")
        .trim();

      methods.push(
        `${comment(doc, "    ")}    ${op.name}: ${signature.replace("): Promise<T>", "): Promise<T> =>")} ${call},`
      );
    }
    spaces.push(`    ${safeKey(space)}: {\n${methods.map((m) => `  ${m}`).join("\n")}\n    },`);
  }

  return [
    "// ════════════════════════════════════════════════════════════════════════",
    "// Kitsuden client — GENERATED by `kitsuden generate-sdk`. Do not edit by hand.",
    "// Comes from GET /api/docs/openapi.json: regenerate it if the routes change.",
    "// ════════════════════════════════════════════════════════════════════════",
    "",
    `const DEFAULT_URL = ${JSON.stringify(baseUrl)};`,
    "",
    CORE,
    "",
    "// ── Dataset types ───────────────────────────────────────────────────────",
    "",
    components || "// (no datasets)",
    "",
    "// ── Operation types ─────────────────────────────────────────────────────",
    "",
    typeBlocks.join("\n\n") || "// (no operations with parameters or body)",
    "",
    "// ── Client ──────────────────────────────────────────────────────────────",
    "",
    "/**",
    " * Creates the client.",
    " *",
    " *     const kitsuden = createKitsudenClient({ token: process.env.KITSUDEN_TOKEN });",
    " *     await kitsuden.esports.reportSet({ tournamentId }, { matchId, winnerId });",
    " */",
    "export function createKitsudenClient(options: KitsudenClientOptions = {}) {",
    "  return {",
    spaces.join("\n"),
    "  };",
    "}",
    "",
    "export type KitsudenClient = ReturnType<typeof createKitsudenClient>;",
    "",
  ].join("\n");
}
