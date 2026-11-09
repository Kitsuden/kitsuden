/**
 * Dataset Permission Middleware
 *
 * Smart permission checker: defaults to "Admin-only" when no policyJson exists.
 * Enterprise features (RLS, custom access) are strictly opt-in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESCUE PHASE: This module now delegates the RLS logic to rls-builder.ts
 * to optimize queries and avoid in-memory filtering.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { eq } from "drizzle-orm";
import type { Context } from "hono";

import { isUuid } from "@kitsuden/engine";

import { db } from "../db";
import { dataSets } from "../db/schema";
import {
  checkReadAccess as rlsCheckRead,
  checkWriteAccess as rlsCheckWrite,
  type PolicyJson,
  type RLSUser,
} from "../lib/rls-builder";

// Re-export types for compatibility
export type { PolicyJson, RLSUser } from "../lib/rls-builder";

/**
 * Interface for workflow configuration
 */
interface WorkflowJson {
  requireApproval?: boolean;
  [key: string]: unknown;
}

/**
 * Check read permission for a dataset.
 *  - NULL policy → admin-only
 *  - 'public' → anyone
 *  - 'authenticated' → logged-in users
 *  - 'admin' → admins only
 *
 * RESCUE PHASE: Now delegates to rls-builder for consistency.
 */
export async function checkDatasetReadAccess(c: Context, datasetId: string): Promise<boolean> {
  // An id that is not a UUID cannot correspond to any dataset, and handing it
  // to Postgres causes `invalid input syntax for type uuid` — a 500 where
  // a denial is due. Denying is also the safe answer: for an id that
  // cannot be resolved, there is no permission to grant.
  if (!isUuid(datasetId)) return false;

  const user = c.get("user") as RLSUser | undefined;

  const [dataset] = await db
    .select({ policyJson: dataSets.policyJson })
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  if (!dataset) return false;

  const policy = dataset.policyJson as PolicyJson | null;
  return rlsCheckRead(policy, user ?? null);
}

/**
 * Check write permission for a dataset.
 *  - NULL policy → admin-only
 *  - 'authenticated' → logged-in users
 *  - 'admin' → admins only
 *
 * RESCUE PHASE: Now delegates to rls-builder for consistency.
 */
export async function checkDatasetWriteAccess(c: Context, datasetId: string): Promise<boolean> {
  // An id that is not a UUID cannot correspond to any dataset, and handing it
  // to Postgres causes `invalid input syntax for type uuid` — a 500 where
  // a denial is due. Denying is also the safe answer: for an id that
  // cannot be resolved, there is no permission to grant.
  if (!isUuid(datasetId)) return false;

  const user = c.get("user") as RLSUser | undefined;

  const [dataset] = await db
    .select({ policyJson: dataSets.policyJson })
    .from(dataSets)
    .where(eq(dataSets.id, datasetId))
    .limit(1);

  if (!dataset) return false;

  const policy = dataset.policyJson as PolicyJson | null;
  return rlsCheckWrite(policy, user ?? null);
}

/**
 * Determine entry status based on workflow config.
 * - No workflowJson → 'published' (instant)
 * - requireApproval → 'draft' (needs review)
 */
export function resolveEntryStatus(
  workflowJson: WorkflowJson | null | undefined
): "published" | "draft" {
  if (!workflowJson || !workflowJson.requireApproval) {
    return "published";
  }
  return "draft";
}
