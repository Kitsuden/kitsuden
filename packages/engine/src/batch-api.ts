/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BATCH API - The Titanium Wall (Atomic Writes)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Batch write API with ACID guarantees:
 * - Atomicity: All or nothing, automatic rollback on failure
 * - Consistency: Declarative validation before writing
 * - Isolation: Database transactions
 * - Durability: Explicit commit confirmation
 *
 * Features:
 * - Batch processing of multiple entities
 * - Pre-validation with ValidatorEngine
 * - Nested transactions (parent-child)
 * - Automatic rollback on failure
 * - Granular error detail
 *
 * @example
 * ```typescript
 * const batch = new BatchProcessor();
 *
 * const result = await batch.execute({
 *   operations: [
 *     { table: agentIdentities, action: "insert", data: { name: "Agent 1" } },
 *     { table: agentApiKeys, action: "insert", data: { agentId: "...", keyHash: "..." } }
 *   ],
 *   validation: agentIdentitySchema
 * });
 *
 * if (!result.success) {
 *   // The whole transaction was rolled back
 *   console.log(result.errors);
 * }
 * ```
 */

import type { PgTable } from "drizzle-orm/pg-core";

import { db } from "../../../apps/api/src/db";

import { writeCondition } from "./db-conditions";
import { messageOf } from "./errors";
import {
  BULK_HISTORY_CAP,
  recordChanges,
  systemSavepointOn,
  tableWritesChanges,
  type TableWrite,
} from "./record-history";
import { useUser } from "./request-scope";
import { validate, type ValidationSchema } from "./validator";
// import * as schema from "../../../apps/api/src/db/schema";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Database action */
export type BatchAction = "insert" | "update" | "delete" | "upsert";

/** Individual operation in the batch (Batch API) */
export interface BatchApiOperation<T = any> {
  /** Target table */
  table: PgTable;
  /** Action to perform */
  action: BatchAction;
  /** Data for the operation */
  data: T;
  /** ID for update/delete */
  id?: string;
  /** Where condition for update/delete */
  where?: Record<string, unknown>;
  /** Validation schema specific to this operation */
  validation?: ValidationSchema;
  /** Description for logs */
  description?: string;
  /** Dependencies: IDs of previous operations that must exist */
  dependsOn?: string[];
  /** Key to reference the result in dependent operations */
  key?: string;
}

/** Batch processor options */
export interface BatchOptions {
  /** Global validation schema */
  validation?: ValidationSchema;
  /** Stop at the first error (default: false) */
  abortEarly?: boolean;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
  /** Transaction isolation level */
  isolationLevel?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  /** Context for validations and transformations */
  context?: Record<string, unknown>;
}

/** Result of an individual operation (Batch API) */
export interface BatchApiOperationResult<T = any> {
  /** Operation success */
  success: boolean;
  /** Resulting data (for inserts, the created record) */
  data?: T;
  /** Generated or affected ID */
  id?: string;
  /** Errors specific to this operation */
  errors?: string[];
  /** Index in the operations array */
  index: number;
  /** Description of the operation */
  description?: string;
}

/** Complete batch result (Batch API) */
export interface BatchApiResult {
  /** Overall batch success */
  success: boolean;
  /** Individual results (only if success=true) */
  results?: BatchApiOperationResult[];
  /** Accumulated errors (only if success=false) */
  errors: BatchError[];
  /** Execution metadata */
  meta: {
    /** Start timestamp */
    startedAt: string;
    /** End timestamp */
    finishedAt: string;
    /** Duration in ms */
    durationMs: number;
    /** Number of operations executed */
    operationsCount: number;
    /** Number of successful operations */
    successCount: number;
    /** Number of failed operations */
    failedCount: number;
    /** Indicates whether a rollback happened */
    rollback: boolean;
  };
}

/** Detailed batch error */
export interface BatchError {
  /** Index of the operation that failed */
  operationIndex: number;
  /** Description of the operation */
  operationDescription?: string;
  /** Error message */
  message: string;
  /** Error code (if applicable) */
  code?: string;
  /** Additional details */
  details?: any;
}

/** Enough of a transaction to read rows back (record history). */
interface HistorySelect {
  select(): {
    from(t: PgTable): { where(c: unknown): { limit(n: number): Promise<HistoryRow[]> } };
  };
}
type HistoryRow = Record<string, unknown>;

/** Internal batch state */
interface BatchState {
  results: Map<string, any>;
  errors: BatchError[];
  operationResults: BatchApiOperationResult[];
  /**
   * What the batch wrote, for the record history (core migration 0076): one row
   * per record, or none once the batch wrote more than `BULK_HISTORY_CAP` rows.
   */
  writes: TableWrite[] | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * This used to call `column.eq(value)` — a method that Drizzle columns
 * do NOT have (`eq(column, value)` is used), so it threw a
 * TypeError; the `as any` in between is what let it compile. In
 * `upsert`, moreover, a `try/catch` swallowed it and did the insert anyway,
 * silently duplicating rows.
 *
 * Now `writeCondition` builds it, shared with `batch.ts`.
 */
const conditionOf = writeCondition;

/**
 * Batch operations processor with ACID guarantees.
 */
export class BatchProcessor {
  private state: BatchState;
  private options: BatchOptions;

  constructor(options: BatchOptions = {}) {
    this.options = {
      abortEarly: false,
      timeout: 30000,
      isolationLevel: "read committed",
      ...options,
    };
    this.state = {
      results: new Map(),
      errors: [],
      operationResults: [],
      writes: [],
    };
  }

  private remember(
    table: PgTable,
    action: TableWrite["action"],
    before: HistoryRow | null | undefined,
    after: HistoryRow | null | undefined
  ): void {
    if (!this.state.writes) return;
    this.state.writes.push({ table, action, before: before ?? null, after: after ?? null });
    if (this.state.writes.length > BULK_HISTORY_CAP) this.state.writes = null;
  }

  /** The rows a write by condition is about to touch (null over the cap). */
  private async rowsBefore(
    tx: unknown,
    table: PgTable,
    condition: unknown
  ): Promise<HistoryRow[] | null> {
    if (!this.state.writes) return null;
    const rows = await (tx as HistorySelect)
      .select()
      .from(table)
      .where(condition)
      .limit(BULK_HISTORY_CAP + 1);
    if (rows.length > BULK_HISTORY_CAP) {
      this.state.writes = null;
      return null;
    }
    return rows;
  }

  private rememberUpdates(table: PgTable, before: HistoryRow[] | null, after: HistoryRow[]): void {
    if (!before) return;
    const byId = new Map(before.map((r) => [String(r.id), r]));
    for (const row of after) this.remember(table, "update", byId.get(String(row.id)), row);
  }

  /**
   * Runs a batch of operations inside a transaction.
   *
   * @param operations - Array of operations to run
   * @returns Batch result
   *
   * @example
   * ```typescript
   * const batch = new BatchProcessor();
   *
   * const result = await batch.execute([
   *   {
   *     table: agentIdentities,
   *     action: "insert",
   *     data: { name: "Agent 1", type: "service" },
   *     key: "agent1",
   *     validation: {
   *       name: { required: true, min: 1 },
   *       type: { enum: ["service", "user"] }
   *     }
   *   },
   *   {
   *     table: agentApiKeys,
   *     action: "insert",
   *     data: { keyHash: "abc123" },
   *     dependsOn: ["agent1"],
   *     description: "Create API key for agent"
   *   }
   * ]);
   * ```
   */
  async execute(operations: BatchApiOperation[]): Promise<BatchApiResult> {
    const startedAt = new Date().toISOString();
    const startTime = performance.now();

    // Reset state
    this.state = {
      results: new Map(),
      errors: [],
      operationResults: [],
      writes: [],
    };

    // Validate operations before the transaction
    const preValidationErrors = this.validateOperations(operations);
    if (preValidationErrors.length > 0) {
      return {
        success: false,
        errors: preValidationErrors,
        meta: {
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: performance.now() - startTime,
          operationsCount: operations.length,
          successCount: 0,
          failedCount: operations.length,
          rollback: false,
        },
      };
    }

    // Run transaction
    try {
      await db.transaction(async (tx) => {
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];

          // Check dependencies
          if (op.dependsOn) {
            for (const depKey of op.dependsOn) {
              if (!this.state.results.has(depKey)) {
                throw new Error(`Dependency not met: ${depKey}`);
              }
            }
          }

          // Run operation
          const result = await this.executeOperation(tx, op, i);

          if (!result.success) {
            this.state.errors.push({
              operationIndex: i,
              operationDescription: op.description,
              message: result.errors?.[0] || "Operation failed",
              details: result.errors,
            });

            if (this.options.abortEarly) {
              throw new Error(`Operation ${i} failed: ${result.errors?.[0]}`);
            }
          } else {
            this.state.operationResults.push(result);

            // Save result for dependencies
            if (op.key) {
              this.state.results.set(op.key, result.data);
            }
          }
        }

        // If there are errors and it is not abortEarly, roll back
        if (this.state.errors.length > 0) {
          throw new Error("Batch validation failed");
        }

        // The history, in the batch's transaction: it commits or rolls back with it.
        await recordChanges(
          tx as never,
          tableWritesChanges(this.state.writes ?? [], useUser()),
          (err) => console.warn("[batch-api] could not record the history:", messageOf(err)),
          systemSavepointOn(tx as never)
        );
      });

      const finishedAt = new Date().toISOString();
      const durationMs = performance.now() - startTime;

      return {
        success: true,
        results: this.state.operationResults,
        errors: [],
        meta: {
          startedAt,
          finishedAt,
          durationMs,
          operationsCount: operations.length,
          successCount: this.state.operationResults.length,
          failedCount: 0,
          rollback: false,
        },
      };
    } catch (error: unknown) {
      const finishedAt = new Date().toISOString();
      const durationMs = performance.now() - startTime;

      // Automatic rollback by the transaction
      return {
        success: false,
        errors: [
          ...this.state.errors,
          {
            operationIndex: -1,
            message: messageOf(error, "Transaction failed"),
            // The code is set by the driver and is not always present: it is read
            // carefully instead of assuming the error has a shape.
            code: (error as { code?: string })?.code,
            details: error,
          },
        ],
        meta: {
          startedAt,
          finishedAt,
          durationMs,
          operationsCount: operations.length,
          successCount: this.state.operationResults.length,
          failedCount: operations.length - this.state.operationResults.length,
          rollback: true,
        },
      };
    }
  }

  /**
   * Runs an individual operation inside the transaction.
   */
  private async executeOperation(
    tx: any,
    operation: BatchApiOperation,
    index: number
  ): Promise<BatchApiOperationResult> {
    const { table, action, data, id, where, validation, description, dependsOn } = operation;

    try {
      // Validate data if there is a schema
      if (validation || this.options.validation) {
        const schemaToUse = validation || this.options.validation!;
        const validationResult = validate(data, schemaToUse, {
          context: this.options.context,
        });

        if (!validationResult.valid) {
          return {
            success: false,
            index,
            description,
            errors: validationResult.errors.map((e) => `${e.field}: ${e.message}`),
          };
        }
      }

      // Resolve dependencies in data
      const resolvedData = { ...data };
      if (dependsOn) {
        for (const depKey of dependsOn) {
          const depResult = this.state.results.get(depKey);
          if (depResult?.id) {
            // Replace placeholders like {agentId} with real values
            for (const [field, value] of Object.entries(resolvedData)) {
              if (typeof value === "string" && value.includes(`{${depKey}}`)) {
                resolvedData[field] = value.replace(`{${depKey}}`, depResult.id);
              }
            }
            // If there is a field ending in "Id" that is empty, assign the dependency's ID
            for (const field of Object.keys(resolvedData)) {
              if (field.endsWith("Id") && !resolvedData[field]) {
                resolvedData[field] = depResult.id;
              }
            }
          }
        }
      }

      // Run action
      let result: any;
      let resultId: string | undefined;

      switch (action) {
        case "insert":
          const insertResult = await tx.insert(table).values(resolvedData).returning();
          result = insertResult[0];
          resultId = result.id;
          this.remember(table, "create", null, result);
          break;

        case "update": {
          const condition = conditionOf(table, id, where, "Update");
          const before = await this.rowsBefore(tx, table, condition);
          const updateResult = await tx
            .update(table)
            .set(resolvedData)
            .where(condition)
            .returning();
          this.rememberUpdates(table, before, updateResult);
          result = updateResult[0];
          resultId = result?.id || id;
          break;
        }

        case "delete": {
          const deleteResult = await tx
            .delete(table)
            .where(conditionOf(table, id, where, "Delete"))
            .returning();
          for (const row of deleteResult) this.remember(table, "delete", row, null);
          result = deleteResult[0];
          resultId = id;
          break;
        }

        case "upsert": {
          // "Did not exist" is decided by `length === 0`, not by something throwing.
          //
          // This was wrapped in a `try/catch` that on ANY error
          // did the insert anyway. With the earlier broken call
          // (`column.eq(...)`, which does not exist in Drizzle) the TypeError landed
          // there: every upsert turned into a create, silently duplicating rows in
          // silence. And with the call fixed it would still be a trap — a
          // uniqueness violation or a nonexistent field in `where` would end up
          // inserting instead of warning.
          const condition = conditionOf(table, id, where, "Upsert");
          const before = await this.rowsBefore(tx, table, condition);
          const upsertResult = await tx
            .update(table)
            .set(resolvedData)
            .where(condition)
            .returning();

          if (upsertResult.length > 0) {
            result = upsertResult[0];
            this.rememberUpdates(table, before, upsertResult);
          } else {
            const insertResult = await tx.insert(table).values(resolvedData).returning();
            result = insertResult[0];
            this.remember(table, "create", null, result);
          }
          resultId = result.id;
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      return {
        success: true,
        data: result,
        id: resultId,
        index,
        description,
      };
    } catch (error: unknown) {
      return {
        success: false,
        index,
        description,
        errors: [messageOf(error) || "Unknown error"],
      };
    }
  }

  /**
   * Validates the operations before running the transaction.
   */
  private validateOperations(operations: BatchApiOperation[]): BatchError[] {
    const errors: BatchError[] = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      // Validate required fields
      if (!op.table) {
        errors.push({
          operationIndex: i,
          message: "Table is required",
        });
      }

      if (!op.action) {
        errors.push({
          operationIndex: i,
          message: "Action is required",
        });
      }

      if (!op.data && op.action !== "delete") {
        errors.push({
          operationIndex: i,
          message: "Data is required",
        });
      }

      // Validate dependencies
      if (op.dependsOn) {
        for (const dep of op.dependsOn) {
          const depOp = operations.find((o) => o.key === dep);
          if (!depOp) {
            errors.push({
              operationIndex: i,
              message: `Dependency '${dep}' not found in operations`,
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * Resets the processor state.
   */
  reset(): void {
    this.state = {
      results: new Map(),
      errors: [],
      operationResults: [],
      writes: [],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a batch processor with predefined options.
 */
export function createBatchProcessor(options: BatchOptions = {}): BatchProcessor {
  return new BatchProcessor(options);
}

/**
 * Runs a simple batch of a single operation.
 */
export async function executeSingle<T = any>(
  table: PgTable,
  action: BatchAction,
  data: T,
  options?: BatchOptions
): Promise<BatchApiResult> {
  const batch = new BatchProcessor(options);
  return batch.execute([
    {
      table,
      action,
      data,
    },
  ]);
}

/**
 * Creates a parent record and multiple children in one transaction.
 *
 * @example
 * ```typescript
 * const result = await createWithChildren(
 *   agentIdentities,
 *   { name: "Agent 1", type: "service" },
 *   [
 *     { table: agentApiKeys, data: { keyHash: "abc" } },
 *     { table: agentMemory, data: { content: { role: "assistant" } } }
 *   ]
 * );
 * ```
 */
export async function createWithChildren<T = any>(
  parentTable: PgTable,
  parentData: T,
  children: Array<{
    table: PgTable;
    data: any;
    foreignKeyField?: string;
  }>,
  options?: BatchOptions
): Promise<BatchApiResult> {
  const operations: BatchApiOperation[] = [
    {
      table: parentTable,
      action: "insert",
      data: parentData,
      key: "parent",
    },
  ];

  for (const child of children) {
    const fkField = child.foreignKeyField || "parentId";
    operations.push({
      table: child.table,
      action: "insert",
      data: {
        ...child.data,
        [fkField]: "{parent}", // Will be replaced by the real ID
      },
      dependsOn: ["parent"],
    });
  }

  const batch = new BatchProcessor(options);
  return batch.execute(operations);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
// Note: Types are already exported as interfaces above
