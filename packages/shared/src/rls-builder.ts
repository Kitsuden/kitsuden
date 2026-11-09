/**
 * ============================================================================
 * RLS QUERY BUILDER - Translator of JSON Rules to Drizzle ORM Conditions
 * ============================================================================
 *
 * RESCUE PHASE: RAM Optimization and Application RLS
 *
 * This module eliminates the antipattern of filtering data in memory (.filter())
 * and translates JSON permission rules into native SQL conditions using
 * Drizzle ORM's operators.
 *
 * Before (RAM-killer):
 *   const all = await db.select().from(table); // 100,000 rows
 *   const filtered = all.filter(createRLSFilter(rules, user)); // In memory
 *
 * After (Drizzle Application RLS):
 *   const whereCondition = buildDrizzleWhere(rules, user);
 *   const filtered = await db.select().from(table).where(whereCondition); // 5 rows
 *
 * The business logic stays the same (application-level RLS), but
 * the heavy filtering work moves to PostgreSQL.
 */

import { eq, and, SQL, sql } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type RLSType = "admin" | "public" | "authenticated";

export type RLSRule = {
  field: string;
  operator: "eq" | "neq" | "contains" | "gt" | "lt";
  value: string;
};

export type PolicyJson = {
  readAccess: RLSType;
  writeAccess: RLSType;
  enableRLS: boolean;
  rlsRules?: RLSRule[];
};

export type RLSUser = {
  id: string;
  role?: string;
} | null;

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const USER_ID_PLACEHOLDER = "__USER_ID__";

// ═══════════════════════════════════════════════════════════════════════════
// Public Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds a Drizzle ORM WHERE condition from JSON RLS rules.
 *
 * This function translates rules like:
 *   `{ field: "author_id", operator: "eq", value: "__USER_ID__" }`
 *
 * Into SQL conditions like:
 *   `data->>'author_id' = 'user-123'`
 *
 * @param rules - Array of RLS rules from policyJson.rlsRules
 * @param user - Authenticated user (to replace __USER_ID__)
 * @returns Drizzle SQL condition or undefined if there are no filters
 *
 * @example
 * ```typescript
 * const rules = [
 *   { field: "author_id", operator: "eq", value: "__USER_ID__" },
 *   { field: "status", operator: "eq", value: "published" }
 * ];
 *
 * const whereCondition = buildDrizzleWhere(rules, { id: "user-123" });
 * // Result: AND(data->>'author_id' = 'user-123', data->>'status' = 'published')
 *
 * const results = await db
 *   .select()
 *   .from(dataEntries)
 *   .where(whereCondition);
 * ```
 */
export function buildDrizzleWhere(rules: RLSRule[] | undefined, user: RLSUser): SQL | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }

  const conditions: SQL[] = [];

  for (const rule of rules) {
    const condition = buildRuleCondition(rule, user);
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  // Combine all the conditions with AND
  return and(...conditions) as SQL;
}

/**
 * Builds a WHERE condition that includes filtering by datasetId + RLS.
 *
 * Useful for endpoints that need to filter by dataset and apply RLS
 * in a single query.
 *
 * @param datasetId - ID of the dataset to filter by
 * @param rules - Optional RLS rules
 * @param user - Authenticated user
 * @param tableDataColumn - Name of the JSONB column (default: "data")
 * @returns Object with separate or combined conditions
 *
 * @example
 * ```typescript
 * const { where, hasRLS } = buildDatasetWhere(
 *   "dataset-123",
 *   policy.rlsRules,
 *   currentUser,
 *   dataEntries
 * );
 *
 * const results = await db
 *   .select()
 *   .from(dataEntries)
 *   .where(where);
 * ```
 */
export function buildDatasetWhere(
  datasetId: string,
  rules: RLSRule[] | undefined,
  user: RLSUser,
  dataColumn: string = "data"
): { where: SQL | undefined; hasRLS: boolean } {
  // The admin sees all rows, as in the rest of the system (the Postgres
  // `data_entries_owner_isolation` policy, realtime's `filterForClient` and
  // `queryWouldSkipIsolation`). Before, the owner rule was applied to them
  // too and they received 0 rows from an owner-scoped dataset. ONLY `admin`: no
  // other role skips the `rlsRules` here.
  const rlsCondition = user?.role === "admin" ? undefined : buildDrizzleWhere(rules, user);

  // Filter by datasetId (always required)
  const datasetFilter = sql`${sql.raw("data_set_id")} = ${datasetId}`;

  if (rlsCondition) {
    return {
      where: and(datasetFilter, rlsCondition) as SQL,
      hasRLS: true,
    };
  }

  return {
    where: datasetFilter,
    hasRLS: false,
  };
}

/**
 * The entries of a dataset that someone outside the team may see: the published
 * ones and their own (they own them or created them; an agent's rows are owned
 * by its sponsor, and `created_by_id` is the agent). No id: only the published.
 *
 * THE one place for this rule: every path that reads entries for a non-staff
 * caller goes through it. `alias` qualifies the columns in a query with a join.
 */
export function publishedOrOwn(userId: string | null | undefined, alias?: string): SQL {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return userId
    ? sql`(${col("status")} = 'published' OR ${col("owner_id")} = ${userId} OR ${col("created_by_id")} = ${userId})`
    : sql`${col("status")} = 'published'`;
}

/** `publishedOrOwn` as a Kitsuden QL filter, for what goes through the query translator. */
export function publishedOrOwnQl(userId: string | null | undefined): Record<string, unknown> {
  const published = { status: { eq: "published" } };
  return userId
    ? { OR: [published, { ownerId: { eq: userId } }, { createdById: { eq: userId } }] }
    : published;
}

/**
 * Checks whether the user has read access based on policyJson.
 * Synchronous version that does not require a database query.
 *
 * @param policy - Policy configuration
 * @param user - Authenticated user
 * @returns true if they have access
 */
export function checkReadAccess(policy: PolicyJson | null, user: RLSUser): boolean {
  // No policy = admin only
  if (!policy) {
    return user?.role === "admin";
  }

  switch (policy.readAccess) {
    case "public":
      return true;
    case "authenticated":
      // An id, not just an object: realtime used to wrap an anonymous socket as
      // `{ id: undefined }`, which is truthy and passed this gate.
      return !!user?.id;
    case "admin":
      return user?.role === "admin";
    default:
      return user?.role === "admin";
  }
}

/**
 * Checks whether the user has write access based on policyJson.
 *
 * @param policy - Policy configuration
 * @param user - Authenticated user
 * @returns true if they have access
 */
export function checkWriteAccess(policy: PolicyJson | null, user: RLSUser): boolean {
  // No policy = admin only
  if (!policy) {
    return user?.role === "admin";
  }

  switch (policy.writeAccess) {
    case "authenticated":
      // As for reads: an object without an id is not a user.
      return !!user?.id;
    case "admin":
      return user?.role === "admin";
    default:
      return user?.role === "admin";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Private Functions (Helpers)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds an SQL condition for a single RLS rule.
 *
 * Accesses the field inside the JSONB using PostgreSQL operators:
 * - `data->>'fieldName'` for text values
 * - Numeric casting for gt/lt operators
 */
function buildRuleCondition(rule: RLSRule, user: RLSUser): SQL | null {
  // Replace the __USER_ID__ placeholder with the user's real ID
  const compareValue = rule.value === USER_ID_PLACEHOLDER ? user?.id : rule.value;

  // If we need __USER_ID__ but there is no user, the rule is not met
  if (rule.value === USER_ID_PLACEHOLDER && !user?.id) {
    // Return an impossible condition (1=0)
    return sql`1 = 0`;
  }

  // Access to the field inside the JSONB column "data"
  // We use sql.raw to build the expression data->>'fieldName'
  const fieldPath = sql`${sql.raw("data")}->>${rule.field}`;

  switch (rule.operator) {
    case "eq":
      return sql`${fieldPath} = ${compareValue}`;

    case "neq":
      return sql`${fieldPath} <> ${compareValue}`;

    case "contains":
      // LIKE %value% - substring search
      return sql`${fieldPath} LIKE ${`%${compareValue}%`}`;

    case "gt":
      // Cast to numeric for comparison
      return sql`(${fieldPath})::numeric > ${Number(compareValue)}`;

    case "lt":
      // Cast to numeric for comparison
      return sql`(${fieldPath})::numeric < ${Number(compareValue)}`;

    default:
      console.warn(`[RLS Builder] Unknown operator: ${rule.operator}`);
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy Exports (for compatibility)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use buildDrizzleWhere() instead.
 *
 * Creates an in-memory filter function (antipattern).
 * Kept only for compatibility with legacy code.
 */
export function createRLSFilter(
  policy: PolicyJson | null,
  user: RLSUser
): ((entry: Record<string, any>) => boolean) | null {
  if (!policy?.enableRLS || !policy.rlsRules?.length) {
    return null;
  }

  return (entry: Record<string, any>) => {
    return policy.rlsRules!.every((rule) => {
      const value = entry.data?.[rule.field];
      const compareValue = rule.value === "__USER_ID__" ? user?.id : rule.value;

      switch (rule.operator) {
        case "eq":
          return value === compareValue;
        case "neq":
          return value !== compareValue;
        case "contains":
          return (
            typeof value === "string" &&
            typeof compareValue === "string" &&
            value.includes(compareValue)
          );
        case "gt":
          return Number(value) > Number(compareValue);
        case "lt":
          return Number(value) < Number(compareValue);
        default:
          return true;
      }
    });
  };
}
