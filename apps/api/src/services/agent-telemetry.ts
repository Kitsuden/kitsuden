/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Agent Telemetry Service (Step 2: Observability)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Implements TelemetryProvider for the engine, using Drizzle ORM
 * with the correct syntax for agentTraceSteps.
 */

import { setTelemetryProvider, type TelemetryStepData } from "@kitsuden/engine"; // Path relative to the workspace
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentTraceSteps } from "../db/schema";

/**
 * Drizzle-based telemetry provider
 * Implements the engine's TelemetryProvider interface
 */
export const drizzleTelemetryProvider = {
  /**
   * Insert a new telemetry step
   */
  async insertStep(step: TelemetryStepData): Promise<void> {
    await db.insert(agentTraceSteps).values({
      id: step.id,
      traceId: step.traceId,
      stepOrder: step.stepOrder,
      stepType: step.stepType as any, // Cast from string to enum
      toolName: step.toolName,
      toolInput: step.toolInput as Record<string, unknown> | undefined,
      toolOutput: undefined, // Updated later
      durationMs: undefined,
      errorMessage: undefined,
      metadata: {},
      createdAt: step.createdAt,
    });
  },

  /**
   * Update an existing telemetry step
   */
  async updateStep(stepId: string, data: Partial<TelemetryStepData>): Promise<void> {
    const updateData: Record<string, unknown> = {};

    if (data.toolOutput !== undefined) {
      updateData.toolOutput = data.toolOutput as Record<string, unknown>;
    }
    if (data.durationMs !== undefined) {
      updateData.durationMs = data.durationMs;
    }
    if (data.errorMessage !== undefined) {
      updateData.errorMessage = data.errorMessage;
    }

    await db.update(agentTraceSteps).set(updateData).where(eq(agentTraceSteps.id, stepId));
  },
};

/**
 * Initialize telemetry provider
 * Call this during application startup
 */
export function initAgentTelemetry(): void {
  setTelemetryProvider(drizzleTelemetryProvider);
  console.log("📊 Agent telemetry provider initialized");
}

/**
 * Helper to create a new trace
 * Returns the traceId to use in actions
 */
export async function createTrace(params: {
  agentId: string;
  sessionId?: string;
  name?: string;
  input?: Record<string, unknown>;
}): Promise<string> {
  const { agentId, sessionId, name, input } = params;

  // Dynamic import to avoid circular dependencies
  const { agentTraces } = await import("../db/schema");

  const [trace] = await db
    .insert(agentTraces)
    .values({
      agentId,
      sessionId: sessionId || null,
      name: name || null,
      input: input || {},
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: agentTraces.id });

  return trace.id;
}

/**
 * Finalizes a trace with the result
 */
export async function completeTrace(
  traceId: string,
  result: {
    output?: Record<string, unknown>;
    errorMessage?: string;
    tokensIn?: number;
    tokensOut?: number;
    estimatedCost?: number;
  }
): Promise<void> {
  const { agentTraces } = await import("../db/schema");

  const durationMs = undefined; // It would be computed from startedAt

  await db
    .update(agentTraces)
    .set({
      output: result.output || {},
      errorMessage: result.errorMessage || null,
      status: result.errorMessage ? "error" : "success",
      tokensIn: result.tokensIn || null,
      tokensOut: result.tokensOut || null,
      estimatedCost: result.estimatedCost || null,
      totalDurationMs: durationMs,
      completedAt: new Date(),
    })
    .where(eq(agentTraces.id, traceId));
}
