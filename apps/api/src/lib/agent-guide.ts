/**
 * Agent guide — what is served at `GET /llms.txt`
 * ============================================================================
 *
 * For a product built for people who build with agents, this IS the
 * documentation: it is the first thing an agent reads. Two parts:
 *
 *   1. The rules an agent tends to break, with the error it will see if it
 *      breaks them. Static on purpose: they say WHY, and that cannot be deduced
 *      from a schema.
 *   2. The kon routes, generated from the mounted router. They cannot fall
 *      behind the API because they come from it.
 *
 * A kon's own rules belong to that kon's description of its operations.
 */

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
    : "- **Full contract:** this installation does not publish it (`ENABLE_SWAGGER=false`). The routes are below and, over MCP, `tools/list` gives each tool with its schema."
}
- **Credential:** \`Authorization: Bearer kitsuden_agent_…\`, an agent token
  created in the admin panel (Agents) with the scopes it needs.
- **MCP:** \`POST ${baseUrl}/mcp\`; \`tools/list\` gives each tool with its schema.
- **SDK:** \`kitsuden generate-sdk\` writes a typed client.`;
}

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

function routes(list: KonRoute[] | undefined): string {
  if (list === undefined) {
    return "## Kon routes\n\nThey are generated when serving `GET /llms.txt` from the running API: they come from the mounted router, \nso they depend on which kons each installation has turned on.";
  }
  if (list.length === 0) {
    return "## Kon routes\n\n(No kon mounted in this installation.)";
  }

  const byKon = new Map<string, KonRoute[]>();
  for (const r of list) {
    if (r.path.includes("*")) continue;
    const group = byKon.get(r.konId) ?? [];
    group.push(r);
    byKon.set(r.konId, group);
  }

  const blocks = [...byKon.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([konId, group]) => {
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
    });

  return `## Kon routes\n\nGenerated from the mounted router.\n\n${blocks.join("\n\n")}`;
}

export function generateAgentGuide(options: {
  baseUrl: string;
  routes?: KonRoute[];
  /** Is `/api/docs/openapi.json` served? (`ENABLE_SWAGGER`). Yes by default. */
  publishedContract?: boolean;
}): string {
  return [
    header(options.baseUrl, options.publishedContract ?? true),
    RULES,
    routes(options.routes),
    "",
  ].join("\n\n");
}
