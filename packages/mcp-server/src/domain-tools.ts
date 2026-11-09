/**
 * Guide and catalog MCP tools of the standalone server
 * ============================================================================
 *
 * Tools that call the API's ROUTES, not the database: the rules, the
 * authorization and the errors are the API's, and a tool cannot skip them
 * because it has no other door. A kon's own tools come from its
 * `defineOperation`s.
 *
 * `runDomainTool` receives the function that calls the API. On the server it is
 * the HTTP request with the agent's token; in tests, a fake. This way the path
 * that is tested is the one an agent uses.
 */

/** Calls the API. `path` is relative to `/api`. Throws if the response is not 2xx. */
export type ApiCall = (path: string, method?: string, body?: unknown) => Promise<unknown>;

// An alias and not an interface, for the same reason as `ToolResult`: the
// Anthropic SDK types `input_schema` with an index signature.
type InputSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

// An alias and not an interface: the MCP SDK types the result with an index signature,
// and an interface does not have one implicitly.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function slugOf(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Removes `undefined` keys: the API rejects what it does not know, but there is no need to send gaps. */
function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
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

function similar(key: string, valid: string[]): string | null {
  const n = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  let best: string | null = null;
  let smaller = Infinity;
  for (const v of valid) {
    if (n(v) === n(key)) return v;
    const d = distance(n(key), n(v));
    if (d < smaller) {
      smaller = d;
      best = v;
    }
  }
  return smaller <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

/**
 * Arguments are checked the same way the API checks bodies: an
 * argument that does not exist is an error with a suggestion, not a value that
 * gets lost. Many MCP clients do not validate against `inputSchema` before calling.
 */
function validateArguments(def: ToolDefinition, args: Record<string, unknown>): string | null {
  const valid = Object.keys(def.inputSchema.properties);
  const problems: string[] = [];

  for (const key of Object.keys(args)) {
    if (valid.includes(key)) continue;
    const suggestion = similar(key, valid);
    problems.push(`«${key}» does not exist${suggestion ? ` (did you mean «${suggestion}»?)` : ""}`);
  }
  for (const key of def.inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") {
      problems.push(`missing «${key}»`);
    }
  }

  return problems.length
    ? `Invalid arguments for ${def.name}: ${problems.join("; ")}. Valid: ${valid.join(", ")}.`
    : null;
}

// ── Definitions ──────────────────────────────────────────────────────────────

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });

export const DOMAIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "kitsuden_guide",
    description:
      "Guide for agents of this Kitsuden: rules that are often broken, recipes (character tier list, Swiss tournament with check-in) and all the kon routes. Read it before building.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kitsuden_describe_api",
    description:
      "Compact list of the contract's routes: method, path, whether it requires a credential and the body fields (* = required). Filter by kon with `kon` (esports, tierlist, broadcast…).",
    inputSchema: {
      type: "object",
      properties: { kon: string("Kon to list, e.g. `esports`. Without it, all.") },
      additionalProperties: false,
    },
  },
  {
    name: "catalog_create",
    description:
      "Creates a catalog (a dataset): characters, items, cards… It is where a tier list gets its items from. With `withImage` (yes by default) it adds an `image` field of type URL, which is the one the tier list uses as the portrait. Returns `datasetId`.",
    inputSchema: {
      type: "object",
      properties: {
        name: string("Display name, e.g. `Characters`."),
        slug: string("Optional. Derived from the name."),
        description: string("Optional."),
        withImage: {
          type: "boolean",
          description: "Add the `image` field (URL). Defaults to true.",
        },
        fields: {
          type: "array",
          description:
            "Extra fields: `{ name, type, label?, required? }`. Types: text, number, url, select, boolean…",
          items: { type: "object" },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "catalog_add_entries",
    description:
      'Adds entries to a catalog in bulk. Each entry carries `title` (the name shown on the item) and the rest of the catalog\'s fields, e.g. `{ title: "Aria", image: "https://…" }`.',
    inputSchema: {
      type: "object",
      properties: {
        datasetId: string("Id of the catalog (from catalog_create)."),
        entries: {
          type: "array",
          items: { type: "object" },
          description: "Entries with `title` and their fields.",
        },
      },
      required: ["datasetId", "entries"],
      additionalProperties: false,
    },
  },
];

// ── Execution ────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
type Handler = (args: Args, api: ApiCall) => Promise<unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const enc = (v: unknown) => encodeURIComponent(String(v));

const HANDLERS: Record<string, Handler> = {
  async kitsuden_guide(_args, api) {
    return api("/llms.txt");
  },

  async kitsuden_describe_api(args, api) {
    const spec = (await api("/docs/openapi.json")) as {
      paths?: Record<
        string,
        Record<
          string,
          {
            summary?: string;
            tags?: string[];
            security?: Record<string, unknown>[];
            requestBody?: {
              content?: Record<
                string,
                { schema?: { properties?: Record<string, unknown>; required?: string[] } }
              >;
            };
          }
        >
      >;
    };
    const kon = str(args.kon)?.replace(/^kon-/, "");
    const lines: string[] = [];

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item[method];
        if (!op) continue;
        if (kon && !(op.tags ?? []).some((t) => t.replace(/^kon-/, "") === kon)) continue;

        const schema = Object.values(op.requestBody?.content ?? {})[0]?.schema;
        const fields = schema?.properties
          ? Object.keys(schema.properties)
              .map((k) => ((schema.required ?? []).includes(k) ? `${k}*` : k))
              .join(", ")
          : "";
        const asksCredential =
          (op.security ?? []).some((s) => Object.keys(s).length > 0) &&
          !(op.security ?? []).some((s) => Object.keys(s).length === 0);
        const summary =
          op.summary && !op.summary.startsWith(method.toUpperCase()) ? ` — ${op.summary}` : "";

        lines.push(
          `${method.toUpperCase()} /api${path}${summary}${asksCredential ? " [credential]" : ""}${fields ? ` · body: ${fields}` : ""}`
        );
      }
    }
    return lines.length ? lines.join("\n") : `No routes${kon ? ` for «${kon}»` : ""}.`;
  },

  async catalog_create(args, api) {
    const name = String(args.name);
    const extra = (Array.isArray(args.fields) ? args.fields : []) as {
      name: string;
      type?: string;
      label?: string;
      required?: boolean;
    }[];
    const schema = [
      // `url` type and not `image`: an `image` field stores the id of an uploaded
      // media item, and here external URLs are pasted. The tier list accepts both.
      ...(args.withImage === false ? [] : [{ name: "image", type: "url", label: "Image" }]),
      ...extra.map((f) => ({
        name: f.name,
        type: f.type ?? "text",
        label: f.label ?? f.name,
        required: Boolean(f.required),
      })),
    ];
    const row = (await api(
      "/data-sets",
      "POST",
      compact({
        name,
        slug: str(args.slug) ?? slugOf(name),
        description: str(args.description),
        schema,
      })
    )) as { id: string; slug: string };
    return {
      datasetId: row.id,
      slug: row.slug,
      fields: schema.map((f) => f.name),
      next: "catalog_add_entries",
    };
  },

  async catalog_add_entries(args, api) {
    const inputs = (args.entries as Args[]).map(({ title, ...rest }) => ({
      title,
      data: rest,
    }));
    const rows = (await api(`/data-sets/${enc(args.datasetId)}/entries`, "POST", inputs)) as {
      id: string;
      title: string;
    }[];
    return { added: rows.length, entries: rows.map((f) => ({ id: f.id, title: f.title })) };
  },
};

/**
 * Runs a domain tool. Returns `null` if the name is not a
 * domain one, so the server tries the generic ones.
 */
export async function runDomainTool(
  name: string,
  args: Record<string, unknown>,
  api: ApiCall
): Promise<ToolResult | null> {
  const def = DOMAIN_TOOL_DEFINITIONS.find((d) => d.name === name);
  const handler = HANDLERS[name];
  if (!def || !handler) return null;

  const invalid = validateArguments(def, args ?? {});
  if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };

  try {
    const result = await handler(args ?? {}, api);
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    // The API's message already says what is missing —unknown field, switched-off
    // section, round half-done—: it is returned as is, without wrapping it in another.
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}
