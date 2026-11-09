/**
 * RLS Builder - Re-export from @kitsuden/shared
 *
 * This module has been moved to packages/shared/src/rls-builder.ts
 * for use by both core API and self-contained kons.
 *
 * This file is kept for backward compatibility with existing imports.
 */

export {
  buildDrizzleWhere,
  buildDatasetWhere,
  checkReadAccess,
  checkWriteAccess,
  createRLSFilter,
  publishedOrOwn,
  publishedOrOwnQl,
} from "@kitsuden/shared";

export type { RLSType, RLSRule, PolicyJson, RLSUser } from "@kitsuden/shared";
