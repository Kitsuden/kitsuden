/**
 * Code samples and badges for each operation in the OpenAPI document
 * ============================================================================
 *
 * `x-codeSamples`: the call with the generated clients (TypeScript `@kitsuden/sdk`,
 * Python `kitsuden`), shown by Scalar and RapiDoc next to the curl they build. The
 * names follow the SAME rules as `scripts/sdk/generate.mjs` (words → camelCase /
 * snake_case): tests/unit/code-samples.test.ts checks every sample against the
 * committed clients, so a rename in one place fails there instead of documenting a
 * method that does not exist.
 *
 * `x-badges`: what a reader should see before calling (public, sensitive, a stream,
 * not an MCP tool). Each badge carries `name` (Scalar) and `label` (RapiDoc).
 */

export type JsonSchema = Record<string, unknown>;

// ── Names: a copy of scripts/sdk/generate.mjs (section 2) ────────────────────

const words = (s: string) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export const camel = (s: string) => {
  const r = words(s)
    .map((x, i) => (i === 0 ? x : x[0].toUpperCase() + x.slice(1)))
    .join("");
  return /^[0-9]/.test(r) ? `_${r}` : r;
};

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " "
  )
);

export const pyIdent = (s: string) => {
  const r = words(s).join("_");
  const n = (/^[0-9]/.test(r) ? `_${r}` : r) || "_";
  return PY_KEYWORDS.has(n) ? `${n}_` : n;
};

// ── Samples ──────────────────────────────────────────────────────────────────

export interface CodeSample {
  lang: "typescript" | "python";
  label: string;
  source: string;
}

interface SampleArg {
  name: string;
  value: unknown;
}

/** A readable stand-in for a value of this schema: `"<id>"`, `1`, `true`. */
function example(name: string, schema: JsonSchema | undefined): unknown {
  if (!schema) return `<${name}>`;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  return `<${name}>`;
}

/** The required fields of a JSON body, each with its stand-in value. */
function bodyExample(schema: JsonSchema | undefined): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  return Object.fromEntries(required.map((k) => [k, example(k, props[k])]));
}

const isTsIdent = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

/** A TypeScript literal: `{ title: "<title>" }`, `["a"]`, `1`. */
function tsValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `[${v.map(tsValue).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return "{}";
    const inner = entries.map(([k, x]) => `${isTsIdent(k) ? k : JSON.stringify(k)}: ${tsValue(x)}`);
    return `{ ${inner.join(", ")} }`;
  }
  return JSON.stringify(v);
}

function pyValue(v: unknown): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (Array.isArray(v)) return `[${v.map(pyValue).join(", ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${pyValue(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The call of one operation with both clients. `args` are the path parameters and
 * the REQUIRED query parameters (the optional ones are in the client's types);
 * `body` the JSON body's required fields, or `"multipart"` for an upload.
 */
export function codeSamples(input: {
  konId: string;
  operationId: string;
  args: { name: string; schema?: JsonSchema }[];
  body?: JsonSchema | "multipart" | null;
}): CodeSample[] {
  const kon = input.konId.replace(/^kon-/, "");
  const args: SampleArg[] = input.args.map((a) => ({
    name: a.name,
    value: example(a.name, a.schema),
  }));
  const body =
    input.body === "multipart" ? "multipart" : input.body ? bodyExample(input.body) : null;

  const tsArgs = args.map(
    (a) => `${isTsIdent(a.name) ? a.name : JSON.stringify(a.name)}: ${tsValue(a.value)}`
  );
  if (body === "multipart") tsArgs.push("body: form /* FormData */");
  else if (body) tsArgs.push(`body: ${tsValue(body)}`);
  const tsCall = `kitsuden.${camel(kon)}.${camel(input.operationId)}(${tsArgs.length ? `{ ${tsArgs.join(", ")} }` : ""})`;

  const pyArgs = args.map((a) => `${pyIdent(a.name)}=${pyValue(a.value)}`);
  if (body === "multipart") pyArgs.push("body=files");
  else if (body) pyArgs.push(`body=${pyValue(body)}`);
  const pyCall = `kitsuden.${pyIdent(kon)}.${pyIdent(input.operationId)}(${pyArgs.join(", ")})`;

  return [
    {
      lang: "typescript",
      label: "@kitsuden/sdk",
      source: [
        `import { createKitsuden } from "@kitsuden/sdk";`,
        ``,
        `const kitsuden = createKitsuden(); // KITSUDEN_API_URL, KITSUDEN_API_TOKEN`,
        `const res = await ${tsCall};`,
        `if (res.kind === "ok") console.log(res.data);`,
      ].join("\n"),
    },
    {
      lang: "python",
      label: "kitsuden (Python)",
      source: [
        `from kitsuden import KitsudenApi`,
        ``,
        `kitsuden = KitsudenApi()  # KITSUDEN_API_URL, KITSUDEN_API_TOKEN`,
        `res = ${pyCall}`,
        `if res.ok:`,
        `    print(res.data)`,
      ].join("\n"),
    },
  ];
}

// ── Badges ───────────────────────────────────────────────────────────────────

export interface Badge {
  name: string;
  label: string;
  color: string;
}

const badge = (text: string, color: string): Badge => ({ name: text, label: text, color });

/** What to know before calling, as badges. Empty for an ordinary operation. */
export function operationBadges(op: {
  access: string;
  sensitive: boolean;
  stream: boolean;
  mcpExcluded: boolean;
}): Badge[] {
  const out: Badge[] = [];
  if (op.access === "public") out.push(badge("Public", "#2563eb"));
  if (op.sensitive) out.push(badge("Sensitive", "#b45309"));
  if (op.stream) out.push(badge("Stream (SSE)", "#7c3aed"));
  if (op.mcpExcluded) out.push(badge("Not an MCP tool", "#6b7280"));
  return out;
}
