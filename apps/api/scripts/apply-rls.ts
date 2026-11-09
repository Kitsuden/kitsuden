#!/usr/bin/env bun
/**
 * Apply native RLS policies (the Titanium Wall)
 * ============================================================================
 *
 * Applies, in order:
 *   1. src/db/rls-policies.sql      — original policies (data_entries…)
 *   2. src/db/rls-owned-tables.sql  — expansion: every table with PERSONAL
 *                                     ownership, with ENABLE + FORCE
 *
 * Idempotent: it can be run after every migration.
 *
 * REQUIREMENT for this to be of any use: the app must connect as a
 * NON-superuser role — Postgres ignores RLS for superusers. See
 * docs/RLS_SETUP_GUIDE.md.
 *
 * USAGE:  bun run scripts/apply-rls.ts   (or `bun run db:rls` from apps/api)
 */

import "./lib/real-postgres-only";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyRlsPolicies, checkSuperuser, reportRls, verifyRls } from "./lib/rls";

const here = dirname(fileURLToPath(import.meta.url));

const SQL_FILES = [
  resolve(here, "../src/db/rls-policies.sql"),
  resolve(here, "../src/db/rls-owned-tables.sql"),
  // Core: secrets, credentials, audit and auth_users
  resolve(here, "../src/db/rls-system-only.sql"),
];

/**
 * Applies and verifies. The logic lives in scripts/lib/rls.ts because the migration
 * runner uses it too: RLS has to be applied on every deployment, not
 * when someone remembers to run this script.
 */
async function applyRLSPolicies(): Promise<void> {
  await applyRlsPolicies(SQL_FILES);
  reportRls(await verifyRls(), await checkSuperuser());
}

if (import.meta.main) {
  applyRLSPolicies().then(() => process.exit(0));
}

export { applyRLSPolicies };
