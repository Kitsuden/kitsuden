/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BATCH PROCESSOR - PHASE 2: The Magic of Data
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Transactional API for batch operations with guaranteed ACID.
 * Supports dependencies between operations through @ref:alias.
 *
 * Features:
 * - ACID transactions: All or nothing (automatic rollback)
 * - Operations: create, update, delete, upsert
 * - References: @ref:alias.id for dependencies
 * - Validation: Integrated with Zod before writing
 * - Rollback: Automatic on failure
 *
 * @example
 * ```typescript
 * const batch = new BatchProcessor();
 * const result = await batch.execute([
 *   { op: "create", table: characters, data: { name: "Hero" }, alias: "hero" },
 *   { op: "create", table: skills, data: { character_id: "@ref:hero.id", damage: 100 } }
 * ]);
 * // If skill fails, hero is NOT created (ACID rollback)
 * ```
 */

import { type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { db } from "../../../apps/api/src/db";

import { writeCondition } from "./db-conditions";
import { messageOf } from "./errors";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES AND CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported operation types */
export type BatchOperationType = "create" | "update" | "delete" | "upsert";

/** Individual batch operation */
export interface BatchOperation {
  /** Operation type */
  op: BatchOperationType;
  /** Target table */
  table: PgTable;
  /** Data for create/update/upsert */
  data?: Record<string, unknown>;
  /** ID for update/delete (can be @ref:alias.id) */
  id?: string;
  /** Alias to reference in later operations */
  alias?: string;
  /** Where condition for multiple update/delete */
  where?: Record<string, unknown>;
  /** Optional Zod validation */
  validation?: (data: any) => { success: boolean; errors?: string[] };
}

/** Result of an individual operation */
export interface BatchOperationResult {
  /** Index of the operation */
  index: number;
  /** Status of the operation */
  status: "created" | "updated" | "deleted" | "upserted" | "failed" | "rolled_back";
  /** ID of the affected record */
  id?: string;
  /** Assigned alias */
  alias?: string;
  /** Record data (for create/upsert) */
  data?: any;
  /** Error if it failed */
  error?: {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  };
}

/** Batch result */
export interface BatchResult {
  /** Overall batch success */
  success: boolean;
  /** Individual results */
  results: BatchOperationResult[];
  /** There was a rollback */
  rolledBack?: boolean;
  /** Error that caused the rollback */
  error?: {
    operationIndex?: number;
    message: string;
    code: string;
  };
  /** Metadata */
  meta: {
    executedAt: string;
    durationMs: number;
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
  };
}

/** BatchProcessor error */
export class BatchProcessorError extends Error {
  constructor(
    message: string,
    public code:
      | "INVALID_OPERATION"
      | "VALIDATION_FAILED"
      | "REF_NOT_FOUND"
      | "TRANSACTION_FAILED"
      | "ROLLBACK_FAILED",
    public operationIndex?: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BatchProcessorError";
  }
}

/** References resolved during the batch */
type ResolvedRefs = Map<string, { id: string; data: any }>;

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BatchProcessor - Runs batch operations with ACID guarantees.
 *
 * All operations run inside a transaction.
 * If one fails, everything is rolled back.
 *
 * @example
 * ```typescript
 * const batch = new BatchProcessor();
 *
 * const result = await batch.execute([
 *   {
 *     op: "create",
 *     table: characters,
 *     data: { name: "Hu Tao", element: "pyro", rarity: 5 },
 *     alias: "hu_tao"
 *   },
 *   {
 *     op: "create",
 *     table: skills,
 *     data: {
 *       name: "Guide to Afterlife",
 *       character_id: "@ref:hu_tao.id",  // Reference to previous operation
 *       damage: 500
 *     }
 *   }
 * ]);
 *
 * if (result.success) {
 *   console.log("Character and skill created:", result.results);
 * } else {
 *   console.error("Rollback executed:", result.error);
 * }
 * ```
 */
export class BatchProcessor {
  private refs: ResolvedRefs = new Map();

  /**
   * @param connection where the transaction opens. In a request, the request's RLS
   * transaction (`resolveExecutor(db)`), which turns this one into a savepoint:
   * without it the batch runs on the global pool, as the system, with no policy
   * in effect.
   */
  constructor(private readonly connection: Pick<typeof db, "transaction"> = db) {}

  /**
   * Runs a batch of operations transactionally.
   *
   * @param operations - Array of operations to run
   * @returns Batch result with the success/failure of each operation
   */
  async execute(operations: BatchOperation[]): Promise<BatchResult> {
    const startTime = performance.now();
    const results: BatchOperationResult[] = [];
    const executedAt = new Date().toISOString();

    // Validate operations before starting the transaction
    this.validateOperations(operations);

    try {
      // Run in a transaction
      await this.connection.transaction(async (tx) => {
        for (let i = 0; i < operations.length; i++) {
          const op = operations[i];

          try {
            const result = await this.executeOperation(tx, op, i);
            results.push(result);

            // Save reference if it has an alias
            if (result.alias && result.id) {
              this.refs.set(result.alias, { id: result.id, data: result.data });
            }
          } catch (error) {
            // Mark operation as failed
            results.push({
              index: i,
              status: "failed",
              alias: op.alias,
              error: {
                message: (error as Error).message,
                code: error instanceof BatchProcessorError ? error.code : "UNKNOWN_ERROR",
                details: error instanceof BatchProcessorError ? error.details : undefined,
              },
            });

            // Throw error to trigger rollback
            throw new BatchProcessorError(
              `Operation ${i} failed: ${(error as Error).message}`,
              "TRANSACTION_FAILED",
              i,
              { operation: op, originalError: error }
            );
          }
        }
      });

      const durationMs = performance.now() - startTime;
      const successfulOps = results.filter((r) => !r.error).length;

      return {
        success: true,
        results,
        meta: {
          executedAt,
          durationMs: Math.round(durationMs * 100) / 100,
          totalOperations: operations.length,
          successfulOperations: successfulOps,
          failedOperations: operations.length - successfulOps,
        },
      };
    } catch (error) {
      const durationMs = performance.now() - startTime;

      // Mark pending operations as rolled_back
      for (let i = results.length; i < operations.length; i++) {
        results.push({
          index: i,
          status: "rolled_back",
          alias: operations[i].alias,
        });
      }

      // Update status of successful operations to rolled_back
      for (const result of results) {
        if (result.status !== "failed") {
          result.status = "rolled_back";
        }
      }

      return {
        success: false,
        results,
        rolledBack: true,
        error: {
          operationIndex: error instanceof BatchProcessorError ? error.operationIndex : -1,
          message: (error as Error).message,
          code: error instanceof BatchProcessorError ? error.code : "TRANSACTION_FAILED",
        },
        meta: {
          executedAt,
          durationMs: Math.round(durationMs * 100) / 100,
          totalOperations: operations.length,
          successfulOperations: 0,
          failedOperations: operations.length,
        },
      };
    }
  }

  /**
   * Runs a single operation inside the transaction.
   */
  private async executeOperation(
    tx: any,
    operation: BatchOperation,
    index: number
  ): Promise<BatchOperationResult> {
    const { op, table, data, id, where, validation } = operation;

    // Resolve references in data
    const resolvedData = data ? this.resolveReferences(data) : undefined;
    const resolvedId = id ? this.resolveReferenceValue(id) : undefined;

    // Validate data if there is a schema
    if (validation && resolvedData) {
      const validationResult = validation(resolvedData);
      if (!validationResult.success) {
        throw new BatchProcessorError(
          `Validation failed: ${validationResult.errors?.join(", ")}`,
          "VALIDATION_FAILED",
          index,
          { errors: validationResult.errors }
        );
      }
    }

    switch (op) {
      case "create":
        return this.executeCreate(tx, table, resolvedData!, operation.alias, index);

      case "update":
        return this.executeUpdate(
          tx,
          table,
          resolvedId,
          resolvedData,
          where,
          operation.alias,
          index
        );

      case "delete":
        return this.executeDelete(tx, table, resolvedId, where, operation.alias, index);

      case "upsert":
        return this.executeUpsert(tx, table, resolvedId, resolvedData!, operation.alias, index);

      default:
        throw new BatchProcessorError(`Unsupported operation: ${op}`, "INVALID_OPERATION", index, {
          supportedOperations: ["create", "update", "delete", "upsert"],
        });
    }
  }

  private async executeCreate(
    tx: any,
    table: PgTable,
    data: Record<string, unknown>,
    alias: string | undefined,
    index: number
  ): Promise<BatchOperationResult> {
    const result = await tx.insert(table).values(data).returning();
    const inserted = result[0];

    return {
      index,
      status: "created",
      id: inserted.id,
      alias,
      data: inserted,
    };
  }

  /**
   * WHERE for a write, with the error translated to the processor's.
   *
   * Before, each operation built it by hand with an `if (id) / else if (where)`.
   * It worked except in one case: with `where: {}` no condition was left
   * and the statement came out WITHOUT a WHERE — an UPDATE, or worse, a DELETE, against
   * the whole table. `{}` is exactly what arrives when the client builds the
   * filter dynamically and finds nothing to put in it.
   */
  private condition(
    table: PgTable,
    id: string | undefined,
    where: Record<string, unknown> | undefined,
    operation: string,
    index: number
  ): SQL {
    try {
      return writeCondition(table, id, where, operation);
    } catch (e) {
      throw new BatchProcessorError(messageOf(e), "INVALID_OPERATION", index);
    }
  }

  private async executeUpdate(
    tx: any,
    table: PgTable,
    id: string | undefined,
    data: Record<string, unknown> | undefined,
    where: Record<string, unknown> | undefined,
    alias: string | undefined,
    index: number
  ): Promise<BatchOperationResult> {
    if (!data) {
      throw new BatchProcessorError("Update requires data", "INVALID_OPERATION", index);
    }

    const result = await tx
      .update(table)
      .set(data)
      .where(this.condition(table, id, where, "Update", index))
      .returning();
    const updated = result[0];

    return {
      index,
      status: "updated",
      id: updated?.id || id,
      alias,
      data: updated,
    };
  }

  private async executeDelete(
    tx: any,
    table: PgTable,
    id: string | undefined,
    where: Record<string, unknown> | undefined,
    alias: string | undefined,
    index: number
  ): Promise<BatchOperationResult> {
    const result = await tx
      .delete(table)
      .where(this.condition(table, id, where, "Delete", index))
      .returning();

    return {
      index,
      status: "deleted",
      id: result[0]?.id || id,
      alias,
    };
  }

  private async executeUpsert(
    tx: any,
    table: PgTable,
    id: string | undefined,
    data: Record<string, unknown>,
    alias: string | undefined,
    index: number
  ): Promise<BatchOperationResult> {
    // Try update first if there is an id
    if (id) {
      // The same condition builder as the rest: it validates that the table
      // has an `id` column instead of trusting an `as any`.
      const byId = this.condition(table, id, undefined, "Upsert", index);

      const existing = await tx.select().from(table).where(byId).limit(1);

      if (existing.length > 0) {
        // Update
        const result = await tx.update(table).set(data).where(byId).returning();
        return {
          index,
          status: "upserted",
          id: result[0].id,
          alias,
          data: result[0],
        };
      }
    }

    // Create
    const result = await tx.insert(table).values(data).returning();
    return {
      index,
      status: "upserted",
      id: result[0].id,
      alias,
      data: result[0],
    };
  }

  /**
   * Resolves @ref:alias.key references in the data object.
   */
  private resolveReferences(data: Record<string, unknown>): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" && value.startsWith("@ref:")) {
        resolved[key] = this.resolveReferenceValue(value);
      } else if (typeof value === "object" && value !== null) {
        // `typeof x === "object"` narrows to `object`, not to a dictionary:
        // an array also satisfies it. Recursion only makes sense over
        // keys, so that shape is asserted here and not in the signature.
        resolved[key] = this.resolveReferences(value as Record<string, unknown>);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /**
   * Resolves a @ref:alias.key reference value.
   */
  private resolveReferenceValue(value: string): string {
    if (!value.startsWith("@ref:")) {
      return value;
    }

    const parts = value.slice(5).split("."); // Strip "@ref:" and split
    if (parts.length < 2) {
      throw new BatchProcessorError(
        `Invalid reference format: ${value}. Use @ref:alias.property`,
        "REF_NOT_FOUND",
        undefined,
        { value }
      );
    }

    const [alias, ...propertyPath] = parts;
    const ref = this.refs.get(alias);

    if (!ref) {
      throw new BatchProcessorError(`Reference not found: ${alias}`, "REF_NOT_FOUND", undefined, {
        alias,
        availableRefs: Array.from(this.refs.keys()),
      });
    }

    // Walk the property path
    let result: any = ref;
    for (const prop of propertyPath) {
      result = result[prop];
      if (result === undefined) {
        throw new BatchProcessorError(
          `Property not found in reference: ${alias}.${propertyPath.join(".")}`,
          "REF_NOT_FOUND",
          undefined,
          { alias, property: prop, availableProperties: Object.keys(ref) }
        );
      }
    }

    return result;
  }

  /**
   * Validates the operations before running.
   */
  private validateOperations(operations: BatchOperation[]): void {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new BatchProcessorError("An array of operations is required", "INVALID_OPERATION");
    }

    if (operations.length > 100) {
      throw new BatchProcessorError(
        "Maximum 100 operations per batch",
        "INVALID_OPERATION",
        undefined,
        { provided: operations.length, max: 100 }
      );
    }

    // Validate duplicate aliases
    const aliases = new Set<string>();
    for (const op of operations) {
      if (op.alias) {
        if (aliases.has(op.alias)) {
          throw new BatchProcessorError(
            `Duplicate alias: ${op.alias}`,
            "INVALID_OPERATION",
            undefined,
            { alias: op.alias }
          );
        }
        aliases.add(op.alias);
      }
    }
  }

  /**
   * Clears the internal references.
   */
  clearRefs(): void {
    this.refs.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates a new BatchProcessor.
 */
export function createBatchProcessor(): BatchProcessor {
  return new BatchProcessor();
}

/**
 * Runs a single operation inside a transaction.
 *
 * @example
 * ```typescript
 * const result = await executeSingle(characters, "create", {
 *   name: "Hero",
 *   level: 50
 * });
 * ```
 */
export async function executeSingle(
  table: PgTable,
  op: BatchOperationType,
  data: Record<string, unknown>,
  options?: {
    id?: string;
    validation?: (data: any) => { success: boolean; errors?: string[] };
  }
): Promise<BatchOperationResult> {
  const batch = new BatchProcessor();
  const result = await batch.execute([
    {
      op,
      table,
      data,
      id: options?.id,
      validation: options?.validation,
    },
  ]);

  if (!result.success) {
    throw new BatchProcessorError(
      result.error?.message || "Operation failed",
      (result.error?.code as any) || "TRANSACTION_FAILED"
    );
  }

  return result.results[0];
}

/**
 * Creates a parent record with children in a single transaction.
 *
 * @example
 * ```typescript
 * const result = await createWithChildren(
 *   characters,
 *   { name: "Hu Tao", element: "pyro" },
 *   [
 *     { table: skills, data: { name: "Skill 1", damage: 100 } },
 *     { table: skills, data: { name: "Skill 2", damage: 200 } }
 *   ]
 * );
 * ```
 */
export async function createWithChildren(
  parentTable: PgTable,
  parentData: Record<string, unknown>,
  children: Array<{
    table: PgTable;
    data: Record<string, unknown>;
    foreignKeyField: string;
  }>,
  options?: {
    parentAlias?: string;
    validation?: (data: any) => { success: boolean; errors?: string[] };
  }
): Promise<BatchResult> {
  const operations: BatchOperation[] = [];
  const parentAlias = options?.parentAlias || "parent";

  // Parent operation
  operations.push({
    op: "create",
    table: parentTable,
    data: parentData,
    alias: parentAlias,
    validation: options?.validation,
  });

  // Child operations referencing the parent
  for (const child of children) {
    operations.push({
      op: "create",
      table: child.table,
      data: {
        ...child.data,
        [child.foreignKeyField]: `@ref:${parentAlias}.id`,
      },
    });
  }

  const batch = new BatchProcessor();
  return batch.execute(operations);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
// Note: Types are already exported as interfaces above
