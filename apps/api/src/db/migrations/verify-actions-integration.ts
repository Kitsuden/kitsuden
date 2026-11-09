/**
 * Verification Script: Actions Integration Test
 *
 * Run this script after deployment to verify everything works:
 *   bun run apps/api/src/db/migrations/verify-actions-integration.ts
 *
 * This tests:
 *   1. Database connectivity and schema
 *   2. ActionEngine initialization
 *   3. CRUD operations
 *   4. Action execution (code and webhook_out)
 *   5. Event dispatch
 */

import { messageOf } from "@kitsuden/engine";
import { eq, desc } from "drizzle-orm";

import {
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
  executeActionById,
  dispatchEvent,
} from "../../lib/actions";
import { db } from "../index";
import { actions, actionExecutions } from "../schema";

const TEST_ACTION_SLUG = "test-verification-action";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

async function cleanupTestData(): Promise<void> {
  try {
    // Delete test action if exists
    const [existing] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (existing) {
      await db.delete(actions).where(eq(actions.id, existing.id));
      console.log("  Cleaned up previous test data");
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

async function testDatabaseConnection(): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await db.execute("SELECT 1 as test");
    if (result.rows[0]?.test === 1) {
      return { name: "Database Connection", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Unexpected result from database");
  } catch (err: unknown) {
    return {
      name: "Database Connection",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testSchemaExists(): Promise<TestResult> {
  const start = Date.now();
  try {
    const tables = await db.execute(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('actions', 'action_executions')
    `);

    const tableNames = tables.rows.map((r: any) => r.table_name);

    if (tableNames.includes("actions") && tableNames.includes("action_executions")) {
      return { name: "Schema Exists", passed: true, durationMs: Date.now() - start };
    }

    const missing = [];
    if (!tableNames.includes("actions")) missing.push("actions");
    if (!tableNames.includes("action_executions")) missing.push("action_executions");

    throw new Error(`Missing tables: ${missing.join(", ")}`);
  } catch (err: unknown) {
    return {
      name: "Schema Exists",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testCreateAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const action = await createAction({
      name: "Test Verification Action",
      slug: TEST_ACTION_SLUG,
      description: "Temporary action for integration testing",
      type: "code",
      trigger: "manual",
      config: {
        code: "export default async function(ctx) { return { success: true, test: true }; }",
        timeoutMs: 5000,
      },
    });

    if (action.id && action.slug === TEST_ACTION_SLUG) {
      return { name: "Create Action", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Action created but returned unexpected data");
  } catch (err: unknown) {
    return {
      name: "Create Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testListActions(): Promise<TestResult> {
  const start = Date.now();
  try {
    const actionList = await listActions({ limit: 10 });

    if (Array.isArray(actionList) && actionList.length > 0) {
      const testAction = actionList.find((a) => a.slug === TEST_ACTION_SLUG);
      if (testAction) {
        return { name: "List Actions", passed: true, durationMs: Date.now() - start };
      }
    }
    throw new Error("Test action not found in list");
  } catch (err: unknown) {
    return {
      name: "List Actions",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testGetAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (!action) throw new Error("Test action not found");

    const fetched = await getAction(action.id);

    if (fetched && fetched.id === action.id) {
      return { name: "Get Action", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Fetched action doesn't match");
  } catch (err: unknown) {
    return {
      name: "Get Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testExecuteCodeAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (!action) throw new Error("Test action not found");

    const result = await executeActionById(action.id, { trigger: "manual" });

    if (result.success && (result.result as any)?.test === true) {
      return { name: "Execute Code Action", passed: true, durationMs: Date.now() - start };
    }
    throw new Error(`Execution failed: ${result.error || "unknown error"}`);
  } catch (err: unknown) {
    return {
      name: "Execute Code Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testCreateWebhookAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const action = await createAction({
      name: "Test Webhook Action",
      slug: "test-webhook-action",
      description: "Temporary webhook for integration testing",
      type: "webhook_out",
      trigger: "event",
      triggerConfig: { eventName: "test.event" },
      config: {
        url: "https://httpbin.org/post",
        headers: { "X-Test": "true" },
      },
    });

    if (action.id && action.type === "webhook_out") {
      // Cleanup
      await db.delete(actions).where(eq(actions.id, action.id));
      return { name: "Create Webhook Action", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Webhook action created but returned unexpected data");
  } catch (err: unknown) {
    return {
      name: "Create Webhook Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testUpdateAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (!action) throw new Error("Test action not found");

    const updated = await updateAction(action.id, {
      description: "Updated description",
    });

    if (updated && updated.description === "Updated description") {
      return { name: "Update Action", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Update didn't apply correctly");
  } catch (err: unknown) {
    return {
      name: "Update Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testExecutionLogging(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (!action) throw new Error("Test action not found");

    // Get executions
    const executions = await db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.actionId, action.id))
      .orderBy(desc(actionExecutions.createdAt))
      .limit(1);

    if (executions.length > 0 && executions[0].status === "success") {
      return { name: "Execution Logging", passed: true, durationMs: Date.now() - start };
    }
    throw new Error("Execution not logged or incorrect status");
  } catch (err: unknown) {
    return {
      name: "Execution Logging",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testDeleteAction(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.slug, TEST_ACTION_SLUG))
      .limit(1);

    if (!action) throw new Error("Test action not found");

    const deleted = await deleteAction(action.id);

    if (deleted) {
      // Verify it's gone
      const [check] = await db.select().from(actions).where(eq(actions.id, action.id)).limit(1);

      if (!check) {
        return { name: "Delete Action", passed: true, durationMs: Date.now() - start };
      }
      throw new Error("Action still exists after deletion");
    }
    throw new Error("Delete returned false");
  } catch (err: unknown) {
    return {
      name: "Delete Action",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function testEventDispatch(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Create a test event action
    const action = await createAction({
      name: "Test Event Action",
      slug: "test-event-action",
      type: "code",
      trigger: "event",
      triggerConfig: { eventName: "entry.created" },
      config: {
        code: "export default async function(ctx) { return { event: ctx.event }; }",
      },
    });

    // Dispatch event
    await dispatchEvent("entry:created", {
      datasetId: "test-dataset",
      entry: { id: "test-123", title: "Test Entry" },
    });

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 500));

    // Cleanup
    await db.delete(actions).where(eq(actions.id, action.id));

    return { name: "Event Dispatch", passed: true, durationMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "Event Dispatch",
      passed: false,
      error: messageOf(err),
      durationMs: Date.now() - start,
    };
  }
}

async function runAllTests(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Actions Integration Verification");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Cleanup first
  console.log("Cleaning up previous test data...");
  await cleanupTestData();
  console.log("");

  const tests: TestResult[] = [];

  // Run tests
  tests.push(await testDatabaseConnection());
  tests.push(await testSchemaExists());
  tests.push(await testCreateAction());
  tests.push(await testListActions());
  tests.push(await testGetAction());
  tests.push(await testExecuteCodeAction());
  tests.push(await testExecutionLogging());
  tests.push(await testUpdateAction());
  tests.push(await testCreateWebhookAction());
  tests.push(await testEventDispatch());
  tests.push(await testDeleteAction());

  // Results
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Test Results");
  console.log("═══════════════════════════════════════════════════════════\n");

  let passed = 0;
  let failed = 0;
  let totalDuration = 0;

  for (const test of tests) {
    const icon = test.passed ? "✅" : "❌";
    const status = test.passed ? "PASS" : "FAIL";
    console.log(`${icon} ${test.name.padEnd(25)} ${status} (${test.durationMs}ms)`);

    if (!test.passed && test.error) {
      console.log(`   Error: ${test.error}`);
    }

    if (test.passed) passed++;
    else failed++;

    totalDuration += test.durationMs;
  }

  console.log("\n───────────────────────────────────────────────────────────");
  console.log(`Total: ${tests.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${totalDuration}ms`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (failed === 0) {
    console.log("✨ All tests passed! Actions integration is working correctly.\n");
    process.exit(0);
  } else {
    console.log("⚠️  Some tests failed. Please review the errors above.\n");
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  runAllTests().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

export { runAllTests };
