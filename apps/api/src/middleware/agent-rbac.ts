/**
 * @file agent-rbac.ts
 * @description RBAC (Role-Based Access Control) middleware for NHI Agents
 *
 * Implements granular scope-based access control.
 * Scopes use the "action:resource" format with wildcard support.
 *
 * Scope examples:
 * - "read:database" - Read permission on the database
 * - "write:files" - Write permission on files
 * - "mcp:connect" - MCP connection allowed
 * - "read:*" - Read permission on all resources
 *
 * @author Kitsuden Security Team
 * @version 1.0.0
 */

import type { MiddlewareHandler, Context, Next } from "hono";

import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import type { AgentAuthContext } from "@/services/agent-auth";
import { hasScope, hasAllScopes, hasAnyScope } from "@/services/agent-auth";

/**
 * Configuration options for the RBAC middleware
 */
export interface RBACOptions {
  /** Scopes required to access the resource */
  scopes: string[];
  /**
   * Verification mode:
   * - "all": Requires ALL scopes (AND)
   * - "any": Requires AT LEAST ONE (OR)
   * @default "all"
   */
  requireAll?: boolean;
  /**
   * Descriptive action for error messages
   * @example "modify user records"
   */
  action?: string;
  /**
   * Protected resource for error messages
   * @example "database"
   */
  resource?: string;
}

/**
 * Error codes specific to RBAC
 */
export enum RBACErrorCode {
  AGENT_NOT_AUTHENTICATED = "AGENT_NOT_AUTHENTICATED",
  INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",
  SCOPE_MISSING = "SCOPE_MISSING",
  FORBIDDEN = "FORBIDDEN",
}

/**
 * RBAC error response structure
 */
export interface RBACErrorResponse {
  error: string;
  code: RBACErrorCode;
  message: string;
  requiredScopes: string[];
  grantedScopes: string[];
  resource?: string;
  action?: string;
  timestamp: string;
  requestId: string;
}

/**
 * Type for the RBAC context stored in Hono variables
 */
interface RBACContext {
  checkedScopes: string[];
  requireAll: boolean;
  timestamp: string;
}

/**
 * Middleware factory: Requires specific scopes
 *
 * @example
 * ```typescript
 * // Requires all the scopes
 * app.post("/api/database/query",
 *   requireAgentAuth(),
 *   requireScopes({ scopes: ["read:database", "write:database"] }),
 *   handler
 * );
 *
 * // Requires at least one
 * app.get("/api/files",
 *   requireAgentAuth(),
 *   requireScopes({ scopes: ["read:files", "admin:*"], requireAll: false }),
 *   handler
 * );
 * ```
 */
export function requireScopes(options: RBACOptions): MiddlewareHandler {
  const { scopes, requireAll = true, action, resource } = options;

  return async (c: Context, next: Next) => {
    const requestId = c.get("requestId") || crypto.randomUUID();
    const agent: AgentAuthContext | undefined = c.get("agent");

    // 1. Verify that the agent is authenticated
    if (!agent) {
      const error: RBACErrorResponse = {
        error: "Unauthorized",
        code: RBACErrorCode.AGENT_NOT_AUTHENTICATED,
        message: "Agent authentication required for this resource",
        requiredScopes: scopes,
        grantedScopes: [],
        resource,
        action,
        timestamp: new Date().toISOString(),
        requestId,
      };

      logger.warn(
        {
          path: c.req.path,
          method: c.req.method,
          requestId,
          code: RBACErrorCode.AGENT_NOT_AUTHENTICATED,
        },
        "RBAC: Agent not authenticated"
      );

      return c.json(error, 401);
    }

    // 2. Verify scopes
    const hasPermission = requireAll ? hasAllScopes(agent, scopes) : hasAnyScope(agent, scopes);

    if (!hasPermission) {
      const error: RBACErrorResponse = {
        error: "Forbidden",
        code: RBACErrorCode.INSUFFICIENT_PERMISSIONS,
        message: buildErrorMessage(action, resource, scopes, agent.scopes),
        requiredScopes: scopes,
        grantedScopes: agent.scopes,
        resource,
        action,
        timestamp: new Date().toISOString(),
        requestId,
      };

      logger.warn(
        {
          agentId: agent.agentId,
          agentName: agent.agentName,
          path: c.req.path,
          method: c.req.method,
          required: scopes,
          granted: agent.scopes,
          requireAll,
          requestId,
          code: RBACErrorCode.INSUFFICIENT_PERMISSIONS,
        },
        "RBAC: Permission denied"
      );

      // Security headers for debugging
      c.header("X-RBAC-Required", scopes.join(","));
      c.header("X-RBAC-Mode", requireAll ? "all" : "any");

      return c.json(error, 403);
    }

    // 3. Add metadata to the context for later use
    c.set("rbac", {
      checkedScopes: scopes,
      requireAll,
      timestamp: new Date().toISOString(),
    });

    logger.debug(
      {
        agentId: agent.agentId,
        path: c.req.path,
        scopes,
        requestId,
      },
      "RBAC: Permission granted"
    );

    await next();
  };
}

/**
 * Middleware factory: Requires a specific scope
 * Simplified version for a single scope
 *
 * @example
 * ```typescript
 * app.get("/api/data", requireScope("read:database"), handler);
 * ```
 */
export function requireScope(scope: string, action?: string, resource?: string): MiddlewareHandler {
  return requireScopes({ scopes: [scope], requireAll: true, action, resource });
}

/**
 * Middleware factory: Allows access if it has any of the scopes
 *
 * @example
 * ```typescript
 * app.get("/api/public", requireAnyScope(["read:public", "admin:*"]), handler);
 * ```
 */
export function requireAnyScope(
  scopes: string[],
  action?: string,
  resource?: string
): MiddlewareHandler {
  return requireScopes({ scopes, requireAll: false, action, resource });
}

/**
 * Middleware: Administrators only (special scope admin:*)
 *
 * @example
 * ```typescript
 * app.delete("/api/agents/:id", requireAdmin, handler);
 * ```
 */
export const requireAdmin: MiddlewareHandler = requireScope("admin:*", "administer", "system");

/**
 * Combined middleware: Authentication + RBAC in a single step
 * Useful for routes that always require both
 *
 * @example
 * ```typescript
 * app.post("/api/mcp/invoke",
 *   agentAuthWithRBAC({ scopes: ["mcp:invoke"] }),
 *   handler
 * );
 * ```
 */
export interface AgentAuthWithRBACOptions extends RBACOptions {
  /** If true, authentication is not required (optional) */
  optional?: boolean;
}

export function agentAuthWithRBAC(options: AgentAuthWithRBACOptions): MiddlewareHandler {
  const { optional = false, scopes, requireAll = true, action, resource } = options;

  return async (c: Context, next: Next) => {
    const requestId = c.get("requestId") || crypto.randomUUID();

    // Import dynamically to avoid circular dependencies
    const { authenticateAgent } = await import("@/services/agent-auth");

    const authHeader = c.req.header("Authorization");

    // If there is no header and it is not optional, reject
    if (!authHeader) {
      if (optional) {
        return next();
      }
      return c.json(
        {
          error: "Unauthorized",
          code: RBACErrorCode.AGENT_NOT_AUTHENTICATED,
          message: "Authorization header required",
          requiredScopes: scopes,
          grantedScopes: [],
          timestamp: new Date().toISOString(),
          requestId,
        },
        401
      );
    }

    // Verify Bearer format
    const [scheme, apiKey] = authHeader.split(" ");

    if (scheme !== "Bearer" || !apiKey) {
      return c.json(
        {
          error: "Unauthorized",
          code: RBACErrorCode.AGENT_NOT_AUTHENTICATED,
          message: "Invalid authorization format. Use: Bearer <api-key>",
          requiredScopes: scopes,
          grantedScopes: [],
          timestamp: new Date().toISOString(),
          requestId,
        },
        401
      );
    }

    // Authenticate agent
    const result = await authenticateAgent(apiKey, {
      // The real IP, not the raw `x-forwarded-for` (the client writes it): the
      // same as the global middleware in index.ts (security review 2026-11-04).
      ipAddress: clientIp(c),
      userAgent: c.req.header("user-agent") || undefined,
      // An OAuth token's audience (RFC 8707) is checked against the path.
      route: c.req.path,
    });

    if (!result.success || !result.context) {
      return c.json(
        {
          error: "Unauthorized",
          code: RBACErrorCode.AGENT_NOT_AUTHENTICATED,
          message: result.error || "Authentication failed",
          requiredScopes: scopes,
          grantedScopes: [],
          timestamp: new Date().toISOString(),
          requestId,
        },
        401
      );
    }

    // Store in context
    c.set("agent", result.context);
    c.header("X-Agent-Id", result.context.agentId);
    c.header("X-RateLimit-Limit", result.context.rateLimit.toString());

    // Verify scopes
    const hasPermission = requireAll
      ? hasAllScopes(result.context, scopes)
      : hasAnyScope(result.context, scopes);

    if (!hasPermission) {
      return c.json(
        {
          error: "Forbidden",
          code: RBACErrorCode.INSUFFICIENT_PERMISSIONS,
          message: buildErrorMessage(action, resource, scopes, result.context.scopes),
          requiredScopes: scopes,
          grantedScopes: result.context.scopes,
          resource,
          action,
          timestamp: new Date().toISOString(),
          requestId,
        },
        403
      );
    }

    await next();
  };
}

/**
 * Helper: Builds a descriptive error message
 */
function buildErrorMessage(
  action?: string,
  resource?: string,
  required?: string[],
  granted?: string[]
): string {
  if (action && resource) {
    return (
      `The agent does not have permission to ${action} en ${resource}. ` +
      `Required scopes: ${required?.join(", ") || "none"}. ` +
      `Granted scopes: ${granted?.join(", ") || "none"}`
    );
  }

  if (action) {
    return (
      `Permission denied for ${action}. ` + `Required scopes: ${required?.join(", ") || "none"}`
    );
  }

  return (
    `Insufficient permissions. ` +
    `Required: ${required?.join(", ") || "none"}, ` +
    `Granted: ${granted?.join(", ") || "none"}`
  );
}

/**
 * Helper: Checks whether an agent has access to a specific resource
 * Useful for manual checks in controllers
 *
 * @example
 * ```typescript
 * // In a controller
 * const canWrite = checkResourceAccess(agent, "write", "database");
 * if (!canWrite) {
 *   return c.json({ error: "Forbidden" }, 403);
 * }
 * ```
 */
export function checkResourceAccess(
  agent: AgentAuthContext,
  action: string,
  resource: string
): boolean {
  // Check specific scope
  const specificScope = `${action}:${resource}`;
  if (hasScope(agent, specificScope)) return true;

  // Check resource wildcard
  const wildcardResource = `${action}:*`;
  if (hasScope(agent, wildcardResource)) return true;

  // Check admin wildcard
  if (hasScope(agent, "admin:*")) return true;

  return false;
}

/**
 * Helper: Gets all the resources the agent has access to
 * for a specific action
 *
 * @example
 * ```typescript
 * const readableResources = getAccessibleResources(agent, "read");
 * // ["database", "files", "users", ...]
 * ```
 */
export function getAccessibleResources(agent: AgentAuthContext, action: string): string[] {
  const resources: string[] = [];
  const actionPrefix = `${action}:`;
  const adminWildcard = "admin:*";

  for (const scope of agent.scopes) {
    // If it has admin:*, it has access to everything
    if (scope === adminWildcard) {
      return ["*"]; // All resources
    }

    // If it matches the action, extract the resource
    if (scope.startsWith(actionPrefix)) {
      const resource = scope.slice(actionPrefix.length);
      resources.push(resource);
    }

    // If it has an action wildcard
    if (scope === `${action}:*`) {
      return ["*"]; // All resources for this action
    }
  }

  return [...new Set(resources)]; // Remove duplicates
}

/**
 * Type declaration to extend ContextVariableMap
 */
declare module "hono" {
  interface ContextVariableMap {
    rbac?: RBACContext;
  }
}

export default {
  requireScopes,
  requireScope,
  requireAnyScope,
  requireAdmin,
  agentAuthWithRBAC,
  checkResourceAccess,
  getAccessibleResources,
  RBACErrorCode,
};
