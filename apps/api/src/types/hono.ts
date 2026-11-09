/**
 * Hono Type Definitions
 *
 * Centralized type definitions for Hono context variables
 */

// import type { Hono } from "hono"; // Not used directly
import type { auth } from "../lib/auth";
import type { AgentAuthContext } from "../services/agent-auth";

/**
 * Variables available in Hono context
 */
export type AppVariables = {
  user: typeof auth.$Infer.Session.user | null;
  session: typeof auth.$Infer.Session.session | null;
  requestId: string;
  /** W3C trace context — populated by requestContextMiddleware */
  traceId?: string;
  spanId?: string;
  agent?: AgentAuthContext;
  /** Enriched ACL context — populated by enrichUserContext middleware */
  userRoleIds?: string[];
  userDepartmentId?: string | null;
};

// Extend Hono's ContextVariableMap globally
declare module "hono" {
  interface ContextVariableMap extends AppVariables {}
}
