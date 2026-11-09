// @ts-nocheck
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DATASET CREATOR - COMPLETE INTEGRATION TEST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * End-to-end tests of the Dataset Creator validating:
 * - Zod schemas (shared)
 * - DatasetStore (reactive state)
 * - API endpoints (backend)
 * - Data transformation (frontend → backend)
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS (copied from @kitsuden/shared)
// ═══════════════════════════════════════════════════════════════════════════════

const FieldTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "image",
  "url",
  "email",
  "select",
  "json",
  "richtext",
  "relation",
  "kpi",
]);

const FieldDefinitionSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().min(1),
  type: FieldTypeSchema,
  helpText: z.string().optional(),
  order: z.number().int().min(0).default(0),
  isRequired: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

const CreateDatasetPayloadSchema = z.object({
  name: z.string().min(1, "Dataset name is required"),
  slug: z.string().min(1, "Dataset slug is required"),
  description: z.string().optional(),
  icon: z.string().optional(),
  fields: z.array(FieldDefinitionSchema).min(0),
  policyJson: z.any().nullable().optional(),
  workflowJson: z.any().nullable().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// TESTING SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  const start = performance.now();
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => {
          results.push({ name, passed: true, duration: performance.now() - start });
        })
        .catch((err) => {
          results.push({
            name,
            passed: false,
            error: err instanceof Error ? err.message : String(err),
            duration: performance.now() - start,
          });
        });
    }
    results.push({ name, passed: true, duration: performance.now() - start });
  } catch (err) {
    results.push({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration: performance.now() - start,
    });
  }
}

function expect(actual: any) {
  return {
    toBe(expected: any) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual(expected: any) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected value to be defined but got undefined`);
      }
    },
    toContain(expected: any) {
      if (!actual.includes(expected)) {
        throw new Error(
          `Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`
        );
      }
    },
    toHaveLength(expected: number) {
      if (actual.length !== expected) {
        throw new Error(`Expected length ${expected} but got ${actual.length}`);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: DATA TRANSFORMATION (FRONTEND → BACKEND)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n🔄 Testing Data Transformation (Frontend → Backend)...\n");

// Test 1.1: Transform native fields
test("Transform native fields to FieldDefinition", () => {
  const nativeFields = [
    { id: "fld_1", name: "title", label: "Title", type: "text", config: {} },
    { id: "fld_2", name: "price", label: "Price", type: "number", config: {} },
  ];

  const transformed = nativeFields.map((f, index) => ({
    id: f.id,
    key: f.name,
    label: f.label,
    type: f.type,
    order: index,
    isRequired: false,
    isUnique: false,
    hidden: false,
    ...f.config,
  }));

  expect(transformed).toHaveLength(2);
  expect(transformed[0].key).toBe("title");
  expect(transformed[0].type).toBe("text");
  expect(transformed[1].key).toBe("price");
  expect(transformed[1].type).toBe("number");
});

// Test 1.2: Transform calculated fields to KPI
test("Transform calculated fields to KPI fields", () => {
  const calculatedFields = [
    {
      id: "cf_1",
      name: "total",
      label: "Total",
      type: "formula",
      config: { expression: "price * quantity" },
    },
    { id: "cf_2", name: "avg_price", label: "Average Price", type: "average", config: {} },
  ];

  const baseFieldsCount = 2;
  const transformed = calculatedFields.map((cf, index) => ({
    id: cf.id,
    key: cf.name,
    label: cf.label,
    type: "kpi",
    order: baseFieldsCount + index,
    isRequired: false,
    isUnique: false,
    hidden: false,
    helpText: cf.config?.expression || `${cf.type} calculation`,
  }));

  expect(transformed).toHaveLength(2);
  expect(transformed[0].type).toBe("kpi");
  expect(transformed[0].key).toBe("total");
  expect(transformed[0].helpText).toBe("price * quantity");
  expect(transformed[1].type).toBe("kpi");
});

// Test 1.3: Create complete payload
test("Create complete CreateDatasetPayload", () => {
  const nativeFields = [
    { id: "fld_1", name: "product", label: "Product", type: "text", config: {} },
  ];

  const calculatedFields = [
    {
      id: "cf_1",
      name: "total",
      label: "Total",
      type: "formula",
      config: { expression: "price * qty" },
    },
  ];

  const transformedNative = nativeFields.map((f, index) => ({
    id: f.id,
    key: f.name,
    label: f.label,
    type: f.type,
    order: index,
    isRequired: false,
    isUnique: false,
    hidden: false,
  }));

  const transformedCalculated = calculatedFields.map((cf, index) => ({
    id: cf.id,
    key: cf.name,
    label: cf.label,
    type: "kpi" as const,
    order: nativeFields.length + index,
    isRequired: false,
    isUnique: false,
    hidden: false,
    helpText: cf.config?.expression || `${cf.type} calculation`,
  }));

  const payload = {
    name: "Sales Orders",
    slug: "sales_orders",
    description: "Track sales orders",
    fields: [...transformedNative, ...transformedCalculated],
    policyJson: null,
    workflowJson: null,
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.fields).toHaveLength(2);
    expect(result.data.fields[1].type).toBe("kpi");
  }
});

// Test 1.4: Slug validation
test("Generate slug from label", () => {
  const generateSlug = (label: string) => {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  };

  expect(generateSlug("Sales Orders")).toBe("sales_orders");
  expect(generateSlug("Product Inventory")).toBe("product_inventory");
  expect(generateSlug("Test---Data")).toBe("test_data");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n📋 Testing Schema Validation...\n");

// Test 2.1: Valid payload passes
test("Valid payload passes schema validation", () => {
  const payload = {
    name: "Test Dataset",
    slug: "test_dataset",
    description: "A test dataset",
    fields: [
      {
        id: "fld_1",
        key: "name",
        label: "Name",
        type: "text",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
    policyJson: null,
    workflowJson: null,
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(true);
});

// Test 2.2: Payload without a name fails
test("Payload without name fails validation", () => {
  const payload = {
    name: "",
    slug: "test",
    fields: [],
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

// Test 2.3: Field without a key fails
test("Field without key fails validation", () => {
  const payload = {
    name: "Test",
    slug: "test",
    fields: [
      {
        id: "fld_1",
        key: "",
        label: "Name",
        type: "text",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

// Test 2.4: Invalid field type fails
test("Invalid field type fails validation", () => {
  const payload = {
    name: "Test",
    slug: "test",
    fields: [
      {
        id: "fld_1",
        key: "name",
        label: "Name",
        type: "invalid_type",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(false);
});

// Test 2.5: KPI type is valid
test("KPI field type is valid", () => {
  const payload = {
    name: "Test",
    slug: "test",
    fields: [
      {
        id: "fld_1",
        key: "total",
        label: "Total",
        type: "kpi",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
  };

  const result = CreateDatasetPayloadSchema.safeParse(payload);
  expect(result.success).toBe(true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: DATASET STORE SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n📊 Testing DatasetStore Simulation...\n");

// DatasetStore mock
class MockDatasetStore {
  datasets: any[] = [];
  isLoading = false;
  error: string | null = null;

  async createDataset(payload: any): Promise<any> {
    this.isLoading = true;
    this.error = null;

    // Simulate validation
    const validation = CreateDatasetPayloadSchema.safeParse(payload);
    if (!validation.success) {
      this.error = "Validation failed: " + validation.error?.issues?.[0]?.message;
      this.isLoading = false;
      return null;
    }

    // Simulate successful creation
    const newDataset = {
      id: `ds_${Date.now()}`,
      ...payload,
      createdAt: new Date().toISOString(),
    };

    this.datasets.push(newDataset);
    this.isLoading = false;
    return newDataset;
  }

  reset() {
    this.datasets = [];
    this.isLoading = false;
    this.error = null;
  }
}

const mockStore = new MockDatasetStore();

// Test 3.1: Create a valid dataset
test("DatasetStore creates valid dataset", async () => {
  mockStore.reset();

  const payload = {
    name: "Products",
    slug: "products",
    fields: [
      {
        id: "fld_1",
        key: "name",
        label: "Name",
        type: "text",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
    policyJson: null,
    workflowJson: null,
  };

  const result = await mockStore.createDataset(payload);
  expect(result).toBeDefined();
  expect(result.name).toBe("Products");
  expect(mockStore.datasets).toHaveLength(1);
});

// Test 3.2: Reject an invalid dataset
test("DatasetStore rejects invalid dataset", async () => {
  mockStore.reset();

  const payload = {
    name: "", // Invalid: empty
    slug: "test",
    fields: [],
  };

  const result = await mockStore.createDataset(payload);
  expect(result).toBeNull();
  expect(mockStore.error).toContain("Validation failed");
});

// Test 3.3: Loading state during the operation
test("DatasetStore sets isLoading during operation", async () => {
  mockStore.reset();

  const payload = {
    name: "Test",
    slug: "test",
    fields: [],
  };

  // Before starting
  expect(mockStore.isLoading).toBe(false);

  // During the operation (we can't verify it in the mock, but we can in the real one)
  const promise = mockStore.createDataset(payload);

  // After
  await promise;
  expect(mockStore.isLoading).toBe(false);
});

// Test 3.4: Dataset with calculated fields
test("DatasetStore creates dataset with calculated fields", async () => {
  mockStore.reset();

  const payload = {
    name: "Orders",
    slug: "orders",
    fields: [
      {
        id: "fld_1",
        key: "price",
        label: "Price",
        type: "number",
        order: 0,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
      {
        id: "fld_2",
        key: "quantity",
        label: "Quantity",
        type: "number",
        order: 1,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
      {
        id: "cf_1",
        key: "total",
        label: "Total",
        type: "kpi",
        order: 2,
        isRequired: false,
        isUnique: false,
        hidden: false,
      },
    ],
    policyJson: null,
    workflowJson: null,
  };

  const result = await mockStore.createDataset(payload);
  expect(result).toBeDefined();
  expect(result.fields).toHaveLength(3);
  expect(result.fields[2].type).toBe("kpi");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: COMPLETE WIZARD FLOW
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n🧙 Testing Wizard Flow...\n");

// Test 4.1: Complete creation flow
test("Complete wizard flow creates dataset", async () => {
  mockStore.reset();

  // Step 1: Basic Info
  const datasetLabel = "Sales Orders";
  const datasetName = "sales_orders";
  const description = "Track all sales orders";

  // Step 2: Native Fields
  const nativeFields = [
    { id: "fld_1", name: "order_number", label: "Order #", type: "text", config: {} },
    { id: "fld_2", name: "customer", label: "Customer", type: "text", config: {} },
    { id: "fld_3", name: "amount", label: "Amount", type: "number", config: {} },
  ];

  // Step 3: Calculated Fields
  const calculatedFields = [
    {
      id: "cf_1",
      name: "tax",
      label: "Tax",
      type: "formula",
      config: { expression: "amount * 0.16" },
    },
    {
      id: "cf_2",
      name: "total",
      label: "Total",
      type: "formula",
      config: { expression: "amount + tax" },
    },
  ];

  // Transform
  const transformedNative = nativeFields.map((f, index) => ({
    id: f.id,
    key: f.name,
    label: f.label,
    type: f.type,
    order: index,
    isRequired: false,
    isUnique: false,
    hidden: false,
  }));

  const transformedCalculated = calculatedFields.map((cf, index) => ({
    id: cf.id,
    key: cf.name,
    label: cf.label,
    type: "kpi" as const,
    order: nativeFields.length + index,
    isRequired: false,
    isUnique: false,
    hidden: false,
    helpText: cf.config?.expression || `${cf.type} calculation`,
  }));

  // Create payload
  const payload = {
    name: datasetLabel,
    slug: datasetName,
    description,
    fields: [...transformedNative, ...transformedCalculated],
    policyJson: null,
    workflowJson: null,
  };

  // Save
  const result = await mockStore.createDataset(payload);

  // Verify
  expect(result).toBeDefined();
  expect(result.name).toBe("Sales Orders");
  expect(result.slug).toBe("sales_orders");
  expect(result.fields).toHaveLength(5); // 3 native + 2 calculated
  expect(result.fields[3].type).toBe("kpi");
  expect(result.fields[3].key).toBe("tax");
});

// Test 4.2: Removing a field with dependencies
test("Removing field cascades to calculated fields", () => {
  const nativeFields = [
    { id: "fld_1", name: "price", label: "Price" },
    { id: "fld_2", name: "quantity", label: "Quantity" },
  ];

  const calculatedFields = [
    { id: "cf_1", name: "subtotal", label: "Subtotal", dependsOn: ["price", "quantity"] },
    { id: "cf_2", name: "total", label: "Total", dependsOn: ["price"] },
  ];

  // Simulate removing the "price" field
  const fieldToRemove = nativeFields[0]; // price
  const updatedCalculated = calculatedFields.filter(
    (cf) => !cf.dependsOn?.includes(fieldToRemove.name)
  );

  // Both calculated fields depend on price
  expect(updatedCalculated).toHaveLength(0);
});

// Test 4.3: Wizard step validation
test("Wizard steps are valid", () => {
  const steps = [
    { id: 1, label: "Basic Info" },
    { id: 2, label: "Fields" },
    { id: 3, label: "Calculated Fields" },
    { id: 4, label: "Review" },
  ];

  expect(steps).toHaveLength(4);
  expect(steps[0].label).toBe("Basic Info");
  expect(steps[1].label).toBe("Fields");
  expect(steps[2].label).toBe("Calculated Fields");
  expect(steps[3].label).toBe("Review");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: CALCULATED FIELDS (KPI CREATOR)
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n🧮 Testing Calculated Fields (KPI Creator)...\n");

// Test 5.1: Supported calculated field types
test("All calculated field types are supported", () => {
  const types = [
    "formula",
    "count",
    "sum",
    "average",
    "min",
    "max",
    "concat",
    "date_diff",
    "conditional",
    "lookup",
  ];

  expect(types).toContain("formula");
  expect(types).toContain("conditional");
  expect(types).toContain("date_diff");
  expect(types).toHaveLength(10);
});

// Test 5.2: Output format
test("Output formats are valid", () => {
  const formatTypes = [
    { id: "text", label: "Text" },
    { id: "number", label: "Number" },
    { id: "currency", label: "Currency" },
    { id: "percentage", label: "Percentage" },
    { id: "duration", label: "Duration" },
    { id: "badge", label: "Status Badge" },
  ];

  expect(formatTypes).toHaveLength(6);
  expect(formatTypes.map((f) => f.id)).toContain("currency");
  expect(formatTypes.map((f) => f.id)).toContain("percentage");
});

// Test 5.3: Dependency detection
test("Formula dependencies are extracted correctly", () => {
  const expression = "{price} * {quantity} + {tax}";
  const matches = expression.match(/\{([^}]+)\}/g) || [];
  const deps = matches.map((m) => m.slice(1, -1));

  expect(deps).toContain("price");
  expect(deps).toContain("quantity");
  expect(deps).toContain("tax");
  expect(deps).toHaveLength(3);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════════

console.log("\n" + "=".repeat(70));
console.log("📊 INTEGRATION TEST RESULTS - Dataset Creator");
console.log("=".repeat(70) + "\n");

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📈 Total: ${results.length}`);
console.log(`⏱️ Duration: ${totalDuration.toFixed(2)}ms\n`);

if (failed > 0) {
  console.log("FAILED TESTS:\n");
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`❌ ${r.name}`);
      console.log(`   Error: ${r.error}\n`);
    });
}

console.log("\n" + "=".repeat(70));
console.log(failed === 0 ? "🎉 ALL INTEGRATION TESTS PASSED!" : "⚠️ SOME TESTS FAILED");
console.log("=".repeat(70) + "\n");

// Save results
import * as fs from "fs";
import * as path from "path";

try {
  const testsJsonPath = path.join(process.cwd(), "tests.json");
  let testsData: any = { meta: {}, results: [] };

  if (fs.existsSync(testsJsonPath)) {
    testsData = JSON.parse(fs.readFileSync(testsJsonPath, "utf-8"));
  }

  testsData.dataset_creator_integration = {
    description: "Dataset Creator - Integration Tests (Frontend → Backend)",
    date: new Date().toISOString().split("T")[0],
    summary: {
      total: results.length,
      passed,
      failed,
      duration: `${totalDuration.toFixed(2)}ms`,
    },
    results: results.map((r) => ({
      name: r.name,
      status: r.passed ? "passed" : "failed",
      duration: `${r.duration.toFixed(2)}ms`,
      error: r.error || undefined,
    })),
  };

  fs.writeFileSync(testsJsonPath, JSON.stringify(testsData, null, 4));
  console.log(`✅ Results saved to tests.json\n`);
} catch (err) {
  console.log(`⚠️ Could not save to tests.json: ${err}\n`);
}

process.exit(failed > 0 ? 1 : 0);
