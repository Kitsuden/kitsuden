/**
 * @kitsuden/engine/zod — THE Zod version of the monorepo
 * ============================================================================
 *
 *   import { z } from "@kitsuden/engine/zod";   // pure: starts nothing
 *   import { z } from "@kitsuden/engine";       // the same, from the index
 *
 * Kons do not import `zod` directly (`no-restricted-imports` rule in
 * eslint.config.js). This way there is a single version controlled by the engine,
 * and upgrading it (the migration to Zod 4) is a change in one place.
 *
 * A separate entry from the index on purpose: the index re-exports host modules
 * (db, auth…) and importing it STARTS the database. A schema file or
 * pure-logic file of a kon, which its tests load without a database, must use this one.
 */

export { z } from "zod";
export type { ZodError, ZodType } from "zod";
