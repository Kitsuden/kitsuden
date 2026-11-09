/**
 * Kitsuden — Authorization: Policies & Gates
 * ============================================================================
 *
 * The ERGONOMIC authorization layer that was missing, on top of what you already have
 * (native RLS + agent scopes + roles). It combines the DX of Laravel Policies with
 * the permission model of Django, without sacrificing "secure by default".
 *
 *   - Gate:   global permission not tied to a resource ("access-admin").
 *   - Policy: per-action rules over a resource type ("post": view/update/…).
 *
 * Usage (definition):
 *   definePolicy("post", {
 *     view:   (u, post) => post.published || post.ownerId === u?.id,
 *     update: (u, post) => u?.role === "admin" || post.ownerId === u?.id,
 *   });
 *   defineGate("access-admin", (u) => u?.role === "admin");
 *
 * Usage (check):
 *   if (!can(user, "update", post, "post")) throw AppError.forbidden();
 *   authorize(user, "update", post, "post");            // throws if not allowed
 *   app.patch("/posts/:id", requirePolicy("update", loadPost, "post"), h);
 *
 * DENY-BY-DEFAULT: if there is no policy/gate for the action, it is DENIED. Secure by
 * default — never "allow if not defined".
 */

import { concedeScope, denialThatCovers } from "@kitsuden/shared";
import type { Context, MiddlewareHandler } from "hono";

import { AppError } from "./errors";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthzUser {
  id?: string;
  role?: string;
  scopes?: string[];
  [key: string]: unknown;
}

/** A rule receives the user and (for policies) the resource. Returns boolean. */
export type PolicyRule<R = unknown> = (
  user: AuthzUser | null,
  resource: R
) => boolean | Promise<boolean>;

export type GateRule = (user: AuthzUser | null) => boolean | Promise<boolean>;

// ── Global registries ─────────────────────────────────────────────────────────

const policies = new Map<string, Map<string, PolicyRule>>();
const gates = new Map<string, GateRule>();

/** Defines (or extends) the policy of a resource type. */
export function definePolicy<R = unknown>(
  resourceType: string,
  rules: Record<string, PolicyRule<R>>
): void {
  const existing = policies.get(resourceType) ?? new Map<string, PolicyRule>();
  for (const [action, rule] of Object.entries(rules)) {
    existing.set(action, rule as PolicyRule);
  }
  policies.set(resourceType, existing);
}

/** Defines a global gate (permission not tied to a resource). */
export function defineGate(name: string, rule: GateRule): void {
  gates.set(name, rule);
}

/**
 * Does any agent scope grant the `required` permission?
 *
 * Same rules as the API's `hasScope` (`apps/api/src/services/agent-auth`),
 * written here because the engine cannot import from the app. A test
 * compares the two over the same table of cases so they do not drift apart.
 *
 *   · `admin:*` or `admin`  → everything
 *   · exact                 → `esports:manage` grants `esports:manage`
 *   · `resource:*`          → `esports:*` grants any esports action
 *   · `*:action`            → `*:view` grants viewing any resource
 */
export function scopeConcede(scopes: readonly string[] | undefined, required: string): boolean {
  // A single rule for all of Kitsuden (wildcards and `!pattern` denials):
  // @kitsuden/shared, agent-permission.ts.
  return concedeScope(scopes, required);
}

function grantedByScope(user: AuthzUser | null, required: string): boolean {
  return Array.isArray(user?.scopes) && scopeConcede(user!.scopes, required);
}

/** Clears the registries (for tests). */
export function resetAuthz(): void {
  policies.clear();
  gates.clear();
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Can `user` run `action` on `resource` (of type `resourceType`)?
 * If `resourceType`/`resource` are omitted, it evaluates a GATE named `action`.
 * Deny-by-default.
 */
export async function can(
  user: AuthzUser | null,
  action: string,
  resource?: unknown,
  resourceType?: string
): Promise<boolean> {
  /**
   * ── AN AGENT'S SCOPES EXTEND, THEY DO NOT INVENT ──────────────────────────
   *
   * An agent authenticates with `Bearer kitsuden_agent_*` and arrives here with
   * `role: "agent"` and its `scopes`. The kons' rules ask about ROLE
   * (`admin`, `editor`), so an agent passed none of them: with its token
   * it could read, but not generate a bracket or report a set. Kitsuden was
   * sold as "AI-native" and an agent could not operate its own domain.
   *
   * Now a scope grants the `resource:action` action (`esports:manage`,
   * `tierlist:*`) but ONLY if the policy defines that action. Without a rule it is still
   * deny: an `admin:*` cannot open an action nobody wrote.
   *
   * Humans carry no `scopes`, so nothing changes for them.
   */
  /**
   * An agent's DENIAL beats the rule: a
   * policy that recognizes the agent as the kon's admin (`isEffectiveAdmin`, via
   * `crm:*`) cannot open what the key denies (`!crm:delete`). Same as in
   * the SDK operations. Humans carry no scopes: nothing changes.
   */
  if (Array.isArray(user?.scopes)) {
    const request = resourceType === undefined ? `gate:${action}` : `${resourceType}:${action}`;
    if (denialThatCovers(user!.scopes, [request])) return false;
  }
  // Gate global.
  if (resourceType === undefined) {
    const gate = gates.get(action);
    if (!gate) return false; // not defined → deny
    if (await gate(user)) return true;
    return grantedByScope(user, `gate:${action}`);
  }
  // Resource policy.
  const policy = policies.get(resourceType);
  const rule = policy?.get(action);
  if (!rule) return false; // not defined → deny
  if (await rule(user, resource)) return true;
  return grantedByScope(user, `${resourceType}:${action}`);
}

/** Same as `can` but throws AppError.forbidden if not allowed. */
export async function authorize(
  user: AuthzUser | null,
  action: string,
  resource?: unknown,
  resourceType?: string
): Promise<void> {
  const allowed = await can(user, action, resource, resourceType);
  if (!allowed) {
    // 401 if there is not even a user; 403 if there is a user but without permission.
    if (!user) throw AppError.unauthenticated();
    throw AppError.forbidden(
      `Not authorized for '${action}'${resourceType ? ` on ${resourceType}` : ""}`
    );
  }
}

/** Introspection: available actions and their result for a user/resource. */
export async function policyMap(
  user: AuthzUser | null,
  resourceType: string,
  resource?: unknown
): Promise<Record<string, boolean>> {
  const policy = policies.get(resourceType);
  if (!policy) return {};
  const out: Record<string, boolean> = {};
  for (const action of policy.keys()) {
    out[action] = await can(user, action, resource, resourceType);
  }
  return out;
}

// ── Middlewares Hono ──────────────────────────────────────────────────────────

/** Requires a global gate. */
export function requireGate(name: string): MiddlewareHandler {
  return async (c, next) => {
    const user = (c.get("user") ?? null) as AuthzUser | null;
    await authorize(user, name);
    await next();
  };
}

/**
 * Requires a resource policy. `loadResource` obtains the resource from the
 * context (e.g. by :id); if it returns null → 404.
 */
export function requirePolicy<R>(
  action: string,
  loadResource: (c: Context) => Promise<R | null> | R | null,
  resourceType: string
): MiddlewareHandler {
  return async (c, next) => {
    const user = (c.get("user") ?? null) as AuthzUser | null;
    const resource = await loadResource(c);
    if (resource === null || resource === undefined) {
      throw AppError.notFound(`${resourceType} not found`);
    }
    await authorize(user, action, resource, resourceType);
    // Leaves the already-loaded resource available to the handler (avoids a double fetch).
    c.set("resource" as never, resource as never);
    await next();
  };
}
