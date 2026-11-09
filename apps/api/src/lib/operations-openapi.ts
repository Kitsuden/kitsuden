/**
 * Kons SDK → OpenAPI 3.1 and MCP tools (pure: no database, no app)
 * ============================================================================
 *
 * From ONE operation declaration (`KonOperation`, in @kitsuden/shared)
 * both agent surfaces come out with the same schemas:
 *
 *   openApiOperation()   the OpenAPI 3.1 operation (real JSON Schema from zod,
 *                        success and error responses, security, and the
 *                        `x-kitsuden-operation` extension with scope, sensitive,
 *                        idempotent and the MCP tool);
 *   mcpTool()     the MCP tool (`inputSchema`, `annotations`),
 *                        or `null` if the operation is excluded with a reason;
 *   requestFromArguments()  that tool's arguments → the HTTP request
 *                        that executes the operation (used by MCP).
 *
 * No dependencies on the database or on startup, so that the coverage test
 * (`apps/api/scripts/operations-coverage.ts`) can generate and VALIDATE the
 * document without mounting anything.
 */

import {
  MCP_BODY_ARGUMENT,
  MCP_IDEMPOTENCY_ARGUMENT,
  KITSUDEN_ERRORS,
  shortGuide,
  operationErrors,
  isIdempotent,
  isRedirect,
  isSensitive,
  isReadOnly,
  exclusionMcp,
  toolName,
  operationIdOf,
  operationFineScope,
  scopesThatGrant,
  type KonOperation,
} from "@kitsuden/shared";
import { z, type ZodTypeAny } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance boundary: each operation brings its own schemas
type Operation = KonOperation<any, any, any>;

export type JsonSchema = Record<string, unknown>;

/**
 * zod → INLINE JSON Schema, in the OpenAPI 3.1 dialect (JSON Schema
 * 2020-12, the one `z.toJSONSchema` emits by default: no `nullable`).
 *
 * - `io: "input"`: what the client SENDS. A field with `.default()` is not
 *   required, and a `.transform()` is described by what it receives.
 * - `unrepresentable: "any"`: a type with no equivalent (a date, a loose
 *   transform) is left open instead of taking down the whole OpenAPI.
 * - Dates travel as ISO text: `format: date-time`.
 *
 * Only recursive schemas leave `$defs` (with their `$ref` inside).
 */
export function jsonSchema(schema: ZodTypeAny | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  const converted = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if ((zodSchema as { _zod?: { def?: { type?: string } } })._zod?.def?.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }
    },
  }) as JsonSchema;
  const { $schema: _s, ...rest } = converted;
  return rest;
}

function isOptional(schema: ZodTypeAny | undefined): boolean {
  return !!schema && schema.safeParse(undefined).success;
}

/** `/pages/:id` → `/pages/{id}` */
export function openApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function join(mountPath: string, route: string): string {
  const base = mountPath.replace(/\/+$/, "");
  return route === "/" ? base || "/" : `${base}${route}`;
}

function parameterNames(route: string): string[] {
  return [...route.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
}

/**
 * How a request authenticates, for every OpenAPI document the API serves
 * (`/api/openapi.json`, `/api/docs`, the SDK spec): one definition, so they cannot
 * drift again. The cookie is the one better-auth sets (`__Secure-` prefixed over
 * HTTPS) and the one `middleware/write-origin.ts` looks for. Bearer tokens are
 * opaque, not JWTs: agent keys and OAuth access tokens for MCP.
 */
export const SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    description:
      "Agent key (`Authorization: Bearer kitsuden_agent_*`) or an OAuth access token issued for MCP. Opaque, not a JWT.",
  },
  cookieAuth: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description:
      "Session cookie of the panel and the sites, set by sign-in. Over HTTPS its name has the `__Secure-` prefix.",
  },
} as const;

/** The common components that operations reference. */
export function commonComponents(): {
  schemas: Record<string, JsonSchema>;
  securitySchemes: Record<string, JsonSchema>;
} {
  return {
    schemas: {
      Problem: {
        type: "object",
        description:
          "RFC 9457 problem details (application/problem+json). `code` is stable: branch on it. See docs/install/errors-and-retries.md.",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
          instance: { type: "string" },
          code: { type: "string", enum: Object.keys(KITSUDEN_ERRORS) },
          retryable: { type: "boolean" },
          retry_after: { type: ["integer", "null"] },
          hint: { type: "string" },
          docs: { type: "string" },
          requestId: { type: ["string", "null"] },
          error: { description: "What the route used to send (text or {code, message, details})." },
        },
        required: [
          "type",
          "title",
          "status",
          "detail",
          "code",
          "retryable",
          "retry_after",
          "hint",
          "docs",
        ],
      },
    },
    securitySchemes: structuredClone(SECURITY_SCHEMES) as unknown as Record<string, JsonSchema>,
  };
}

export interface OpenApiOperation {
  /** Without `/api` (the server URL carries it) and with `{param}`. */
  path: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  operation: JsonSchema;
}

/** The OpenAPI 3.1 operation of a declaration. */
export function openApiOperation(
  konId: string,
  mountPath: string,
  op: Operation
): OpenApiOperation {
  const fullPath = join(mountPath, op.route);
  const path = openApiPath(fullPath.replace(/^\/api(?=\/|$)/, "")) || "/";

  const parameters: JsonSchema[] = [];
  const params = jsonSchema(op.input?.params) as
    { properties?: Record<string, JsonSchema> } | undefined;
  for (const name of parameterNames(op.route)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: params?.properties?.[name] ?? { type: "string" },
    });
  }
  const query = jsonSchema(op.input?.query) as
    { properties?: Record<string, JsonSchema>; required?: string[] } | undefined;
  for (const [name, schema] of Object.entries(query?.properties ?? {})) {
    parameters.push({
      name,
      in: "query",
      required: query?.required?.includes(name) ?? false,
      schema,
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    });
  }
  const idempotent = isIdempotent(op);
  if (op.method !== "GET") {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description: idempotent
        ? "Optional. Repeating this operation already leaves the same state."
        : "Recommended for retries: the same key and body replay the first response instead of running twice.",
      schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" },
    });
  }

  const operation: JsonSchema = {
    operationId: operationIdOf(konId, op.id),
    summary: op.summary,
    description: op.description,
    tags: [konId, ...(op.tags ?? [])],
  };
  if (parameters.length > 0) operation.parameters = parameters;

  if (op.input?.body) {
    const type = op.input.format === "multipart" ? "multipart/form-data" : "application/json";
    operation.requestBody = {
      required: !isOptional(op.input.body),
      content: { [type]: { schema: jsonSchema(op.input.body) } },
    };
  }

  // ── Responses ──
  const responses: Record<string, JsonSchema> = {};
  const status = String(op.output.status ?? 200);
  const outputType = op.output.type ?? "application/json";
  if (op.output.flow && op.output.schema) {
    // A flow (plan C5): standard Server-Sent Events. The schema of
    // EACH event goes in `x-kitsuden-event-schema` (OpenAPI 3.1 has no
    // `itemSchema`, which arrives in 3.2); the SDK generator reads it from there.
    responses["200"] = {
      description:
        op.output.description ??
        "Server-Sent Events: one `data:` event per item (JSON, see x-kitsuden-event-schema), then `event: end`; on failure `event: error` with a problem+json.",
      content: {
        "text/event-stream": {
          schema: { type: "string", contentMediaType: "text/event-stream" },
          "x-kitsuden-event-schema": jsonSchema(op.output.schema),
        },
      },
    };
  } else if (status === "204") {
    responses[status] = { description: op.output.description ?? "No content" };
  } else if (!isRedirect(op.output.status)) {
    const content: JsonSchema = op.output.schema
      ? { schema: jsonSchema(op.output.schema) }
      : { schema: { type: "string", contentMediaType: outputType } };
    responses[status] = {
      description: op.output.description ?? "OK",
      content: { [outputType]: content },
    };
    // Same body, another success status (an upsert: 201 on create, 200 on rewrite).
    for (const other of op.output.otherStatuses ?? []) {
      if (isRedirect(other)) continue;
      responses[String(other)] = {
        description: op.output.description ?? "OK",
        content: { [outputType]: content },
      };
    }
  }
  // Redirects: no body and with their `Location`. They are not errors, so they do not
  // carry a catalog code.
  for (const r of [op.output.status, ...(op.output.otherStatuses ?? [])]) {
    if (!isRedirect(r)) continue;
    responses[String(r)] = {
      description: op.output.description ?? "Redirect",
      headers: { Location: { required: true, schema: { type: "string" } } },
    };
  }
  const errors = operationErrors(op);
  for (const code of errors) {
    const input = KITSUDEN_ERRORS[code];
    const key = String(input.status);
    const prior = responses[key];
    const line = `\`${code}\`: ${input.title}`;
    responses[key] = prior
      ? { ...prior, description: `${String(prior.description)}; ${line}` }
      : {
          description: line,
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
          },
        };
  }
  operation.responses = responses;

  // Mandatory credential: `session`, or a permission that is checked before
  // the handler. Optional: `optional`, or a permission that depends on the resource
  // (a public dataset is read without a session).
  const requires = op.access === "session" || (op.permission && !op.permission.policy?.inHandler);
  operation.security = requires
    ? [{ bearerAuth: [] }, { cookieAuth: [] }]
    : op.access === "optional" || op.permission
      ? [{}, { bearerAuth: [] }, { cookieAuth: [] }]
      : [];

  const exclusion = exclusionMcp(op);
  operation["x-kitsuden-operation"] = {
    kon: konId,
    id: op.id,
    access: op.access,
    scope: operationFineScope(konId, op.id),
    grantedBy: op.permission ? scopesThatGrant(konId, op) : [],
    ...(op.permission?.policy
      ? { policy: `${op.permission.policy.resource}:${op.permission.policy.action}` }
      : {}),
    ...(op.permission?.roles ? { roles: op.permission.roles } : {}),
    sensitive: isSensitive(op),
    readOnly: isReadOnly(op),
    idempotent,
    ...(op.input?.validatesHandler ? { bodyValidatedBy: "handler (400 Validation failed)" } : {}),
    errors,
    ...(op.output.flow ? { stream: true } : {}),
    mcp: exclusion === null ? { tool: toolName(konId, op) } : { excluded: exclusion },
  };
  if (op.guide) operation["x-kitsuden-guide"] = op.guide;

  return {
    path,
    method: op.method.toLowerCase() as OpenApiOperation["method"],
    operation,
  };
}

// ── MCP ─────────────────────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** Extra argument of non-idempotent tools. */
export const ARG_IDEMPOTENCY = MCP_IDEMPOTENCY_ARGUMENT;
/** The body goes under this key (params and query, flat alongside). */
export const ARG_BODY = MCP_BODY_ARGUMENT;

/** The MCP resource with the full guide of a tool. */
export function guideUri(tool: string): string {
  return `kitsuden://guide/${tool}`;
}

/**
 * The MCP tool of an operation, or `null` if it is excluded.
 *
 * Shape of the arguments: the path and query parameters, FLAT;
 * the body, whole under `body`. This way there are no name clashes (an `id` in the
 * path and an `id` in the body are different things) and the `body` schema is
 * exactly the REST body's.
 */
export function mcpTool(konId: string, mountPath: string, op: Operation): McpTool | null {
  if (exclusionMcp(op) !== null) return null;

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const params = jsonSchema(op.input?.params) as
    { properties?: Record<string, JsonSchema> } | undefined;
  for (const name of parameterNames(op.route)) {
    properties[name] = params?.properties?.[name] ?? { type: "string" };
    required.push(name);
  }
  const query = jsonSchema(op.input?.query) as
    { properties?: Record<string, JsonSchema>; required?: string[] } | undefined;
  for (const [name, schema] of Object.entries(query?.properties ?? {})) {
    if (name in properties) {
      throw new Error(`${konId}/${op.id}: '${name}' is in both the path and the query`);
    }
    properties[name] = schema;
    if (query?.required?.includes(name)) required.push(name);
  }
  if (op.input?.body) {
    if (ARG_BODY in properties) throw new Error(`${konId}/${op.id}: 'body' cannot be a parameter`);
    properties[ARG_BODY] = jsonSchema(op.input.body)!;
    if (!isOptional(op.input.body)) required.push(ARG_BODY);
  }
  const idempotent = isIdempotent(op);
  if (!idempotent) {
    properties[ARG_IDEMPOTENCY] = {
      type: "string",
      minLength: 8,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_.:-]+$",
      description:
        "Optional. Send the same key when retrying this call: it runs once and the retry gets the first result.",
    };
  }

  const sensitive = isSensitive(op);
  const route = join(mountPath, op.route);
  const notes = [
    `REST: ${op.method} ${route}.`,
    op.permission
      ? `Needs one of: ${scopesThatGrant(konId, op).join(", ")}${
          op.permission.policy
            ? ` (or the kon policy ${op.permission.policy.resource}:${op.permission.policy.action})`
            : ""
        }.`
      : op.access === "session"
        ? "Needs an authenticated agent."
        : "Public.",
    sensitive ? "Sensitive: may require human approval in the future." : null,
    idempotent
      ? "Idempotent: safe to retry."
      : `Not idempotent: pass ${ARG_IDEMPOTENCY} to retry safely.`,
  ].filter(Boolean);

  const name = toolName(konId, op);
  const guide = shortGuide(op);
  return {
    name,
    title: op.summary,
    description: [
      op.description,
      guide
        ? guide.replace("read the guide resource", `read the resource ${guideUri(name)}`)
        : null,
      notes.join(" "),
    ]
      .filter(Boolean)
      .join("\n\n"),
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      title: op.summary,
      readOnlyHint: isReadOnly(op),
      destructiveHint: op.method === "DELETE" || sensitive,
      idempotentHint: idempotent,
      openWorldHint: false,
    },
  };
}

export interface InternalRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

/**
 * A tool's arguments → the HTTP request of its operation.
 * Throws (with a message for the model) if a path parameter is missing.
 */
export function requestFromArguments(
  mountPath: string,
  op: Operation,
  args: Record<string, unknown>
): InternalRequest {
  let route = join(mountPath, op.route);
  for (const name of parameterNames(op.route)) {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing argument '${name}' (path parameter)`);
    }
    // `encodeURIComponent` leaves `.` and `..` alone, and the URL then resolves
    // them: `id: ".."` would send the call to another route than the tool's
    // (security review 2026-11-03).
    const text = String(value);
    if (text === "." || text === "..") {
      throw new Error(`Invalid argument '${name}' (path parameter): '${text}'`);
    }
    route = route.replace(`:${name}`, encodeURIComponent(text));
  }

  const query = new URLSearchParams();
  const propsQuery = Object.keys(
    ((jsonSchema(op.input?.query) as { properties?: Record<string, unknown> } | undefined)
      ?.properties ?? {}) as Record<string, unknown>
  );
  for (const name of propsQuery) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    query.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }

  const headers: Record<string, string> = {};
  const init: InternalRequest["init"] = { method: op.method, headers };
  if (op.input?.body && args[ARG_BODY] !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(args[ARG_BODY]);
  }
  const key = args[ARG_IDEMPOTENCY];
  if (typeof key === "string" && key) headers["idempotency-key"] = key;

  const qs = query.toString();
  return { url: `http://kitsuden.internal${route}${qs ? `?${qs}` : ""}`, init };
}
